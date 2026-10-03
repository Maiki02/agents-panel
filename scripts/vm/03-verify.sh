#!/usr/bin/env bash
# Verifica que la VM puede trabajar sobre NovaGent: Kyro, backend y frontend.
# Uso (en la VM):  bash ~/03-verify.sh
set -uo pipefail

BASE="$HOME/proyectos/ventas"
LOG="$HOME/agent-panel-setup.log"
exec > >(tee -a "$LOG") 2>&1
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/go/bin:$HOME/go/bin:$PATH"
step() { echo; echo "=== $* ($(date -Is))"; }
ok=0

step "kyro doctor";        (cd "$BASE" && kyro doctor)                          || ok=1
step "go build + go test"; (cd "$BASE/be-ventas" && go build ./... && go test ./...) || ok=1
step "build client (fe)";  (cd "$BASE/fe-ventas" && /usr/bin/time -v npm run build:client 2>&1 | tail -25) || ok=1
step "Memoria y disco";    free -h; df -h /

[ $ok -eq 0 ] && echo "VERIFY OK" || echo "VERIFY CON ERRORES (ver arriba)"
