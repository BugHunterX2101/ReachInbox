FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 UV_TOOL_DIR=/opt/uvtools UV_TOOL_BIN_DIR=/usr/local/bin CAREEROPS_DB=/tmp/careerops.sqlite PORT=8000
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt ./
RUN pip install -r requirements.txt && pip install uv
RUN uv tool install https://github.com/Panniantong/Agent-Reach/releases/latest/download/agent-reach.zip
COPY server.py ./
RUN useradd -u 10001 -m careerops
USER careerops
EXPOSE 8000
CMD ["python","-m","server"]
