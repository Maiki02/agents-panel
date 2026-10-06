#!/usr/bin/env bash
# Instala el panel como servicio systemd (agents-panel.service): compila (npm ci + npm run build),
# instala o actualiza la unidad, y la habilita y arranca. La API sirve la web compilada en
# 127.0.0.1:3000 y Funnel publica ese puerto (09-tailscale-funnel.sh).
# Idempotente: sin cambios en la unidad y con el servicio activo, no reinicia nada.
# Documentado en docs/vm-setup.md (paso 16).
# Uso (en la VM, con tu usuario; pide sudo):
#   bash scripts/vm/10-panel-service.sh              primera vez o ajustes de la unidad
#   bash scripts/vm/10-panel-service.sh --restart    tras un git pull: recompila y reinicia
# Variables: PANEL_SKIP_BUILD=1 saltea npm ci + build; UNIT_DIR cambia dónde se instala la unidad.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"
UNIT="$UNIT_DIR/agents-panel.service"
PORT=3000
RESTART=0
for arg in "$@"; do
  case "$arg" in
    --restart) RESTART=1 ;;
    *) echo "ERROR: argumento desconocido '$arg'" >&2; exit 1 ;;
  esac
done

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "ERROR: no hay node en el PATH" >&2; exit 1; }
[ -f "$ROOT/apps/api/.env" ] || { echo "ERROR: falta apps/api/.env (ver docs/panel-desarrollo.md)" >&2; exit 1; }

echo "== 1/4 Compilación (shared, api, web)"
if [ "${PANEL_SKIP_BUILD:-0}" = "1" ]; then
  echo "salteada (PANEL_SKIP_BUILD=1)"
else
  (cd "$ROOT" && npm ci && npm run build)
fi
[ -f "$ROOT/apps/api/dist/main.js" ] || { echo "ERROR: falta apps/api/dist/main.js" >&2; exit 1; }
[ -f "$ROOT/apps/web/dist/web/browser/index.html" ] || { echo "ERROR: falta el build de la web" >&2; exit 1; }

echo "== 2/4 Unidad $UNIT"
rendered="$(mktemp)"
trap 'rm -f "$rendered"' EXIT
sed -e "s|@REPO@|$ROOT|g" -e "s|@NODE@|$NODE|g" -e "s|@HOME@|$HOME|g" \
  "$ROOT/scripts/vm/agents-panel.service" > "$rendered"
changed=0
if [ -f "$UNIT" ] && cmp -s "$rendered" "$UNIT"; then
  echo "sin cambios"
else
  # El puerto tiene que estar libre: un tsx watch o un ng serve de desarrollo lo ocupa.
  if ! systemctl is-active --quiet agents-panel && ss -ltn "sport = :$PORT" 2>/dev/null | grep -q ":$PORT"; then
    echo "ERROR: el puerto $PORT está ocupado (¿tsx watch de desarrollo?). Paralo y volvé a correr." >&2
    exit 1
  fi
  sudo install -m 644 "$rendered" "$UNIT"
  sudo systemctl daemon-reload
  changed=1
  echo "instalada"
fi

echo "== 3/4 Habilitado"
if systemctl is-enabled --quiet agents-panel 2>/dev/null; then
  echo "ya habilitado"
else
  sudo systemctl enable agents-panel
fi

echo "== 4/4 Arranque"
if [ "$changed" = 1 ] || [ "$RESTART" = 1 ] || ! systemctl is-active --quiet agents-panel; then
  if systemctl is-active --quiet agents-panel; then
    sudo systemctl restart agents-panel
  else
    if ss -ltn "sport = :$PORT" 2>/dev/null | grep -q ":$PORT"; then
      echo "ERROR: el puerto $PORT está ocupado (¿tsx watch de desarrollo?). Paralo y volvé a correr." >&2
      exit 1
    fi
    sudo systemctl start agents-panel
  fi
  echo "arrancado"
else
  echo "activo, sin cambios"
fi
echo "Siguiente: bash scripts/vm/09-tailscale-funnel.sh  (publica el puerto $PORT)"
