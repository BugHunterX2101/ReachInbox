"""One-shot local ScrapeGraphAI + Ollama inference test. No network providers or customer data."""
import json
import os
import sys
from scrapegraphai.graphs import SmartScraperGraph

BASE = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
MODEL = os.environ.get("OLLAMA_MODEL", "smollm2:135m-instruct-q4_0")
if BASE not in ("http://127.0.0.1:11434", "http://localhost:11434"):
    raise SystemExit("LOCAL_OLLAMA_ONLY")

PAGE = """<html><body><main><h1>Graduate Software Engineer</h1>
<p>Employer: Example Robotics</p><p>Location: London, United Kingdom</p>
</main></body></html>"""

try:
    graph = SmartScraperGraph(
        prompt="Extract the job title from this HTML. Return only JSON with key title.",
        source=PAGE,
        config={
            "llm": {
                "model": "ollama/" + MODEL,
                "base_url": BASE,
                "temperature": 0,
                "format": "json",
                "num_ctx": 512,
            },
            "verbose": False,
            "headless": True,
        },
    )
    result = graph.run()
    title = result.get("title", "") if isinstance(result, dict) else ""
    passed = isinstance(title, str) and title.strip().lower() == "graduate software engineer"
    print(json.dumps({
        "status": "PASSED" if passed else "UNRELIABLE_OUTPUT",
        "used": "ScrapeGraphAI SmartScraperGraph + local Ollama",
        "model": MODEL,
        "verified_title": passed,
    }))
    sys.exit(0 if passed else 2)
except Exception as exc:
    print(json.dumps({"status": "FAILED", "error_type": type(exc).__name__}))
    sys.exit(1)
