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
AGENT_PROBE_LOCK = threading.Lock()
AGENT_PROBE_ACTIVE = False
MODEL_PROBE_LOCK = threading.Lock()
MODEL_PROBE_ACTIVE = False

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
    # Never make public collection wait on unverified local inference.
    if os.getenv("ENABLE_SCRAPEGRAPH_AUTO", "false").lower() != "true":
        return []
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
    """One explicit, read-only public-web probe. Never asks for logins or uses account sessions."""
    checked = timestamp()
    if os.getenv("ENABLE_AGENT_REACH_PUBLIC", "false").lower() != "true":
        return {"status": "DISABLED", "checked_utc": checked, "items": 0, "code": "FLAG_OFF"}
    # A public GitHub README is a stable verification target; not contact harvesting.
    cmd = ["agent-reach", "web", "read", "https://www.ubisar.com/vacancies/tech-intern", "--timeout", "18"]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=25, check=False)
    except subprocess.TimeoutExpired:
        return {"status": "TIMEOUT", "checked_utc": checked, "items": 0, "code": "CLI_TIMEOUT"}
    except FileNotFoundError:
        return {"status": "UNAVAILABLE", "checked_utc": checked, "items": 0, "code": "CLI_NOT_INSTALLED"}
    try:
        data = json.loads(proc.stdout[:65_536])
    except (ValueError, TypeError):
        return {"status": "UNAVAILABLE", "checked_utc": checked, "items": 0, "code": "INVALID_CLI_JSON"}
    error = data.get("error") if isinstance(data, dict) else None
    code = str(error.get("code", ""))[:55] if isinstance(error, dict) else "CLI_EXIT_" + str(proc.returncode)
    hits = data.get("items") if isinstance(data, dict) else None
    count = len(hits) if isinstance(hits, list) else 0
    if proc.returncode == 0 and data.get("ok") is True and count > 0:
        return {"status": "OK", "checked_utc": checked, "items": count, "code": "PUBLIC_READ_VERIFIED"}
    if code in {"RATE_LIMITED", "PLATFORM_BLOCKED", "NEED_LOGIN", "BUSY"}:
        return {"status": "BLOCKED", "checked_utc": checked, "items": 0, "code": code}
    return {"status": "UNAVAILABLE", "checked_utc": checked, "items": 0, "code": code or "NO_PUBLIC_ITEMS"}

def run_agent_probe_background():
    """Only an authenticated request starts this; never a scheduler."""
    global AGENT_PROBE_ACTIVE
    try:
        result = agent_reach_discovery()
        with LOCK:
            with sqlite3.connect(DB_PATH) as conn:
                conn.execute("INSERT INTO meta(key,value) VALUES('agent_reach_result',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(result),))
    finally:
        with AGENT_PROBE_LOCK:
            AGENT_PROBE_ACTIVE = False

def run_model_probe_background():
    """One manual bounded test of the real SmartScraperGraph class and local Ollama."""
    global MODEL_PROBE_ACTIVE
    status = {"status": "FAILED", "verified_title": False, "checked_utc": timestamp()}
    try:
        proc = subprocess.run(
            ["python", "/app/model_probe.py"], capture_output=True, text=True,
            timeout=110, check=False,
        )
        try:
            info = json.loads(proc.stdout[-1600:])
        except (ValueError, TypeError):
            info = {"status": "INVALID_RESULT"}
        if proc.returncode == 0 and info.get("status") == "PASSED" and info.get("verified_title") is True:
            status["status"] = "PASSED"
            status["verified_title"] = True
        elif info.get("status") == "UNRELIABLE_OUTPUT":
            status["status"] = "UNRELIABLE_OUTPUT"
        else:
            status["status"] = "FAILED"
            status["error_type"] = str(info.get("error_type") or "PROBE_FAILED")[:90]
    except subprocess.TimeoutExpired:
        status["status"] = "TIMEOUT"
    except Exception as exc:
        status["status"] = "FAILED"
        status["error_type"] = type(exc).__name__
    finally:
        with LOCK:
            with sqlite3.connect(DB_PATH) as conn:
                conn.execute("INSERT INTO meta(key,value) VALUES('model_probe_result',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(status),))
        with MODEL_PROBE_LOCK:
            MODEL_PROBE_ACTIVE = False

def get_adapter_status():
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute("SELECT value FROM meta WHERE key='agent_reach_result'").fetchone()
        model = conn.execute("SELECT value FROM meta WHERE key='model_probe_result'").fetchone()
    try:
        agent = json.loads(row[0]) if row else None
    except (ValueError, TypeError):
        agent = None
    try:
        probe = json.loads(model[0]) if model else None
    except (ValueError, TypeError):
        probe = None
    ready = ollama_ready()
    return {"ok": True, "agent_reach": agent or {"status": "NOT_TESTED", "items": 0},
            "scrapegraphai": probe if ready and probe else
                {"status": "MODEL_READY_NOT_TESTED" if ready else "NO_LOCAL_MODEL"},
            "checked_utc": timestamp()}

def ollama_ready():
    if os.getenv("ENABLE_LOCAL_SCRAPEGRAPHAI", "false").lower() != "true":
        return False
    base = os.getenv("OLLAMA_BASE_URL", "")
    model = os.getenv("OLLAMA_MODEL", "")
    if base not in ("http://127.0.0.1:11434", "http://localhost:11434") or not model:
        return False
    try:
        with OPENER.open(Request(base + "/api/tags", headers={"Accept": "application/json"}), timeout=1.5) as response:
            if response.status != 200: return False
            payload = json.loads(response.read(65536))
        return any(x.get("name") == model or x.get("model") == model for x in payload.get("models", []) if isinstance(x, dict))
    except Exception:
        return False

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
            # Agent Reach runs only via explicit authenticated probe, never inside collection.
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
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass
    def do_GET(self):
        if self.path == "/v1/agent-status":
            expected = os.getenv("CAREEROPS_BRIDGE_TOKEN", "")
            supplied = self.headers.get("X-CareerOps-Token", "")
            if len(expected) < 32 or not hmac.compare_digest(expected, supplied):
                return self.json(403, {"ok": False, "error": "unauthorized"})
            return self.json(200, get_adapter_status())
        if self.path != "/healthz":
            return self.json(404, {"ok": False})
        return self.json(200, {
            "ok": True, "component": "careerops-research-bridge", "version": "1.0",
            "scrapling_installed": installed("scrapling"),
            "scrapegraphai_installed": installed("scrapegraphai"),
            "agent_reach_installed": shutil.which("agent-reach") is not None,
            "ollama_enabled": ollama_ready(),
            "gmail_write_capable": False, "sheet_write_capable": False, "schedule_created": False
        })
    def do_POST(self):
        if self.path not in ("/v1/collect", "/v1/agent-probe", "/v1/model-probe"):
            return self.json(404, {"ok": False})
        expected = os.getenv("CAREEROPS_BRIDGE_TOKEN", "")
        supplied = self.headers.get("X-CareerOps-Token", "")
        if len(expected) < 32 or not hmac.compare_digest(expected, supplied):
            return self.json(403, {"ok": False, "error": "unauthorized"})
        if self.path == "/v1/model-probe":
            if not ollama_ready():
                return self.json(409, {"ok": False, "error": "LOCAL_OLLAMA_MODEL_NOT_READY"})
            with MODEL_PROBE_LOCK:
                global MODEL_PROBE_ACTIVE
                if MODEL_PROBE_ACTIVE:
                    return self.json(202, {"ok": True, "scrapegraphai": {"status": "RUNNING"}})
                with LOCK:
                    with sqlite3.connect(DB_PATH) as conn:
                        last = conn.execute("SELECT value FROM meta WHERE key='model_probe_checked'").fetchone()
                        if last and time.time() - float(last[0]) < 300:
                            return self.json(200, get_adapter_status())
                        conn.execute("INSERT INTO meta(key,value) VALUES('model_probe_checked',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(time.time()),))
                        conn.execute("INSERT INTO meta(key,value) VALUES('model_probe_result',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps({"status": "RUNNING", "checked_utc": timestamp()}),))
                MODEL_PROBE_ACTIVE = True
            threading.Thread(target=run_model_probe_background, daemon=True, name="scrapegraph-one-shot").start()
            return self.json(202, {"ok": True, "scrapegraphai": {"status": "RUNNING"}})
        if self.path == "/v1/agent-probe":
            if os.getenv("ENABLE_AGENT_REACH_PUBLIC", "false").lower() != "true":
                return self.json(409, {"ok": False, "error": "disabled"})
            with AGENT_PROBE_LOCK:
                global AGENT_PROBE_ACTIVE
                if AGENT_PROBE_ACTIVE:
                    return self.json(202, {"ok": True, "agent_reach": {"status": "RUNNING", "items": 0}})
                with LOCK:
                    with sqlite3.connect(DB_PATH) as conn:
                        prev = conn.execute("SELECT value FROM meta WHERE key='agent_reach_checked'").fetchone()
                        if prev and time.time() - float(prev[0]) < 300:
                            return self.json(200, get_adapter_status())
                        conn.execute("INSERT INTO meta(key,value) VALUES('agent_reach_checked',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(time.time()),))
                        conn.execute("INSERT INTO meta(key,value) VALUES('agent_reach_result',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps({"status": "RUNNING", "checked_utc": timestamp(), "items": 0}),))
                AGENT_PROBE_ACTIVE = True
            threading.Thread(target=run_agent_probe_background, daemon=True, name="agent-reach-one-shot").start()
            return self.json(202, {"ok": True, "agent_reach": {"status": "RUNNING", "items": 0}})
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
