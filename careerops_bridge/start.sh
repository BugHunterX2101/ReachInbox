#!/bin/sh
set -eu
# Loopback-only Ollama. The only public listener is the read-only CareerOps bridge.
ollama serve > /tmp/careerops-ollama.log 2>&1 &
exec python -m server
