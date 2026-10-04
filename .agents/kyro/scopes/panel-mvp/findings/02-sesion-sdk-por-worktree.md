# 02 — Sesión del Agent SDK por worktree

- **Severidad:** media.
- **Archivos:** nuevos en `apps/api/src/agent/`, `apps/api/src/worktrees/`.
- **Comportamiento esperado:** crear un scope/work = `git worktree add ~/wt/<proyecto>/<slug> -b feature/<slug>` + setup del proyecto + `query()` del SDK con `cwd` en el worktree, `settingSources: ['project','user']`, `permissionMode: 'acceptEdits'`, allowlist de comandos y `canUseTool` que niega lo demás. Nunca `bypassPermissions`.
- **Hallazgos:** la VM ya tiene Claude Code logueado (`~/.claude/.credentials.json`); hay que verificar si el SDK lo reutiliza o hace falta `claude setup-token`. `@anthropic-ai/claude-agent-sdk` está en 0.3.289.
- **Riesgo:** el setup de NovaGent (clones de fe/be con `origin` en GitHub) depende de la etapa 3, que no está cerrada. El panel solo ejecuta el `setup_command` que declare el proyecto.
- **Recomendación:** cada mensaje del usuario = un `query()` con `resume: sessionId` (sobrevive reinicios). El SDK queda detrás de una interfaz `AgentRunner` para poder testear con un fake.
- **Validación:** tests con repo git temporal y runner falso; una corrida real de humo en la VM.
