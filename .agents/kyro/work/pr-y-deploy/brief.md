# PR de works terminados y despliegue del panel desde la web

Un work terminado muestra el link de su PR en la web aunque la haya abierto el agente, y agents-panel se despliega desde la pantalla Versiones con un botón, sin entrar a la VM.

## Objetivo

1. Que un work que terminó con su PR abierta muestre el link de la PR en la web aunque el piloto no la haya registrado.
2. Desplegar agents-panel (traer `main`, compilar y reiniciar el servicio) con un botón de la web, sin entrar a la VM.

## Problema

- La tarjeta de la PR solo aparece en `pr_lista` y lee `autopilot_runs.pr_urls`. Si el agente cierra el work y abre la PR por su cuenta (por ejemplo, retomado con un mensaje), el estado queda en `terminado`, `pr_urls` vacío y no se ve ningún link (caso real: chat 5, PR `Maiki02/agents-panel#1`).
- Para desplegar el panel hoy hay que entrar a la VM, hacer `git pull`, compilar y reiniciar `agents-panel` a mano.

## Regla nueva

### PR de un work terminado

- `GET /api/chats/:id/pr` (con sesión) devuelve `{ urls: string[] }`. Si el piloto guardó PRs, son esas. Si no y el work está en `terminado` o `pr_lista`, busca en GitHub con `gh pr list --head <rama> --state all --json url` (en el worktree, o en el repo del proyecto si el worktree ya no existe). Si encuentra y hay corrida del piloto, la guarda en `pr_urls` para no volver a buscar.
- La señal es GitHub (`gh`), nunca el texto del agente. Si `gh` falla, la respuesta es la lista vacía.
- La web, al entrar a un chat de work en `terminado`, pide esa ruta y muestra la tarjeta de la PR solo si hay URLs. En `pr_lista` usa la misma ruta.

### Despliegue del panel

- Script `scripts/vm/12-panel-deploy.sh [<repo>]`, idempotente, `set -euo pipefail`: se niega si el repo no está en `main` o tiene cambios; `git fetch` + `git merge --ff-only origin/main`; `npm ci` solo si cambió `package-lock.json`; `npm run build`. Si el build falla vuelve al commit anterior y recompila. Últimas líneas: `DEPLOY_FROM=<sha>`, `DEPLOY_TO=<sha>`, `DEPLOY_RESTART=yes|no` (no cuando ya estaba al día).
- API: `POST /api/versions/panel/deploy` con TOTP fresco (como Actualizar Kyro). Se rechaza (409) con sesiones corriendo, otra mantención en curso o un piloto en fase de merge. Mientras corre no arrancan sesiones nuevas. La corrida queda en `maintenance_runs` con `kind = 'panel-deploy'`, `from_version`/`to_version` = commits cortos.
- Reinicio: si el script terminó bien y pidió reinicio, la API cierra y sale con código distinto de cero; systemd (`Restart=on-failure`) la levanta con el código nuevo. Los pilotos retoman como en cualquier reinicio.
- Solo disponible bajo systemd (variable `INVOCATION_ID`); con `tsx watch` el botón aparece deshabilitado con el motivo.
- `GET /api/versions` suma `panel`: commit corriendo, commits de `origin/main` sin desplegar (con `git fetch` cacheado 60 s; null si falla), si hay un deploy en curso y si está disponible.
- Web, pantalla Versiones: tarjeta **Panel** con el commit, "N commits sin desplegar" y el botón Desplegar (TOTP). Tras desplegar la página espera a que el servidor vuelva y pide refrescar. El Historial muestra ambos tipos de corrida.
- Docs: paso nuevo en `docs/vm-setup.md` + bitácora; `CLAUDE.md` extiende la excepción de la bitácora a los deploys desde el botón.

## Fuera de alcance

- Despliegue automático al mergear (polling o webhook).
- Despliegue de otros proyectos (sus credenciales de producción no van en la VM; queda para su CI).
