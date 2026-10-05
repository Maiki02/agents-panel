---
title: 'autopiloto-kyro — Sprint 2: Modelos por rol, estado fino y permisos por proyecto'
date: '2026-10-05'
scope: 'autopiloto-kyro'
sprint: 2
slug: 'modelos-estado-permisos'
outcome: 'partial'
type: 'sprint-archive'
---

# Sprint 2: Modelos por rol, estado fino y permisos por proyecto

> Closed: 2026-10-05
> Outcome: partial

## Objective

Cada sesión del agente corre con el modelo de su rol y queda registrada, cada trabajo tiene un estado fino con Timeline leído de Kyro después de cada turno, y cada proyecto puede sumar comandos y hosts de curl permitidos sin tocar la base ni los denegados fijos.

## Definition of Done

- Todas las tareas están done con evidencia y veredicto pass.
- Cada sesión del agente queda registrada con rol, proveedor, modelo y sdk_session_id, y ninguna corre con bypassPermissions.
- Cada trabajo con worktree tiene estado fino y Timeline con actor, actualizados después de cada turno a partir de la CLI de Kyro.
- Los permisos por proyecto amplían la base sin poder habilitar los denegados fijos, curl queda restringido y cambiarlos exige TOTP.
- typecheck, lint, format:check, tests y build pasan; ninguna ruta pública nueva; docs/estados.md y docs/plan.md al día.
- debt-1 resuelta con el recorrido manual, o diferida otra vez con su motivo.

## Phases

### P1 — Modelos por rol (WS3)

> Configurar modelo pensante y ejecutor por proyecto con override por chat, pasar model al SDK y registrar rol y modelo de cada sesión.

#### T1.1: Catálogo de modelos, configuración por proyecto y override al crear un chat

**Status**: done

**Description**: En packages/shared: tipos ModelRole ('thinker' | 'executor'), ModelProvider ('claude'), catálogo MODEL_CATALOG por proveedor (claude-opus-5-5, claude-sonnet-5-5, claude-fable-5-1, claude-haiku-4-5-20251001) y DEFAULT_MODELS (pensante claude-opus-5-5, ejecutor claude-sonnet-5-5). Migración nueva (siguiente número libre): projects suma provider, thinker_model y executor_model (NULL = valor por defecto global); chats suma provider, thinker_model y executor_model NOT NULL, resueltos al crear el chat (override del chat > proyecto > defecto) para que cambiar el proyecto después no cambie un trabajo en curso; las filas existentes se completan con los valores por defecto. API: GET y PUT /api/projects/:id/models (sesión + CSRF; sin TOTP porque no expone secretos ni cambia costos) y POST /api/chats acepta models opcional { thinker?, executor? }. Un modelo fuera del catálogo del proveedor da 400 y no guarda nada. Project y Chat de shared exponen los modelos.

**Evidence**:
- Summary: Catálogo de modelos en shared; migración 8 (projects NULL=default, chats NOT NULL con defaults) con test que verifica el relleno de filas existentes; GET/PUT /api/projects/:id/models con validación contra catálogo (400 sin guardar); POST /api/chats acepta models con override>proyecto>default resuelto al crear; Project y Chat exponen models.
- Validation: npm run typecheck (shared, api, web) sin errores
- Validation: npm test -w apps/api: 31 archivos pasan (nuevo projects-models.test.ts y test de migración 8 en db.test.ts)
- Validation: eslint y prettier --check limpios
- Files changed: `packages/shared/src/index.ts`, `apps/api/src/db/migrations.ts`, `apps/api/src/projects/repo.ts`, `apps/api/src/projects/routes.ts`, `apps/api/src/chats/repo.ts`, `apps/api/src/chats/routes.ts`, `apps/api/src/chats/service.ts`, `apps/api/test/projects-models.test.ts`, `apps/api/test/db.test.ts`, `apps/api/test/cli.test.ts`, `apps/api/test/worktrees.test.ts`

**Verdict**: pass

---
#### T1.2: El runner pasa model y cada sesión queda registrada con su rol y modelo

**Status**: done

**Description**: RunParams suma model y role; SdkRunner arma las opciones de query() en una función pura (buildQueryOptions) que pasa model y que se puede testear, y nunca usa bypassPermissions. Tabla nueva agent_sessions (chat_id, role, provider, model, sdk_session_id, sprint_n NULL, started_at, ended_at, result) que el orquestador del sprint 3 usa para contar sesiones por sprint. AgentManager.start(chatId, text, { role }) resuelve el modelo del rol desde el chat, abre la fila de agent_sessions, registra el evento session_started { role, provider, model } y cierra la fila con el resultado del turno; si system:init informa un modelo distinto del pedido, registra un evento model_mismatch. Rol de los turnos manuales hasta que exista el piloto: el primer turno de un chat scope o work (INIT o plan) usa el pensante; los siguientes y los pedidos directos usan el ejecutor. FakeRunner registra el model y el role que recibe.

**Evidence**:
- Summary: RunParams suma model y role; buildQueryOptions pura (model, acceptEdits, sin bypass); migración 9 agent_sessions + AgentSessionRepository; AgentManager.start(chatId, text, {role}) resuelve el modelo del chat, abre/cierra la fila de sesión con sdk_session_id y resultado, registra session_started {role, provider, model} y model_mismatch si system:init reporta otro modelo; ChatService usa pensante en el primer turno de scope/work y ejecutor en el resto y en directos.
- Validation: npm run typecheck sin errores
- Validation: npm test -w apps/api: 32 archivos, 518 tests pasan (nuevos: sdk-runner.test.ts, roles/sesiones/model_mismatch en agent.test.ts, roles en chats.test.ts)
- Validation: eslint y prettier --check limpios
- Files changed: `apps/api/src/agent/runner.ts`, `apps/api/src/agent/sdk-runner.ts`, `apps/api/src/agent/manager.ts`, `apps/api/src/chats/service.ts`, `apps/api/src/chats/sessions-repo.ts`, `apps/api/src/db/migrations.ts`, `apps/api/src/app.ts`, `packages/shared/src/index.ts`, `apps/api/test/sdk-runner.test.ts`, `apps/api/test/agent.test.ts`, `apps/api/test/chats.test.ts`, `apps/api/test/db.test.ts`

**Verdict**: pass

---
### P2 — Estado fino y Timeline (WS4)

> Guardar el estado fino de cada trabajo y sus transiciones, leído de Kyro después de cada turno, con actor, rol y modelo.

#### T2.1: Tablas worktree_state y worktree_transitions con su repositorio y API de lectura

**Status**: done

**Description**: Migración nueva: worktree_state (chat_id PK, state, detail, phase, sprint_current, sprint_closed, sprint_total, task_done, task_total, open_debt, blocked_reason, actor, role, model, since, previous_state) y worktree_transitions (id, chat_id, from_state, to_state, reason, actor, role, model, data JSON, created_at). WorktreeStateRepository.transition() escribe las dos en una transacción y publica un evento state_changed por el bus de SSE del chat; registrar el mismo estado con otro detalle o avance actualiza la fila sin sumar transición. En shared: WorktreeStateId con el catálogo de docs/estados.md, Actor ('user' | 'pilot' | 'agent' | 'system'), BlockedReason (sin_avance, tope_de_sesiones, tarea_bloqueada, kyro_bloqueado, integridad_kyro, git, otro) y los tipos de estado y transición. API: GET /api/chats/:id/state y GET /api/chats/:id/timeline (sesión; solo lectura). Un chat directo no tiene estado fino: 404 o null documentado.

**Evidence**:
- Summary: Migración 10 (worktree_state, worktree_transitions con CASCADE y CHECK de actor); catálogo WORKTREE_STATE_IDS, Actor, BlockedReason y tipos en shared; WorktreeStateRepository.transition() escribe estado+transición en una transacción con actor obligatorio y publica state_changed (el mismo estado solo actualiza la fila); GET /api/chats/:id/state y /timeline (sesión, 404 para chat directo, state null antes de la primera transición).
- Validation: npm run typecheck sin errores
- Validation: npm test -w apps/api: 33 archivos, 528 tests pasan (worktree-state.test.ts nuevo, migración 10 en db.test.ts)
- Validation: eslint y prettier limpios
- Files changed: `packages/shared/src/index.ts`, `apps/api/src/db/migrations.ts`, `apps/api/src/worktrees/state-repo.ts`, `apps/api/src/chats/routes.ts`, `apps/api/src/app.ts`, `apps/api/test/worktree-state.test.ts`, `apps/api/test/db.test.ts`

**Verdict**: pass

---
#### T2.2: Lector de Kyro por worktree y mapeo de nextAction a estado fino

**Status**: done

**Description**: KyroReader (apps/api/src/kyro/reader.ts) corre en el worktree, con execFile y argv y un timeout, kyro context-pack --kyro-scope <s> --json y kyro status full --kyro-scope <s> --json, y lee roadmap y ledger del sprint.json (solo lectura) para un scope; para un Work, kyro work status --work <slug> --json. El scope sale de activeScope en .agents/kyro/local.json del worktree; el Work, del único Work del worktree según la CLI (confirmar el comando con la fixture o kyro work --help). El ejecutor de comandos se inyecta para testear con las fixtures del sprint 1. Si context-pack y status no coinciden en nextAction (KyroStateError), se vuelve a leer una vez. Una función pura mapKyroState(estado de Kyro) devuelve estado fino, fase, sprint n/m, tarea n/m, deuda y motivo de bloqueo: plan_sprint → planificando, clarify → esperando_aclaracion, execute_task → escribiendo_codigo, review_task → revisando_tarea, qa_or_close → qa, close_sprint → cerrando_sprint, await_scope_completion → esperando_aprobacion_cierre, done → terminado; Work: plan_tasks → planificando, resolve_blocker → bloqueado con blockedReason, ready_to_close → cerrando y done → terminado. Un blocker de Kyro → bloqueado con el motivo kyro_bloqueado.

**Evidence**:
- Summary: KyroReader (execFile con argv, timeout, ejecutor inyectable) lee el scope desde local.json del worktree (context-pack + status full + sprint.json solo lectura, reintenta una vez si no coinciden) y el Work (único del worktree o slug dado); devuelve resultados tipados {ok,error{kind}} sin lanzar. mapKyroState pura mapea cada nextAction de scope y de Work al estado fino con fase, sprint n/m, tarea n/m, deuda y motivo; blocker de Kyro → bloqueado/kyro_bloqueado; Work resolve_blocker → bloqueado/tarea_bloqueada. Se suman 'cerrando' y 'terminado' al catálogo de shared (documentación en T2.4).
- Validation: npm run typecheck sin errores
- Validation: npm test -w apps/api: 35 archivos, 553 tests pasan (kyro-reader.test.ts y kyro-map-state.test.ts nuevos, con fixtures reales)
- Validation: eslint y prettier limpios
- Files changed: `apps/api/src/kyro/reader.ts`, `apps/api/src/kyro/map-state.ts`, `apps/api/test/kyro-reader.test.ts`, `apps/api/test/kyro-map-state.test.ts`, `packages/shared/src/index.ts`

**Verdict**: pass

---
#### T2.3: El estado se actualiza tras cada turno, pregunta, respuesta y arranque del panel

**Status**: done

**Description**: Un WorktreeStateTracker conecta AgentManager con el repositorio y el lector. Al crear un chat scope o work registra creando_worktree e instalando_dependencias (actor system) con los eventos del setup que hoy se guardan en buffered. Al empezar un turno registra el rol y el modelo de la sesión; al terminar lee Kyro y transiciona al estado mapeado (actor agent), con el actor de quién tiene que mover: si el turno terminó y no hay piloto, le toca al usuario. Una pregunta pendiente pasa a esperando_respuesta (actor agent) y al responderla vuelve al estado anterior (actor user). Un fallo al leer Kyro deja error con el detalle, sin romper el turno ni el chat. Al arrancar el panel, cada trabajo que estaba en running pasa a interrumpido (actor system). Los chats directos no tienen estado fino.

**Evidence**:
- Summary: WorktreeStateTracker (TurnObserver) conectado a AgentManager, ChatService y app.ts: al crear scope/work registra creando_worktree e instalando_dependencias (system) con los pasos del setup; al empezar un turno registra rol y modelo (primer turno → planificando); al terminar lee Kyro (lector inyectable) y transiciona al estado mapeado con actor agent, rol, modelo, tarea n/m y waitingOn=user; pregunta → esperando_respuesta (agent) y respuesta → estado previo (user); lector que falla → error con detalle y chat usable; al arrancar los running pasan a interrumpido (system) y reanudar vuelve al estado previo (user); chats directos sin estado. Un fallo del tracker nunca rompe el turno.
- Validation: npm run typecheck sin errores
- Validation: npm test -w apps/api: 35 archivos, 560 tests pasan (7 tests nuevos del tracker en worktree-state.test.ts con lector falso y fixtures)
- Validation: eslint y prettier limpios
- Files changed: `apps/api/src/worktrees/state-tracker.ts`, `apps/api/src/agent/manager.ts`, `apps/api/src/chats/service.ts`, `apps/api/src/chats/repo.ts`, `apps/api/src/app.ts`, `apps/api/test/worktree-state.test.ts`, `apps/api/test/chats.test.ts`

**Verdict**: pass

---
#### T2.4: docs/estados.md y docs/plan.md con la detección real del estado fino

**Status**: done

**Description**: Actualizar docs/estados.md: la sección 'Cómo lo implementa el panel' describe las tablas reales (worktree_state, worktree_transitions, agent_sessions), qué estados se detectan hoy y con qué señal (tabla nextAction → estado de T2.2, preguntas, arranque), el actor de cada transición, los motivos de bloqueo (incluidos sin_avance y tope_de_sesiones, que los dispara el piloto del sprint 3) y los ids nuevos si T2.2 los agregó. Marcar qué estados del catálogo todavía no se detectan (builds, PR, limpieza) y en qué etapa llegan. docs/plan.md: modelos por rol (catálogo, defecto, override por chat, regla de rol de los turnos manuales) y permisos por proyecto, en las secciones de la etapa.

**Evidence**:
- Summary: docs/estados.md: sección 'Cómo lo implementa el panel' reescrita con las tablas reales (worktree_state, worktree_transitions, agent_sessions), tabla de estados detectados hoy con su señal y actor, mapeo nextAction→estado de scope y Work, ids nuevos (cerrando, terminado), catálogo de motivos de bloqueo (incluidos sin_avance y tope_de_sesiones del piloto) y lista de estados aún no detectados con su etapa. docs/plan.md: modelos por rol (catálogo, defecto, override, regla de rol provisoria) y permisos de Bash por proyecto (base, denegados fijos, curl restringido, TOTP, sugerencias) tal como quedaron.
- Validation: npx prettier --check docs/estados.md docs/plan.md limpio
- Validation: Contrastado con el código: ids de estado, motivos de bloqueo y rutas coinciden con packages/shared y apps/api
- Files changed: `docs/estados.md`, `docs/plan.md`

**Verdict**: pass

---
### P3 — Permisos de comandos por proyecto (WS15)

> Que cada proyecto sume comandos y hosts de curl permitidos, con la base fija, los denegados fijos imposibles de habilitar y curl restringido.

#### T3.1: Política de Bash por proyecto, denegados fijos y parser de curl restringido

**Status**: done

**Description**: En apps/api/src/agent/permissions.ts: FIXED_DENIED_COMMANDS (oci, tailscale, terraform, sudo, su, ssh, scp, sftp, nc, ncat, socat, wget); PermissionPolicy suma bashExtras { commands, hosts }; checkBash recibe la política y permite base + extras − denegados fijos (un denegado fijo se deniega aunque esté en la configuración). curl siempre en modo restringido y nunca en la lista de auto-aprobados: solo GET o HEAD (-I), solo a localhost o 127.0.0.1 o a un host de la política, sin -L, -d/--data*, -F, -T, -X, -o/-O, --output, -K/--config ni @archivo; URL con esquema http o https y host comparado después de parsearla con URL, sin credenciales en la URL. validateProjectPermissions() valida que cada comando sea un nombre simple (sin rutas, espacios ni metacaracteres) y que no sea un denegado fijo ni de la base, y que cada host sea un hostname válido. AgentManager carga la política del proyecto del chat en cada turno.

**Evidence**:
- Summary: Corrección de kyro qa: COMMAND_RUNNERS (shells y envoltorios: bash, sh, env, xargs, nohup, timeout, time, watch…) y NEVER_ENABLED_COMMANDS = denegados fijos + envoltorios; validateProjectPermissions los rechaza como extras (400) y checkBash los deniega como primera palabra de cualquier etapa aunque una configuración vieja los tenga guardados. GET /permissions los devuelve en fixedDenied y la tab Permisos explica por qué. docs/plan.md corregido (envoltorios, caminos de la base como deuda, tab Permisos entregada en el sprint 2).
- Validation: npm run typecheck: exit 0
- Validation: npm run lint: exit 0
- Validation: npm run format:check: exit 0
- Validation: npm test: API 684 passed, web 166 passed
- Validation: Tests nuevos: cada COMMAND_RUNNER denegado aun configurado ('env sudo id', 'bash -c tailscale', 'git ls-files | xargs ssh' → deny); PUT con env o xargs → 400 sin guardar
- Files changed: `apps/api/src/agent/permissions.ts`, `apps/api/src/projects/permissions-routes.ts`, `apps/web/src/app/projects/permissions.section.ts`, `apps/api/test/permissions.test.ts`, `apps/api/test/projects-permissions.test.ts`, `docs/plan.md`

**Verdict**: pass

---
#### T3.2: Columnas de permisos del proyecto, API con TOTP y sugerencias por lockfiles

**Status**: done

**Description**: Migración nueva: projects suma allowed_commands y allowed_hosts (JSON, por defecto lista vacía). GET /api/projects/:id/permissions devuelve la base, los extras, los hosts, los denegados fijos y las sugerencias; PUT guarda extras y hosts validados con validateProjectPermissions, con sesión, CSRF y TOTP (reauth.verify, como las rutas de env-files). Las sugerencias salen de los archivos del clon base (uv.lock o pyproject.toml → uv, python, pytest; Makefile → make; Cargo.toml → cargo) y nunca se aplican solas; lo que ya está en la base no se sugiere.

**Evidence**:
- Summary: Migración 11 (allowed_commands/allowed_hosts JSON, default []); ProjectRepository.get/setBashExtras (datos ilegibles = sin extras); GET/PUT /api/projects/:id/permissions con sesión, CSRF y TOTP (reauth.verify antes de validar) y validateProjectPermissions (400 sin guardar); sugerencias por uv.lock/pyproject.toml, Makefile y Cargo.toml sin aplicarlas ni repetir base/configurado; el AgentManager de la app carga los extras del proyecto en cada turno.
- Validation: npm run typecheck sin errores
- Validation: npm test -w apps/api: 37 archivos, 651 tests pasan (projects-permissions.test.ts nuevo: TOTP, 400 sin guardar, sugerencias, 401/403, no público; migración 11 en db.test.ts; cli.test.ts fija la lista de rutas mutantes)
- Validation: eslint y prettier limpios
- Files changed: `apps/api/src/db/migrations.ts`, `apps/api/src/projects/repo.ts`, `apps/api/src/projects/permissions-routes.ts`, `apps/api/src/projects/permission-suggestions.ts`, `apps/api/src/agent/permissions.ts`, `apps/api/src/app.ts`, `packages/shared/src/index.ts`, `apps/api/test/projects-permissions.test.ts`, `apps/api/test/db.test.ts`, `apps/api/test/cli.test.ts`

**Verdict**: pass

---
#### T3.3: Tab Permisos en la Configuración del proyecto

**Status**: done

**Description**: Sumar la tab Permisos a SETTINGS_TABS y su @case en settings.page.ts. La sección muestra la base (solo lectura), los comandos extra y los hosts de curl (editables, con validación en la web igual a la de la API), los denegados fijos (solo lectura, explicando que no se pueden habilitar), y las sugerencias con un botón Agregar cada una, que no guardan hasta Guardar. Guardar pide el TOTP con el totp-modal existente. Lógica pura (validación de nombre y host, armado de la lista con sugerencias) en un archivo con spec.

**Evidence**:
- Summary: Tab Permisos en SETTINGS_TABS y su @case en settings.page.ts. PermissionsSection muestra la base (solo lectura), comandos extra y hosts de curl editables en un borrador con validación igual a la de la API, denegados fijos con explicación y sugerencias con botón Agregar (no guardan); Guardar abre el totp-modal existente y recién ahí hace el PUT (un código inválido deja el borrador y el modal). Lógica pura en permissions-logic.ts con spec. Solo componentes compartidos y clases de tokens; layout en columna y filas que envuelven.
- Validation: npm run typecheck sin errores
- Validation: npm test -w apps/web: 19 archivos, 166 tests pasan (permissions-logic.spec.ts nuevo: validación de nombre y host, sugerencia sin repetir; settings-tabs.spec.ts)
- Validation: ng build de apps/web compila las plantillas sin errores; eslint y prettier limpios; sin colores fuera de tokens (grep)
- Files changed: `apps/web/src/app/projects/settings-tabs.ts`, `apps/web/src/app/projects/settings.page.ts`, `apps/web/src/app/projects/permissions.section.ts`, `apps/web/src/app/projects/permissions-logic.ts`, `apps/web/src/app/projects/permissions-logic.spec.ts`, `apps/web/src/app/projects/projects.service.ts`, `apps/web/src/app/projects/settings-tabs.spec.ts`
- Notes: No se probó en un navegador ni en un celular real: el uso en celular se apoya en los patrones existentes (formularios en columna, filas flex-wrap), sin verificación visual.

**Verdict**: pass

---
### P4 — Arrastre del sprint 1 y verificación

> Cerrar lo que dejó el sprint 1 y verificar el sprint entero.

#### T4.1: Limpiar las preguntas en espera cuando termina el turno

**Status**: done

**Description**: Cuando un turno termina (bien, con error o cancelado), AgentManager borra y resuelve con deny todos los waiters de ese chat además del cancelPending que ya hace, y registra question_cancelled por cada uno. Una respuesta que llega después del fin del turno da 409 (QuestionNotPendingError) y no resuelve nada.

**Evidence**:
- Summary: AgentManager.consume, al terminar un turno (éxito, error o cancelado), además del cancelPending resuelve con deny y borra todos los waiters del chat (dropWaiters) y registra question_cancelled por cada uno; una respuesta posterior da QuestionNotPendingError (409) sin cambiar nada.
- Validation: npm run typecheck sin errores
- Validation: npm test -w apps/api: 37 archivos, 655 tests pasan, incluidos los de preguntas del sprint 1 y los nuevos de turno terminado con pregunta pendiente (éxito/error/cancelado, sin waiters, pregunta cancelled con evento, respuesta tardía rechazada)
- Validation: eslint y prettier limpios
- Files changed: `apps/api/src/agent/manager.ts`, `apps/api/test/agent.test.ts`

**Verdict**: pass

---
#### T4.2: Verificación automática del sprint

**Status**: done

**Description**: Correr typecheck, lint, format:check, tests y build de todo el repo. Comprobar con grep que no hay colores hex, rgb o hsl fuera de tokens.css, que las únicas rutas públicas siguen siendo health, login y totp, que ningún comando de la API usa shell (solo execFile con argv) y que no aparece bypassPermissions en el código.

**Evidence**:
- Summary: Verificación del sprint: typecheck, lint, format:check, tests (API 655, web 166) y build del repo pasan con exit 0. Los greps no encuentran colores hex/rgb/hsl fuera de tokens.css, ningún uso de shell (solo execFile con argv; los db.exec son SQLite) ni bypassPermissions; las únicas rutas con public: true son health, login y totp. Las rutas nuevas (models, state, timeline, permissions) tienen casos de 401 sin sesión y 403 sin CSRF en sus tests.
- Validation: npm run typecheck && npm run lint && npm run format:check && npm test && npm run build → exit 0
- Validation: grep colores hex/rgb/hsl en apps/web/src: solo tokens.css
- Validation: grep exec/shell/bypassPermissions en apps/api/src: sin resultados fuera de db.exec y de un comentario
- Validation: grep public: true: /api/health y las dos rutas de auth (login, totp)
- Files changed: 

**Verdict**: pass

---
#### T4.3: Recorrido manual: preguntas (debt-1), modelos y permisos con una sesión real

**Status**: pending

**Disposition**: deferred → debt:debt-1 — El usuario decidió hacer el recorrido manual al final del scope (sprint 6), junto con la corrida real.

**Description**: El usuario, desde el navegador por el túnel SSH (docs/panel-desarrollo.md): (1) chat real que pregunta, respuesta con botones y el agente sigue (debt-1, pasos en 'Probar una pregunta del agente'); (2) un chat con override de modelos donde el primer turno corre con el pensante y el siguiente con el ejecutor (system:init y agent_sessions); (3) tab Permisos: agregar un comando sugerido con TOTP y ver que un chat del proyecto puede usarlo y que curl a un host no listado queda como permission_denied. Si el recorrido no se puede hacer en el sprint, se registra otra vez como deuda diferida con su motivo, sin marcar debt-1 como resuelta.

**Evidence**:
- Summary: Recorrido manual diferido al sprint 6 por decisión del usuario; los pasos ya están en docs/panel-desarrollo.md (Probar una pregunta del agente; Probar modelos por rol, estado y permisos por proyecto).
- Validation: docs/panel-desarrollo.md contiene los pasos A (modelos y sesiones), B (estado fino y Timeline) y C (permisos por proyecto); el recorrido no se ejecutó.
- Files changed: `docs/panel-desarrollo.md`

**Verdict**: _Not reviewed._

---

## Unfinished work

- **T4.3** (Recorrido manual: preguntas (debt-1), modelos y permisos con una sesión real): deferred → debt:debt-1 — El usuario decidió hacer el recorrido manual al final del scope (sprint 6), junto con la corrida real.

## Learnings

- Kyro 6.1.0 deja la ruta en await_scope_completion con el bloqueo no_ready_work cuando la única tarea pendiente se dispone como diferida; el cierre igual procede con close-sprint (outcome partial).
- Una allowlist por primera palabra no alcanza: cualquier comando que ejecute otro (env, xargs, bash) anula la lista de denegados; la QA lo encontró probando el bypass en vivo.
- En kyro review, la opción de criterio verificado exige el texto exacto del criterio; sin ella la review pasa sobre la evidencia registrada.

## Resolved Debt

_No debt resolved in this sprint._

## Recommendations for Sprint 3

- Resolver debt-2 al principio del sprint 3: el piloto corre sin supervisión y R9 depende de que npm exec -c, git -c core.sshCommand y alias ! no lleguen a los denegados.
- Construir el orquestador con runner y Kyro falsos (fixtures del sprint 1) y un test de cobertura de gates de la política antes de cualquier corrida real.
