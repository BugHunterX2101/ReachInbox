#!/bin/sh
set -eu
# Only this existing local CPU model is authorized; never send inference off-host.
# Explicitly initialize the runtime even if obsolete Render env flags override Docker defaults.
export HOME=/home/careerops
export OLLAMA_HOST=127.0.0.1:11434
export OLLAMA_BASE_URL=http://127.0.0.1:11434
export OLLAMA_MODELS=/opt/ollama/models
export OLLAMA_MODEL=smollm2:135m-instruct-q4_0
export OLLAMA_NO_CLOUD=1
export OLLAMA_NUM_PARALLEL=1
export OLLAMA_MAX_LOADED_MODELS=1
export OLLAMA_CONTEXT_LENGTH=512
export OLLAMA_KEEP_ALIVE=0
export ENABLE_LOCAL_SCRAPEGRAPHAI=true
export ENABLE_AGENT_REACH_PUBLIC=true
export ENABLE_SCRAPEGRAPH_AUTO=false
export ENABLE_GROUNDED_MODEL_REPLAY=true
# No bridge secret or other credentials inherited by the local model daemon.
env -i PATH="$PATH" HOME="$HOME" OLLAMA_HOST="$OLLAMA_HOST" OLLAMA_MODELS="$OLLAMA_MODELS" \
    OLLAMA_NO_CLOUD=1 OLLAMA_NUM_PARALLEL=1 OLLAMA_MAX_LOADED_MODELS=1 OLLAMA_CONTEXT_LENGTH=512 \
    OLLAMA_KEEP_ALIVE=0 OMP_NUM_THREADS=1 ollama serve >/tmp/careerops-ollama.log 2>&1 &
pid=$!
status=STARTUP_TIMEOUT
for i in 1 2 3 4 5 6 7 8; do
    if ! kill -0 "$pid" 2>/dev/null; then
        status=DAEMON_EXITED
        break
    fi
    if curl --noproxy '*' -fsS --max-time 1 http://127.0.0.1:11434/api/tags >/tmp/careerops-model-tags.json 2>/dev/null; then
        if python -c 'import json,os; data=json.load(open("/tmp/careerops-model-tags.json")); assert any(x.get("name")==os.environ["OLLAMA_MODEL"] or x.get("model")==os.environ["OLLAMA_MODEL"] for x in data.get("models",[]) if isinstance(x,dict))' 2>/dev/null; then
            status=MODEL_LISTED
        else
            status=MODEL_NOT_LISTED
        fi
        break
    fi
    sleep 1
done
# Log fixed diagnostic codes only; never dump environment, raw daemon logs or tokens.
if [ "$status" = DAEMON_EXITED ]; then
    if grep -qi 'permission denied' /tmp/careerops-ollama.log; then status=DAEMON_PERMISSION_DENIED
    elif grep -qi 'address already in use' /tmp/careerops-ollama.log; then status=DAEMON_PORT_CONFLICT
    elif grep -Eqi 'error while loading shared libraries|not found' /tmp/careerops-ollama.log; then status=DAEMON_BINARY_OR_LIBRARY
    elif grep -Eqi 'out of memory|cannot allocate memory' /tmp/careerops-ollama.log; then status=DAEMON_MEMORY_ERROR
    fi
fi
printf '{"event":"ollama_startup","status":"%s","local_only":true}\n' "$status"
rm -f /tmp/careerops-model-tags.json
exec python -m server
