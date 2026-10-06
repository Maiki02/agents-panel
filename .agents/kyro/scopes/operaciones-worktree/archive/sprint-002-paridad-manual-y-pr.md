---
title: 'operaciones-worktree — Sprint 2: Servicio único de acciones, Crear PR, ver cambios, descartar y borrar (WS14)'
date: '2026-10-06'
scope: 'operaciones-worktree'
sprint: 2
slug: 'paridad-manual-y-pr'
outcome: 'shipped'
type: 'sprint-archive'
---

# Sprint 2: Servicio único de acciones, Crear PR, ver cambios, descartar y borrar (WS14)

> Closed: 2026-10-06
> Outcome: shipped

## Objective

Que el piloto y la API usen un único servicio de acciones con actor, que cada acción del catálogo D26 que hace el piloto tenga su ruta manual (incluidos los pasos del agente), y que la API ofrezca Crear PR, Correr merge-dev, ver cambios, descartar y borrar trabajo, seguros frente al agente y al piloto.

## Definition of Done

- Todas las tareas en done con evidencia y review pass.
- npm run typecheck, npm run lint, npm test y prettier --check pasan en la raíz.
- Ninguna ruta nueva es pública y todas las mutantes exigen CSRF y responden 409 con el agente corriendo o el piloto ocupado.
- Ningún camino nuevo usa --force, rebase, pushea una rama que no sea la del trabajo ni lee o toca archivos ignorados.
- El piloto usa el mismo servicio que la API y el Timeline registra el actor.

## Phases

### P1 — Servicio único de acciones y pasos del agente

> Un solo servicio con actor (user, pilot, agent) para las acciones deterministas, usado por el piloto y por la API, y rutas manuales que lanzan los pasos del agente (R5, R8).

#### T1.1: Servicio de acciones con actor compartido por el piloto y la API

**Status**: done

**Description**: Convertir WorktreeOps (apps/api/src/worktrees/ops.ts) en el servicio único de acciones de D26: cada operación recibe el actor ('user' | 'pilot' | 'agent') y lo escribe en la entrada del Timeline (hoy está fijo en 'user'). Exponer en el servicio, además de lo que ya tiene, las acciones deterministas que hoy hace el piloto por su cuenta: push de la rama del trabajo con evento git_push, commit de .agents/kyro tras completar (commitKyro) y abrir o reusar la PR (openOrReusePr, hoy privada en apps/api/src/pilot/merge.ts). El piloto (apps/api/src/pilot/autopilot.ts: push, commitCompletion y mergePhase) pasa a llamar al servicio con actor 'pilot' en vez de a realGit/realGh directo. Las guardas de idle (agente corriendo, piloto ocupado) solo aplican a actor 'user': el piloto es quien está corriendo; el candado por chat (busy) aplica a todos. Mantener las firmas públicas que ya usan git-routes.ts y los tests de S1.

**Evidence**:
- Summary: WorktreeOps es el servicio único de acciones con actor (user|pilot|agent): las guardas de agente/piloto/mantenimiento aplican solo a user, el candado por chat a todos. Nuevas acciones pushBranch (con evento git_push), commitKyro y openPr (openOrReusePr exportada de merge.ts). El piloto hace push, commit de Kyro y PR por el servicio con actor pilot (hooks push/openPr en merge); app.ts crea el servicio antes del piloto y lo comparte con las rutas git. Firmas públicas previas intactas (actor opcional, por defecto user).
- Validation: npm run typecheck OK; npm run lint OK; npm test OK (api 1117 tests, web 260); prettier aplicado
- Files changed: `apps/api/src/worktrees/ops.ts`, `apps/api/src/pilot/autopilot.ts`, `apps/api/src/pilot/merge.ts`, `apps/api/src/pilot/merge-phase.ts`, `apps/api/src/app.ts`, `apps/api/test/worktree-ops.test.ts`, `apps/api/test/pilot-autopilot.test.ts`, `apps/api/test/pilot-merge.test.ts`

**Verdict**: pass

---
#### T1.2: Rutas manuales de los pasos del agente y de completar

**Status**: done

**Description**: Agregar POST /api/chats/:id/steps con body { step } donde step es plan, execute, qa, fix, close, merge_dev o complete. plan/execute/fix/close lanzan al agente con el mismo prompt y rol que usa el piloto (buildStepPrompt con el task context de Kyro; plan con rol thinker, el resto executor). qa corre kyro analyze como el check_quality del piloto y lanza fix si hay hallazgos bloqueantes o close si no. merge_dev solo existe si el worktree trae .claude/skills/merge-dev/SKILL.md y lanza buildMergeDevPrompt. complete corre kyro scope complete o kyro work close y commitea .agents/kyro por el servicio de T1.1. Extraer del piloto la construcción del prompt de cada paso a una función compartida para que manual y automático manden lo mismo. Guardas: 404 sin worktree, 409 en un pedido directo o una idea, y las mismas de T1.1 para actor user (agente corriendo, piloto active/queued/waiting_quota, mantenimiento). Cada paso deja entrada en el Timeline con actor user y el paso pedido.

**Evidence**:
- Summary: POST /api/chats/:id/steps (plan, execute, qa, fix, close, merge_dev, complete) con StepService: mismo buildStepPrompt/rol que el piloto, guardas de actor user via WorktreeOps.assertIdle, 404/409, Timeline con actor user (markStep). Prompt, rol y afterAnalyze extraidos a prompts.ts y usados por el piloto.
- Validation: npm run typecheck; npm run lint; npm run format:check; npm test -w @agents-panel/api (65 archivos, incluido step-routes.test.ts, guard.test.ts y cli.test.ts)
- Files changed: `apps/api/src/chats/step-routes.ts`, `apps/api/src/pilot/autopilot.ts`, `apps/api/src/pilot/prompts.ts`, `apps/api/src/worktrees/ops.ts`, `apps/api/src/app.ts`, `packages/shared/src/index.ts`, `apps/api/test/step-routes.test.ts`, `apps/api/test/guard.test.ts`, `apps/api/test/cli.test.ts`

**Verdict**: pass

---
### P2 — Crear PR desde la web

> Prellenar y abrir (o reusar) la PR de cada repo del trabajo con commits fuera de su base (R3, R8).

#### T2.1: Crear PR por repo: prellenado y apertura

**Status**: done

**Description**: En el servicio de acciones: prPreview(chatId) devuelve por cada repo del trabajo (raíz e hijos, con la base de project_repos) cuántos commits tiene fuera de origin/<base>, la PR abierta si existe (gh.openPr), el título prellenado en Conventional Commits a partir del scope o work (por ejemplo feat(<scope>): <título del scope>) y el cuerpo desde git log <base>..HEAD --no-merges, más hasMergeDev. createPr(chatId, actor, repos[{ repo, title, body }]) por cada repo pedido: trae la base (pull --no-rebase; con conflicto aborta, devuelve los archivos y askAgent como en D19 y sigue con los demás repos), busca secretos (scanWorktreeSecrets; si encuentra, no pushea ni abre PR en ese repo), pushea la rama del trabajo sin force y abre la PR con gh pr create --base <base del repo> o devuelve la existente (el push ya la actualizó). Rutas GET /api/chats/:id/git/pr y POST /api/chats/:id/git/pr. Resultado por repo con url; cada repo deja entrada en el Timeline con el link. Título acotado y sin saltos de línea; el cuerpo viaja en archivo (createPrArgs con --body-file), nunca en argv.

**Evidence**:
- Summary: prPreview y createPr en WorktreeOps (actor, Timeline con link, scan de secretos, pull de base con conflicto abortado, push sin force, gh pr create con --body-file) y rutas GET/POST /api/chats/:id/git/pr
- Validation: npm run typecheck: ok
- Validation: npm run lint: ok
- Validation: npm run format:check: ok
- Validation: npm run test -w @agents-panel/api: worktree-pr, worktree-git-routes, guard, cli ok (S9, S10, S12, conflicto, sin commits, 409 agente/piloto)
- Files changed: `apps/api/src/worktrees/ops.ts`, `apps/api/src/pilot/git-ops.ts`, `apps/api/src/chats/git-routes.ts`, `packages/shared/src/index.ts`, `apps/api/test/worktree-pr.test.ts`, `apps/api/test/worktree-git-routes.test.ts`, `apps/api/test/guard.test.ts`, `apps/api/test/cli.test.ts`

**Verdict**: pass

---
### P3 — Ver cambios, descartar y borrar trabajo

> Diff de solo lectura, descarte de archivos elegidos y borrado del trabajo con confirmación (R4, R8).

#### T3.1: Ver cambios por repo

**Status**: done

**Description**: GET /api/chats/:id/git/diff?repo=<path>&against=worktree|base[&file=<ruta>]. worktree: cambios sin commitear (git diff HEAD más los no rastreados no ignorados con git diff --no-index contra /dev/null). base: git diff <base>...HEAD. Devuelve por archivo ruta, estado, adiciones, borrados, binario y el parche recortado (por ejemplo 20000 caracteres) con truncated; con file devuelve ese archivo hasta un tope mayor ('ver más'). Nunca muestra archivos ignorados: se filtran con git check-ignore aunque estén rastreados por error, y file con una ruta ignorada, absoluta, con '..' o fuera del repo responde 400. Solo lectura: no exige que el agente esté quieto. Todo por execFile sin shell; repo tiene que ser uno de los del trabajo.

**Evidence**:
- Summary: GET /api/chats/:id/git/diff?repo&against=worktree|base[&file]: RepoGit.diff (git-ops) con numstat/name-status, untracked por ls-files, filtro de ignorados con check-ignore --no-index (fail-closed), parche recortado a 20000 chars con truncated y hasta 400000 con file, 400 para ruta absoluta, con .. o ignorada; WorktreeOps.diff solo lectura; tipos RepoDiff/DiffFile en shared; ruta en guard test.
- Validation: npm run test -w @agents-panel/api (67 archivos, 1147 tests OK, incluye worktree-diff y guard); npm run typecheck OK; npm run lint OK; prettier check OK
- Files changed: `apps/api/src/pilot/git-ops.ts`, `apps/api/src/worktrees/ops.ts`, `apps/api/src/chats/git-routes.ts`, `packages/shared/src/index.ts`, `apps/api/test/worktree-diff.test.ts`, `apps/api/test/guard.test.ts`

**Verdict**: pass

---
#### T3.2: Descartar cambios de archivos elegidos

**Status**: done

**Description**: POST /api/chats/:id/git/discard con { repo, files }. Los rastreados vuelven a HEAD (git restore --staged --worktree --source=HEAD -- <archivos>); los no rastreados elegidos se borran solo si git ls-files --others --exclude-standard los lista. Rechaza con 400 lista vacía, rutas absolutas, '..', archivos fuera del repo, archivos sin cambios e ignorados, sin tocar nada si alguno es inválido. Guardas de actor user (409). Entrada en el Timeline con actor y la lista de archivos.

**Evidence**:
- Summary: POST /api/chats/:id/git/discard: RepoGit.discardFiles valida todo antes de tocar (ruta, ignorado, sin cambios -> GitInputError 400), restaura rastreados desde HEAD, borra no rastreados listados por ls-files --others, deshace nuevos staged; WorktreeOps.discard con guardas de actor y Timeline con actor y archivos
- Validation: npm run typecheck OK
- Validation: npm run lint OK
- Validation: npm run test -w apps/api: 1150 pasan; el unico fallo (lista de rutas en cli.test.ts) corregido y re-corrido OK
- Validation: prettier aplicado (npm run format)
- Files changed: `apps/api/src/pilot/git-ops.ts`, `apps/api/src/worktrees/ops.ts`, `apps/api/src/chats/git-routes.ts`, `packages/shared/src/index.ts`, `apps/api/test/worktree-ops.test.ts`, `apps/api/test/worktree-git-routes.test.ts`, `apps/api/test/guard.test.ts`, `apps/api/test/cli.test.ts`

**Verdict**: pass

---
#### T3.3: Borrar trabajo con vista previa

**Status**: done

**Description**: GET /api/chats/:id/work/delete-preview devuelve el worktree, por repo la rama local, si existe en origin, los commits sin pushear y los archivos sin commitear. POST /api/chats/:id/work/delete con { deleteRemote: boolean } exige que el agente no esté corriendo y que el piloto no esté ocupado (409), apaga el run del piloto si existe, marca limpiando, borra el worktree y las ramas locales del trabajo (raíz e hijos; nunca la base), y solo con deleteRemote borra en origin las ramas del trabajo (git push origin --delete <rama>, validada; nunca la base). El chat queda en archivado y en solo lectura: mandar un mensaje, lanzar un paso, encender el piloto o cualquier operación git responden 409. Un fallo a mitad deja el estado en revisar con el detalle.

**Evidence**:
- Summary: Borrar trabajo con vista previa: GET work/delete-preview y POST work/delete (409 con agente o piloto ocupado, apaga el run, limpiando -> archivado, remota solo con deleteRemote y nunca la base, fallo -> revisar). Archivado da 409 en mensajes, pasos, piloto y operaciones git.
- Validation: npm run typecheck -w apps/api: limpio
- Validation: vitest worktree-delete, guard, cli, pilot-routes: pasan; suite completa 1160 tests, el único fallo (cli.test lista de rutas) corregido y vuelto a pasar
- Validation: npm run format:check: limpio
- Files changed: `apps/api/src/worktrees/ops.ts`, `apps/api/src/worktrees/create.ts`, `apps/api/src/pilot/git-ops.ts`, `apps/api/src/chats/service.ts`, `apps/api/src/chats/git-routes.ts`, `apps/api/src/pilot/routes.ts`, `packages/shared/src/index.ts`, `apps/api/test/worktree-delete.test.ts`, `apps/api/test/guard.test.ts`

**Verdict**: pass

---
### P4 — Catálogo de paridad y docs

> Verificar por test que cada acción automática tiene su ruta manual y dejar escrito lo que cambió (R5, R9).

#### T4.1: Catálogo de paridad manual y su test

**Status**: done

**Description**: Definir en packages/shared el catálogo de acciones de D26 (id, quién la hace en automático, si es determinista o un paso del agente, y la ruta manual: método y path, o el step de POST /api/chats/:id/steps). Test que recorre el catálogo contra la app de Fastify (hasRoute) y verifica que cada acción que hace el piloto tiene ruta manual, y que cada paso del piloto (PromptStep, merge, merge_dev, complete, push, commit de Kyro, PR) figura en el catálogo; así una fila nueva del piloto sin botón rompe el test. Test de que el Timeline registra actor pilot y user para la misma acción.

**Evidence**:
- Summary: PARITY_CATALOG en shared y test parity-catalog: rutas por hasRoute, pasos del piloto, llamadas actions.* y actor pilot/user en el Timeline
- Validation: npm run typecheck ok
- Validation: npm run lint ok
- Validation: npm test ok (api 1169, web 260)
- Files changed: `packages/shared/src/index.ts`, `apps/api/test/parity-catalog.test.ts`

**Verdict**: pass

---
#### T4.2: Documentar el servicio de acciones, Crear PR, diff, descartar y borrar

**Status**: done

**Description**: Sumar a docs/plan.md (scope operaciones-worktree) el servicio único con actor, las rutas de pasos del agente, Crear PR y merge-dev, ver cambios, descartar y borrar trabajo, y el catálogo con su test. En docs/estados.md, el borrado manual hacia limpiando y archivado, el chat en solo lectura y el actor en las entradas del Timeline. En docs/panel-desarrollo.md, cómo probar las rutas nuevas desde el túnel (curl con cookie y CSRF) sin pegar secretos.

**Evidence**:
- Summary: Documentado el servicio de acciones con actor, pasos del agente, Crear PR, diff, descartar, borrar, catálogo y su test; estados (borrado manual, archivado en solo lectura, actor) y guía de prueba por curl sin secretos
- Validation: grep de cada ruta nueva en docs/plan.md
- Validation: sin tokens ni cookies en los docs (solo variables)
- Files changed: `docs/plan.md`, `docs/estados.md`, `docs/panel-desarrollo.md`

**Verdict**: pass

---

## Unfinished work

_None — every task is done with a passing verdict._

## Learnings

- El catálogo de paridad hace que un paso nuevo del piloto sin ruta manual rompa el test

## Resolved Debt

_No debt resolved in this sprint._

## Recommendations for Sprint 3

- Vincular escenarios a R6, R7 y R9 y dar scenario_refs a las tareas nuevas
- Verificar Crear PR real en agents-panel en el recorrido manual del sprint 3
