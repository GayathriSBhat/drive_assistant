#!/usr/bin/env bash
# Starts LiveKit, the API server, the voice agent and the Next.js app. Ctrl-C stops all four.
# If any one of them dies, everything stops (a half-running stack just gives confusing errors).
set -euo pipefail
cd "$(dirname "$0")"

if ! grep -qE '^(GOOGLE_API_KEY|GEMINI_API_KEY)=.+' .env; then
  echo "✗ GOOGLE_API_KEY (or GEMINI_API_KEY) is empty in .env — get a Gemini key at https://aistudio.google.com/apikey" >&2
  exit 1
fi

# The Docker stack uses the same ports — don't fight it (and never kill Docker's port forwarder).
if command -v docker >/dev/null && [ -n "$(docker compose ps -q 2>/dev/null)" ]; then
  echo "✗ The Docker stack is running (docker compose). Stop it first: docker compose down" >&2
  exit 1
fi

# Free the ports in case a previous run is still alive.
for port in 7880 8000 3000; do
  lsof -ti "tcp:$port" -sTCP:LISTEN | xargs kill 2>/dev/null || true
done
pkill -f "agent.py dev" 2>/dev/null || true
sleep 1

mkdir -p data
trap 'trap - EXIT; kill 0' EXIT INT TERM
# --dev forces debug logging, which drowns out the agent's logs; keep it in a file.
livekit-server --dev --bind 0.0.0.0 > data/livekit.log 2>&1 &
LIVEKIT=$!
uv run uvicorn server:app --host 0.0.0.0 --port 8000 --log-level warning &
API=$!
sleep 2
uv run agent.py dev --log-level info &
AGENT=$!
(cd frontend && exec npm run dev -- --port 3000) &
WEB=$!
echo; echo "  Aween → http://localhost:3000  (?demo = Dubai, ?demo=singapore = Singapore with live parking)"
echo "  LiveKit server logs → data/livekit.log"; echo

# Watch the four services (macOS bash 3.2 has no `wait -n`).
while :; do
  for svc in LIVEKIT API AGENT WEB; do
    if ! kill -0 "${!svc}" 2>/dev/null; then
      echo; echo "✗ $svc stopped — shutting everything down. (LiveKit logs: data/livekit.log)" >&2
      exit 1
    fi
  done
  sleep 2
done
