#!/usr/bin/env bash
# Hace visibles las skills de Kyro para Claude Code. Kyro 6 (adapter "standard") las deja en
# ~/.agents/skills/, pero Claude Code solo lee ~/.claude/skills/ y <proyecto>/.claude/skills/.
# Idempotente: crea (o refresca) un symlink por skill kyro-*, sin tocar otras skills.
# Documentado en docs/vm-setup.md. Uso (en la VM):  bash scripts/vm/06-kyro-skills.sh
set -euo pipefail

SRC="$HOME/.agents/skills"
DST="$HOME/.claude/skills"

[ -d "$SRC" ] || { echo "ERROR: no existe $SRC. Correr antes: kyro install --scope workspace --yes" >&2; exit 1; }
mkdir -p "$DST"

count=0
for dir in "$SRC"/kyro-*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  # Si ya hay una copia real (no symlink), no se pisa: se avisa.
  if [ -e "$DST/$name" ] && [ ! -L "$DST/$name" ]; then
    echo "WARN: $DST/$name existe y no es un symlink; se deja como está" >&2
    continue
  fi
  ln -sfn "${dir%/}" "$DST/$name"
  count=$((count + 1))
done

echo "OK $count skills de Kyro enlazadas en $DST"
ls -l "$DST" | grep kyro- || true
