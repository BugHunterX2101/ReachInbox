"""Reviewed, bounded public-source adapters; every output is a research hint only."""
from __future__ import annotations

import json
import os
import re
import subprocess
from html import unescape
from urllib.parse import urlsplit, urlunsplit

# Snapshot of enabled, relevant public employer boards from Worker Sources.
# Geography is NOT inferred from an employer's board; each posting must supply it.
APPROVED_FEEDS = (
    ("Abound", "ASHBY", "Abound", "https://api.ashbyhq.com/posting-api/job-board/Abound"),
    ("Bloxd", "ASHBY", "bloxd", "https://api.ashbyhq.com/posting-api/job-board/bloxd"),
    ("Edra", "ASHBY", "edra", "https://api.ashbyhq.com/posting-api/job-board/edra"),
    ("Fellow Insights Inc.", "ASHBY", "fellowai", "https://api.ashbyhq.com/posting-api/job-board/fellowai"),
    ("Genesis AI", "ASHBY", "genesis", "https://api.ashbyhq.com/posting-api/job-board/genesis"),
    ("Northslope Technologies", "ASHBY", "northslope-technologies", "https://api.ashbyhq.com/posting-api/job-board/northslope-technologies"),
    ("Promise Robotics", "LEVER", "promiserobotics", "https://api.lever.co/v0/postings/promiserobotics?mode=json"),
    ("Quadrature Capital", "GREENHOUSE", "quadraturecapital", "https://boards-api.greenhouse.io/v1/boards/quadraturecapital/jobs"),
    ("TransFICC", "ASHBY", "transficc", "https://api.ashbyhq.com/posting-api/job-board/transficc"),
    ("Zip", "ASHBY", "zip", "https://api.ashbyhq.com/posting-api/job-board/zip"),
    ("Isomorphic Labs", "GREENHOUSE", "isomorphiclabs", "https://boards-api.greenhouse.io/v1/boards/isomorphiclabs/jobs"),
    ("Deepwatch", "GREENHOUSE", "deepwatchindia", "https://boards-api.greenhouse.io/v1/boards/deepwatchindia/jobs"),
    ("Forma.ai", "GREENHOUSE", "formaaiinc3", "https://boards-api.greenhouse.io/v1/boards/formaaiinc3/jobs"),
    ("Interview Kickstart", "ASHBY", "interview-kickstart", "https://api.ashbyhq.com/posting-api/job-board/interview-kickstart"),
    ("Meraki Labs", "ASHBY", "Meraki-Labs", "https://api.ashbyhq.com/posting-api/job-board/Meraki-Labs"),
)


def clean(value, limit):
    text = re.sub(r"<[^>]*>", " ", unescape(str(value or "")))
    text = re.sub(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "[redacted]", text)
    text = re.sub(r"[\x00-\x1f\x7f]", " ", text)
    text = re.sub(r"[<>]", " ", text)
    return re.sub(r"\s+", " ", text).strip()[:limit]


def norm(value):
    return clean(value, 900000).casefold()


def posting_url(value, ats, board):
    """Accept only HTTPS URLs on the exact reviewed ATS board, not arbitrary links."""
    if not isinstance(value, str) or len(value) > 2048:
        return None
    try:
        u = urlsplit(value)
        if u.scheme != "https" or u.username or u.password or u.port not in (None, 443) or u.fragment:
            return None
        path = u.path.rstrip("/")
        b = re.escape(board)
        uuid = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
        if ats == "GREENHOUSE":
            valid = u.hostname in {"job-boards.greenhouse.io", "boards.greenhouse.io"} and re.fullmatch(rf"/{b}/jobs/\d+", path, re.I)
        elif ats == "ASHBY":
            valid = u.hostname == "jobs.ashbyhq.com" and re.fullmatch(rf"/{b}/{uuid}", path, re.I)
        elif ats == "LEVER":
            valid = u.hostname == "jobs.lever.co" and re.fullmatch(rf"/{b}/{uuid}(?:/apply)?", path, re.I)
            if valid and path.endswith("/apply"):
                path = path[:-6]
        else:
            return None
        return urlunsplit(("https", u.hostname, path, "", "")) if valid else None
    except (ValueError, TypeError):
        return None


def eligible_hint(title, location, description=""):
    """Conservative lead filter, never a graduate eligibility or work-rights decision."""
    t, loc, desc = norm(title), norm(location), norm(description)
    if not re.search(r"software|engineer|backend|developer|\bai\b|machine learning|full.stack|\bdata\b|devops|quant|platform|infrastructure", t):
        return False
    if re.search(r"\b(senior|staff|principal|lead|director|manager)\b", t):
        return False
    india = bool(re.search(r"\b(india|bengaluru|bangalore|hyderabad|pune|mumbai|delhi|gurugram|gurgaon|chennai|noida)\b", loc))
    overseas = bool(re.search(r"\b(united kingdom|uk|london|cambridge|edinburgh|manchester|canada|toronto|ottawa|waterloo|vancouver|montreal|montréal|calgary|england|scotland|wales|germany|berlin|munich|france|paris|netherlands|amsterdam|switzerland|zurich|zürich|geneva|lausanne|ireland|dublin|sweden|stockholm|norway|oslo|denmark|copenhagen|poland|warsaw|austria|vienna|belgium|brussels|finland|helsinki|czechia|prague|spain|madrid|portugal|lisbon|italy|milan|luxembourg)\b", loc))
    if overseas:
        # A location containing both India and overseas is ambiguous, not verified.
        # A mention of internships in the description is not an internship job title.
        return not india and not re.search(r"\b(united states|usa|u\.s\.a\.|singapore|hong kong|australia|new zealand)\b", loc) and bool(re.search(r"\b2027\b", t + " " + desc) and re.search(r"\b(grad|graduate|graduates|campus|new grad|early career|entry.level)\b", t + " " + desc) and not re.search(r"intern|placement|co.op", t))
    return india and bool(re.search(r"\b(intern|internship|graduate|junior|associate|entry.level|early career|new grad|fresher|student)\b", t + " " + desc))


def parse_feed(payload, company, ats, board, source_url):
    """Standard public ATS response parsing with exact-board URL validation."""
    if (company, ats, board, source_url) not in APPROVED_FEEDS:
        raise ValueError("UNREVIEWED_FEED")
    rows = payload if ats == "LEVER" else payload.get("jobs") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise ValueError("FEED_SCHEMA_INVALID")
    out, seen = [], set()
    for row in rows[:500]:
        if not isinstance(row, dict):
            continue
        if ats == "ASHBY":
            if row.get("isListed") is False:
                continue
            title, location, url = row.get("title"), row.get("location"), row.get("jobUrl")
            desc = row.get("descriptionPlain") or row.get("descriptionHtml")
        elif ats == "GREENHOUSE":
            loc = row.get("location")
            title, location, url, desc = row.get("title"), loc.get("name") if isinstance(loc, dict) else "", row.get("absolute_url"), row.get("content")
        elif ats == "LEVER":
            cat = row.get("categories") if isinstance(row.get("categories"), dict) else {}
            title, location, url = row.get("text"), cat.get("location"), row.get("hostedUrl")
            desc = row.get("descriptionPlain") or row.get("description")
        else:
            raise ValueError("UNSUPPORTED_ATS")
        title, location, desc = clean(title, 220), clean(location, 200), clean(desc, 16000)
        url = posting_url(url, ats, board)
        if not url or url in seen or not eligible_hint(title, location, desc):
            continue
        seen.add(url)
        out.append({"url": url, "company": company, "title": title, "location": location,
                    "source_url": source_url, "extraction": "official-ats:" + ats.lower(), "description": desc})
        if len(out) >= 12:
            break
    return out


def agent_read_verified(url, expected_title, timeout=12, runner=subprocess.run):
    """Use Agent Reach's declared anonymous Jina backend only, after origin preflight.

    The caller must have checked the exact employer URL, robots, direct HTTP 200 and
    extracted expected_title independently. This never substitutes for a blocked origin.
    No raw provider response, contact fields, tokens or browser credentials are retained.
    """
    title = clean(expected_title, 220)
    if not title or len(title) < 5 or not isinstance(url, str) or not url.startswith("https://"):
        return {"status": "UNAVAILABLE", "items": 0, "code": "ORIGIN_EVIDENCE_MISSING"}
    # Do not inherit provider keys, auth tokens, proxy settings or login/session secrets.
    env = {k: v for k, v in os.environ.items() if k in {"PATH", "HOME", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"}}
    kwargs = dict(capture_output=True, text=True, check=False, env=env)
    phase = "CHANNELS"
    try:
        # Cold CLI import on the free CPU instance can exceed three seconds.
        # This is one bounded manual probe, not a retry loop.
        channels = runner(["agent-reach", "channels"], timeout=15, **kwargs)
        if channels.returncode or len(channels.stdout) > 262144:
            raise ValueError("CHANNEL_CONTRACT_UNAVAILABLE")
        declared = json.loads(channels.stdout)
        supported = any(c.get("name") == "web" and any(a.get("name") == "read" and "jina" in a.get("backends", []) for a in c.get("actions", []) if isinstance(a, dict)) for c in declared.get("channels", []) if isinstance(c, dict)) if isinstance(declared, dict) else False
        if not supported:
            return {"status": "UNAVAILABLE", "items": 0, "code": "ANONYMOUS_BACKEND_NOT_DECLARED"}
        phase = "READ"
        proc = runner(["agent-reach", "web", "read", url, "--backend", "jina", "--timeout", str(timeout)], timeout=timeout + 5, **kwargs)
        if len(proc.stdout) > 262144:
            return {"status": "UNAVAILABLE", "items": 0, "code": "CLI_RESPONSE_LIMIT"}
        data = json.loads(proc.stdout)
        if not isinstance(data, dict):
            raise ValueError("INVALID_CLI_JSON")
        if proc.returncode or data.get("ok") is not True:
            err = data.get("error")
            code = err.get("code") if isinstance(err, dict) else None
            code = code if isinstance(code, str) and code in {"RATE_LIMITED", "PLATFORM_BLOCKED", "NEED_LOGIN", "BUSY", "BAD_INPUT", "UPSTREAM_BROKEN", "NEED_SETUP", "TIMEOUT", "NOT_FOUND"} else "CLI_FAILED"
            return {"status": "BLOCKED" if code in {"RATE_LIMITED", "PLATFORM_BLOCKED", "NEED_LOGIN", "BUSY"} else "UNAVAILABLE", "items": 0, "code": code or "CLI_FAILED"}
        items = data.get("items")
        if not isinstance(items, list):
            raise ValueError("INVALID_ITEMS")
        for item in items[:5]:
            if not isinstance(item, dict) or item.get("url") != url:
                continue
            body = item.get("text")
            if not isinstance(body, str) or len(body.strip()) < 40:
                continue
            if re.search(r"captcha|security verification|access denied|just a moment|sign in to continue", norm(body[:1000])):
                continue
            if norm(title) in norm(body) or norm(title) == norm(item.get("title")):
                return {"status": "OK", "items": 1, "code": "ORIGIN_TITLE_CORROBORATED", "source_url": url, "title": title}
        return {"status": "UNAVAILABLE", "items": 0, "code": "NO_CORROBORATED_PUBLIC_CONTENT"}
    except subprocess.TimeoutExpired:
        return {"status": "TIMEOUT", "items": 0, "code": "CLI_" + phase + "_TIMEOUT"}
    except FileNotFoundError:
        return {"status": "UNAVAILABLE", "items": 0, "code": "CLI_NOT_INSTALLED"}
    except (ValueError, TypeError, AttributeError):
        return {"status": "UNAVAILABLE", "items": 0, "code": "CLI_CONTRACT_INVALID"}


def model_fields_grounded(title, location, url, source_url, visible_text, allowed_links):
    """Model suggestions must be grounded in deterministic original-page evidence."""
    if not isinstance(title, str) or not isinstance(location, str) or not isinstance(url, str):
        return False
    t, loc, body = norm(title), norm(location), norm(visible_text)
    return bool(t and loc and t in body and loc in body and (url == source_url or url in allowed_links))


def reviewed_inventory(html_seeds):
    """Europe/Canada-first approved feed snapshot plus reviewed HTML seed pages."""
    feeds = [(company, ats, board, url) for company, ats, board, url in APPROVED_FEEDS]
    pages = [(company, "HTML", "", url) for company, url in html_seeds]
    return tuple(feeds + pages)


def source_candidates(source, fetch_json, fetch_html, parse_html, model_fallback):
    """One reviewed source; never switch backend after a blocked/failed origin."""
    company, kind, board, url = source
    if kind != "HTML":
        if source not in APPROVED_FEEDS:
            raise ValueError("UNREVIEWED_FEED")
        return parse_feed(fetch_json(url), company, kind, board, url)
    html = fetch_html(url)
    jobs = parse_html(html, url, company)
    if not jobs:
        jobs = model_fallback(html, url, company)
    return [job for job in jobs if eligible_hint(job.get("title"), job.get("location"), job.get("description", ""))]
