#!/usr/bin/env bash
# Clona NovaGent (raíz) + fe-ventas + be-ventas y deja todo listo para trabajar.
# Requiere: 01-base.sh corrido y `gh auth login` hecho. Idempotente.
# Uso (en la VM):  bash ~/02-novagent.sh
set -euo pipefail

BASE="$HOME/proyectos/ventas"
LOG="$HOME/agent-panel-setup.log"
exec > >(tee -a "$LOG") 2>&1
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/go/bin:$HOME/go/bin:$PATH"
step() { echo; echo "=== $* ($(date -Is))"; }

step "1. Credenciales de git vía gh"
gh auth status
gh auth setup-git

step "2. Clonar repos"
mkdir -p "$HOME/proyectos"
# --filter=blob:none: clon parcial; be-ventas pesa ~590 MB de historial (binarios viejos).
# Baja los archivos de cada commit recién cuando se necesitan. --progress: muestra avance aunque la salida vaya al log.
[ -d "$BASE/.git" ] || git clone --progress --filter=blob:none https://github.com/Maiki02/NovaGent.git "$BASE"
for r in fe-ventas be-ventas; do
  [ -d "$BASE/$r/.git" ] || git clone --progress --filter=blob:none https://github.com/Maiki02/$r.git "$BASE/$r"
  git -C "$BASE/$r" checkout dev
  git -C "$BASE/$r" pull --no-rebase origin dev
done

step "3. Dependencias"
(cd "$BASE/be-ventas" && go mod download)
(cd "$BASE/fe-ventas" && npm ci)

step "4. Kyro en el workspace (crea local.json de esta máquina)"
(cd "$BASE" && npx --yes kyro-ai@latest install --init-workspace --yes || echo "WARN: revisar kyro install")
bash "$(dirname "$0")/06-kyro-skills.sh" || echo "WARN: 06-kyro-skills.sh falló"

echo; echo "OK NovaGent en $BASE"
