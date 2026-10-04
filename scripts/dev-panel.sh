#!/usr/bin/env bash
# Restarts the panel in development: kills panel-api / panel-web tmux sessions if any,
# rebuilds packages/shared and starts the API and the web, each in its own tmux session.
# Usage: bash scripts/dev-panel.sh        (from anywhere)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

for session in panel-api panel-web; do
  tmux kill-session -t "$session" 2>/dev/null || true
done

npm run build -w @agents-panel/shared

tmux new -d -s panel-api "cd '$ROOT' && npm run dev -w @agents-panel/api"
tmux new -d -s panel-web "cd '$ROOT' && npm run start -w @agents-panel/web"

echo "Waiting for the API on 127.0.0.1:3000..."
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3000/api/health; then
    echo
    echo "API up. Web: http://localhost:4200 (once ng serve finishes building; see: tmux attach -t panel-web)."
    echo "Logs: tmux attach -t panel-api | tmux attach -t panel-web (detach with Ctrl+b d)."
    exit 0
  fi
  sleep 1
done

echo "The API did not answer in 30 s. Check: tmux attach -t panel-api" >&2
exit 1
