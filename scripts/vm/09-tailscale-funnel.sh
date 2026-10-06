#!/usr/bin/env bash
# Instala Tailscale (repositorio oficial) y publica la web del panel con Funnel en el puerto 443.
# Idempotente: si ya está instalado, habilitado y publicado, no cambia nada.
# El login (sudo tailscale up) es manual, una sola vez, con la cuenta del usuario: sin sesión el
# script instala, habilita el servicio, avisa qué falta y sale con 0 (se vuelve a correr después).
# No usa authkeys: ningún secreto pasa por este script.
# Documentado en docs/vm-setup.md (paso 15).
# Uso (en la VM):  bash scripts/vm/09-tailscale-funnel.sh [<puerto-de-la-web>]   (por defecto 4200)
# La última línea es FUNNEL_URL=<url> cuando quedó publicado, o FUNNEL_URL= si falta el login.
set -euo pipefail

PORT="${1:-4200}"
case "$PORT" in
  '' | *[!0-9]*) echo "ERROR: el puerto '$PORT' no es un número" >&2; exit 1 ;;
esac

echo "== 1/4 Tailscale instalado"
if command -v tailscale >/dev/null 2>&1; then
  echo "ya está: $(tailscale version | head -1)"
else
  codename="$(. /etc/os-release && echo "${VERSION_CODENAME:?sin VERSION_CODENAME en /etc/os-release}")"
  repo="https://pkgs.tailscale.com/stable/ubuntu/$codename"
  curl -fsSL "$repo.noarmor.gpg" | sudo tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
  curl -fsSL "$repo.tailscale-keyring.list" | sudo tee /etc/apt/sources.list.d/tailscale.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y tailscale
fi

echo "== 2/4 tailscaled habilitado y corriendo"
sudo systemctl enable --now tailscaled

echo "== 3/4 Sesión de Tailscale"
if ! sudo tailscale status >/dev/null 2>&1; then
  echo "Falta el login (manual, una sola vez, con tu cuenta):"
  echo "  sudo tailscale up"
  echo "Abrí el link que imprime, aprobá la máquina y volvé a correr este script."
  echo "FUNNEL_URL="
  exit 0
fi

echo "== 4/4 Funnel en 443 hacia http://127.0.0.1:$PORT"
status="$(sudo tailscale funnel status 2>&1 || true)"
if echo "$status" | grep -q "proxy http://127.0.0.1:$PORT"; then
  echo "ya publicado"
else
  # --bg deja la configuración guardada en tailscaled (sobrevive a reinicios).
  sudo tailscale funnel --bg "$PORT"
  status="$(sudo tailscale funnel status 2>&1 || true)"
fi
echo "$status"
url="$(echo "$status" | grep -oE 'https://[^ ]+\.ts\.net' | head -1 || true)"
echo "FUNNEL_URL=$url"
