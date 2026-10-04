#!/usr/bin/env bash
# Instala la base de la VM: paquetes, swap, Node, Go, gh, Claude Code y Kyro.
# Idempotente: se puede correr varias veces. Documentado en docs/vm-setup.md.
# Uso (en la VM, usuario ubuntu):  bash ~/01-base.sh
set -euo pipefail

NODE_MAJOR=24
GO_SERIES=1.25   # la de `go` en be-ventas/go.mod
SWAP_SIZE=8G
LOG="$HOME/agent-panel-setup.log"
exec > >(tee -a "$LOG") 2>&1

export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/go/bin:$HOME/go/bin:$PATH"
step() { echo; echo "=== $* ($(date -Is))"; }

step "1. Paquetes base"
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  git tmux build-essential curl ca-certificates gnupg jq unzip xz-utils ripgrep sqlite3 time

step "2. Swap de $SWAP_SIZE"
if ! swapon --show | grep -q '/swapfile'; then
  sudo fallocate -l "$SWAP_SIZE" /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-agent-panel.conf >/dev/null
sudo sysctl --system >/dev/null

step "3. Node $NODE_MAJOR (binario oficial en /opt/node)"
if ! node -v 2>/dev/null | grep -q "^v$NODE_MAJOR\."; then
  NODE_V=$(curl -fsSL https://nodejs.org/dist/index.json | jq -r "[.[] | select(.version | startswith(\"v$NODE_MAJOR.\"))][0].version")
  curl -fsSL "https://nodejs.org/dist/$NODE_V/node-$NODE_V-linux-arm64.tar.xz" -o /tmp/node.tar.xz
  sudo rm -rf /opt/node && sudo mkdir -p /opt/node
  sudo tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
  for b in node npm npx corepack; do sudo ln -sf "/opt/node/bin/$b" "/usr/local/bin/$b"; done
fi
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"

step "4. Go $GO_SERIES.x (binario oficial en /usr/local/go)"
# Fijado a la serie de go.mod de be-ventas: con go1.27, `go vet` (corre dentro de `go test`)
# trae chequeos nuevos que fallan en código que en la PC/CI pasa. Misma versión en todos lados.
GO_V=$(curl -fsSL 'https://go.dev/dl/?mode=json&include=all' | jq -r "[.[] | select(.stable and (.version | startswith(\"go$GO_SERIES.\")))][0].version")
if [ "$(go version 2>/dev/null | awk '{print $3}')" != "$GO_V" ]; then
  curl -fsSL "https://go.dev/dl/$GO_V.linux-arm64.tar.gz" -o /tmp/go.tgz
  sudo rm -rf /usr/local/go
  sudo tar -C /usr/local -xzf /tmp/go.tgz
fi

step "5. GitHub CLI (repo apt oficial)"
if ! command -v gh >/dev/null; then
  sudo mkdir -p -m 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
  sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y gh
fi

step "6. Claude Code (instalador nativo, ~/.local/bin/claude)"
if ! command -v claude >/dev/null; then
  curl -fsSL https://claude.ai/install.sh | bash
fi

step "7. Kyro (npm global, sin sudo)"
npm install -g kyro-ai@latest
# Las skills y el runtime se instalan por workspace (02-novagent.sh / docs/vm-setup.md paso 7),
# seguido de 06-kyro-skills.sh para que Claude Code las vea.

step "8. PATH permanente y git"
for f in "$HOME/.profile" "$HOME/.bashrc"; do
  if ! grep -q '>>> agent-panel >>>' "$f"; then
    cat >> "$f" <<'EOPATH'
# >>> agent-panel >>>
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/go/bin:$HOME/go/bin:$PATH"
# <<< agent-panel <<<
EOPATH
  fi
done
git config --global user.name "Maiki02"
git config --global user.email "miqueasdavidgentile@gmail.com"
git config --global init.defaultBranch main
git config --global pull.rebase false

step "Versiones"
echo "node   $(node -v)"
echo "npm    $(npm -v)"
echo "go     $(go version | awk '{print $3}')"
echo "gh     $(gh --version | head -1)"
echo "claude $(claude --version 2>/dev/null || echo 'no encontrado')"
echo "kyro   $(kyro --version 2>/dev/null || echo 'no encontrado')"
echo "swap   $(swapon --show --noheadings | awk '{print $1, $3}')"
echo; echo "OK base. Log: $LOG"
