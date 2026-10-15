#!/usr/bin/env bash
# GIT_ASKPASS helper of the panel: git calls it with the prompt as $1 and reads the answer from
# stdout. The user and the token come from the environment of the git process (PANEL_GIT_USERNAME /
# PANEL_GIT_TOKEN), so they never reach argv, the remote URL or .git/config.
set -euo pipefail

case "${1:-}" in
  Username*)
    value="${PANEL_GIT_USERNAME:-}"
    ;;
  Password*)
    value="${PANEL_GIT_TOKEN:-}"
    ;;
  *)
    value=""
    ;;
esac

if [ -n "$value" ]; then
  printf '%s\n' "$value"
fi
