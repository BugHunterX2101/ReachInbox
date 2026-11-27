# Minimal CPU-only Ollama, with no exposed model port.
FROM alpine/ollama:0.40.17 AS ollama-cpu

FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    UV_TOOL_DIR=/opt/uvtools \
    UV_TOOL_BIN_DIR=/usr/local/bin \
    CAREEROPS_DB=/tmp/careerops.sqlite \
    PORT=8000 \
    OLLAMA_HOST=127.0.0.1:11434 \
    OLLAMA_BASE_URL=http://127.0.0.1:11434 \
    OLLAMA_MODELS=/opt/ollama/models \
    OLLAMA_MODEL=smollm2:135m-instruct-q4_0 \
    OLLAMA_NUM_PARALLEL=1 \
    OLLAMA_MAX_LOADED_MODELS=1 \
    OLLAMA_CONTEXT_LENGTH=512 \
    OLLAMA_KEEP_ALIVE=0 \
    ENABLE_LOCAL_SCRAPEGRAPHAI=true \
    ENABLE_SCRAPEGRAPH_AUTO=false \
    ENABLE_GROUNDED_MODEL_REPLAY=true \
    ENABLE_AGENT_REACH_PUBLIC=true
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git libstdc++6 libgomp1 && rm -rf /var/lib/apt/lists/*
COPY --from=ollama-cpu /usr/bin/ollama /usr/bin/ollama
COPY --from=ollama-cpu /usr/lib/ollama /usr/lib/ollama
WORKDIR /app
COPY requirements.txt ./
RUN pip install -r requirements.txt && pip install uv
# v1.76.0's legacy ChatOllama import is fixed upstream (PR #1076).
# Backport only that import on the installed Python 3.11-compatible release.
RUN python -c 'import importlib.metadata as m, importlib.util as u; from pathlib import Path; assert m.version("scrapegraphai")=="1.76.0"; root=Path(u.find_spec("scrapegraphai").origin).parent; files=[p for p in root.rglob("*.py") if "from langchain_community.chat_models import ChatOllama" in p.read_text()]; assert files; [(p.write_text(p.read_text().replace("from langchain_community.chat_models import ChatOllama","from langchain_ollama import ChatOllama"))) for p in files]; print("Patched upstream ChatOllama import:",len(files))'
RUN python -c 'from scrapegraphai.graphs import SmartScraperGraph; from langchain_ollama import ChatOllama; print("SCRAPEGRAPHAI_IMPORT_OK")'
RUN uv tool install https://github.com/Panniantong/Agent-Reach/releases/download/v1.6.1/agent-reach.zip
RUN mkdir -p /opt/ollama/models && \
    (ollama serve >/tmp/ollama-build.log 2>&1 & echo $! >/tmp/ollama-build.pid) && \
    (for i in $(seq 1 40); do curl -fsS --max-time 1 http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break || sleep 1; done) && \
    ollama pull smollm2:135m-instruct-q4_0 && \
    kill $(cat /tmp/ollama-build.pid) && \
    chmod -R a+rX /opt/ollama/models
COPY bridge_adapters.py ./bridge_adapters.py
COPY server.py ./server.py
COPY model_probe.py ./model_probe.py
COPY test_bridge.py ./test_bridge.py
RUN python -m py_compile server.py bridge_adapters.py model_probe.py && python -m unittest -v test_bridge
COPY start.sh ./start.sh
RUN sh -n /app/start.sh
RUN useradd -u 10001 -m careerops && \
    chown -R careerops:careerops /opt/ollama/models && \
    chmod +x /app/start.sh
USER careerops
EXPOSE 8000
CMD ["sh", "/app/start.sh"]
