---
title: 'autopiloto-kyro — Sprint 4: Idea con aprobación y cierre con merge'
date: '2026-10-05'
scope: 'autopiloto-kyro'
sprint: 4
slug: 'idea-cierre-merge'
outcome: 'shipped'
type: 'sprint-archive'
---

# Sprint 4: Idea con aprobación y cierre con merge

> Closed: 2026-10-05
> Outcome: shipped

## Objective

Que un trabajo empiece como Idea desde la web, espere la aprobación del plan y, aprobado, el piloto lo lleve solo hasta la PR: push tras cada cierre de sprint, cierre del scope o work (preguntando una sola vez si queda deuda), traer la base, resolver conflictos, validar, buscar secretos y abrir la PR con la merge-dev del proyecto o con el merge genérico.

## Definition of Done

- Todas las tareas terminadas con evidencia y veredicto pass
- typecheck, lint, format:check, test y build en verde; kyro analyze sin CRITICAL ni HIGH
- QA del sprint con kyro-qa APPROVED o APPROVED WITH NOTES
- debt-6 y debt-7 resueltas; debt-1 y debt-5 siguen con target 6
- Docs al día: plan.md, estados.md, panel-desarrollo.md y CLAUDE.md

## Phases

### P1 — Base del piloto antes del cierre automático (debt-6, debt-7)

> El piloto solo da por bueno un cierre de sprint con QA aprobado verificable, y no frena por una carrera con un mensaje del usuario.

#### T1.1: Veredicto de kyro-qa verificable antes de aceptar un cierre (debt-6)

**Status**: done

**Description**: Hoy el piloto solo comprueba que la sesión de cierre invocó la skill kyro-qa (usedSkill en autopilot.ts). kyro-qa es de solo lectura y su veredicto (APPROVED, APPROVED WITH NOTES, CHANGES REQUIRED, REJECTED) queda solo en el texto del agente, que el piloto no lee (R7). Cambiar la cláusula qa_or_close/close_sprint de policy.ts: la sesión de cierre guarda el informe de QA en .agents/kyro/qa/<scope>/sprint-<n>.md, con una primera línea exacta 'Verdict: <VEREDICTO>', antes de correr kyro close-sprint. Subir POLICY_VERSION a 2. En autopilot.ts, después de un paso close que cerró el sprint, leer ese archivo del worktree (ruta fija, sin seguir symlinks, dentro del worktree) y parsear la línea: si falta, no se puede leer o el veredicto no es APPROVED ni APPROVED WITH NOTES, frenar con un BlockedReason nuevo 'qa_sin_aprobar' y el detalle (veredicto leído o 'sin informe'). Se mantiene el freno qa_sin_correr. Resolver debt-6 con kyro debt resolve al terminar.

**Evidence**:
- Summary: POLICY_VERSION 2 pide el informe .agents/kyro/qa/<scope>/sprint-<n>.md con 'Verdict:' en la primera línea; el piloto lo lee tras el cierre (qa-report.ts, sin symlinks ni salir del worktree) y frena con qa_sin_aprobar
- Validation: vitest run (apps/api): 860 passed
- Validation: tsc --noEmit y eslint de src/pilot y los tests: sin errores
- Files changed: `apps/api/src/pilot/qa-report.ts`, `apps/api/src/pilot/policy.ts`, `apps/api/src/pilot/autopilot.ts`, `packages/shared/src/index.ts`, `apps/api/test/pilot-policy.test.ts`, `apps/api/test/pilot-autopilot.test.ts`, `docs/estados.md`, `docs/plan.md`
- Notes: kyro doctor --artifacts pasa; .agents/kyro/qa/ aún no existe, no hay chequeo propio de esa carpeta

**Verdict**: pass

---
#### T1.2: Reintentar cuando el usuario manda un mensaje entre waitForIdle y start (debt-7)

**Status**: done

**Description**: En autopilot.ts, si manager.start tira AlreadyRunningError (el usuario mandó un mensaje entre waitForIdle y start), el piloto no frena ni se cae a crashed: vuelve a waitForIdle y decide de nuevo desde Kyro, sin contar la sesión. Igual en resumeStep. Con un tope de reintentos seguidos (por ejemplo 3) que, si se pasa, frena con 'otro' y el motivo. Resolver debt-7.

**Evidence**:
- Summary: Si manager.start tira AlreadyRunningError el piloto espera el turno del usuario y decide de nuevo desde Kyro, sin contar la sesión; tras 3 seguidos frena con 'otro'. Igual en resumeStep (devuelve 'busy').
- Validation: vitest run (apps/api): 862 passed, con dos tests nuevos de debt-7
- Validation: tsc --noEmit y eslint sin errores
- Files changed: `apps/api/src/pilot/autopilot.ts`, `apps/api/test/pilot-autopilot.test.ts`

**Verdict**: pass

---
### P2 — Chat de tipo Idea con aprobación del plan (R17)

> Un chat Idea madura el plan con el modelo pensante, queda esperando la aprobación y, aprobado, se convierte en scope o work en el mismo worktree con el piloto prendido.

#### T2.1: Tipo de chat idea: base, creación y primer turno con kyro-idea

**Status**: done

**Description**: Sumar 'idea' a ChatKind (packages/shared) y a la restricción CHECK de chats.kind con una migración nueva que reconstruye la tabla (mismo patrón que chats_kind_direct). ChatService.create acepta kind 'idea': exige proyecto con Kyro y sin autopilot en el body (400: el piloto se prende al aprobar), crea el worktree y arranca el primer turno con el modelo pensante, la skill kyro-idea por ruta (como buildInitialPrompt) y un bloque nuevo de política 'idea' en policy.ts: confirmar sin preguntar el docType y la ruta que kyro-idea infiere (son rutina), usar AskUserQuestion solo para huecos materiales, no crear scope ni work (lo hace el panel al aprobar) y terminar el turno cuando el documento quedó escrito y verificado. Estado del trabajo: madurando_idea.

**Evidence**:
- Summary: ChatKind idea: migración 13 que reconstruye chats, create con kyro-idea + política 'idea' + pensante, 400 con autopilot, 409 sin Kyro, estado madurando_idea con actor user; el piloto rechaza ideas hasta aprobar
- Validation: vitest run (apps/api): 868 passed (migración 13 sobre scope/work/direct, create idea, tracker, política)
- Validation: npm run typecheck (shared, api, web) y eslint sin errores
- Files changed: `packages/shared/src/index.ts`, `apps/api/src/db/migrations.ts`, `apps/api/src/chats/service.ts`, `apps/api/src/chats/routes.ts`, `apps/api/src/pilot/policy.ts`, `apps/api/src/pilot/routes.ts`, `apps/api/src/worktrees/state-tracker.ts`, `apps/api/test/chats.test.ts`, `apps/api/test/pilot-policy.test.ts`, `apps/api/test/db.test.ts`, `apps/api/test/worktree-state.test.ts`

**Verdict**: pass

---
#### T2.2: Detección del plan escrito y estado esperando_aprobacion_plan

**Status**: done

**Description**: Después de cada turno de un chat idea, el tracker busca el documento de kyro-idea en el worktree: archivos .md nuevos o cambiados respecto de la base bajo .agents/kyro/<docType>/ (excluyendo scopes/, work/, trace/, qa/ y los archivos de configuración), por git status --porcelain y execFile, nunca por el texto del agente. Si hay exactamente uno, la sesión quedó idle y no hay pregunta pendiente, el trabajo pasa a esperando_aprobacion_plan con la ruta guardada (columna o tabla nueva en la misma migración de T2.1 o una siguiente) y en el detalle de la transición. Si hay varios, queda bloqueado con un motivo claro. Si no hay ninguno, queda en madurando_idea esperando al usuario. GET /api/chats/:id/idea devuelve la ruta, el estado y el contenido del documento (solo si la ruta está dentro del worktree, sin symlinks, hasta un tamaño máximo).

**Evidence**:
- Summary: El tracker detecta por git el documento de kyro-idea: uno solo -> esperando_aprobacion_plan con ruta; ninguno -> madurando_idea; varios -> bloqueado; con pregunta pendiente no avanza. GET /api/chats/:id/idea devuelve ruta, estado y contenido sin symlinks ni salir del worktree.
- Validation: vitest run (apps/api): 881 passed, incluye test/idea.test.ts (13 casos)
- Validation: npm run typecheck y eslint sin errores
- Files changed: `apps/api/src/chats/idea.ts`, `apps/api/src/worktrees/state-tracker.ts`, `apps/api/src/chats/routes.ts`, `apps/api/src/app.ts`, `packages/shared/src/index.ts`, `apps/api/test/idea.test.ts`
- Notes: No hizo falta migración: la ruta queda en detail y data.path de la transición y GET /idea la recalcula desde git.

**Verdict**: pass

---
#### T2.3: Acciones de aprobación: aprobar como scope, aprobar como work o pedir cambios

**Status**: done

**Description**: POST /api/chats/:id/idea con { action: 'approve_scope' | 'approve_work' | 'request_changes', text? }, solo desde esperando_aprobacion_plan (si no, 409). approve_work: el panel corre kyro work create --id <slug> --from <ruta> --by <usuario> --json por execFile en el worktree; si sale bien, chats.kind pasa a 'work', se crea el autopilot_run activo y el piloto arranca (plan_tasks con el pensante). approve_scope: chats.kind pasa a 'scope', se crea el run activo y el piloto abre un paso nuevo 'init' con el pensante: prompt con kyro-forge en modo INIT referenciando el documento (seedbed-init-mapping) para el scope <slug>, con la política de plan; después sigue el bucle normal (plan_sprint del sprint 1). request_changes: exige text, manda el texto del usuario como turno nuevo en la misma sesión (pensante) y el trabajo vuelve a madurando_idea. Cada decisión queda en el Timeline con actor user, el usuario que la tomó y la ruta del plan. decideNextStep y readScope cubren el scope sin sprint.json todavía (paso init).

**Evidence**:
- Summary: POST /api/chats/:id/idea: approve_work corre kyro work create con argv exacto y pasa el chat a work con piloto; approve_scope pasa a scope y el piloto abre un paso init (migración 14, seed_path, buildInitPrompt con kyro-forge y la ruta); request_changes manda el texto al pensante en la misma sesión; 409 fuera de esperando_aprobacion_plan, 400 sin texto, 401/403; cada decisión en el Timeline con actor user
- Validation: vitest run (apps/api): 893 passed (idea-approval, autopilot init, decide, prompts, db)
- Validation: npm run typecheck y eslint sin errores
- Files changed: `apps/api/src/chats/idea-actions.ts`, `apps/api/src/chats/routes.ts`, `apps/api/src/chats/repo.ts`, `apps/api/src/pilot/decide.ts`, `apps/api/src/pilot/prompts.ts`, `apps/api/src/pilot/autopilot.ts`, `apps/api/src/pilot/runs-repo.ts`, `apps/api/src/db/migrations.ts`, `packages/shared/src/index.ts`, `apps/api/test/idea-approval.test.ts`, `apps/api/test/pilot-autopilot.test.ts`, `apps/api/test/pilot-decide.test.ts`, `apps/api/test/pilot-prompts.test.ts`
- Notes: El init va por needsScopeInit (decide.ts) en autopilot.ts en vez de por readScope; apps/api/src/kyro/reader.ts no cambió. Nota: tests nuevos en idea-approval.test.ts, no idea.test.ts.

**Verdict**: pass

---
### P3 — Cierre del scope o work (R18)

> Al terminar Kyro, el panel completa el scope o cierra el work solo si no hay deuda abierta, y si la hay pregunta una sola vez con la lista.

#### T3.1: Completar el scope o cerrar el work desde el panel

**Status**: done

**Description**: decideNextStep: await_scope_completion sin sprint abierto da una decisión nueva { kind: 'complete' } si openDebt es 0, y si no, stop en esperando_aprobacion_cierre con la lista de deuda abierta (id, título, prioridad) en los datos de la transición. Un work en ready_to_close da { kind: 'complete' }. Para completar, el panel (no el agente) corre por execFile kyro scope complete --kyro-scope <scope> --yes o kyro work close --work <slug> --outcome completed --reason <motivo> --expect-revision <n> --by pilot --yes, y commitea solo los cambios de .agents/kyro/ con un Conventional Commit (chore(kyro): completar scope <scope> / cerrar work <slug>). Después el run pasa a la fase de merge (T4.5). Métodos nuevos en KyroReader: completeScope, closeWork y la lectura de la deuda abierta.

**Evidence**:
- Summary: decideNextStep da 'complete' sin deuda (scope) o en ready_to_close (work), y stop en esperando_aprobacion_cierre con la deuda en el Timeline si hay; el panel corre kyro scope complete --yes / work close por execFile (argv exacto en test) y commitea solo .agents/kyro (git-ops.ts, probado con repo real)
- Validation: vitest run (apps/api): 905 passed (decide, autopilot completion, kyro-reader, pilot-git)
- Validation: npm run typecheck y eslint sin errores
- Files changed: `apps/api/src/pilot/decide.ts`, `apps/api/src/pilot/autopilot.ts`, `apps/api/src/pilot/git-ops.ts`, `apps/api/src/kyro/reader.ts`, `apps/api/src/kyro/state.ts`, `apps/api/src/worktrees/state-repo.ts`, `apps/api/src/worktrees/state-tracker.ts`, `apps/api/test/pilot-decide.test.ts`, `apps/api/test/pilot-autopilot.test.ts`, `apps/api/test/kyro-reader.test.ts`, `apps/api/test/pilot-git.test.ts`
- Notes: La lectura de deuda abierta es parseOpenDebt sobre el sprint.json que readScope ya lee (no hay 'kyro debt list'); el commit vive en git-ops.ts, no en reader.ts.

**Verdict**: pass

---
#### T3.2: Completar aceptando la deuda con OK explícito

**Status**: done

**Description**: Acción nueva en POST /api/chats/:id/autopilot: { action: 'accept_debt', reason } solo desde esperando_aprobacion_cierre (si no, 409; reason obligatorio, 400). El panel corre kyro scope complete --kyro-scope <scope> --accept-open-debt --reason <reason> --yes, commitea .agents/kyro, registra en el Timeline quién aceptó, el motivo y la lista de deuda aceptada, y retoma el piloto en la fase de merge. No vuelve a preguntar por la misma deuda.

**Evidence**:
- Summary: accept_debt en POST /api/chats/:id/autopilot: solo desde esperando_aprobacion_cierre, reason obligatorio; corre scope complete --accept-open-debt --reason --yes, commitea .agents/kyro, registra usuario, motivo y deuda en el Timeline y retoma el piloto
- Validation: vitest run (apps/api): todo verde, incluye pilot-accept-debt.test.ts (4 casos: ok, 400/409, 409 work/401/403, 422 y git)
- Validation: tsc --noEmit y eslint sin errores
- Files changed: `apps/api/src/pilot/accept-debt.ts`, `apps/api/src/pilot/routes.ts`, `apps/api/src/app.ts`, `packages/shared/src/index.ts`, `apps/api/test/pilot-accept-debt.test.ts`, `apps/api/test/helpers.ts`

**Verdict**: pass

---
### P4 — Push, traer la base, validar y abrir la PR (R12, R13, R14, R20)

> El piloto pushea tras cada cierre de sprint y al final deja la PR lista con la merge-dev del proyecto o con el merge genérico, frenando por conflicto de lógica, build roto o secretos.

#### T4.1: Validación del proyecto: validate_command

**Status**: done

**Description**: Columna opcional projects.validate_command (migración nueva), igual que setup_command: se edita por PATCH /api/projects/:id (validateCommand, string o null, maxLength 500) y se muestra en GET. Se parte con splitCommand y corre sin shell por execFile en el worktree, con timeout configurable (por defecto 15 minutos) y salida recortada guardada en el evento. El campo de la web queda para el sprint 5.

**Evidence**:
- Summary: projects.validate_command (migración 15) editable por PATCH/GET con validateCommand (<=500, comillas validadas); runValidation corre el comando sin shell por execFile en el worktree con timeout configurable (15 min por defecto) y devuelve passed/failed/timeout/skipped con la salida recortada
- Validation: vitest run (apps/api): 918 passed, incluye validate.test.ts
- Validation: npm run typecheck y eslint sin errores
- Files changed: `apps/api/src/worktrees/validate.ts`, `apps/api/src/db/migrations.ts`, `apps/api/src/projects/repo.ts`, `apps/api/src/projects/service.ts`, `apps/api/src/projects/routes.ts`, `apps/api/src/config.ts`, `packages/shared/src/index.ts`, `apps/api/test/validate.test.ts`, `apps/api/test/db.test.ts`, `apps/api/.env.example`

**Verdict**: pass

---
#### T4.2: Push de la rama después de cada cierre de sprint

**Status**: done

**Description**: Después de un paso close que cerró el sprint, el panel comprueba que HEAD tiene un commit nuevo en la rama del worktree y que la rama base local no cambió, y pushea con git push -u origin <rama> por execFile (nunca --force, --force-with-lease ni +refspec; test sobre el argv). Si el push falla, frena con blockedReason 'git' y la salida recortada. En un work, lo mismo después de kyro work close. Un worktree sin remoto frena con 'git'.

**Evidence**:
- Summary: Tras un close que cerró el sprint el panel verifica commit nuevo en HEAD y base local intacta y hace git push -u origin <rama> por execFile (pushArgs rechaza force/refspec/opciones); también tras completar scope o cerrar work y al aceptar deuda; push rechazado o sin remoto frena con git y la salida
- Validation: vitest run (apps/api): 926 passed, con repo real y remoto bare en pilot-git-ops.test.ts (push ok, base del remoto intacta, rechazo por remoto adelantado, sin remoto, argv sin force)
- Validation: tsc --noEmit y eslint sin errores
- Files changed: `apps/api/src/pilot/git-ops.ts`, `apps/api/src/pilot/autopilot.ts`, `apps/api/src/pilot/accept-debt.ts`, `apps/api/src/app.ts`, `apps/api/test/pilot-git-ops.test.ts`, `apps/api/test/pilot-autopilot.test.ts`, `apps/api/test/pilot-accept-debt.test.ts`
- Notes: pilot-git.test.ts pasó a llamarse pilot-git-ops.test.ts (nombre de la tarea).

**Verdict**: pass

---
#### T4.3: Búsqueda de secretos en el diff

**Status**: done

**Description**: Función pura scanSecrets(diff) sobre las líneas agregadas de git diff origin/<base>...HEAD (más lo pendiente sin commitear): nombres de archivo (.env y .env.* salvo .env.example, *.pem, *.key, id_rsa*, id_ed25519*, credentials.json) y patrones de contenido (BEGIN ... PRIVATE KEY, ghp_ / github_pat_, sk-ant-, AKIA[0-9A-Z]{16}, xox[abpr]-). Devuelve archivo y tipo, nunca el valor. El merge (genérico y de merge-dev) la corre antes del push final y frena con blockedReason nuevo 'secretos' listando solo archivos y tipos.

**Evidence**:
- Summary: scanSecrets(diff) pura sobre líneas agregadas y nombres de archivo (.env/.pem/.key/id_rsa/id_ed25519/credentials.json, claves privadas, ghp_/github_pat_/sk-ant-/AKIA/xox) que devuelve solo archivo y tipo; scanWorktreeSecrets une diff contra origin/<base>, lo pendiente y archivos sin trackear; blockedReason secretos agregado
- Validation: vitest run (apps/api): 937 passed, incluye pilot-secrets.test.ts (no marca .env.example ni líneas borradas; el valor nunca aparece en la salida)
- Validation: tsc --noEmit y eslint sin errores
- Files changed: `apps/api/src/pilot/secrets.ts`, `packages/shared/src/index.ts`, `apps/api/test/pilot-secrets.test.ts`

**Verdict**: pass

---
#### T4.4: Merge genérico: traer la base, conflictos, validación y PR

**Status**: done

**Description**: Módulo de merge genérico (git-ops.ts) para proyectos sin merge-dev, con estados del Timeline: trayendo_dev → (resolviendo_conflictos) → validando_post_merge → abriendo_pr → pr_lista. Pasos: commitear lo pendiente si hay (excepto si scanSecrets lo marca), git pull --no-rebase origin <base> por execFile. Si quedan rutas sin mergear (git diff --name-only --diff-filter=U), el piloto abre una sesión 'merge' con el ejecutor y un bloque nuevo de política 'merge': resolver los conflictos mecánicos (lockfiles, imports, docs, formato), git add y git commit --no-edit; si un hunk tiene lógica de negocio de los dos lados, preguntar con AskUserQuestion mostrando los dos lados y esperar; nunca git merge --abort, push, rebase ni --force. Al terminar la sesión el panel verifica que no hay rutas sin mergear ni MERGE_HEAD; si no, frena con 'conflicto'. Si el pull trajo commits y el proyecto tiene validate_command, lo corre; si falla, frena con 'build_roto' (sin PR). Después scanSecrets, push y PR: reusar la PR abierta de esa rama (gh pr list --head <rama> --base <base> --state open --json url) o gh pr create --base <base> --head <rama> --title --body-file con el objetivo del scope y los sprints cerrados. La URL de la PR queda en el run y en el Timeline.

**Evidence**:
- Summary: runGenericMerge: commit de lo pendiente (sin secretos), git pull --no-rebase, sesión merge del ejecutor sobre los conflictos con verificación de rutas sin mergear y MERGE_HEAD (conflicto), validate_command tras traer cambios (build_roto), scanWorktreeSecrets (secretos), push de la rama y PR reutilizada o creada con gh --body-file; bloque de política merge, buildMergePrompt, migración 16 con phase y pr_urls
- Validation: vitest run (apps/api): todo verde, pilot-merge.test.ts con repos reales y remoto bare y gh falso (13+ casos, incluye argv sin force/rebase y push solo de la rama)
- Validation: npm run typecheck y eslint sin errores
- Files changed: `apps/api/src/pilot/merge.ts`, `apps/api/src/pilot/git-ops.ts`, `apps/api/src/pilot/github-cli.ts`, `apps/api/src/pilot/policy.ts`, `apps/api/src/pilot/prompts.ts`, `apps/api/src/pilot/runs-repo.ts`, `apps/api/src/db/migrations.ts`, `packages/shared/src/index.ts`, `apps/api/test/pilot-merge.test.ts`, `apps/api/test/pilot-policy.test.ts`, `apps/api/test/pilot-runs.test.ts`, `apps/api/test/db.test.ts`
- Notes: La sesión 'merge' se abre desde el bucle en T4.5; aquí el módulo recibe resolveConflicts como dependencia. Migración 16 (no 15) porque 15 es validate_command.

**Verdict**: pass

---
#### T4.5: Fase de merge en el bucle: merge-dev del proyecto o merge genérico, y retoma

**Status**: done

**Description**: Después de completar el scope o cerrar el work (T3.1, T3.2), el run pasa a una fase 'merge' guardada en autopilot_runs (columna nueva phase y pr_urls, migración) para que un reinicio la retome. Si el worktree tiene .claude/skills/merge-dev/SKILL.md, el piloto abre una sesión 'merge_dev' con el ejecutor: prompt que lee esa skill para el scope, más el bloque de política 'merge' (no mergear PRs, no --force, preguntas por AskUserQuestion). Antes de terminar la fase corre scanSecrets sobre la raíz y sobre cada repo hijo (carpetas de primer nivel con .git). Señal de éxito: la rama de la raíz quedó en origin/<base> (git merge-base --is-ancestor) o hay una PR abierta de la rama, y se juntan las PR abiertas de la raíz y de los repos hijos con gh pr list. Sin ninguna señal, frena con 'merge_sin_pr'. Si no hay merge-dev, corre el merge genérico de T4.4. Al reiniciar el panel, un run en fase merge la retoma de forma idempotente (traer la base de nuevo es seguro, la PR se reusa).

**Evidence**:
- Summary: Tras completar scope/work el run pasa a phase merge (persistida, migración 16): merge-dev del proyecto (sesión merge_dev del ejecutor con la skill y política merge_dev) o merge genérico; scanWorktreeSecrets sobre raíz e hijos; señal de éxito por is-ancestor o PR abierta (raíz e hijos, gh pr list); sin señal frena merge_sin_pr; PR URLs en el run y el Timeline; un reinicio retoma la fase
- Validation: vitest run (apps/api): 964 passed (autopilot merge phase: PR con objetivo y sprints, conflictos, conflicto, secretos, reinicio, merge-dev con PR/ancestor/merge_sin_pr; merge-phase con repos hijos)
- Validation: npm run typecheck y eslint sin errores
- Files changed: `apps/api/src/pilot/merge-phase.ts`, `apps/api/src/pilot/autopilot.ts`, `apps/api/src/pilot/accept-debt.ts`, `apps/api/src/pilot/git-ops.ts`, `apps/api/src/pilot/policy.ts`, `apps/api/src/pilot/prompts.ts`, `apps/api/src/pilot/secrets.ts`, `apps/api/src/kyro/reader.ts`, `apps/api/src/kyro/state.ts`, `apps/api/src/app.ts`, `apps/api/test/pilot-autopilot.test.ts`, `apps/api/test/pilot-merge.test.ts`, `apps/api/test/pilot-accept-debt.test.ts`
- Notes: La columna phase y pr_urls ya existían desde T4.4 (migración 16); aquí se usan.

**Verdict**: pass

---
### P5 — Web mínima de las acciones

> La Idea, la aprobación del plan, la aceptación de deuda y el link de la PR se usan desde la web; el Timeline y el push quedan para el sprint 5.

#### T5.1: Tipo Idea en Nuevo chat

**Status**: done

**Description**: En chat-kinds.ts y new-chat.form.ts sumar el tipo Idea (solo con Kyro en el proyecto, como scope y work), con su descripción y sin el interruptor de piloto (se prende al aprobar). La sidebar muestra el estado del trabajo como para scope y work.

**Evidence**:
- Summary: La web ofrece Idea solo con Kyro, con descripción por tipo y sin mandar autopilot (newChatInput); GET /api/chats y /:id traen workState y la sidebar muestra un solo badge con la etiqueta del estado y el tono de quién actúa (ámbar en esperando_aprobacion_plan, acento en madurando_idea)
- Validation: vitest run apps/web: 173 passed (chat-kinds, status, work-state); apps/api: 965 passed
- Validation: npm run typecheck, lint y format:check sin errores
- Files changed: `apps/web/src/app/chats/chat-kinds.ts`, `apps/web/src/app/chats/new-chat.form.ts`, `apps/web/src/app/chats/status.ts`, `apps/web/src/app/chats/work-state.ts`, `apps/web/src/app/chats/chat-sidebar.ts`, `apps/web/src/app/chats/chat-kinds.spec.ts`, `apps/web/src/app/chats/status.spec.ts`, `apps/web/src/app/chats/work-state.spec.ts`, `apps/api/src/chats/routes.ts`, `packages/shared/src/index.ts`, `apps/api/test/worktree-state.test.ts`
- Notes: La web no mostraba el estado fino de ningún trabajo: se agregó workState a la API del chat y work-state.ts con las etiquetas de todo el catálogo. new-chat.form.spec.ts no cambió: la lógica se prueba en chat-kinds.spec.ts (el repo no usa TestBed).

**Verdict**: pass

---
#### T5.2: Barra de aprobación del plan, aceptación de deuda y link de la PR

**Status**: done

**Description**: En chat.page: con el trabajo en esperando_aprobacion_plan, una tarjeta muestra el plan (GET /api/chats/:id/idea, Markdown renderizado sin HTML crudo) con tres acciones: Aprobar como scope, Aprobar como work y Pedir cambios (con un textarea obligatorio). En esperando_aprobacion_cierre, una tarjeta con la lista de deuda abierta y la acción Completar aceptando la deuda (con motivo obligatorio). En pr_lista, el link (o los links) de la PR. Acciones deshabilitadas con el motivo mientras corren.

**Evidence**:
- Summary: chat.page muestra la tarjeta del plan (Markdown como datos, sin HTML crudo) con Aprobar como scope/work y Pedir cambios con texto obligatorio, la tarjeta de deuda con Completar aceptando la deuda con motivo obligatorio y los links de la PR en pr_lista; approval-logic.ts decide tarjeta y acciones con motivo de deshabilitado
- Validation: vitest run apps/web: 187 passed (approval-logic.spec.ts: tarjeta por estado, acciones, texto obligatorio, <script> como texto)
- Validation: ng build, lint y format:check sin errores; npm run typecheck sin errores
- Files changed: `apps/web/src/app/chats/chat.page.ts`, `apps/web/src/app/chats/idea-approval.card.ts`, `apps/web/src/app/chats/debt-approval.card.ts`, `apps/web/src/app/chats/chats.service.ts`, `apps/web/src/app/chats/approval-logic.ts`, `apps/web/src/app/chats/approval-logic.spec.ts`, `apps/web/src/styles/components.css`

**Verdict**: pass

---
### P6 — Docs y verificación

> Los docs describen la Idea, el cierre y el merge, y el sprint pasa todos los gates.

#### T6.1: docs: Idea, cierre, merge, estados y cómo probarlo

**Status**: done

**Description**: docs/plan.md: chat Idea y sus tres acciones, cierre del scope o work por el panel, push tras cada cierre, merge genérico y merge-dev, validate_command, secretos, política versión 2 y lo que queda para los sprints 5 y 6. docs/estados.md: kind idea, estados madurando_idea y esperando_aprobacion_plan con su detección, fase merge (trayendo_dev, resolviendo_conflictos, validando_post_merge, abriendo_pr, pr_lista) y motivos nuevos (qa_sin_aprobar, conflicto, build_roto, secretos, merge_sin_pr). docs/panel-desarrollo.md: cómo probar una Idea y un cierre con merge contra un repo de prueba sin tocar repos reales. CLAUDE.md: validate_command en 'Proyectos registrados en el panel'.

**Evidence**:
- Summary: docs al día: plan.md (resumen del sprint 4 y lo que queda para los sprints 5 y 6, sin la frase de que push/PR/merge son del sprint 4), estados.md (idea, aprobación, cierre, fase de merge, motivos nuevos y tablas del piloto), panel-desarrollo.md (cómo probar Idea → aprobación → cierre → PR con un repo de prueba) y CLAUDE.md (validate_command)
- Validation: prettier --check docs CLAUDE.md sin errores
- Validation: cada motivo nuevo de BLOCKED_REASONS (qa_sin_aprobar, secretos, conflicto, build_roto, merge_sin_pr) aparece en docs/estados.md con su señal
- Files changed: `docs/plan.md`, `docs/estados.md`, `docs/panel-desarrollo.md`, `CLAUDE.md`
- Notes: Sin cambios en la VM en este sprint: docs/vm-setup.md no se toca.

**Verdict**: pass

---
#### T6.2: Verificación automática del sprint

**Status**: done

**Description**: Correr typecheck, lint, format:check, test y build del repo. Greps: ningún bypassPermissions ni allowDangerouslySkipPermissions; ningún --force, --force-with-lease ni rebase en apps/api/src; todo comando externo nuevo por execFile con argv; ninguna ruta pública nueva (apps/api/src/http y la allowlist del guard sin cambios). Comprobar que /tmp queda igual antes y después de los tests. kyro analyze sin CRITICAL ni HIGH.

**Evidence**:
- Summary: Verificación automática del sprint 4: typecheck, lint, format:check, test y build en verde; greps de seguridad sin hallazgos nuevos; /tmp igual antes y después de los tests; kyro analyze sin CRITICAL ni HIGH
- Validation: npm run typecheck && lint && format:check && test && build: exit 0 (api 965 passed, web 187 passed, ng build ok)
- Validation: grep bypassPermissions/allowDangerouslySkipPermissions en apps/api/src: ninguno (solo tests y scripts de spike ya existentes)
- Validation: grep --force/force-with-lease/rebase en apps/api/src: solo la lista de denegados de permissions.ts, el texto de la política que lo prohíbe, comentarios y git worktree remove --force de la limpieza ya existente; ningún push ni rebase forzado
- Validation: comandos externos nuevos (git, gh, kyro, validate_command) por execFile con argv; sin exec con shell
- Validation: git diff de apps/api/src/http y apps/api/src/auth vacío; las rutas public: true siguen siendo /api/health y los pasos de login
- Validation: /tmp idéntico antes y después de npm test (diff vacío)
- Validation: kyro analyze: CRITICAL=0 HIGH=0 MEDIUM=5 (escenarios sin cobertura S6, S20, S22, S23 y T6.1 sin scenario_refs)
- Files changed: 
- Notes: El 'ERROR: ... no es un directorio con .agents/kyro/' del log de tests es la salida esperada de un test del CLI.

**Verdict**: pass

---

## Unfinished work

_None — every task is done with a passing verdict._

## Learnings

_No learnings recorded._

## Resolved Debt

- **debt-2**: La base de Bash todavía alcanza los denegados fijos: npm exec -c, git -c core.sshCommand / alias !, go run y python ejecutan cualquier comando; cerrar esos caminos (o un deny por argumento) antes de que el piloto corra solo (R9, R10)
- **debt-3**: WorktreeStateTracker.turnStarted: al retomar tras interrumpido puede volver a esperando_respuesta aunque la pregunta ya se canceló (la etiqueta se corrige al terminar el turno)
- **debt-4**: Los tests de apps/api dejan carpetas panel-* en /tmp (mkdtemp sin limpieza): agotaron los inodos de la VM el 05/10/2026. Limpiar lo creado en afterEach o usar un TMPDIR propio por corrida
- **debt-6**: Verificar el veredicto de kyro-qa (APPROVED / APPROVED WITH NOTES) además de que la sesión de cierre invocó la skill
- **debt-7**: AlreadyRunningError si el usuario manda un mensaje entre waitForIdle y start: el piloto debe reintentar en vez de frenar con otro

## Recommendations for Sprint 5

_None recorded._
