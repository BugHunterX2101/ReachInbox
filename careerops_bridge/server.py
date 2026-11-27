"""CareerOps read-only Python research bridge.

Separate runtime for the existing Lovable dashboard and Apps Script worker.
No Gmail/Sheets credentials, scheduler, contact harvesting or READY promotion.
"""
from __future__ import annotations

import csv
import hmac
import importlib.util
import json
import os
import re
import shutil
import sqlite3
import subprocess
import threading
import time
from datetime import datetime, timezone
from html import unescape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.robotparser import RobotFileParser

AGENT = "CareerOpsResearchBridge/1.0 (public jobs, read-only)"
LIMIT_BYTES = 900_000
PAGES = [
    ("Ubisar", "https://www.ubisar.com/vacancies/tech-intern"),
    ("Tecell", "https://careers.tecell.in/jobs/01a1ff0a-21e8-7e75-bb78-e17358385b66"),
]
DB_PATH = Path(os.environ.get("CAREEROPS_DB", "/tmp/careerops.sqlite"))
LOCK = threading.RLock()

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

OPENER = build_opener(NoRedirect())

def timestamp():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def allowed_url(s):
    if not isinstance(s, str) or len(s) > 2048:
        return False
    try:
        u = urlsplit(s)
        return (u.scheme == "https" and u.hostname not in (None, "", "localhost")
                and u.username is None and u.password is None
                and u.port in (None, 443) and not u.fragment
                and re.fullmatch(r"[a-z0-9.-]+", u.hostname or "") is not None
                and not re.fullmatch(r"\d+(\.\d+){0,3}", u.hostname or "")
                and not (u.hostname or "").endswith((".localhost", ".local", ".internal", ".lan")))
    except ValueError:
        return False

def safe_text(value, limit):
    text = re.sub(r"<[^>]*>", " ", str(value or ""))
    text = unescape(text)
    # No private contact data is collected or returned.
    text = re.sub(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "[redacted]", text)
    return re.sub(r"\s+", " ", text).strip()[:limit]

def _get_public(url, accept, maximum=LIMIT_BYTES):
    if not allowed_url(url):
        raise ValueError("PUBLIC_URL_INVALID")
    res = OPENER.open(Request(url, headers={"User-Agent": AGENT, "Accept": accept}), timeout=7)
    try:
        if res.status != 200 or res.geturl() != url:
            raise PermissionError("REDIRECT_OR_HTTP_NOT_ALLOWED")
        raw = res.read(maximum + 1)
        if len(raw) > maximum:
            raise ValueError("RESPONSE_LIMIT")
        return raw, res.headers.get("Content-Type", "")
    finally:
        res.close()

def robots_check(url):
    u = urlsplit(url)
    robots_url = f"{u.scheme}://{u.netloc}/robots.txt"
    raw, _ = _get_public(robots_url, "text/plain", maximum=80_000)
    rp = RobotFileParser()
    rp.parse(raw.decode("utf-8", "replace").splitlines())
    if not rp.can_fetch(AGENT, url):
        raise PermissionError("ROBOTS_DISALLOWED")

def get_html(url):
    robots_check(url)       # Any inaccessible robots.txt fails closed.
    raw, ctype = _get_public(url, "text/html")
    if not ctype.lower().startswith("text/html"):
        raise ValueError("HTML_REQUIRED")
    return raw.decode("utf-8", "replace")

def parse_jobposting(html, source_url, company):
    from scrapling import Selector
    selector = Selector(html, url=source_url)
    out = []
    seen = set()
    for payload in selector.css('script[type="application/ld+json"]::text').getall():
        try:
            root = json.loads(str(payload))
        except (ValueError, TypeError):
            continue
        stack = [root]
        while stack:
            item = stack.pop()
            if isinstance(item, list):
                stack.extend(item)
                continue
            if not isinstance(item, dict):
                continue
            stack.extend(item.get("@graph", []) if isinstance(item.get("@graph"), list) else [item.get("@graph")] if item.get("@graph") else [])
            types = item.get("@type", [])
            if "JobPosting" not in ([types] if isinstance(types, str) else types if isinstance(types, list) else []):
                continue
            title = safe_text(item.get("title"), 220)
            url = item.get("url") or source_url
            if not title or not allowed_url(url) or urlsplit(url).hostname != urlsplit(source_url).hostname or url in seen:
                continue
            locations = item.get("jobLocation") or []
            locations = [locations] if isinstance(locations, dict) else locations
            pieces = []
            for place in locations if isinstance(locations, list) else []:
                if not isinstance(place, dict):
                    continue
                address = place.get("address")
                if isinstance(address, dict):
                    pieces.append(", ".join(str(address[k]) for k in ("addressLocality", "addressRegion", "addressCountry") if address.get(k)))
            seen.add(url)
            out.append({"url": url, "company": company, "title": title,
                        "location": safe_text(", ".join(pieces), 200),
                        "source_url": source_url, "extraction": "scrapling:jsonld",
                        "description": safe_text(item.get("description"), 1000)})
    return out

def scrapegraph_fallback(html, source_url, company):
    if os.getenv("ENABLE_LOCAL_SCRAPEGRAPHAI", "false").lower() != "true":
        return []
    base, model = os.getenv("OLLAMA_BASE_URL", ""), os.getenv("OLLAMA_MODEL", "")
    if base not in ("http://127.0.0.1:11434", "http://localhost:11434") or not model:
        raise RuntimeError("LOCAL_OLLAMA_REQUIRED")
    from scrapegraphai.graphs import SmartScraperGraph
    graph = SmartScraperGraph(
        prompt='Return JSON {"jobs":[{"title":"", "location":"", "url":""}]} only for actual currently advertised jobs. Do not invent fields or collect emails.',
        source=html,
        config={"llm": {"model": "ollama/" + model, "base_url": base, "temperature": 0, "format": "json"},
                "verbose": False})
    response = graph.run()
    out = []
    for item in response.get("jobs", [])[:6] if isinstance(response, dict) else []:
        if not isinstance(item, dict):
            continue
        url = item.get("url", "")
        if allowed_url(url) and urlsplit(url).hostname == urlsplit(source_url).hostname:
            out.append({"url": url, "title": safe_text(item.get("title"), 220),
                        "company": company, "location": safe_text(item.get("location"), 200),
                        "source_url": source_url, "extraction": "scrapegraphai:unverified_hint"})
    return out

def eligible_hint(job):
    title, location = job["title"].lower(), job["location"].lower()
    if not re.search(r"software|engineer|backend|developer|ai |machine learning|full.stack|data|devops", title):
        return False
    if re.search(r"\bsenior\b|\bstaff\b|\bprincipal\b|\blead\b", title):
        return False
    india = bool(re.search(r"india|bengaluru|bangalore|remote india", location))
    international = bool(re.search(r"united kingdom|uk|london|canada|toronto|ottawa|england|germany|france|netherlands|switzerland|ireland|sweden|norway|denmark|poland", location))
    if international:
        return bool(re.search(r"\b2027\b", title) and re.search(r"grad|graduate|new grad|campus", title) and not re.search(r"intern|placement|co.op", title))
    return india

def agent_reach_discovery():
    """Optional one-per-day anonymous public-web discovery, not a source scan."""
    if os.getenv("ENABLE_AGENT_REACH_PUBLIC", "false").lower() != "true":
        return "DISABLED"
    proc = subprocess.run(
        ["agent-reach", "web", "search", "2027 graduate software engineer UK Canada employer careers", "--limit", "5", "--backend", "public-web"],
        capture_output=True, text=True, timeout=12, check=False)
    if proc.returncode != 0:
        return "UNAVAILABLE"
    data = json.loads(proc.stdout)
    return "OK" if data.get("ok") else "UNAVAILABLE"

def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("CREATE TABLE IF NOT EXISTS jobs (url TEXT PRIMARY KEY, first_seen TEXT)")
        conn.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")

def collect(max_sources):
    with LOCK:
        with sqlite3.connect(DB_PATH) as conn:
            state = conn.execute("SELECT value FROM meta WHERE key='cursor'").fetchone()
            cursor = int(state[0]) if state else 0
            items, scans = [], []
            batch = min(max_sources, len(PAGES))
            for i in range(batch):
                company, url = PAGES[(cursor+i) % len(PAGES)]
                code, new = "OK", 0
                try:
                    html = get_html(url)
                    candidates = parse_jobposting(html, url, company)
                    if not candidates:
                        candidates = scrapegraph_fallback(html, url, company)
                    for job in candidates:
                        if len(items) >= 3 or not eligible_hint(job):
                            continue
                        existing = conn.execute("SELECT 1 FROM jobs WHERE url=?", (job["url"],)).fetchone()
                        if existing:
                            continue
                        conn.execute("INSERT INTO jobs(url,first_seen) VALUES(?,?)", (job["url"], timestamp()))
                        items.append({key: job[key] for key in ("url","company","title","location","source_url","extraction")})
                        items[-1].update({"checked_utc": timestamp(), "status": "HOLD",
                                          "blocker": "Original job, timing, prior company history, contact, resume and projects must be independently verified."})
                        new += 1
                except PermissionError:
                    code = "BLOCKED"
                except Exception:
                    code = "ERROR"
                scans.append({"source": url[:300], "status": code, "new": new})
            cursor = (cursor + batch) % len(PAGES)
            conn.execute("INSERT INTO meta(key,value) VALUES('cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",(str(cursor),))
            if os.getenv("ENABLE_AGENT_REACH_PUBLIC", "false").lower() == "true":
                last = conn.execute("SELECT value FROM meta WHERE key='agent_reach_checked'").fetchone()
                if not last or time.time() - float(last[0]) > 86400:
                    try:
                        outcome = agent_reach_discovery()
                    except Exception:
                        outcome = "UNAVAILABLE"
                    conn.execute("INSERT INTO meta(key,value) VALUES('agent_reach_checked',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",(str(time.time()),))
                    conn.execute("INSERT INTO meta(key,value) VALUES('agent_reach_result',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",(outcome,))
            return {"ok": True, "items": items, "scans": scans, "state": {"sources": len(PAGES), "cursor": cursor}}

def installed(module):
    return importlib.util.find_spec(module) is not None

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass
    def json(self, status, data):
        raw = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
    def do_GET(self):
        if self.path != "/healthz":
            return self.json(404, {"ok": False})
        return self.json(200, {
            "ok": True, "component": "careerops-research-bridge", "version": "1.0",
            "scrapling_installed": installed("scrapling"),
            "scrapegraphai_installed": installed("scrapegraphai"),
            "agent_reach_installed": shutil.which("agent-reach") is not None,
            "ollama_enabled": os.getenv("ENABLE_LOCAL_SCRAPEGRAPHAI", "false").lower() == "true"
                and os.getenv("OLLAMA_BASE_URL", "") in ("http://127.0.0.1:11434","http://localhost:11434")
                and bool(os.getenv("OLLAMA_MODEL")),
            "gmail_write_capable": False, "sheet_write_capable": False, "schedule_created": False
        })
    def do_POST(self):
        if self.path != "/v1/collect":
            return self.json(404, {"ok": False})
        expected = os.getenv("CAREEROPS_BRIDGE_TOKEN", "")
        supplied = self.headers.get("X-CareerOps-Token", "")
        if len(expected) < 32 or not hmac.compare_digest(expected, supplied):
            return self.json(403, {"ok": False, "error": "unauthorized"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > 2048:
                return self.json(413, {"ok": False, "error": "too_large"})
            request = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(request, dict) or set(request) - {"max_sources"}:
                raise ValueError("invalid request")
            limit = int(request.get("max_sources", 2))
            if limit < 1 or limit > 2:
                raise ValueError("invalid max_sources")
            return self.json(200, collect(limit))
        except (ValueError, TypeError, json.JSONDecodeError):
            return self.json(400, {"ok": False, "error": "bad_request"})
        except Exception:
            return self.json(503, {"ok": False, "error": "unavailable"})

if __name__ == "__main__":
    if len(os.getenv("CAREEROPS_BRIDGE_TOKEN", "")) < 32:
        raise SystemExit("Bridge secret must be configured in Render")
    init_db()
    server = ThreadingHTTPServer(("0.0.0.0", int(os.getenv("PORT", "8000"))), Handler)
    print("CareerOps Python research-only bridge started", flush=True)
    server.serve_forever()
