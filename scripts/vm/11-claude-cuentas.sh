#!/usr/bin/env bash
# Enlaza el directorio de config de una cuenta extra de Claude Code (CLAUDE_CONFIG_DIR, por defecto
# ~/.claude2) con ~/.claude, que es la fuente de la verdad: settings, skills, agentes, plugins,
# historial y sesiones (projects/) se comparten; el login queda separado por cuenta.
# Compartir projects/ es lo que permite retomar (resume) con una cuenta una sesión empezada con otra.
# Idempotente: lo ya enlazado se saltea. Lo que existía en la cuenta extra se mezcla en ~/.claude
# (sin pisar nada: un conflicto queda como <nombre>.cuenta-extra.<fecha>) antes de enlazar.
# Documentado en docs/vm-setup.md (paso 17).
# Uso (en la VM):  bash scripts/vm/11-claude-cuentas.sh [directorio]   (defecto: ~/.claude2)
set -euo pipefail

SRC="${CLAUDE_SOURCE_DIR:-$HOME/.claude}"
DST="${1:-$HOME/.claude2}"
STAMP="$(date +%Y%m%d%H%M%S)"

# Compartido. Queda por cuenta: .credentials.json, .claude.json (oauthAccount), policy-limits*,
# remote-settings.json, cache, backups, sessions, session-env, shell-snapshots.
SHARED_DIRS=(projects skills agents commands plugins file-history todos)
SHARED_FILES=(settings.json history.jsonl CLAUDE.md)

[ -d "$SRC" ] || { echo "ERROR: no existe $SRC" >&2; exit 1; }
[ -d "$DST" ] || { echo "ERROR: no existe $DST. Antes: CLAUDE_CONFIG_DIR=$DST claude (login)" >&2; exit 1; }
[ "$(cd "$SRC" && pwd -P)" != "$(cd "$DST" && pwd -P)" ] || { echo "ERROR: $DST es $SRC" >&2; exit 1; }

# Moves every entry of $1 into $2 without overwriting; directories present on both sides recurse.
merge_dir() {
  local from="$1" to="$2" entry name
  mkdir -p "$to"
  for entry in "$from"/* "$from"/.[!.]*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name="$(basename "$entry")"
    if [ ! -e "$to/$name" ] && [ ! -L "$to/$name" ]; then
      mv "$entry" "$to/$name"
    elif [ -d "$entry" ] && [ ! -L "$entry" ] && [ -d "$to/$name" ]; then
      merge_dir "$entry" "$to/$name"
    elif [ -f "$entry" ] && cmp -s "$entry" "$to/$name"; then
      rm "$entry"
    else
      echo "WARN: $to/$name ya existe; el de la cuenta extra queda como $name.cuenta-extra.$STAMP" >&2
      mv "$entry" "$to/$name.cuenta-extra.$STAMP"
    fi
  done
  rmdir "$from" 2>/dev/null || echo "WARN: quedó contenido en $from" >&2
}

link() {
  local name="$1" kind="$2" target="$SRC/$1" here="$DST/$1"
  if [ -L "$here" ] && [ "$(readlink "$here")" = "$target" ]; then
    echo "ya enlazado: $name"
    return
  fi
  if [ "$kind" = dir ]; then mkdir -p "$target"; fi
  if [ -L "$here" ]; then
    ln -sfn "$target" "$here"
  elif [ -e "$here" ]; then
    # Primero se aparta y se enlaza (una sesión abierta sigue escribiendo por la ruta), después se mezcla.
    local aside="$here.mezclando.$STAMP"
    mv "$here" "$aside"
    ln -s "$target" "$here"
    if [ "$name" = plugins ]; then
      # Solo descargas (marketplaces, caché): la copia de ~/.claude alcanza y se vuelve a bajar sola.
      rm -rf "$aside"
    elif [ "$kind" = dir ]; then
      merge_dir "$aside" "$target"
    elif [ "$name" = history.jsonl ]; then
      cat "$aside" >> "$target" && rm "$aside"
    elif [ ! -e "$target" ]; then
      mv "$aside" "$target"
    elif cmp -s "$aside" "$target"; then
      rm "$aside"
    else
      mv "$aside" "$here.cuenta-extra.$STAMP"
      echo "WARN: $name difería de $target; la copia de la cuenta extra quedó en $here.cuenta-extra.$STAMP" >&2
    fi
  else
    [ "$kind" = dir ] || [ -e "$target" ] || { echo "sin origen: $name (se saltea)"; return; }
    ln -s "$target" "$here"
  fi
  echo "enlazado: $name"
}

for d in "${SHARED_DIRS[@]}"; do link "$d" dir; done
for f in "${SHARED_FILES[@]}"; do link "$f" file; done

echo "OK $DST comparte config con $SRC (login propio en $DST/.credentials.json)"
