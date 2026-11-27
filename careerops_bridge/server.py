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
from urllib.request import Request, build_opener, HTTPRedirectHandler, ProxyHandler
from urllib.robotparser import RobotFileParser
from urllib.error import HTTPError, URLError
from bridge_adapters import (APPROVED_FEEDS, agent_read_verified, clean, eligible_hint as candidate_eligible,
                             model_fields_grounded, norm, posting_url, reviewed_inventory, source_candidates)

AGENT = "CareerOpsResearchBridge/1.0 (public jobs, read-only)"
LIMIT_BYTES = 900_000
PUBLIC_TIMEOUT = 3.0
PROBE_TIMEOUT = 10.0
REQUEST_BUDGET = threading.local()
PAGES = [
    ("Ubisar", "https://www.ubisar.com/vacancies/tech-intern"),
    ("Tecell", "https://careers.tecell.in/jobs/01a1ff0a-21e8-7e75-bb78-e17358385b66"),
]
# Start with distinct documented providers rather than two boards on the
# same failing host. Retain all reviewed sources and the Europe/Canada priority.
_base_inventory = reviewed_inventory(PAGES)
_preferred = ("Quadrature Capital","Promise Robotics","Fellow Insights Inc.")
SOURCE_INVENTORY = tuple(s for name in _preferred for s in _base_inventory if s[0]==name) + tuple(s for s in _base_inventory if s[0] not in _preferred and s[0]!="Ubisar")
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
LOCAL_OPENER = build_opener(ProxyHandler({}), NoRedirect())
# Diagnostic-only public employer posting; never enters discovery or outreach.
DIAGNOSTIC_ORIGIN = ("Ubisar", "https://www.ubisar.com/vacancies/tech-intern", {"title":"Tech Intern", "location":"India - Remote"})

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
    phase = "ROBOTS" if urlsplit(url).path == "/robots.txt" else "ORIGIN"
    try:
        res = OPENER.open(Request(url, headers={"User-Agent": AGENT, "Accept": accept}), timeout=getattr(REQUEST_BUDGET,"timeout",PUBLIC_TIMEOUT))
    except TimeoutError:
        raise TimeoutError(phase+"_CONNECT_TIMEOUT") from None
    except HTTPError:
        raise
    except URLError as exc:
        if isinstance(exc.reason, TimeoutError):
            raise TimeoutError(phase+"_CONNECT_TIMEOUT") from None
        raise ConnectionError(phase+"_NETWORK_ERROR") from None
    try:
        if res.status != 200 or res.geturl() != url:
            raise PermissionError("REDIRECT_OR_HTTP_NOT_ALLOWED")
        try:
            raw = res.read(maximum + 1)
        except TimeoutError:
            raise TimeoutError(phase+'_READ_TIMEOUT') from None
        if len(raw) > maximum:
            raise ValueError("RESPONSE_LIMIT")
        return raw, res.headers.get("Content-Type", "")
    finally:
        res.close()

def robots_check(url):
    u = urlsplit(url)
    robots_url = f"{u.scheme}://{u.netloc}/robots.txt"
    try:
        raw, ctype = _get_public(robots_url, "text/plain", maximum=512_000)
    except HTTPError as exc:
        # RFC 9309 §2.3.1.3: a genuinely absent robots file is not a
        # prohibition. Narrow this exception to documented public GET ATS
        # feeds in the reviewed allowlist, never arbitrary HTML or blocked
        # paths. 401/403/429/5xx/redirects/network failures remain fail-closed.
        if exc.code in (404, 410) and url in {s[3] for s in APPROVED_FEEDS}:
            print(json.dumps({"event":"robots_policy","source":url,"code":"PUBLIC_API_ROBOTS_ABSENT","http":exc.code}),flush=True)
            return
        raise PermissionError("ROBOTS_HTTP_" + str(exc.code)) from None
    if not ctype.lower().startswith("text/plain"):
        raise PermissionError("ROBOTS_CONTENT_TYPE")
    rp = RobotFileParser()
    rp.parse(raw.decode("utf-8", "replace").splitlines())
    if not rp.can_fetch(AGENT, url):
        raise PermissionError("ROBOTS_DISALLOWED")
    if rp.crawl_delay(AGENT) or rp.request_rate(AGENT):
        raise PermissionError("ROBOTS_PACING_REQUIRES_REVIEW")

def get_html(url):
    robots_check(url)       # HTML requires an accessible, permitting robots policy.
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
    if expected and (approved_detail(company, source_url) or (company, source_url) == DIAGNOSTIC_ORIGIN[:2]):
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
    # Explicit manual diagnostics may use a separately reviewed public job.
    # This role is excluded from outreach (no sponsorship), never a queue item.
    return DIAGNOSTIC_ORIGIN


def agent_reach_discovery():
    checked = timestamp()
    if os.getenv("ENABLE_AGENT_REACH_PUBLIC", "false").lower() != "true":
        return {"status": "DISABLED", "checked_utc": checked, "items": 0, "code": "FLAG_OFF"}
    try:
        company, url, expected = select_probe_origin()
        REQUEST_BUDGET.timeout = PROBE_TIMEOUT
        html = get_html(url)
        jobs = detail_evidence(html, url, company, expected)
        if not jobs:
            return {"status": "UNAVAILABLE", "checked_utc": checked, "items": 0, "code": "ORIGIN_EVIDENCE_MISSING"}
        job = jobs[0]
        record_scrapling_proof(job)
        result = agent_read_verified(url, job["title"], timeout=25)
        if result.get("status") == "OK" and (company,url) != DIAGNOSTIC_ORIGIN[:2]:
            result["candidate"] = {k: job[k] for k in ("url", "company", "title", "location", "source_url")}
        result["checked_utc"] = timestamp()
        result["diagnostic_only"] = (company,url) == DIAGNOSTIC_ORIGIN[:2]
        return result
    except (PermissionError, HTTPError) as exc:
        return {"status": "BLOCKED", "checked_utc": checked, "items": 0, "code": public_failure(exc)}
    except TimeoutError as exc:
        return {"status":"TIMEOUT","checked_utc":timestamp(),"items":0,"code":public_failure(exc)}
    except Exception as exc:
        return {"status":"UNAVAILABLE","checked_utc":timestamp(),"items":0,"code":public_failure(exc)}


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

def build_model_evidence(html, url, job, expected=None, diagnostic_only=False):
    """Use literal, current employer-page text, not reconstructed JSON-LD fields.

    A diagnostic fixture can name an independently reviewed visible title/location;
    both must be found verbatim (case/whitespace normalized) on the fetched page.
    The model receives only a contiguous excerpt, not the expected answer.
    """
    body = visible_text(html, url)
    pairs = [(job.get("title"), job.get("location"))]
    if diagnostic_only and isinstance(expected, dict):
        pairs.insert(0, (expected.get("title"), expected.get("location")))
    for title,location in pairs:
        if not isinstance(title,str) or not isinstance(location,str) or not title or not location:
            continue
        if not model_fields_grounded(title,location,url,url,body,[]):
            continue
        # Choose the nearest pair of exact source occurrences, not an unrelated
        # country name in the page's navigation. A short contiguous excerpt
        # preserves original evidence and order.
        starts = [m.start() for m in re.finditer(re.escape(title),body,re.I)]
        locations = [m.start() for m in re.finditer(re.escape(location),body,re.I)]
        spans = [(min(a,b),max(a+len(title),b+len(location))) for a in starts for b in locations]
        if not spans: continue
        left,right=min(spans,key=lambda span:span[1]-span[0])
        if right-left>600: continue
        excerpt=body[max(0,left-24):min(len(body),right+48)]
        if model_fields_grounded(title,location,url,url,excerpt,[]):
            return {"text":excerpt,"expected_title":title,"expected_location":location}
    raise ValueError("ORIGIN_VISIBLE_EVIDENCE_MISSING")


def run_model_probe_background():
    """A bounded genuine-source local-model probe, triggered only by authorized request."""
    global MODEL_PROBE_ACTIVE
    status = {"status": "FAILED", "verified_title": False, "checked_utc": timestamp()}
    try:
        company, url, expected = select_probe_origin()
        REQUEST_BUDGET.timeout = PROBE_TIMEOUT
        html = get_html(url)
        jobs = detail_evidence(html, url, company, expected)
        if not jobs:
            raise ValueError("ORIGIN_EVIDENCE_MISSING")
        job = jobs[0]
        record_scrapling_proof(job)
        diagnostic_only = (company,url) == DIAGNOSTIC_ORIGIN[:2]
        data = build_model_evidence(html,url,job,expected,diagnostic_only)
        env = {k: v for k, v in os.environ.items() if k in {"PATH","HOME","LANG","LC_ALL","OLLAMA_BASE_URL","OLLAMA_MODEL","OLLAMA_HOST","OLLAMA_CONTEXT_LENGTH"}}
        proc = subprocess.run(["python", "/app/model_probe.py"], input=json.dumps(data),
                              capture_output=True, text=True, timeout=110, check=False, env=env)
        try:
            info = json.loads(proc.stdout.strip().splitlines()[-1])
        except (IndexError, ValueError, TypeError):
            info = {"status": "INVALID_RESULT"}
        if proc.returncode == 0 and info.get("status") == "PASSED" and info.get("verified_title") is True and info.get("verified_location") is True:
            status = {"status": "PASSED", "verified_title": True, "verified_location": True,
                      "checked_utc": timestamp(), "diagnostic_only": (company,url) == DIAGNOSTIC_ORIGIN[:2]}
            status["code"] = "ORIGIN_FIELDS_MATCHED"
            if not status["diagnostic_only"]:
                status["candidate"] = {k: job[k] for k in ("url","company","title","location","source_url")}
        elif info.get("status") == "UNRELIABLE_OUTPUT":
            status["status"] = "UNRELIABLE_OUTPUT"
        else:
            status["error_type"] = str(info.get("error_type") or "PROBE_FAILED")[:90]
    except (subprocess.TimeoutExpired, TimeoutError) as exc:
        status["status"] = "TIMEOUT"
        status["error_type"] = public_failure(exc)
    except (PermissionError, HTTPError) as exc:
        status["status"] = "BLOCKED"
        status["error_type"] = public_failure(exc)
    except Exception as exc:
        status["error_type"] = public_failure(exc)
    finally:
        with LOCK:
            with sqlite3.connect(DB_PATH) as conn:
                conn.execute("INSERT INTO meta(key,value) VALUES('model_probe_result',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(status),))
                if status.get("status") == "PASSED" and isinstance(status.get("candidate"), dict):
                    conn.execute("UPDATE detail_queue SET last_checked=NULL WHERE url=?", (status["candidate"]["url"],))
        print(json.dumps({"event":"model_probe","status":status["status"],"code":status.get("error_type"),"verified_title":status.get("verified_title",False),"verified_location":status.get("verified_location",False),"checked_utc":status["checked_utc"]}), flush=True)
        with MODEL_PROBE_LOCK:
            MODEL_PROBE_ACTIVE = False

def public_failure(exc):
    if isinstance(exc, HTTPError):
        return "ORIGIN_HTTP_" + str(exc.code)
    code = str(exc)
    return code if re.fullmatch(r"[A-Z0-9_]{1,60}",code) else type(exc).__name__


def record_scrapling_proof(job):
    proof = {"status":"PASSED","code":"ORIGIN_FIELDS_EXTRACTED","source_url":job["source_url"],
             "title":job["title"],"location":job["location"],"checked_utc":timestamp(),"extraction":job["extraction"],
             "diagnostic_only":(job["company"],job["source_url"]) == DIAGNOSTIC_ORIGIN[:2]}
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("INSERT INTO meta(key,value) VALUES('scrapling_result',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",(json.dumps(proof),))
    print(json.dumps({"event":"scrapling_live","status":"PASSED","source":proof["source_url"],"extraction":proof["extraction"],"checked_utc":proof["checked_utc"],"diagnostic_only":proof["diagnostic_only"]}),flush=True)


def get_adapter_status():
    with sqlite3.connect(DB_PATH) as conn:
        data = dict(conn.execute("SELECT key,value FROM meta WHERE key IN ('agent_reach_result','model_probe_result','scrapling_result')"))
    def saved(key):
        try: return json.loads(data[key])
        except (KeyError,ValueError,TypeError): return None
    runtime = ollama_status()
    ready = runtime == "MODEL_READY"
    return {"ok": True, "agent_reach": saved("agent_reach_result") or {"status": "NOT_TESTED", "items": 0},
            "scrapling": saved("scrapling_result") or {"status":"NOT_TESTED"},
            "scrapegraphai": (saved("model_probe_result") if ready else None) or
                {"status": "MODEL_READY_NOT_TESTED" if ready else "NO_LOCAL_MODEL", "code":runtime},
            "checked_utc": timestamp()}


def ollama_status():
    if os.getenv("ENABLE_LOCAL_SCRAPEGRAPHAI", "false").lower() != "true":
        return "LOCAL_MODEL_FLAG_OFF"
    base = os.getenv("OLLAMA_BASE_URL", "")
    model = os.getenv("OLLAMA_MODEL", "")
    if base not in ("http://127.0.0.1:11434", "http://localhost:11434") or not model:
        return "LOCAL_MODEL_CONFIG_INVALID"
    try:
        with LOCAL_OPENER.open(Request(base + "/api/tags", headers={"Accept": "application/json"}), timeout=1.5) as response:
            if response.status != 200: return "LOCAL_TAGS_HTTP_ERROR"
            payload = json.loads(response.read(65536))
        if not isinstance(payload,dict): return "LOCAL_TAGS_INVALID"
        return "MODEL_READY" if any(x.get("name") == model or x.get("model") == model for x in payload.get("models", []) if isinstance(x, dict)) else "LOCAL_MODEL_NOT_LISTED"
    except Exception as exc:
        return "LOCAL_TAGS_UNAVAILABLE_" + type(exc).__name__.upper()


def ollama_ready():
    return ollama_status() == "MODEL_READY"

def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("CREATE TABLE IF NOT EXISTS jobs (url TEXT PRIMARY KEY, first_seen TEXT)")
        conn.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
        conn.execute("CREATE TABLE IF NOT EXISTS detail_queue (url TEXT PRIMARY KEY, company TEXT NOT NULL, title TEXT NOT NULL, location TEXT NOT NULL, added_utc TEXT NOT NULL, last_checked TEXT)")
        conn.execute("CREATE TABLE IF NOT EXISTS source_cooldown (url TEXT PRIMARY KEY, until_epoch REAL NOT NULL, status TEXT NOT NULL)")

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
    except (PermissionError, HTTPError) as exc:
        reason=public_failure(exc)
        print(json.dumps({"event":"source_scan_blocked","source":source[3],"code":reason}),flush=True)
        if reason in ("ROBOTS_HTTP_429","ORIGIN_HTTP_429","ROBOTS_HTTP_403","ROBOTS_HTTP_401"):
            # Respect host-wide throttling/robots access denial, not merely a board.
            with sqlite3.connect(DB_PATH) as conn:
                conn.execute("INSERT INTO source_cooldown(url,until_epoch,status) VALUES(?,?,?) ON CONFLICT(url) DO UPDATE SET until_epoch=excluded.until_epoch,status=excluded.status",("host:"+urlsplit(source[3]).hostname,time.time()+21600,"BLOCKED"))
        return "BLOCKED", []
    except (TimeoutError, subprocess.TimeoutExpired) as exc:
        print(json.dumps({"event":"source_scan_timeout","source":source[3],"code":public_failure(exc)}),flush=True)
        return "TIMEOUT", []
    except Exception as exc:
        print(json.dumps({"event":"source_scan_error","source":source[3],"error_type":type(exc).__name__}), flush=True)
        return "ERROR", []


def choose_work(inventory, cursor, detail, blocked, max_sources):
    """Choose separate eligible hosts, never retry a blocked source in the same batch."""
    work, hosts = [], set()
    def add(source, expected=None):
        url = source[3]
        host = urlsplit(url).hostname
        if url in blocked or "host:"+host in blocked or host in hosts or len(work)>=max_sources:
            return False
        work.append((source,expected)); hosts.add(host)
        return True
    # Prefer an independently discovered original posting, then a different provider.
    if max_sources==2:
        for company,url,title,location in detail:
            if approved_detail(company,url) and add((company,"HTML","",url),{"title":title,"location":location}):
                break
    n=len(inventory)
    next_cursor=cursor
    for offset in range(n):
        i=(cursor+offset)%n
        if add(inventory[i]):
            next_cursor=(i+1)%n
        if len(work)>=max_sources:
            break
    return work,next_cursor


def collect(max_sources):
    if type(max_sources) is not int or not 1 <= max_sources <= 2:
        raise ValueError("INVALID_LIMIT")
    with LOCK:
        with sqlite3.connect(DB_PATH) as conn:
            state = conn.execute("SELECT value FROM meta WHERE key='cursor'").fetchone()
            cursor = int(state[0]) % len(SOURCE_INVENTORY) if state else 0
            detail = conn.execute("SELECT company,url,title,location FROM detail_queue WHERE last_checked IS NULL ORDER BY added_utc,url LIMIT 10").fetchall()
            blocked = {r[0] for r in conn.execute("SELECT url FROM source_cooldown WHERE until_epoch>?",(time.time(),))}
        work,cursor=choose_work(SOURCE_INVENTORY,cursor,detail,blocked,max_sources)
        if not work:
            return {"ok":True,"items":[],"scans":[],"state":{"sources":len(SOURCE_INVENTORY),"cursor":cursor}}
        with ThreadPoolExecutor(max_workers=len(work)) as pool:
            results=list(pool.map(lambda x:safe_scan(*x),work))
        items,scans,seen=[],[],set()
        with sqlite3.connect(DB_PATH) as conn:
            for (source,expected),(code,candidates) in zip(work,results):
                company,kind,board,url=source
                new=0
                if code!="OK":
                    # Defer actual access failures; no retry or alternate backend.
                    cooldown=21600 if code=="BLOCKED" else 3600
                    conn.execute("INSERT INTO source_cooldown(url,until_epoch,status) VALUES(?,?,?) ON CONFLICT(url) DO UPDATE SET until_epoch=excluded.until_epoch,status=excluded.status",(url,time.time()+cooldown,code))
                if expected is not None and code=="OK":
                    conn.execute("UPDATE detail_queue SET last_checked=? WHERE url=?",(timestamp(),url))
                if code=="OK":
                    for job in candidates:
                        if not eligible_hint(job) or job.get("source_url")!=url or not allowed_url(job.get("url")):
                            continue
                        if kind!="HTML" and approved_detail(company,job["url"]):
                            conn.execute("INSERT OR IGNORE INTO detail_queue(url,company,title,location,added_utc) VALUES(?,?,?,?,?)",(job["url"],company,clean(job["title"],220),clean(job["location"],200),timestamp()))
                    ordered=sorted(candidates,key=lambda j:conn.execute("SELECT 1 FROM jobs WHERE url=?",(j["url"],)).fetchone() is not None)
                    for job in ordered:
                        if len(items)>=3 or job["url"] in seen or job.get("source_url")!=url or not allowed_url(job["url"]) or not eligible_hint(job):
                            continue
                        seen.add(job["url"])
                        inserted=conn.execute("INSERT OR IGNORE INTO jobs(url,first_seen) VALUES(?,?)",(job["url"],timestamp())).rowcount
                        new+=int(inserted==1)
                        item={key:job[key] for key in ("url","company","title","location","source_url","extraction")}
                        item.update({"checked_utc":timestamp(),"status":"HOLD","blocker":"Independent current role, 2027 timing, history, contact, resume and projects still required."})
                        items.append(item)
                scans.append({"source":url,"status":code,"new":new})
            conn.execute("INSERT INTO meta(key,value) VALUES('cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",(str(cursor),))
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
            "ok": True, "component": "careerops-research-bridge", "version": "1.3",
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
