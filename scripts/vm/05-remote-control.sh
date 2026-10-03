#!/usr/bin/env bash
# Deja un server de Claude Remote Control corriendo por proyecto, cada uno en su sesión de tmux,
# para usar Claude Code de la VM desde claude.ai/code (web). Idempotente.
# Uso (en la VM):
#   bash 05-remote-control.sh            # levanta lo que falte
#   bash 05-remote-control.sh --install  # además instala el servicio systemd (arranca solo al reiniciar la VM)
#   bash 05-remote-control.sh --stop     # baja todo
# Documentado en docs/vm-setup.md.
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/go/bin:$HOME/go/bin:$PATH"

# nombre de sesión tmux | carpeta | modo spawn
# ventas usa same-dir: fe-ventas y be-ventas son repos aparte y un git worktree de la raíz no los trae.
PROJECTS=(
  "rc-ventas|$HOME/proyectos/ventas|same-dir"
  "rc-agents-panel|$HOME/proyectos/agents-panel|worktree"
)

if [ "${1:-}" = "--stop" ]; then
  for p in "${PROJECTS[@]}"; do IFS='|' read -r name _ _ <<<"$p"; tmux kill-session -t "$name" 2>/dev/null && echo "$name detenido" || true; done
  exit 0
fi

if [ "${1:-}" = "--install" ]; then
  SCRIPT="$(readlink -f "$0")"
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/claude-remote-control.service" <<EOUNIT
[Unit]
Description=Claude Remote Control (un server por proyecto en tmux)
After=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash $SCRIPT
ExecStop=/bin/bash $SCRIPT --stop

[Install]
WantedBy=default.target
EOUNIT
  sudo loginctl enable-linger "$USER"   # servicios de usuario corren sin sesión SSH abierta
  systemctl --user daemon-reload
  systemctl --user enable claude-remote-control.service
  echo "Servicio instalado: claude-remote-control.service"
fi

for p in "${PROJECTS[@]}"; do
  IFS='|' read -r name dir spawn <<<"$p"
  if [ ! -d "$dir" ]; then echo "SALTEO $name: no existe $dir"; continue; fi
  if tmux has-session -t "$name" 2>/dev/null; then echo "$name ya está corriendo"; continue; fi
  # Marca la carpeta como confiable (si no, el server queda esperando "Trust …? [y/N]" dentro de tmux).
  CJ="$HOME/.claude.json"; [ -f "$CJ" ] || echo '{}' > "$CJ"
  jq --arg d "$dir" '.projects[$d].hasTrustDialogAccepted = true' "$CJ" > "$CJ.tmp" && mv "$CJ.tmp" "$CJ"
  tmux new-session -d -s "$name" -c "$dir" \
    "claude remote-control --permission-mode auto --spawn $spawn --remote-control-session-name-prefix $name; echo 'Remote Control terminó. Enter para cerrar.'; read"
  echo "$name iniciado en $dir (spawn=$spawn)"
done
echo
echo "Abrí claude.ai/code en el navegador: las sesiones aparecen como rc-ventas-… y rc-agents-panel-…"
echo "Ver un server: tmux attach -t <nombre>   (salir sin cortarlo: Ctrl+b y después d)"
