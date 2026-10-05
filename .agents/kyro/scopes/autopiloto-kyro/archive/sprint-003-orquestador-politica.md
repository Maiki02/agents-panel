---
title: 'autopiloto-kyro — Sprint 3: Orquestador y política de gates'
date: '2026-10-05'
scope: 'autopiloto-kyro'
sprint: 3
slug: 'orquestador-politica'
outcome: 'shipped'
type: 'sprint-archive'
---

# Sprint 3: Orquestador y política de gates

> Closed: 2026-10-05
> Outcome: shipped

## Objective

Un scope o work con piloto activo avanza solo de sesión en sesión (plan con el pensante, ejecución y cierre con el ejecutor) decidiendo cada paso por señales de Kyro y del SDK, con la política de gates inyectada, QA y analyze verificados antes de cerrar, frenos con motivo y retoma tras reinicio, probado con runner y Kyro falsos.

## Definition of Done

- Todas las tareas done con evidencia y review pass.
- Un scope de 2 sprints con runner y Kyro falsos llega solo a await_scope_completion con una sesión por paso y el modelo de su rol.
- Ningún cierre de sprint sin QA corrida ni con analyze CRITICAL/HIGH; cada freno deja el motivo en el Timeline con actor pilot.
- debt-2 y debt-3 resueltas; debt-1 sigue diferida al sprint 6.
- typecheck, lint, format:check, test y build en verde y kyro analyze sin CRITICAL/HIGH.
- QA de Kyro (kyro-qa) APPROVED o APPROVED WITH NOTES antes de cerrar.

## Phases

### P1 — Seguridad antes del piloto (debt-2, debt-3)

> Que la base de Bash no alcance los denegados fijos antes de que un piloto corra sin supervisión, y corregir la etiqueta al retomar tras una interrupción.

#### T1.1: Cerrar los caminos de la base hacia los denegados fijos (debt-2)

**Status**: done

**Description**: En apps/api/src/agent/permissions.ts, sumar reglas por argumento para los comandos de la base que ejecutan otros comandos: npm deniega los subcomandos exec, x, explore, edit y el flag --script-shell (y npm config set de script-shell); git deniega la opción global -c y --config-env, --exec-path, git config que escriba (set, --add, --replace-all, alias.*, core.sshCommand, core.pager, core.hooksPath, core.editor) y la invocación de alias definidos con ! que no se puedan resolver (o, más simple, git config solo con --get/--list/-l); go deniega generate y la variable GOFLAGS con -toolexec (go run y go test siguen, el plan los acepta como código del repo). Una asignación de variable al principio (GIT_SSH_COMMAND=… git push) ya se deniega por primera palabra: cubrirla con test. Mensaje de denegación claro para que el agente se adapte. Actualizar docs/plan.md (el párrafo de la base deja de decir que los caminos quedan como deuda) y resolver debt-2 con kyro debt resolve.

**Evidence**:
- Summary: checkBaseArgs en permissions.ts: reglas por argumento para npm (exec/x/explore/edit/script-shell), git (-c, --config-env, --exec-path, config solo lectura, upload-pack/receive-pack/exec, ext::, rebase --exec, bisect run, submodule foreach, filter-branch) y go (generate, -exec, -toolexec, -vettool, env -w/-u). docs/plan.md actualizado.
- Validation: vitest test/permissions.test.ts: 164 passed (33 denegados y 29 permitidos nuevos, incluido GIT_SSH_COMMAND=ssh git push)
- Validation: tsc --noEmit y eslint sin errores
- Files changed: `apps/api/src/agent/permissions.ts`, `apps/api/test/permissions.test.ts`, `docs/plan.md`
- Notes: La suite completa falla por ENOSPC en /tmp (decenas de miles de directorios panel-* viejos), ajeno a este cambio; no se limpió /tmp.

**Verdict**: pass

---
#### T1.2: Retomar tras interrumpido sin volver a esperando_respuesta (debt-3)

**Status**: done

**Description**: En WorktreeStateTracker.turnStarted, cuando el estado actual es interrumpido o error y previousState es esperando_respuesta (o esperando_permiso), volver al estado anterior a la pregunta si se conoce o a planificando, nunca a un estado de espera de pregunta: la pregunta ya fue cancelada al reiniciar. Test de regresión. Resolver debt-3.

**Evidence**:
- Summary: WorktreeStateTracker.resumeState: al retomar desde interrumpido/error con previousState esperando_respuesta o esperando_permiso vuelve al estado previo a la pregunta (según el Timeline) o a planificando; nunca a una espera de pregunta.
- Validation: vitest suite completa de apps/api con TMPDIR=/dev/shm: 37 archivos, 752 tests pasan (2 tests de regresión nuevos en worktree-state.test.ts)
- Validation: tsc --noEmit y eslint sin errores
- Files changed: `apps/api/src/worktrees/state-tracker.ts`, `apps/api/test/worktree-state.test.ts`
- Notes: /tmp de la VM sin inodos (decenas de miles de panel-* viejos): los tests se corrieron con TMPDIR=/dev/shm. No se limpió /tmp.

**Verdict**: pass

---
### P2 — Política de gates versionada (R16)

> La política que pre-aprueba los gates rutinarios de Kyro vive en un archivo versionado del panel, cubre cada gate conocido y deja en pregunta lo que no cubre.

#### T2.1: Archivo de política con versión, bloques por paso y test de cobertura de gates

**Status**: done

**Description**: apps/api/src/pilot/policy.ts: POLICY_VERSION, KNOWN_GATES (execute_task, review_task, qa_or_close, close_sprint, await_scope_completion, clarify, plan_sprint, regla nueva global, deuda corregible y no corregible, commit de cierre, repair, scope complete, accept-open-debt, kyro-sprint-executor) con la cláusula de política que lo cubre y su decisión (proceder, parar, preguntar). buildPolicy(step) devuelve el bloque de texto para el paso (plan, ejecución, cierre) partiendo del texto probado en el spike H2 (docs/plan.md) más lo que pidieron los sprints 1 y 2: quién hace el review (maker y checker con --by distintos), parar en qa_or_close en la sesión de ejecución, en la sesión de cierre correr la skill kyro-qa siempre y cerrar solo con APPROVED o APPROVED WITH NOTES y analyze sin CRITICAL/HIGH, reglas nuevas solo del scope (candidatas a globales listadas al final), deuda corregible sin decisión nueva se corrige y el resto kyro debt defer con motivo, commit al cerrar el sprint (Conventional Commits, sin push: el push y el merge son del sprint 4), nunca kyro repair apply, nunca kyro scope complete ni --accept-open-debt, nunca kyro-sprint-executor, ADR con kyro adr por cada decisión tomada sin preguntar, preguntar con AskUserQuestion solo por decisión material, costo o clarify, rutas absolutas y sin echo ni redirecciones (llamadas denegadas en el spike). gateDecision(gate) devuelve 'ask' para un gate desconocido.

**Evidence**:
- Summary: apps/api/src/pilot/policy.ts: POLICY_VERSION, KNOWN_GATES (16 gates con cláusula, keyword, decisión y pasos), gateDecision (ask para lo desconocido) y buildPolicy(plan|execute|close) partiendo del texto del spike H2 más review con --by distinto, parada en qa_or_close, QA obligatoria y cierre con APPROVED/analyze limpio, reglas solo del scope, deuda, commit sin push, sin repair apply/scope complete/--accept-open-debt/kyro-sprint-executor, ADR y rutas absolutas. POLICY_VERSION exportado para T3.4.
- Validation: vitest test/pilot-policy.test.ts: 7 tests pasan (cobertura de gates, gate desconocido=ask, sin kyro-sprint-executor salvo prohibirlo ni bypassPermissions, execute para en qa_or_close, versión en cada paso)
- Validation: tsc --noEmit y eslint sin errores
- Files changed: `apps/api/src/pilot/policy.ts`, `apps/api/test/pilot-policy.test.ts`
- Notes: TMPDIR=/dev/shm por /tmp sin inodos.

**Verdict**: pass

---
### P3 — Orquestador (R6, R7, R8, R10, R11, R15, R20)

> El piloto decide el paso por señales, abre una sesión nueva por paso con el modelo del rol, verifica los gates de calidad, frena con motivo y se retoma tras un reinicio.

#### T3.1: Tabla autopilot_runs, repositorio y activación del piloto por la API

**Status**: done

**Description**: Migración 12: autopilot_runs (chat_id PK con CASCADE, status: active | paused | off | stopped | waiting_quota | queued | finished, step actual, sprint_n, sessions_in_sprint, last_fingerprint JSON, stop_reason, retry_at, policy_version, created_at, updated_at) y agent_sessions suma step (plan | execute | fix | close | manual) y policy_version. AutopilotRunRepository con transiciones explícitas. Tipos en packages/shared (AutopilotStatus, AutopilotStep, AutopilotRun). API con sesión y CSRF: POST /api/chats con autopilot: true opcional (solo scope y work; 400 en direct), GET /api/chats/:id/autopilot y POST /api/chats/:id/autopilot { action: 'pause' | 'resume' | 'off' } con 409 si la acción no corresponde al estado. El tope de sesiones por sprint es configurable (variable de entorno del panel PILOT_MAX_SESSIONS_PER_SPRINT, por defecto 6, en .env.example).

**Evidence**:
- Summary: Migración 12 (autopilot_runs; agent_sessions suma step y policy_version), AutopilotRunRepository con transiciones explícitas, tipos en shared, rutas GET/POST /api/chats/:id/autopilot (pause|resume|off, 409 si no corresponde, 404 en direct), POST /api/chats con autopilot:true (400 en direct), PILOT_MAX_SESSIONS_PER_SPRINT (6 por defecto) en config y .env.example.
- Validation: vitest apps/api completo (TMPDIR=/dev/shm): 39 archivos, 774 tests pasan (db migración 12, repo, rutas 401/403/404/409/400, tope de sesiones)
- Validation: tsc --noEmit, eslint y typecheck de workspaces sin errores
- Files changed: `apps/api/src/db/migrations.ts`, `apps/api/src/pilot/runs-repo.ts`, `apps/api/src/pilot/routes.ts`, `apps/api/src/chats/service.ts`, `apps/api/src/chats/routes.ts`, `apps/api/src/app.ts`, `packages/shared/src/index.ts`, `apps/api/.env.example`, `apps/api/test/db.test.ts`, `apps/api/test/pilot-runs.test.ts`

**Verdict**: pass

---
#### T3.2: Decisor puro del paso siguiente y detector de avance

**Status**: done

**Description**: apps/api/src/pilot/decide.ts: decideNextStep(kyro: KyroScopeState | KyroWorkState, run, lastSession) puro, que devuelve { kind: 'session', step, role } o { kind: 'stop', state, blockedReason, detail } o { kind: 'check_quality' }. Scope: plan_sprint → plan (pensante); execute_task y review_task → execute (ejecutor); qa_or_close → check_quality (T3.4 corre analyze y decide fix o close); clarify → stop esperando_aclaracion; blockers del CLI → stop bloqueado kyro_bloqueado (integridad_kyro si el bloqueo pide repair); tarea bloqueada → stop tarea_bloqueada; await_scope_completion → stop (cierre y merge son del sprint 4); done → finished. Work: plan_tasks → plan (pensante); execute_task y review_task → execute; resolve_blocker → stop tarea_bloqueada; ready_to_close → stop (sprint 4). fingerprint(kyro) = nextAction, nextTaskId, sprint actual y cerrados, tareas hechas, deuda abierta y pendientes de review; progressed(before, after) compara fingerprints. Sin avance (mismo fingerprint, sesión sin pregunta respondida) → stop sin_avance. sessions_in_sprint >= tope → stop tope_de_sesiones. El texto del agente no es una entrada de la función (L1).

**Evidence**:
- Summary: apps/api/src/pilot/decide.ts: decideNextStep puro (session plan/execute con rol, stop con estado y motivo, check_quality, finished), fingerprint y progressed, guardas sin_avance y tope_de_sesiones (configurable, 6 por defecto). El texto del agente no es entrada (LastSession solo trae result y answeredQuestion). KyroScopeState suma blockedTasks opcional leído de execution.blockedTasks.
- Validation: vitest apps/api completo: 39 archivos pasan (28 tests nuevos de pilot-decide con las fixtures reales de scope y work, S8, S12, await_scope_completion con sprint abierto y no_ready_work)
- Validation: tsc --noEmit y eslint sin errores
- Files changed: `apps/api/src/pilot/decide.ts`, `apps/api/src/kyro/state.ts`, `apps/api/test/pilot-decide.test.ts`

**Verdict**: pass

---
#### T3.3: Prompts de cada paso armados por el panel y chequeo de capacidades

**Status**: done

**Description**: apps/api/src/pilot/prompts.ts: buildStepPrompt(step, ctx) arma el primer mensaje de cada sesión del piloto con: qué skill cargar (kyro-forge para plan, ejecución y fix; kyro-qa y después kyro-forge para cierre; kyro-work para un Work), el contexto de la tarea que sale de kyro context-pack --kyro-scope <scope> --task --verbosity detailed --json (scope, sprint, nextAction, nextTaskId, descripción, archivos, criterios, escenarios, deuda, convenciones), los hallazgos de analyze para el paso fix, y el bloque de política de T2.1 para ese paso. KyroReader suma contextPackTask(cwd, scope) y capabilities(cwd) por execFile con argv. Antes de cada paso el piloto exige que kyro capabilities --json incluya record-evidence, review, close-sprint, analyze y context-pack; si falta alguno → stop kyro_bloqueado con el detalle.

**Evidence**:
- Summary: pilot/prompts.ts: buildStepPrompt(plan|execute|fix|close) con la skill correcta (kyro-forge; kyro-qa y luego kyro-forge en el cierre; kyro-work para un Work), contexto de la tarea, hallazgos de analyze en fix y el bloque de política de su paso; checkCapabilities frena con kyro_bloqueado si falta record-evidence, review, close-sprint, analyze o context-pack. KyroReader suma contextPackTask, workContextPack y capabilities (execFile con argv); state.ts suma parseScopeTaskContext, parseWorkTaskContext y parseCapabilities. Fixtures reales nuevas (capabilities.json, context-pack-task.execute_task.json) y capture.sh actualizado.
- Validation: vitest apps/api completo: 41 archivos, 825 tests pasan (19 de pilot-prompts con fixtures y 4 nuevos de kyro-reader)
- Validation: tsc --noEmit y eslint sin errores
- Files changed: `apps/api/src/pilot/prompts.ts`, `apps/api/src/kyro/reader.ts`, `apps/api/src/kyro/state.ts`, `apps/api/test/pilot-prompts.test.ts`, `apps/api/test/kyro-reader.test.ts`, `apps/api/test/fixtures/kyro/capture.sh`

**Verdict**: pass

---
#### T3.4: Bucle del piloto: una sesión nueva por paso, gate de calidad y frenos

**Status**: done

**Description**: apps/api/src/pilot/autopilot.ts: servicio Autopilot que, para cada run active, lee Kyro, llama a decideNextStep y abre una sesión SDK nueva (AgentManager.start con { role, step, freshSession: true } que no reanuda chat.sdkSessionId) con el prompt de T3.3; espera el fin del turno, vuelve a leer Kyro, compara fingerprints y repite o frena. qa_or_close: el piloto corre kyro analyze --kyro-scope <scope> --json; con CRITICAL o HIGH abre un paso fix (ejecutor) con los hallazgos; limpio, abre el paso close. Tras el close verifica que la sesión invocó la skill kyro-qa (evento tool_use de Skill con kyro-qa) y que el ledger creció; si cerró sin QA → stop bloqueado con motivo nuevo qa_sin_correr (sumarlo a BLOCKED_REASONS). Cada transición del piloto usa actor 'pilot' y registra paso, rol, modelo y versión de política. Pregunta pendiente: el piloto no hace nada hasta que el turno termina (la respuesta vuelve a la misma sesión). Tope de 4 sesiones lleno → run queued y estado en_cola; se reintenta al liberarse una sesión. rate_limit_event con status rejected o resultado por límite de uso → waiting_quota, estado sin_cupo_de_uso y reintento cada 15 minutos (reloj inyectable). Pausa → no abre el paso siguiente; off → el chat vuelve al modo manual. El piloto nunca toca permissionMode ni bypassPermissions (usa buildQueryOptions).

**Evidence**:
- Summary: pilot/autopilot.ts: servicio Autopilot (drive/kick/drainQueue) que lee Kyro, decide con decideNextStep y abre una sesión SDK nueva por paso (AgentManager.start con pilot{step,policyVersion,sprintN} y freshSession); qa_or_close corre kyro analyze (HIGH/CRITICAL → fix, limpio → close); verifica kyro-qa tras el cierre (qa_sin_correr, motivo nuevo); cola con 4 sesiones, sin_cupo_de_uso con reintento a 15 min, pausa y apagado; transiciones con actor pilot. Soporte: AutopilotRunRepository (queue/dequeue/waitForQuota/retryAfterQuota/beginSession/listByStatus), KyroReader.analyze, ChatRepository.lastSeq/allEventsAfter, TurnInfo.pilot y WorktreeStateTracker.pilotMark, cableado en app.ts, ChatService y rutas (onResume/onAutopilotStart). docs/plan.md y docs/estados.md actualizados.
- Validation: vitest apps/api completo: 42 archivos, 841 tests pasan (16 de pilot-autopilot con runner y Kyro falsos: S7 dos sprints, S9, S11, S12, S21, cola, pausa, apagado, texto del agente)
- Validation: tsc --noEmit, eslint y typecheck de workspaces sin errores
- Files changed: `apps/api/src/pilot/autopilot.ts`, `apps/api/src/agent/manager.ts`, `apps/api/src/chats/sessions-repo.ts`, `apps/api/src/worktrees/state-tracker.ts`, `apps/api/src/app.ts`, `packages/shared/src/index.ts`, `apps/api/test/pilot-autopilot.test.ts`, `docs/plan.md`, `docs/estados.md`

**Verdict**: pass

---
#### T3.5: Retoma de los pilotos activos al arrancar el panel

**Status**: done

**Description**: Al arrancar (app.ts), después de marcar interrumpidos los chats que estaban corriendo, el Autopilot retoma cada run active o waiting_quota o queued sin mensaje del usuario: si el paso en curso tenía una sesión SDK, la reanuda con resume y un prompt corto de continuación del mismo paso (cuenta como sesión del sprint); si no, vuelve a decidir desde Kyro. Un run paused u off no se retoma. El tope de sesiones por sprint corta reintentos en bucle tras reinicios repetidos.

**Evidence**:
- Summary: Autopilot.resumeAll (llamado en onReady de app.ts tras marcar interrumpidos): un run active con sesión SDK abierta retoma el mismo paso con resume del sdk_session_id y un prompt corto de continuación (cuenta como sesión del sprint); sin sesión abierta vuelve a decidir desde Kyro; paused y off no se retoman; waiting_quota respeta retry_at; en el tope de sesiones frena con tope_de_sesiones. Soporte: AgentSessionRepository.lastOpen/closeOpen, AutopilotRunRepository.countSession y settle() extraído del bucle.
- Validation: vitest apps/api completo: 42 archivos, 846 tests pasan (5 nuevos de reinicio: S16, pausado/apagado, retry_at, tope, entre pasos)
- Validation: tsc --noEmit y eslint sin errores
- Files changed: `apps/api/src/pilot/autopilot.ts`, `apps/api/src/app.ts`, `apps/api/src/chats/sessions-repo.ts`, `apps/api/src/pilot/runs-repo.ts`, `apps/api/test/pilot-autopilot.test.ts`

**Verdict**: pass

---
### P4 — Docs y verificación

> Los docs describen el piloto real y el sprint pasa todos los gates automáticos.

#### T4.1: docs: piloto, política, estados y cómo probarlo

**Status**: done

**Description**: docs/plan.md: el orquestador (pasos, roles, sesión de cierre separada, prompt armado por el panel, gate de analyze y verificación de QA, frenos, cola, sin cupo, retoma, versión de política) y la actualización de D3 con la decisión del 05/10/2026. docs/estados.md: estados y motivos que ahora usa el piloto (en_cola, sin_cupo_de_uso, pausado, bloqueado con qa_sin_correr, sin_avance, tope_de_sesiones), actor pilot y la tabla autopilot_runs. docs/panel-desarrollo.md: cómo activar, pausar y apagar el piloto por la API y una prueba sugerida con un work de prueba (D31), y la nota de que cerrar la terminal corta el panel hasta tener systemd (usar tmux). apps/api/.env.example con la variable del tope.

**Evidence**:
- Summary: docs: plan.md registra la D3 actualizada (sesión de cierre separada, analyze del panel, prompt armado por el panel), la retoma tras reinicio y lo que falta; estados.md lista cada estado y motivo que escribe el piloto con su señal y actor pilot, la tabla autopilot_runs y actualiza los motivos y los estados todavía no detectados; panel-desarrollo.md suma «Probar el piloto automático (por la API)» con la nota de tmux hasta tener systemd. .env.example ya traía PILOT_MAX_SESSIONS_PER_SPRINT (T3.1).
- Validation: revisión de los tres docs contra el código: estados, motivos, rutas y variables coinciden con apps/api/src/pilot y packages/shared
- Validation: git diff --stat: solo docs
- Files changed: `docs/plan.md`, `docs/estados.md`, `docs/panel-desarrollo.md`, `apps/api/.env.example`

**Verdict**: pass

---
#### T4.2: Verificación automática del sprint

**Status**: done

**Description**: Correr typecheck, lint, format:check, tests y build del repo. Greps: ningún bypassPermissions ni allowDangerouslySkipPermissions en el código, ningún kyro-sprint-executor en prompts del piloto salvo la prohibición, todo comando externo nuevo por execFile con argv, ninguna ruta pública nueva (allowlist del guard sin cambios). kyro analyze sin CRITICAL ni HIGH.

**Evidence**:
- Summary: Verificación automática del sprint 3: typecheck, lint, format:check, test y build salen con 0; 1012 tests (846 api + 166 web). Greps: sin bypassPermissions ni allowDangerouslySkipPermissions en apps/api, apps/web ni packages/shared; kyro-sprint-executor solo en policy.ts como cláusula que lo prohíbe; los únicos exec( son db.exec de SQLite (ningún comando externo nuevo sin execFile); apps/api/src/http y auth sin cambios (allowlist pública intacta, las rutas nuevas /api/chats/:id/autopilot exigen sesión y CSRF con test 401/403). kyro analyze: 9 MEDIUM, 0 CRITICAL ni HIGH.
- Validation: npm run typecheck, lint, format:check, test, build: todos exit 0; 42 archivos y 846 tests en api, 19 archivos y 166 en web
- Validation: grep bypassPermissions|allowDangerouslySkipPermissions, kyro-sprint-executor, exec(, git diff de http/auth: sin hallazgos
- Validation: kyro analyze --kyro-scope autopiloto-kyro: MEDIUM 9, sin CRITICAL ni HIGH
- Files changed: 

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

## Recommendations for Sprint 4

_None recorded._
