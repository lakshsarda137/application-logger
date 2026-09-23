#!/usr/bin/env bash
# Starts the server on 127.0.0.1:8765 (or whatever config.local.json says).
# First run creates config.local.json with a fresh API token.
set -euo pipefail
cd "$(dirname "$0")/.."

PY=.venv/bin/python
[ -x "$PY" ] || PY=python3

read -r HOST PORT < <("$PY" -c 'from server.config import load_config; c = load_config(); print(c.host, c.port)')
echo "Application Logger: http://$HOST:$PORT  (token in config.local.json)"
exec "$PY" -m uvicorn --factory server.main:create_app --host "$HOST" --port "$PORT" "$@"
