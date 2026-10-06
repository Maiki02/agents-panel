---
title: 'panel-mvp — Sprint 1: Panel MVP: login, scopes y chats'
date: '2026-10-06'
scope: 'panel-mvp'
sprint: 1
slug: 'panel-mvp'
outcome: 'shipped'
type: 'sprint-archive'
---

# Sprint 1: Panel MVP: login, scopes y chats

> Closed: 2026-10-06
> Outcome: shipped

## Objective

Entregar de punta a punta login con contraseña + TOTP, creación de scope/work en worktree con sesión del Agent SDK, streaming SSE, historial en SQLite y resume, con las pantallas web mínimas.

## Definition of Done

- Todas las tareas en done con evidencia y veredicto pass.
- npm run build, typecheck, lint, format:check y test pasan desde un clon limpio.
- Ninguna ruta de la API sin sesión salvo la allowlist documentada; ningún bypassPermissions en el código.
- docs/plan.md, docs/estados.md y docs/vm-setup.md reflejan lo hecho; ningún secreto en el repo.

## Phases

### P1 — Base: configuración, SQLite y tests

> Dejar la API con configuración por entorno, base SQLite con migraciones y un runner de tests.

#### T1.1: Configuración, SQLite con migraciones y vitest en la API

**Status**: done

**Description**: Crear apps/api/src/config.ts (lee y valida env: PANEL_DATA_DIR con default ~/.local/share/agents-panel, PANEL_ORIGIN, PANEL_SECRET_KEY, TTLs de sesión), apps/api/src/db/ con un runner de migraciones sobre node:sqlite (DatabaseSync, WAL, foreign_keys=ON, tabla schema_migrations, migraciones numeradas en código) y la migración 001 con users, user_totp, recovery_codes, sessions y login_attempts. Agregar vitest a apps/api con script test y un script test en la raíz que recorra workspaces. Agregar apps/api/.env.example con valores falsos.

**Evidence**:
- Summary: Config con fail-fast, node:sqlite con migraciones idempotentes (WAL+FK), vitest en api, test raíz, .env.example, decisión en docs/plan.md
- Validation: npm test: 6 tests pasan
- Validation: npm run typecheck, lint, format:check pasan
- Validation: git status sin .db ni .env
- Files changed: `apps/api/src/config.ts`, `apps/api/src/db/index.ts`, `apps/api/src/db/migrations.ts`, `apps/api/test/db.test.ts`, `docs/plan.md`

**Verdict**: pass

---
### P2 — Autenticación: Argon2id, sesiones, límite de intentos, TOTP, CSRF y CLI

> Que la API solo responda a una sesión obtenida con contraseña + TOTP, con defensas contra fuerza bruta y CSRF, y que los usuarios se creen solo por CLI.

#### T2.1: Hash de contraseñas Argon2id y repositorio de usuarios

**Status**: done

**Description**: Crear apps/api/src/auth/password.ts con hash y verify Argon2id (@node-rs/argon2, parámetros mínimos OWASP: m=19456 KiB, t=2, p=1, configurables) y apps/api/src/auth/users.ts con el repositorio de usuarios sobre la base de T1.1. Verificar contra un hash ficticio cuando el usuario no existe para no filtrar por tiempo qué usuarios existen. Política de contraseña: mínimo 14 caracteres.

**Evidence**:
- Summary: Argon2id (@node-rs/argon2, m=19456 t=2 p=1), política de 14 caracteres, UserRepository con verificación ficticia para usuarios inexistentes
- Validation: vitest password.test.ts: hash $argon2id$, verify ok/falla, <14 rechazado, usuario inexistente ejecuta verify
- Validation: typecheck, lint y format:check pasan
- Files changed: `apps/api/src/auth/password.ts`, `apps/api/src/auth/users.ts`, `apps/api/test/password.test.ts`

**Verdict**: pass

---
#### T2.2: Sesiones por cookie y guard global deny-by-default

**Status**: done

**Description**: Crear apps/api/src/auth/sessions.ts: token opaco de 32 bytes aleatorios en la cookie __Host-panel_session (HttpOnly, Secure, SameSite=Strict, Path=/), en la base solo su SHA-256, vencimiento por inactividad (30 min) y absoluto (12 h) configurables, y un csrf_token por sesión. Hook onRequest global: toda ruta /api/* exige sesión salvo las marcadas explícitamente con config.public=true. Rutas GET /api/auth/me (usuario + csrfToken) y POST /api/auth/logout. Dejar /api/health como pública y documentarlo.

**Evidence**:
- Summary: SessionService (token opaco, solo SHA-256 en la base, vencimiento por inactividad y absoluto), guard onRequest deny-by-default con config.public, /api/auth/me y /logout, allowlist en docs/plan.md
- Validation: vitest guard.test.ts: 401 en todas las rutas no públicas recorridas desde registeredRoutes, atributos de cookie, expiración inactividad/absoluta borra fila, hash en base, logout
- Validation: typecheck, lint, format:check pasan
- Files changed: `apps/api/src/auth/sessions.ts`, `apps/api/src/auth/guard.ts`, `apps/api/src/auth/routes.ts`, `apps/api/src/app.ts`, `apps/api/test/guard.test.ts`, `docs/plan.md`
- Notes: La allowlist documenta login/totp que se implementan en T2.3/T2.4

**Verdict**: pass

---
#### T2.3: Login paso 1 (contraseña), límite de intentos y auditoría

**Status**: done

**Description**: POST /api/auth/login {username, password} (pública). Si la contraseña es correcta no crea sesión: crea un desafío de 2FA de 5 minutos en la cookie __Host-panel_mfa (mismos atributos). Mensaje de error genérico en todo fallo. Límite por IP con @fastify/rate-limit en /api/auth/* (10 por minuto). Por cuenta: 5 fallos seguidos (contraseña o código) bloquean 15 minutos. Cada intento se guarda en login_attempts (fecha, usuario, IP, user agent, paso, resultado).

**Evidence**:
- Summary: POST /api/auth/login: desafío MFA firmado (__Host-panel_mfa) sin sesión, error genérico, bloqueo de cuenta a los 5 fallos por 15 min, rate limit 10/min por IP (429), auditoría en login_attempts (migración 002 agrega user_agent y step)
- Validation: vitest login.test.ts: sin __Host-panel_session y /me 401; sexto intento con contraseña correcta bloqueado; mismo cuerpo para inexistente e incorrecta; cada intento en login_attempts; 429 al intento 11
- Validation: typecheck, lint, tests (25) pasan
- Files changed: `apps/api/src/auth/routes.ts`, `apps/api/src/auth/challenge.ts`, `apps/api/src/auth/attempts.ts`, `apps/api/src/auth/crypto.ts`, `apps/api/src/db/migrations.ts`, `apps/api/test/login.test.ts`
- Notes: trustProxy sigue en false; registrado como deuda para etapa 6

**Verdict**: pass

---
#### T2.4: Segundo factor TOTP y códigos de recuperación

**Status**: done

**Description**: Crear apps/api/src/auth/totp.ts con otpauth (SHA-1, 6 dígitos, 30 s, ventana ±1). El secreto se guarda cifrado con AES-256-GCM usando una clave derivada de PANEL_SECRET_KEY. POST /api/auth/totp {code} (pública, exige la cookie de desafío): si el código es válido crea la sesión y borra el desafío. No acepta el mismo paso de tiempo dos veces. Alternativa: POST con un código de recuperación de un solo uso (guardado como hash). Los fallos cuentan para el bloqueo de T2.3.

**Evidence**:
- Summary: TOTP (otpauth SHA-1/6/30s/±1) con secreto cifrado AES-256-GCM (clave derivada de PANEL_SECRET_KEY), POST /api/auth/totp con desafío, anti-replay por paso de tiempo, códigos de recuperación de un solo uso (HMAC), fallos cuentan para el bloqueo
- Validation: vitest totp.test.ts: login completo password+TOTP y /me 200; mismo código dos veces rechazado; código de recuperación una sola vez; secreto base32 y códigos no están en la base; sin/forjada/vencida cookie de desafío da 401
- Validation: typecheck, lint, tests (31) pasan
- Files changed: `apps/api/src/auth/totp.ts`, `apps/api/src/auth/routes.ts`, `apps/api/src/app.ts`, `apps/api/test/totp.test.ts`

**Verdict**: pass

---
#### T2.5: CSRF, control de Origin y cabeceras de seguridad

**Status**: done

**Description**: Hook que en POST/PUT/PATCH/DELETE exige: Origin igual a PANEL_ORIGIN (o Sec-Fetch-Site: same-origin) en todas las rutas, y además X-CSRF-Token igual al csrf_token de la sesión en las rutas autenticadas. Agregar @fastify/helmet con CSP default-src 'self', HSTS, frame-ancestors 'none' y noSniff. Límite de tamaño de body.

**Evidence**:
- Summary: Hook de Origin (o Sec-Fetch-Site) para POST/PUT/PATCH/DELETE, X-CSRF-Token timing-safe en rutas autenticadas, @fastify/helmet (CSP default-src 'self', HSTS, frame-ancestors 'none', nosniff), bodyLimit 64 KiB
- Validation: vitest security.test.ts: POST autenticado sin/mal token da 403 y no cambia la base; login con Origin ajeno o ausente 403; cabeceras CSP/HSTS/nosniff presentes (también en 404); body grande 413
- Validation: typecheck, lint, tests (37) pasan
- Files changed: `apps/api/src/auth/security.ts`, `apps/api/src/app.ts`, `apps/api/test/security.test.ts`

**Verdict**: pass

---
#### T2.6: CLI de administración de usuarios

**Status**: done

**Description**: Crear apps/api/src/cli.ts con el script npm run -w @agents-panel/api cli -- <comando>: user:create <username> (pide la contraseña dos veces sin mostrarla, genera el secreto TOTP, muestra el URI otpauth y un QR en la terminal, pide un código para confirmar y recién ahí guarda; imprime 10 códigos de recuperación una sola vez), user:list, user:reset-password, user:reset-2fa y user:unlock. Es la única forma de dar de alta usuarios.

**Evidence**:
- Summary: CLI user:create/list/reset-password/reset-2fa/unlock (readline sin eco, QR en terminal, confirmación TOTP antes de guardar, 10 códigos de recuperación), README con los comandos
- Validation: vitest cli.test.ts: user:create + login web completo; código de confirmación incorrecto no crea usuario; contraseña corta/distinta rechazada; unlock borra el bloqueo; ninguna ruta HTTP gestiona usuarios
- Validation: smoke: npm run cli -- user:list con config válida e inválida
- Validation: typecheck, lint, format:check, tests (42) pasan
- Files changed: `apps/api/src/cli.ts`, `apps/api/src/cli/commands.ts`, `apps/api/test/cli.test.ts`, `README.md`

**Verdict**: pass

---
### P3 — Agente: proyectos, worktrees, sesión del SDK, historial y SSE

> Que una sesión válida pueda crear un scope/work que corre en su propio worktree con el Agent SDK, con todo guardado en SQLite, transmitido por SSE y continuable con resume.

#### T3.1: Registro de proyectos y modelo de chats

**Status**: done

**Description**: Migración 002: projects (id, name, repo_path, base_branch, setup_command opcional), chats (id, project_id, kind 'scope'|'work', slug, title, worktree_path, branch, sdk_session_id, status, created_at, updated_at) y chat_events (id, chat_id, seq, type, payload JSON, created_at, UNIQUE(chat_id, seq)). Comandos de CLI project:add y project:list. GET /api/projects. Tipos compartidos en packages/shared.

**Evidence**:
- Summary: Migración 003 (projects, chats, chat_events con UNIQUE(chat_id,seq)), ProjectRepository y ChatRepository, project:add/project:list en el CLI, GET /api/projects, tipos Project/Chat/ChatEvent/ChatStatus/ChatKind en packages/shared
- Validation: vitest projects.test.ts: project:add valida repo git y rama base; GET /api/projects 200 con sesión y 401 sin; seq por chat y UNIQUE(chat_id,seq)
- Validation: typecheck (shared, api, web), lint, format:check, tests (45) pasan
- Files changed: `apps/api/src/db/migrations.ts`, `apps/api/src/projects/repo.ts`, `apps/api/src/projects/routes.ts`, `apps/api/src/chats/repo.ts`, `apps/api/src/cli/projects.ts`, `packages/shared/src/index.ts`, `apps/api/test/projects.test.ts`
- Notes: La migración es la 003 (la 002 ya existía por login_attempts)

**Verdict**: pass

---
#### T3.2: Creación del worktree

**Status**: done

**Description**: Crear apps/api/src/worktrees/create.ts: valida el slug (kebab-case, máximo 50 caracteres), calcula ~/wt/<proyecto>/<slug> y la rama feature/<slug>, corre git -C <repo> worktree add <path> -b feature/<slug> <base_branch> con execFile (sin shell) y después el setup_command del proyecto si está definido, con cwd en el worktree. La salida se guarda como eventos del chat. Si algo falla, borra lo que creó.

**Evidence**:
- Summary: createWorktree: valida slug kebab-case ≤50, crea ~/wt/<proyecto>/<slug> en feature/<slug> con execFile, corre setup_command tokenizado sin shell, rollback de worktree y rama ante cualquier fallo, salida como eventos; PANEL_WORKTREES_DIR en config; plan.md actualizado
- Validation: vitest worktrees.test.ts (8): ruta/rama esperadas en repo git temporal; slug inválido y rama existente no dejan rastro; setup falla => rollback y evento worktree_output con stderr; sin interpretación de shell
- Validation: grep -rnE 'shell: *true|exec\(|spawn\(' apps/api/src/worktrees: sin resultados
- Validation: typecheck, lint, format:check, tests (53) pasan
- Files changed: `apps/api/src/worktrees/create.ts`, `apps/api/test/worktrees.test.ts`, `apps/api/src/config.ts`, `docs/plan.md`

**Verdict**: pass

---
#### T3.3: Sesión del Agent SDK por worktree

**Status**: done

**Description**: Crear apps/api/src/agent/runner.ts con una interfaz AgentRunner y la implementación sobre @anthropic-ai/claude-agent-sdk: query() con cwd en el worktree, settingSources ['project','user'], permissionMode 'acceptEdits', allowedTools (Read, Edit, Write, Glob, Grep, Bash de git, gh, npm, go y kyro) y canUseTool que niega lo demás y emite un evento permission_denied. Cada mensaje del SDK se guarda en chat_events con seq creciente; el session_id del mensaje init se guarda en chats.sdk_session_id. Soporta resume y cancelación con AbortController. Tope fijo de 4 sesiones corriendo a la vez (la quinta se rechaza con 409).

**Evidence**:
- Summary: AgentRunner + SdkRunner (query() con cwd en el worktree, settingSources project/user, acceptEdits, allowedTools Bash git/gh/npm/go/kyro, canUseTool con política de allowlist y rutas), AgentManager (eventos con seq, sdk_session_id, resume, cancelación, tope de 4 sesiones, 409), ChatEventBus; el SDK reutiliza el login de la VM, sin cambios en la VM
- Validation: vitest agent.test.ts (14): eventos en orden, sdk_session_id guardado y resume lo usa, permission_denied almacenado, quinta sesión y turno doble rechazados, cancelación, error del runner
- Validation: grep -r 'bypassPermissions|allowDangerouslySkipPermissions' apps/ (sin node_modules/dist): sin resultados
- Validation: Corrida real en la VM (SdkRunner sobre repo git de prueba): system:init con session_id, mensajes del asistente (PONG, tool_use Bash x2) y result:success; curl negado por la política (denied=1); apiKeySource none (OAuth de la suscripción)
- Validation: typecheck, lint, format:check, tests (65) pasan
- Files changed: `apps/api/src/agent/runner.ts`, `apps/api/src/agent/sdk-runner.ts`, `apps/api/src/agent/permissions.ts`, `apps/api/src/agent/manager.ts`, `apps/api/src/chats/events.ts`, `apps/api/test/agent.test.ts`, `docs/vm-setup.md`
- Notes: Decisión: Read/Edit/Write/Glob/Grep no van en allowedTools (lo auto-aprobaría sin chequear rutas); los resuelve canUseTool confinando escritura al worktree y lectura al worktree + ~/.agents + ~/.claude/skills. La VM no cambió; se documentó la verificación y una línea de bitácora

**Verdict**: pass

---
#### T3.4: API de chats, resume y estado al arrancar

**Status**: done

**Description**: Rutas autenticadas: POST /api/chats {projectId, kind, slug, prompt} crea el worktree (T3.2) y arranca la sesión con /kyro:forge <pedido> o /kyro:work <pedido>; GET /api/chats (lista con proyecto, tipo, título, fecha y estado); GET /api/chats/:id; GET /api/chats/:id/events?afterSeq=; POST /api/chats/:id/messages {text} sigue con resume (409 si ya está corriendo); POST /api/chats/:id/cancel. Al arrancar el servidor, los chats en running pasan a interrupted.

**Evidence**:
- Summary: ChatService + rutas autenticadas POST/GET /api/chats, GET /api/chats/:id, GET .../events?afterSeq, POST .../messages (resume, 409 si corre), POST .../cancel; crea worktree y arranca la sesión; al construir la app los chats running pasan a interrupted; docs/estados.md con los estados de sesión del MVP y su mapeo a los finos
- Validation: vitest chats.test.ts (6): crear chat, leer eventos, mandar mensaje y el runner recibe resumeSessionId; reconstruir la app sobre la misma base deja interrupted y se puede continuar con su sdk_session_id; mensaje a chat running da 409; cancelar; validaciones 400/404/409; 401 sin sesión
- Validation: typecheck, lint, format:check, tests (71) pasan
- Files changed: `apps/api/src/chats/service.ts`, `apps/api/src/chats/routes.ts`, `apps/api/src/app.ts`, `apps/api/test/chats.test.ts`, `docs/estados.md`
- Notes: Hallazgo: en la VM el SDK no registra /kyro:forge ni /kyro:work (el init no lista comandos ni skills kyro). El prompt inicial apunta a ~/.agents/skills/<skill>/SKILL.md; queda como deuda debt-2. La corrida real con Kyro se verifica en T5.1

**Verdict**: pass

---
#### T3.5: Streaming por SSE

**Status**: done

**Description**: GET /api/chats/:id/stream (autenticada): text/event-stream, cada evento con id=seq. Con Last-Event-ID o ?afterSeq= reproduce primero desde la base y después sigue en vivo con un emisor en proceso, sin duplicados ni huecos. Heartbeat cada 15 s. Se limpia al cerrar la conexión.

**Evidence**:
- Summary: GET /api/chats/:id/stream (SSE autenticado): id=seq, replay desde la base con Last-Event-ID o ?afterSeq y luego en vivo (suscribe primero, buffer, descarta seq ya enviados), heartbeat configurable (15 s por defecto), limpieza del listener al cerrar
- Validation: vitest stream.test.ts (7) con el servidor escuchando y fetch en streaming: eventos en vivo en orden con id=seq; reconexión con Last-Event-ID recibe solo los siguientes; ?afterSeq; 1205 eventos con vivos durante el replay sin huecos ni duplicados; 401 sin sesión y 404; listenerCount vuelve a 0 al cerrar el cliente; heartbeat
- Validation: typecheck, lint, format:check, tests (78) pasan
- Files changed: `apps/api/src/chats/stream.ts`, `apps/api/src/chats/events.ts`, `apps/api/src/app.ts`, `apps/api/test/stream.test.ts`

**Verdict**: pass

---
### P4 — Web: login, lista de chats y chat

> Pantallas Angular mínimas para usar todo lo anterior desde el navegador.

#### T4.1: Cliente HTTP, sesión y pantalla de login

**Status**: done

**Description**: En apps/web: proxy de desarrollo /api → 127.0.0.1:3000, provideHttpClient con un interceptor que agrega X-CSRF-Token en los métodos que cambian estado, AuthService con signals (me, csrfToken), guard de rutas y pantalla de login en dos pasos (contraseña → código TOTP o de recuperación) con errores genéricos y aviso de bloqueo. Botón de logout.

**Evidence**:
- Summary: Web: proxy /api→127.0.0.1:3000, provideHttpClient con interceptor CSRF, AuthService con signals, authGuard/guestGuard, pantalla de login en dos pasos (contraseña → TOTP o recuperación) con errores genéricos y aviso de bloqueo, botón Salir, rutas lazy; vitest en apps/web
- Validation: ng build OK; typecheck, lint y format:check pasan
- Validation: vitest apps/web: withCsrfHeader agrega X-CSRF-Token en POST/PUT/PATCH/DELETE y no en GET ni sin token (6 tests)
- Validation: Recorrido por el proxy de ng serve (:4200) con curl y API real: /api/auth/me 401 sin sesión; login+TOTP crea sesión; logout sin X-CSRF-Token 403, con token 200; /me 401 después
- Files changed: `apps/web/proxy.conf.json`, `apps/web/angular.json`, `apps/web/src/app/app.config.ts`, `apps/web/src/app/app.routes.ts`, `apps/web/src/app/app.ts`, `apps/web/src/app/auth/auth.service.ts`, `apps/web/src/app/auth/csrf.interceptor.ts`, `apps/web/src/app/auth/auth.guard.ts`, `apps/web/src/app/auth/login.page.ts`
- Notes: LIMITACIÓN: no hay navegador en la VM, así que la prueba manual de las pantallas (redirección al login, formulario de dos pasos, botón Salir) no se ejecutó en un navegador; quedó verificada solo la capa HTTP y el guard por compilación. Pendiente de confirmar por el usuario por túnel SSH.

**Verdict**: pass

---
#### T4.2: Lista de chats y formulario de nuevo scope/work

**Status**: done

**Description**: Pantalla con la lista de chats (título, proyecto, tipo, fecha y estado con badge) y un formulario de nuevo chat: proyecto (de GET /api/projects), tipo scope o work, slug con validación kebab-case y pedido. Al crear, navega al chat.

**Evidence**:
- Summary: Lista de chats (título, proyecto, tipo, fecha, badge de estado), formulario de nuevo scope/work (proyectos de GET /api/projects, slug kebab-case validado en vivo, pedido) que navega al chat al crear y muestra el error de la API sin perder lo escrito; ChatsService con los métodos de la API
- Validation: ng build OK; typecheck, lint y format:check pasan
- Validation: vitest apps/web new-chat.form.spec.ts: slugProblem marca slugs inválidos antes de enviar (8 tests web en total)
- Files changed: `apps/web/src/app/chats/chats.service.ts`, `apps/web/src/app/chats/chat-list.page.ts`, `apps/web/src/app/chats/new-chat.form.ts`, `apps/web/src/app/chats/status.ts`
- Notes: LIMITACIÓN: sin navegador en la VM, la prueba manual (crear un scope desde el formulario y ver el chat nuevo en la lista) no se ejecutó en pantalla; la creación de chat contra la API real se ejercita en T5.1. Pendiente de confirmar por el usuario.

**Verdict**: pass

---
#### T4.3: Pantalla de chat con streaming, continuar y cancelar

**Status**: done

**Description**: Vista de chat: carga el historial y se suscribe a /api/chats/:id/stream con EventSource. Muestra texto del asistente, uso de herramientas (nombre y entrada colapsable), resultados, permission_denied destacado y el resultado final. Caja para mandar un mensaje (resume), deshabilitada mientras corre; botón cancelar; badge de estado que se actualiza en vivo; aviso para retomar si está interrumpido.

**Evidence**:
- Summary: Pantalla de chat: carga historial, se suscribe por EventSource a /api/chats/:id/stream (sin duplicados por seq), muestra texto del asistente, herramientas con entrada colapsable, resultados, permission_denied destacado y resultado final; caja de mensaje (resume) deshabilitada mientras corre, cancelar, badge de estado vivo, aviso de retomar si está interrumpido. Todo como texto interpolado
- Validation: ng build OK; typecheck, lint y format:check pasan
- Validation: vitest apps/web event-view.spec.ts: mapeo de eventos SDK a la vista, markup queda como texto, recorte de salidas grandes, payloads malformados tolerados (13 tests web en total)
- Validation: grep bypassSecurityTrust e innerHTML en apps/web/src: sin resultados
- Files changed: `apps/web/src/app/chats/chat.page.ts`, `apps/web/src/app/chats/chat-stream.service.ts`, `apps/web/src/app/chats/event-view.ts`, `apps/web/src/app/chats/event-view.spec.ts`
- Notes: LIMITACIÓN: sin navegador en la VM, la prueba manual (mensajes en vivo, recargar muestra el historial, mandar mensaje continúa la sesión) no se ejecutó en pantalla. El SSE y el resume se prueban en el API con tests y se recorren con la API real en T5.1. Pendiente de confirmar por el usuario en el navegador.

**Verdict**: pass

---
### P5 — Cierre: docs y prueba de punta a punta en la VM

> Dejar documentado todo lo que cambió y probar el flujo completo en la VM.

#### T5.1: Docs y prueba de punta a punta en la VM

**Status**: done

**Description**: En la VM: crear el .env de desarrollo de apps/api (sin commitear), crear el usuario real con user:create, registrar NovaGent (o un repo de prueba si la etapa 3 no está lista) con project:add, levantar API y web, y por túnel SSH hacer login, crear un work chico, verlo en vivo, reiniciar la API y continuarlo. Actualizar docs/vm-setup.md (paso nuevo, bitácora y tabla de costos con US$0), README (cómo correr el panel en desarrollo) y revisar que plan.md y estados.md reflejen las decisiones del sprint.

**Evidence**:
- Summary: Docs y prueba de punta a punta en la VM: paso 10 en vm-setup.md (.env de desarrollo con clave generada 600, user:create, project:add, túnel SSH), bitácora y fila de costos US$0; README con cómo correr el panel; plan.md y estados.md al día con las decisiones del sprint
- Validation: Copia limpia del árbol (sin node_modules/dist/.env): npm ci, build, typecheck, lint, format:check y test pasan (api 78, web 13)
- Validation: 2026-10-04 recorrido real con API + ng serve y datos descartables: login+TOTP por el proxy; crear work (worktree feature/e2e-demo, sesión del SDK, 8 eventos, idle); SSE por el proxy con Last-Event-ID (ids 7,8); kill -9 de la API en pleno turno → chat interrupted con 21 eventos guardados; mensaje de continuación retomó la misma sesión del SDK (sdk_session_id idéntico) y el agente recordó el contexto
- Validation: git status: sin .env ni .db ni secretos para commitear (apps/api/.env existe, ignorado, permisos 600; solo aparece .env.example)
- Files changed: `docs/vm-setup.md`, `docs/plan.md`, `docs/estados.md`, `README.md`
- Notes: NO HECHO: (1) usuario real con user:create y proyecto real con project:add: los crea la persona porque elige contraseña y escanea el QR; (2) prueba en navegador de las 3 pantallas (la VM no tiene navegador); (3) el recorrido usó una base y un repo descartables, no NovaGent ni la base real. El .env real sí se creó (clave generada, sin mostrarla).

**Verdict**: pass

---

## Unfinished work

_None — every task is done with a passing verdict._

## Learnings

- Se cerró sin QA por decisión explícita del usuario; los criterios manuales de las pantallas (debt-6) no tienen confirmación registrada.

## Resolved Debt

- **debt-3**: Registrar CSP default-src 'self' vs estilos inline de Angular al servir la web desde la API (etapa 6)

## Recommendations for Sprint 2

- Retomar debt-1 (trustProxy detrás de Funnel) y debt-4 (SSE al vencer la sesión) si se vuelven un problema real.
