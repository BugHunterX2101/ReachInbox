"""CareerOps read-only Python research bridge.

Separate runtime for the existing Lovable dashboard and Apps Script worker.
No Gmail/Sheets credentials, scheduler, contact harvesting or READY promotion.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
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
from urllib.error import HTTPError
from bridge_adapters import (APPROVED_FEEDS, agent_read_verified, clean, eligible_hint as candidate_eligible,
                             model_fields_grounded, norm, posting_url, reviewed_inventory, source_candidates)

AGENT = "CareerOpsResearchBridge/1.0 (public jobs, read-only)"
LIMIT_BYTES = 900_000
PUBLIC_TIMEOUT = 2.5
PAGES = [
    ("Ubisar", "https://www.ubisar.com/vacancies/tech-intern"),
    ("Tecell", "https://careers.tecell.in/jobs/01a1ff0a-21e8-7e75-bb78-e17358385b66"),
]
SOURCE_INVENTORY = reviewed_inventory(PAGES)
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
    return clean(value, limit)

def _get_public(url, accept, maximum=LIMIT_BYTES):
    if not allowed_url(url):
        raise ValueError("PUBLIC_URL_INVALID")
    res = OPENER.open(Request(url, headers={"User-Agent": AGENT, "Accept": accept}), timeout=PUBLIC_TIMEOUT)
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
    html = raw.decode("utf-8", "replace")
    if re.search(r"<title[^>]*>\s*(just a moment|access denied|security verification|sign in|log in)", html[:16000], re.I):
        raise PermissionError("ACCESS_CHALLENGE")
    return html


def get_json(url):
    if url not in {source[3] for source in APPROVED_FEEDS}:
        raise ValueError("UNREVIEWED_FEED")
    robots_check(url)
    raw, ctype = _get_public(url, "application/json")
    if not ctype.lower().startswith("application/json"):
        raise ValueError("JSON_REQUIRED")
    return json.loads(raw)


def visible_text(html, source_url):
    from scrapling import Selector
    return clean(Selector(html, url=source_url).get_all_text(separator=" ", strip=True,
                 ignore_tags=("script", "style", "noscript", "head")), LIMIT_BYTES)

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
    """Local model output may corroborate origin text, never invent a job URL."""
    if os.getenv("ENABLE_GROUNDED_MODEL_REPLAY", "true").lower() != "true" or not ollama_ready():
        return []
    # The authenticated manual model probe is a prerequisite to production inference.
    with sqlite3.connect(DB_PATH) as conn:
        row = conn.execute("SELECT value FROM meta WHERE key='model_probe_result'").fetchone()
    probe = json.loads(row[0]) if row else {}
    if probe.get("status") != "PASSED" or not fresh(probe.get("checked_utc")):
        return []
    # Model calls are isolated and time-limited; do not make repeated provider attempts.
    # The existing synchronous collection has an 8-second client deadline; slow
    # inference is therefore consumed from a completed, manually requested probe.
    job = probe.get("candidate")
    if not isinstance(job, dict) or job.get("source_url") != source_url:
        return []
    if not model_fields_grounded(job.get("title"), job.get("location"), job.get("url"),
                                 source_url, visible_text(html, source_url), []):
        return []
    return [{"url": source_url, "title": clean(job["title"], 220),
             "location": clean(job["location"], 200), "company": company,
             "source_url": source_url, "extraction": "scrapegraphai:grounded_local_probe",
             "description": visible_text(html, source_url)[:16000]}]


def fresh(stamp, seconds=86400):
    try:
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(stamp.replace("Z", "+00:00"))).total_seconds()
        return 0 <= age <= seconds
    except (AttributeError, TypeError, ValueError):
        return False


def eligible_hint(job):
    return candidate_eligible(job.get("title", ""), job.get("location", ""), job.get("description", ""))


def approved_detail(company, url):
    return any(company == c and posting_url(url, ats, board) == url for c, ats, board, _ in APPROVED_FEEDS)


def detail_evidence(html, source_url, company, expected=None):
    """Actual Scrapling extraction, including a deterministic ATS-to-page corroboration."""
    out = parse_jobposting(html, source_url, company)
    out = [j for j in out if j.get("url") == source_url]
    if out:
        return out
    if expected and approved_detail(company, source_url):
        body = visible_text(html, source_url)
        if model_fields_grounded(expected["title"], expected["location"], source_url, source_url, body, []):
            return [{"url": source_url, "title": expected["title"], "location": expected["location"],
                     "company": company, "source_url": source_url,
                     "extraction": "scrapling:origin_visible_text", "description": body[:16000]}]
    return []


def select_probe_origin():
    """Select an actual previously discovered, approved public job; static seeds only as fallback."""
    with sqlite3.connect(DB_PATH) as conn:
        pending = conn.execute("SELECT company,url,title,location FROM detail_queue ORDER BY added_utc DESC,url LIMIT 10").fetchall()
    for company, url, title, location in pending:
        if approved_detail(company, url):
            return company, url, {"title": title, "location": location}
    company, url = PAGES[0]
    return company, url, None


def agent_reach_discovery():
    checked = timestamp()
    if os.getenv("ENABLE_AGENT_REACH_PUBLIC", "false").lower() != "true":
        return {"status": "DISABLED", "checked_utc": checked, "items": 0, "code": "FLAG_OFF"}
    try:
        company, url, expected = select_probe_origin()
        html = get_html(url)
        jobs = detail_evidence(html, url, company, expected)
        if not jobs:
            return {"status": "UNAVAILABLE", "checked_utc": checked, "items": 0, "code": "ORIGIN_EVIDENCE_MISSING"}
        job = jobs[0]
        result = agent_read_verified(url, job["title"], timeout=12)
        if result.get("status") == "OK":
            result["candidate"] = {k: job[k] for k in ("url", "company", "title", "location", "source_url")}
        result["checked_utc"] = timestamp()
        return result
    except (PermissionError, HTTPError):
        return {"status": "BLOCKED", "checked_utc": checked, "items": 0, "code": "ORIGIN_HTTP_OR_ROBOTS_BLOCKED"}
    except Exception as exc:
        return {"status": "UNAVAILABLE", "checked_utc": checked, "items": 0, "code": type(exc).__name__}


def run_agent_probe_background():
    """Only an authenticated request starts this; never a scheduler."""
    global AGENT_PROBE_ACTIVE
    try:
        result = agent_reach_discovery()
        with LOCK:
            with sqlite3.connect(DB_PATH) as conn:
                conn.execute("INSERT INTO meta(key,value) VALUES('agent_reach_result',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(result),))
                if result.get("status") == "OK" and isinstance(result.get("candidate"), dict):
                    conn.execute("UPDATE detail_queue SET last_checked=NULL WHERE url=?", (result["candidate"]["url"],))
        print(json.dumps({"event":"agent_probe","status":result.get("status"),"code":result.get("code"),"checked_utc":result.get("checked_utc")}),flush=True)
    finally:
        with AGENT_PROBE_LOCK:
            AGENT_PROBE_ACTIVE = False

def run_model_probe_background():
    """A bounded genuine-source local-model probe, triggered only by authorized request."""
    global MODEL_PROBE_ACTIVE
    status = {"status": "FAILED", "verified_title": False, "checked_utc": timestamp()}
    try:
        company, url, expected = select_probe_origin()
        html = get_html(url)
        jobs = detail_evidence(html, url, company, expected)
        if not jobs:
            raise ValueError("ORIGIN_EVIDENCE_MISSING")
        job = jobs[0]
        body = visible_text(html, url)
        if not model_fields_grounded(job["title"], job["location"], url, url, body, []):
            raise ValueError("ORIGIN_VISIBLE_EVIDENCE_MISSING")
        # Pass only bounded origin text, not any credentials or external URL.
        data = {"text": body[:3500], "expected_title": job["title"], "expected_location": job["location"]}
        if not model_fields_grounded(job["title"], job["location"], url, url, data["text"], []):
            raise ValueError("BOUNDED_EVIDENCE_MISSING")
        env = {k: v for k, v in os.environ.items() if k in {"PATH","HOME","LANG","LC_ALL","OLLAMA_BASE_URL","OLLAMA_MODEL","OLLAMA_HOST","OLLAMA_CONTEXT_LENGTH"}}
        proc = subprocess.run(["python", "/app/model_probe.py"], input=json.dumps(data),
                              capture_output=True, text=True, timeout=110, check=False, env=env)
        try:
            info = json.loads(proc.stdout.strip().splitlines()[-1])
        except (IndexError, ValueError, TypeError):
            info = {"status": "INVALID_RESULT"}
        if proc.returncode == 0 and info.get("status") == "PASSED" and info.get("verified_title") is True and info.get("verified_location") is True:
            status = {"status": "PASSED", "verified_title": True, "verified_location": True,
                      "checked_utc": timestamp(), "candidate": {k: job[k] for k in ("url","company","title","location","source_url")}}
        elif info.get("status") == "UNRELIABLE_OUTPUT":
            status["status"] = "UNRELIABLE_OUTPUT"
        else:
            status["error_type"] = str(info.get("error_type") or "PROBE_FAILED")[:90]
    except subprocess.TimeoutExpired:
        status["status"] = "TIMEOUT"
    except (PermissionError, HTTPError):
        status["status"] = "BLOCKED"
    except Exception as exc:
        status["error_type"] = type(exc).__name__
    finally:
        with LOCK:
            with sqlite3.connect(DB_PATH) as conn:
                conn.execute("INSERT INTO meta(key,value) VALUES('model_probe_result',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(status),))
                if status.get("status") == "PASSED" and isinstance(status.get("candidate"), dict):
                    conn.execute("UPDATE detail_queue SET last_checked=NULL WHERE url=?", (status["candidate"]["url"],))
        print(json.dumps({"event":"model_probe","status":status["status"],"checked_utc":status["checked_utc"]}), flush=True)
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
        conn.execute("CREATE TABLE IF NOT EXISTS detail_queue (url TEXT PRIMARY KEY, company TEXT NOT NULL, title TEXT NOT NULL, location TEXT NOT NULL, added_utc TEXT NOT NULL, last_checked TEXT)")

def scan_source(source, expected=None):
    company, kind, board, url = source
    if kind == "HTML":
        if (company, url) not in PAGES and not approved_detail(company, url):
            raise ValueError("UNREVIEWED_ORIGIN")
        html = get_html(url)
        jobs = detail_evidence(html, url, company, expected)
        # A completed model extraction may provide independent grounded evidence
        # even where deterministic extraction exists. No inference in this request.
        model_jobs = scrapegraph_fallback(html, url, company)
        if model_jobs:
            jobs = model_jobs
        with sqlite3.connect(DB_PATH) as conn:
            row = conn.execute("SELECT value FROM meta WHERE key='agent_reach_result'").fetchone()
        agent = json.loads(row[0]) if row else {}
        proof = agent.get("candidate")
        if os.getenv("ENABLE_AGENT_REACH_PUBLIC", "false").lower() == "true" and agent.get("status") == "OK" and fresh(agent.get("checked_utc")) and isinstance(proof, dict):
            for job in jobs:
                if all(job.get(k) == proof.get(k) for k in ("url","company","title","location","source_url")):
                    job["extraction"] = "agent_reach:origin_corroborated"
        return [j for j in jobs if eligible_hint(j)]
    return source_candidates(source, get_json, get_html, parse_jobposting, scrapegraph_fallback)


def safe_scan(source, expected=None):
    try:
        return "OK", scan_source(source, expected)
    except (PermissionError, HTTPError):
        return "BLOCKED", []
    except (TimeoutError, subprocess.TimeoutExpired):
        return "TIMEOUT", []
    except Exception as exc:
        print(json.dumps({"event":"source_scan_error","source":source[3],"error_type":type(exc).__name__}), flush=True)
        return "ERROR", []


def collect(max_sources):
    if type(max_sources) is not int or not 1 <= max_sources <= 2:
        raise ValueError("INVALID_LIMIT")
    with LOCK:
        # Read and release SQLite before network access; never share a connection
        # across the two bounded source workers.
        with sqlite3.connect(DB_PATH) as conn:
            state = conn.execute("SELECT value FROM meta WHERE key='cursor'").fetchone()
            cursor = int(state[0]) % len(SOURCE_INVENTORY) if state else 0
            detail = conn.execute("SELECT company,url,title,location FROM detail_queue WHERE last_checked IS NULL ORDER BY added_utc,url LIMIT 10").fetchall()
        work = [(SOURCE_INVENTORY[cursor], None)]
        if max_sources == 2:
            candidate = next((r for r in detail if approved_detail(r[0], r[1]) and r[1] != work[0][0][3]), None)
            if candidate:
                company, url, title, location = candidate
                work.insert(0, ((company,"HTML","",url), {"title":title,"location":location}))
            else:
                work.append((SOURCE_INVENTORY[(cursor+1)%len(SOURCE_INVENTORY)], None))
        advanced = sum(1 for _, expected in work if expected is None)
        with ThreadPoolExecutor(max_workers=len(work)) as pool:
            results = list(pool.map(lambda x: safe_scan(*x), work))
        items, scans, seen = [], [], set()
        with sqlite3.connect(DB_PATH) as conn:
            for (source, expected), (code, candidates) in zip(work, results):
                company, kind, board, url = source
                new = 0
                if expected is not None:
                    conn.execute("UPDATE detail_queue SET last_checked=? WHERE url=?", (timestamp(), url))
                if code == "OK":
                    for job in candidates:
                        if not eligible_hint(job) or job.get("source_url") != url or not allowed_url(job.get("url")):
                            continue
                        if kind != "HTML" and approved_detail(company, job["url"]):
                            conn.execute("INSERT OR IGNORE INTO detail_queue(url,company,title,location,added_utc) VALUES(?,?,?,?,?)",
                                         (job["url"], company, clean(job["title"],220), clean(job["location"],200), timestamp()))
                    # Prefer unseen jobs, but allow bounded replay of older records
                    # so a failed HTTP delivery cannot permanently hide a discovery.
                    ordered = sorted(candidates, key=lambda j: conn.execute("SELECT 1 FROM jobs WHERE url=?", (j["url"],)).fetchone() is not None)
                    for job in ordered:
                        if len(items) >= 3 or job["url"] in seen or job.get("source_url") != url or not allowed_url(job["url"]) or not eligible_hint(job):
                            continue
                        seen.add(job["url"])
                        inserted = conn.execute("INSERT OR IGNORE INTO jobs(url,first_seen) VALUES(?,?)", (job["url"],timestamp())).rowcount
                        new += int(inserted == 1)
                        item = {key: job[key] for key in ("url","company","title","location","source_url","extraction")}
                        item.update({"checked_utc":timestamp(),"status":"HOLD",
                                     "blocker":"Independent current role, 2027 timing, history, contact, resume and projects still required."})
                        items.append(item)
                scans.append({"source":url,"status":code,"new":new})
            cursor = (cursor + advanced) % len(SOURCE_INVENTORY)
            conn.execute("INSERT INTO meta(key,value) VALUES('cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(cursor),))
            # Keep local discovery cache bounded. Downstream dedup is authoritative.
            conn.execute("DELETE FROM detail_queue WHERE url NOT IN (SELECT url FROM detail_queue ORDER BY added_utc DESC,url LIMIT 250)")
        print(json.dumps({"event":"collect","checked_utc":timestamp(),"scans":scans,"items":len(items)}),flush=True)
        return {"ok":True,"items":items,"scans":scans,"state":{"sources":len(SOURCE_INVENTORY),"cursor":cursor}}

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
            "ok": True, "component": "careerops-research-bridge", "version": "1.1",
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
            limit = request.get("max_sources", 2)
            if type(limit) is not int or limit < 1 or limit > 2:
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
