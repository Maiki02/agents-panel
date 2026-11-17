#!/usr/bin/env bash
# Pasa las cuentas de Claude Code a una config global con una carpeta por cuenta:
#   ~/.claude           config global (skills, settings, sesiones/projects, memoria, plugins), sin login
#   ~/.claude-personal  login personal (antes en ~/.claude)   → comando claude-personal
#   ~/.claude-work      login del trabajo (antes ~/.claude2)  → comando claude-work
# Cada carpeta enlaza lo compartido con ~/.claude (11-claude-cuentas.sh) y `claude` a secas queda
# como alias de claude-personal (~/.bashrc). Al final apunta las cuentas del panel a sus carpetas
# (CLI account:dir).
# Hay que correrlo sin ninguna sesión de Claude Code abierta y con el servicio del panel parado:
# mueve .credentials.json, y un proceso que lo refresque por la ruta vieja perdería el login.
# Idempotente: lo ya migrado se saltea.
# Documentado en docs/vm-setup.md (paso 19).
# Uso (en la VM, desde una shell SSH sin claude corriendo):
#   sudo systemctl stop agents-panel
#   bash scripts/vm/13-claude-global.sh
#   sudo systemctl start agents-panel
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
GLOBAL="$HOME/.claude"
PERSONAL="$HOME/.claude-personal"
WORK="$HOME/.claude-work"
OLD_WORK="$HOME/.claude2"
BASHRC="$HOME/.bashrc"

[ -d "$GLOBAL" ] || { echo "ERROR: no existe $GLOBAL" >&2; exit 1; }
if pgrep -u "$(id -u)" -x claude >/dev/null; then
  echo "ERROR: hay procesos claude corriendo (pgrep -a -x claude); cerralos antes" >&2
  exit 1
fi
if systemctl is-active --quiet agents-panel 2>/dev/null; then
  echo "ERROR: el servicio agents-panel está corriendo: sudo systemctl stop agents-panel" >&2
  exit 1
fi

# 1. Personal: the login leaves the global folder.
mkdir -p -m 700 "$PERSONAL"
if [ -f "$GLOBAL/.credentials.json" ]; then
  if [ -e "$PERSONAL/.credentials.json" ]; then
    echo "WARN: hay login en $GLOBAL y en $PERSONAL; no se toca ninguno (revisar a mano)" >&2
  else
    mv "$GLOBAL/.credentials.json" "$PERSONAL/.credentials.json"
    echo "movido: login personal → $PERSONAL/.credentials.json"
  fi
else
  echo "ya movido: login personal"
fi
if [ -f "$HOME/.claude.json" ] && [ ! -e "$PERSONAL/.claude.json" ]; then
  cp -p "$HOME/.claude.json" "$PERSONAL/.claude.json"
  echo "copiado: ~/.claude.json → $PERSONAL/.claude.json"
else
  echo "ya copiado: .claude.json personal"
fi

# 2. Work: ~/.claude2 is renamed (its links to ~/.claude are absolute and keep working).
if [ -d "$OLD_WORK" ] && [ ! -L "$OLD_WORK" ]; then
  if [ -e "$WORK" ]; then
    echo "WARN: existen $OLD_WORK y $WORK; no se mueve (revisar a mano)" >&2
  else
    mv "$OLD_WORK" "$WORK"
    echo "movido: $OLD_WORK → $WORK"
  fi
else
  echo "ya movido: cuenta del trabajo"
fi

# 3. Links to the global config and the commands claude-personal / claude-work.
bash "$SCRIPT_DIR/11-claude-cuentas.sh" "$PERSONAL"
[ -d "$WORK" ] && bash "$SCRIPT_DIR/11-claude-cuentas.sh" "$WORK"

# 4. Plain `claude` is the personal account in interactive shells.
MARK_BEGIN='# >>> claude-cuentas (agents-panel/scripts/vm/13-claude-global.sh) >>>'
MARK_END='# <<< claude-cuentas <<<'
if grep -qF "$MARK_BEGIN" "$BASHRC" 2>/dev/null; then
  echo "ya configurado: alias claude=claude-personal"
else
  printf '\n%s\nalias claude=claude-personal\n%s\n' "$MARK_BEGIN" "$MARK_END" >> "$BASHRC"
  echo "agregado a $BASHRC: alias claude=claude-personal"
fi

# 5. Panel accounts point to their folders.
cli() { (cd "$REPO/apps/api" && npx --no-install tsx --env-file-if-exists=.env src/cli.ts "$@"); }
accounts="$(cli account:list)"
legacy_id="$(printf '%s\n' "$accounts" | awk -F'\t' '$2 ~ /^\(sin carpeta/ {print $1; exit}')"
old_work_id="$(printf '%s\n' "$accounts" | awk -F'\t' -v d="$OLD_WORK" '$2 == d {print $1; exit}')"
[ -z "$legacy_id" ] && echo "ya en su carpeta: cuenta personal del panel" || cli account:dir "$legacy_id" "$PERSONAL"
if [ -n "$old_work_id" ] && [ -d "$WORK" ]; then
  cli account:dir "$old_work_id" "$WORK"
else
  echo "ya en su carpeta: cuenta del trabajo del panel"
fi
cli account:list

echo "OK. Verificar: claude-personal y claude-work (/status muestra cada cuenta); después: sudo systemctl start agents-panel"
