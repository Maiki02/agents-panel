#!/usr/bin/env bash
# Instala uv (gestor de Python de Astral) en ~/.local/bin, o lo actualiza si ya está. Lo necesitan
# proyectos como expedientes-ai (setup: `uv sync --project backend`). Sin privilegios de root; solo toca el home.
# Fuente oficial: https://astral.sh/uv/install.sh (el instalador baja el binario de releases.astral.sh
# y verifica su checksum). No modifica .bashrc/.profile (UV_NO_MODIFY_PATH): ~/.local/bin ya está en el PATH.
# Idempotente: con uv instalado solo corre `uv self update` (sin cambios si ya es la última versión).
# Documentado en docs/vm-setup.md. Uso (en la VM):  bash scripts/vm/07-uv.sh
set -euo pipefail

BIN="$HOME/.local/bin"
UV="$BIN/uv"

if [ -x "$UV" ]; then
  echo "uv ya está instalado ($("$UV" --version)): se busca una versión nueva"
  "$UV" self update
else
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  curl -fsSL --proto '=https' --tlsv1.2 https://astral.sh/uv/install.sh -o "$tmp"
  UV_NO_MODIFY_PATH=1 UV_INSTALL_DIR="$BIN" sh "$tmp"
fi

[ -x "$UV" ] || { echo "ERROR: no quedó $UV" >&2; exit 1; }
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "WARN: $BIN no está en el PATH de esta sesión; abrir una sesión nueva" >&2 ;;
esac
echo "OK $("$UV" --version) en $UV"
