#!/usr/bin/env bash
# Actualiza Kyro en la VM: paquete global, runtime + workspace de cada proyecto con Kyro,
# symlinks de skills y chequeo final. Lo corre a mano o el panel (pantalla Versiones).
# Idempotente: si Kyro ya está en la última versión no cambia nada.
# Documentado en docs/vm-setup.md (paso 14).
# Uso (en la VM):  bash scripts/vm/08-kyro-update.sh [<raíz-de-proyecto> ...]
# Sin argumentos solo actualiza lo global. La última línea de salida es KYRO_VERSION=<x.y.z>.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Validar todas las raíces antes de tocar nada.
roots=()
for root in "$@"; do
  [ -d "$root/.agents/kyro" ] || {
    echo "ERROR: '$root' no es un directorio con .agents/kyro/; no se cambió nada" >&2
    exit 1
  }
  roots+=("$(cd "$root" && pwd)")
done

echo "== 1/4 npm i -g kyro-ai@latest"
npm i -g kyro-ai@latest

for root in "${roots[@]+"${roots[@]}"}"; do
  echo "== 2/4 kyro update --yes en $root"
  (cd "$root" && kyro update --yes)
done
[ "${#roots[@]}" -gt 0 ] || echo "== 2/4 sin raíces de proyecto: solo se actualiza lo global"

echo "== 3/4 skills de Kyro"
bash "$SCRIPT_DIR/06-kyro-skills.sh"

echo "== 4/4 kyro doctor"
kyro doctor

echo "KYRO_VERSION=$(kyro --version)"
