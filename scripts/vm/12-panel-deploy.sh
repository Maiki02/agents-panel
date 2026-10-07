#!/usr/bin/env bash
# Despliega agents-panel en la VM: trae origin/main (solo fast-forward), instala dependencias si
# cambió package-lock.json y compila (shared, api y web). NO reinicia el servicio: eso lo hace el
# panel saliendo con error (systemd lo relanza, Restart=on-failure) o, a mano,
# 'bash scripts/vm/10-panel-service.sh --restart'.
# Lo corre el botón Desplegar de la pantalla Versiones, o a mano.
# Idempotente: con main al día y el servicio corriendo ese commit no compila ni cambia nada
# (DEPLOY_RESTART=no). <commit-corriendo> es el commit con el que arrancó el servicio (lo pasa el
# panel): si el disco ya está en origin/main pero el servicio corre otro commit (alguien hizo
# 'git pull' sin reiniciar), igual compila y pide el reinicio.
# Se niega (sin tocar nada) si el repo no está en main, tiene cambios locales o commits que
# origin/main no tiene. Si el build falla, vuelve al commit anterior y lo recompila.
# Documentado en docs/vm-setup.md (paso 18).
# Uso (en la VM):  bash scripts/vm/12-panel-deploy.sh [<repo> [<commit-corriendo>]]
# Las últimas líneas son DEPLOY_FROM=<sha>, DEPLOY_TO=<sha> y DEPLOY_RESTART=yes|no.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${1:-$SCRIPT_DIR/../..}" && pwd)"
RUNNING="${2:-}"
BRANCH=main

cd "$REPO"

current="$(git rev-parse --abbrev-ref HEAD)"
if [ "$current" != "$BRANCH" ]; then
  echo "ERROR: $REPO está en '$current', no en $BRANCH; no se cambió nada" >&2
  exit 1
fi
dirty="$(git status --porcelain)"
if [ -n "$dirty" ]; then
  echo "ERROR: $REPO tiene cambios locales; commiteá o descartá antes de desplegar:" >&2
  echo "$dirty" | head -10 | sed 's/^/   /' >&2
  exit 1
fi

echo "== 1/3 git fetch origin $BRANCH"
git fetch --quiet origin "$BRANCH"
before="$(git rev-parse --short HEAD)"
target="$(git rev-parse --short "origin/$BRANCH")"
# What the service runs; without it, what the disk has.
from="$before"
if [ -n "$RUNNING" ]; then
  from="$(git rev-parse --short "$RUNNING^{commit}" 2>/dev/null || echo "$RUNNING")"
fi

finish() {
  echo "DEPLOY_FROM=$1"
  echo "DEPLOY_TO=$2"
  echo "DEPLOY_RESTART=$3"
}

if [ "$from" = "$target" ] && [ "$before" = "$target" ]; then
  echo "== $BRANCH ya está al día ($from): no hay nada que desplegar"
  finish "$from" "$from" no
  exit 0
fi
if ! git merge-base --is-ancestor HEAD "origin/$BRANCH"; then
  echo "ERROR: $BRANCH local tiene commits que origin/$BRANCH no tiene; no se cambió nada" >&2
  exit 1
fi

if [ "$before" = "$target" ]; then
  echo "== 2/3 el disco ya está en $target pero el servicio corre $from: se compila igual"
else
  echo "== 2/3 git merge --ff-only origin/$BRANCH ($before → $target)"
  git merge --ff-only --quiet "origin/$BRANCH"
fi
git log --oneline "$from..HEAD" 2>/dev/null | head -20 | sed 's/^/   /' || true

# A commit the clone does not know (odd) counts as a changed lock: npm ci is the safe side.
lock_changed=no
git diff --quiet "$from" HEAD -- package-lock.json 2>/dev/null || lock_changed=yes

build() {
  if [ "$lock_changed" = yes ]; then
    echo "   package-lock.json cambió: npm ci"
    npm ci --no-audit --no-fund
  fi
  npm run build
}

echo "== 3/3 build"
if ! build; then
  echo "ERROR: el build de $target falló; se vuelve a $before y se recompila" >&2
  # The tree was clean before the merge: going back loses nothing.
  git reset --hard --quiet "$before"
  build || echo "ERROR: el build de $before también falló; el servicio sigue con lo que tiene cargado" >&2
  finish "$from" "$from" no
  exit 1
fi

finish "$from" "$target" yes
