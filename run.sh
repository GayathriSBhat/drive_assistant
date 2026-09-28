#!/usr/bin/env bash
# Starts the local LiveKit server, the web/API server and the voice agent. Ctrl-C stops all three.
set -euo pipefail
cd "$(dirname "$0")"

if ! grep -qE '^(GOOGLE_API_KEY|GEMINI_API_KEY)=.+' .env; then
  echo "✗ GOOGLE_API_KEY (or GEMINI_API_KEY) is empty in .env — get a Gemini key at https://aistudio.google.com/apikey" >&2
  exit 1
fi

# Free the ports in case a previous run is still alive.
for port in 7880 8000; do
  lsof -ti "tcp:$port" -sTCP:LISTEN | xargs kill 2>/dev/null || true
done
pkill -f "agent.py dev" 2>/dev/null || true
sleep 1

mkdir -p data
trap 'kill 0' EXIT
# --dev forces debug logging, which drowns out the agent's logs; keep it in a file.
livekit-server --dev --bind 0.0.0.0 > data/livekit.log 2>&1 &
uv run uvicorn server:app --host 0.0.0.0 --port 8000 --log-level warning &
sleep 2
uv run agent.py dev --log-level info &
echo; echo "  KenDrive → http://localhost:8000  (add ?demo to force the Dubai demo location)"
echo "  LiveKit server logs → data/livekit.log"; echo
wait
