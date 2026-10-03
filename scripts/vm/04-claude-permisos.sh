#!/usr/bin/env bash
# Permisos de Claude Code en la VM: deja trabajar solo (sin pedir permiso a cada paso)
# en lo que el flujo Kyro necesita, y bloquea lo peligroso. Idempotente: hace merge con
# el ~/.claude/settings.json que exista. Documentado en docs/vm-setup.md.
# Uso (en la VM):  bash ~/04-claude-permisos.sh
set -euo pipefail

F="$HOME/.claude/settings.json"
mkdir -p "$HOME/.claude"
[ -f "$F" ] || echo '{}' > "$F"
cp "$F" "$F.bak.$(date +%Y%m%d%H%M%S)"

jq '.permissions.defaultMode = "acceptEdits"
  | .permissions.additionalDirectories = ((.permissions.additionalDirectories // []) + [
      "~/.agents", "~/.claude", "~/proyectos", "/tmp"
    ] | unique)
  | .permissions.allow = ((.permissions.allow // []) + [
      "Read", "Edit", "Write", "Glob", "Grep",
      "Bash(git:*)", "Bash(gh:*)", "Bash(go:*)", "Bash(gofmt:*)",
      "Bash(npm:*)", "Bash(npx:*)", "Bash(node:*)", "Bash(kyro:*)",
      "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)",
      "Bash(rg:*)", "Bash(grep:*)", "Bash(find:*)", "Bash(sed:*)", "Bash(jq:*)",
      "Bash(mkdir:*)", "Bash(cp:*)", "Bash(mv:*)", "Bash(touch:*)", "Bash(diff:*)",
      "Bash(sort:*)", "Bash(uniq:*)", "Bash(echo:*)", "Bash(pwd)", "Bash(cd:*)",
      "Bash(test:*)", "Bash(tr:*)", "Bash(cut:*)", "Bash(xargs:*)", "Bash(env:*)", "Bash(which:*)",
      "Bash(git push -u origin feature-:*)", "Bash(git push origin feature-:*)",
      "Bash(git push -u origin feature/:*)", "Bash(git push origin feature/:*)", "Bash(git push origin main)",
      "Bash(gh pr create:*)", "Bash(gh pr list:*)", "Bash(gh pr view:*)", "Bash(gh pr checks:*)",
      "Bash(gh pr edit:*)", "Bash(gh auth status:*)", "Bash(gh repo view:*)", "Bash(gh run list:*)", "Bash(gh run view:*)",
      "Bash(tee:*)", "Bash(sha256sum:*)", "Bash(date:*)", "Bash(true)", "Bash(make:*)", "Bash(vitest:*)", "Bash(ng:*)"
    ] | unique)
  | .permissions.deny = ((.permissions.deny // []) + [
      "Bash(git push --force:*)", "Bash(git push -f:*)", "Bash(git rebase:*)",
      "Bash(git push origin dev:*)", "Bash(git push -u origin dev:*)", "Bash(git push origin HEAD:dev:*)",
      "Bash(gh pr merge:*)", "Bash(sudo:*)", "Bash(rm -rf /:*)",
      "Read(**/.env.production)", "Bash(npm run deploy:*)", "Bash(sls deploy:*)"
    ] | unique)' "$F" > "$F.tmp" && mv "$F.tmp" "$F"

echo "OK permisos en $F"
jq '.permissions' "$F"
