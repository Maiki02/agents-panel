---
title: 'operaciones-worktree — Sprint 3: Uso de proveedores y web de operaciones (WS13 + WS16)'
date: '2026-10-07'
scope: 'operaciones-worktree'
sprint: 3
slug: 'web-operaciones-y-uso'
outcome: 'shipped'
type: 'sprint-archive'
---

# Sprint 3: Uso de proveedores y web de operaciones (WS13 + WS16)

> Closed: 2026-10-07
> Outcome: shipped

## Objective

Que el uso de la cuenta activa se vea desde un icono del header en todas las pantallas (con lectura a pedido, dato pasivo y degradado), que el piloto retome sin_cupo_de_uso a la hora de resetsAt, y que la web ofrezca los filtros de la sidebar, la pestaña Git con todas las operaciones por repo y los pasos del agente, y la lista de repos en Configuración → Repositorio.

## Definition of Done

- Todas las tareas en done con evidencia y review pass.
- npm run build, typecheck, lint, test y format:check pasan en la raíz.
- GET /api/usage exige sesión, la allowlist pública no cambia y una falla de la lectura del SDK degrada sin romper.
- El uso se guarda y se muestra por account_id; el tono usa el mismo umbral en la API y la web.
- Cada acción del catálogo de paridad con ruta manual tiene su botón en la web, deshabilitado con motivo cuando el agente o el piloto están ocupados.

## Phases

### P1 — Uso de proveedores en la API

> Guardar el uso por cuenta, leerlo a pedido con caché y degradado, exponerlo en GET /api/usage y usar resetsAt en el piloto (R6, R8).

#### T1.1: Tabla provider_usage y guardado de cada rate_limit_event por cuenta

**Status**: done

**Description**: Migración 21 provider_usage (id, account_id, provider 'claude', window: five_hour | seven_day | seven_day_opus | seven_day_sonnet u otro rateLimitType del SDK, utilization 0-100 o null, status allowed | allowed_warning | rejected o null, resets_at, source 'event' | 'query', observed_at; índice único por account_id+provider+window: se guarda la última observación de cada ventana). UsageRepository con upsert y lectura por cuenta. En apps/api/src/agent/manager.ts, cada mensaje rate_limit_event de una sesión se guarda con el account_id de esa sesión (el mismo que se registra en agent_sessions), sin frenar el turno si falla el guardado. Tipos compartidos en packages/shared: UsageWindow, ProviderUsage { provider, accountId, windows[], source, observedAt, degraded, error? } y la función usageTone(window) que devuelve ok (< 70 %), warn (>= 70 %) o danger (>= 90 % o status rejected), para que la API y la web usen el mismo umbral.

**Evidence**:
- Summary: Migración 21 provider_usage, UsageRepository (upsert por cuenta+ventana), guardado de rate_limit_event por account_id en AgentManager sin cortar el turno, tipos compartidos y usageTone
- Validation: npm run typecheck
- Validation: npm run lint
- Validation: npm test (api 1176 tests, shared 8)
- Validation: npm run format:check
- Files changed: `apps/api/src/db/migrations.ts`, `apps/api/src/usage/repo.ts`, `apps/api/src/agent/manager.ts`, `apps/api/src/app.ts`, `packages/shared/src/index.ts`, `packages/shared/src/usage.ts`, `apps/api/test/usage-repo.test.ts`, `packages/shared/test/usage-tone.test.ts`, `apps/api/test/db.test.ts`
- Notes: packages/shared gana script test, vitest.config.ts y tsconfig.build.json (el tsconfig.json incluye test y no emite).

**Verdict**: pass

---
#### T1.2: Lectura de uso a pedido con caché, degradado y GET /api/usage

**Status**: done

**Description**: UsageService.read(accountId): si hay una lectura 'query' de menos de 60 s para la cuenta, la devuelve; si no, abre una sesión corta del SDK sin prompt con la cuenta (CLAUDE_CONFIG_DIR de la cuenta, o la variable quitada para la principal, por accountEnv), llama a usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(), mapea rate_limits.{five_hour, seven_day, seven_day_opus, seven_day_sonnet} a ventanas, las guarda con source 'query' y cierra la sesión (interrupt/close) siempre, con timeout corto (por ejemplo 20 s). Una sola lectura en vuelo por cuenta (las demás esperan la misma promesa). Si la llamada no existe, falla, tarda de más o devuelve rate_limits_available false, responde con lo último guardado (event o query) con degraded true, el error recortado y observedAt para que la web muestre la antigüedad; sin datos devuelve windows vacías y degraded true, nunca 500. GET /api/usage (cuenta activa; ?refresh=1 fuerza saltar la caché) exige sesión; no muta nada, así que no pide CSRF. El runner del SDK se inyecta para que los tests usen fixtures sin lanzar procesos.

**Evidence**:
- Summary: UsageService.read con caché 60 s, una lectura en vuelo por cuenta, timeout y degradado al dato guardado; lector del SDK inyectable (createUsageReader) que siempre cierra la sesión; GET /api/usage con sesión, sin CSRF; tone en UsageWindowView
- Validation: npm run typecheck ok
- Validation: npm run lint ok
- Validation: npm run format:check ok
- Validation: npm test: api 1193 y web 260 pasan (antes del arreglo de lint); usage/guard/cli 39 pasan después
- Files changed: `apps/api/src/usage/service.ts`, `apps/api/src/usage/sdk-usage.ts`, `apps/api/src/usage/routes.ts`, `apps/api/src/app.ts`, `apps/api/test/usage-service.test.ts`, `apps/api/test/usage-routes.test.ts`, `apps/api/test/guard.test.ts`
- Notes: cli.test.ts no cambia: su lista son solo rutas mutantes y GET /api/usage no muta; la cubre guard.test.ts

**Verdict**: pass

---
#### T1.3: El piloto retoma sin_cupo_de_uso a la hora de resetsAt

**Status**: done

**Description**: En apps/api/src/pilot/autopilot.ts, cuando hitUsageLimit detecta el límite, buscar el resetsAt del rate_limit_event rechazado de esa sesión (o, si no vino, el resets_at guardado en provider_usage para la cuenta del run en la ventana rechazada) y usar retryAt = resetsAt + un margen chico (por ejemplo 60 s). Si no hay resetsAt conocido o ya pasó, se mantiene QUOTA_RETRY_MS (15 min). El rearmado tras reinicio sigue usando el retryAt guardado. El Timeline de sin_cupo_de_uso muestra la hora de retomada.

**Evidence**:
- Summary: El piloto retoma sin_cupo_de_uso a resetsAt + 60 s (del rate_limit_event rechazado de la sesión, o de provider_usage de la cuenta de la última sesión del run); sin resetsAt o pasado mantiene 15 min; el Timeline muestra la hora de retomada.
- Validation: npm run typecheck
- Validation: npm run lint
- Validation: npm test (api 1196, web 260 pasan)
- Validation: npm run format:check
- Files changed: `apps/api/src/pilot/autopilot.ts`, `apps/api/src/app.ts`, `apps/api/test/pilot-autopilot.test.ts`

**Verdict**: pass

---
### P2 — Web de operaciones y uso

> Icono de uso en el header, filtros de la sidebar, pestaña Git con todas las operaciones y pasos del agente, y repos en Configuración → Repositorio (R6, R7, R3, R4, R5).

#### T2.1: Icono de uso en el header y su panel

**Status**: done

**Description**: Componente UsageIndicator en el header de App (al lado de app-account-selector, visible en todas las pantallas y en celular): muestra el % de la ventana de 5 h de la cuenta activa con el tono de usageTone (o un guion sin dato). Al hacer click abre un panel (popover en escritorio, hoja inferior en celular) con, por proveedor (hoy Claude), una barra por ventana (5 h, semanal y las semanales por modelo si vienen) con porcentaje, tono y hora de reinicio en hora local, 'actualizado hace X' y un aviso discreto cuando degraded es true. Abrir el panel pide GET /api/usage; el icono se refresca al cargar, al cambiar de cuenta y cada pocos minutos con la pestaña visible (sin saltar la caché de 60 s de la API). Barra como componente compartido en ui/.

**Evidence**:
- Summary: Icono de uso en el header (app-usage-indicator) con panel popover/hoja inferior: barra por ventana con tono de usageTone, hora de reinicio local, 'actualizado hace X', aviso degraded y estado vacío; recarga al iniciar, al cambiar de cuenta y cada 3 min con pestaña visible. UsageBar compartido en ui/.
- Validation: npm run build -w apps/web
- Validation: npm test (api 1196, web 269 pasan)
- Validation: npm run typecheck
- Validation: npm run lint
- Validation: npm run format:check
- Files changed: `apps/web/src/app/app.ts`, `apps/web/src/app/usage/usage.service.ts`, `apps/web/src/app/usage/usage-indicator.ts`, `apps/web/src/app/usage/usage-logic.ts`, `apps/web/src/app/usage/usage-logic.spec.ts`, `apps/web/src/app/ui/usage-bar.ts`, `apps/web/src/app/ui/icon.ts`

**Verdict**: pass

---
#### T2.2: Filtros de la sidebar Chats

**Status**: done

**Description**: Filtros rápidos Activos · Te toca · Terminados · Todos en chats/chat-sidebar.ts. La clasificación vive en una función pura (chats/chat-filter-logic.ts): trabajos con workState según WORKTREE_STATE_INFO[state].who (working o waiting → Activos; user o error → Te toca; ok → Terminados); consultas sin workState según Chat.status (running → Activos; error o interrupted → Te toca; idle o cancelled → Terminados). Todos muestra todo. El filtro elegido se recuerda en localStorage y cada filtro muestra su cantidad; un filtro sin chats muestra un estado vacío con texto.

**Evidence**:
- Summary: Filtros Activos · Te toca · Terminados · Todos en la sidebar Chats, con clasificación pura (chat-filter-logic.ts), cantidad por filtro, persistencia en localStorage y estado vacío por filtro.
- Validation: npm run build -w apps/web
- Validation: npm test (web 276 pasan; spec recorre WORKTREE_STATE_IDS y cada ChatStatus)
- Validation: npm run typecheck
- Validation: npm run lint
- Validation: npm run format:check
- Files changed: `apps/web/src/app/chats/chat-sidebar.ts`, `apps/web/src/app/chats/chat-filter-logic.ts`, `apps/web/src/app/chats/chat-filter-logic.spec.ts`

**Verdict**: pass

---
#### T2.3: Pestaña Git: estado por repo y operaciones git

**Status**: done

**Description**: Sumar a chats/chat.page.ts la pestaña Git (solo en chats con worktree). Cliente en la web para GET /api/chats/:id/git, POST git/commit, git/pull-base, git/pull-branch, git/push y POST /api/chats/:id/setup. Una tarjeta por repo (raíz e hijos) con rama, base, archivos cambiados y adelante/atrás del remoto, y botones Commit, Traer base, Traer mi rama, Push y Reinstalar dependencias. Commit abre un modal con la lista de archivos para elegir y el mensaje, con aviso (no bloqueo) si no es Conventional Commits. El resultado se muestra por repo con la salida recortada; un pull con conflicto lista los archivos y ofrece 'Pedírselo al agente', que manda al chat un mensaje con el repo y los archivos por la ruta de mensajes existente; si se corrió la reinstalación, se informa. Mientras el agente corre o el piloto está active, queued o waiting_quota, o el chat está archivado, los botones se ven deshabilitados con el motivo (y un 409 de la API se muestra con su motivo). Operaciones largas con indicador de progreso y botón deshabilitado para no duplicar.

**Evidence**:
- Summary: Pestaña Git en el chat (todo chat con worktree): tarjeta por repo con rama, base, cambios y adelante/atrás; Commit con modal de archivos y aviso Conventional Commits no bloqueante; Traer base, Traer mi rama, Push y Reinstalar con resultado por repo y salida recortada; conflicto lista archivos y 'Pedírselo al agente' manda el mensaje; botones deshabilitados con motivo (agente, piloto, archivado); una operación a la vez con indicador.
- Validation: npm run build -w apps/web
- Validation: npm test (web 287 pasan, spec git-logic)
- Validation: npm run typecheck
- Validation: npm run lint
- Validation: npm run format:check
- Files changed: `apps/web/src/app/chats/chat.page.ts`, `apps/web/src/app/chats/git/git-tab.ts`, `apps/web/src/app/chats/git/repo-card.ts`, `apps/web/src/app/chats/git/commit.modal.ts`, `apps/web/src/app/chats/git/git.service.ts`, `apps/web/src/app/chats/git/git-logic.ts`, `apps/web/src/app/chats/git/git-logic.spec.ts`

**Verdict**: pass

---
#### T2.4: Pestaña Git: ver cambios, descartar, Crear PR, pasos del agente y borrar trabajo

**Status**: done

**Description**: Completar la pestaña Git con: Ver cambios por repo (GET git/diff, sin commitear o contra la base, parche por archivo con 'ver más' que pide el archivo completo; también accesible desde los modales de Commit y Crear PR); Descartar con selección de archivos y confirmación danger que nombra cada archivo (POST git/discard); Crear PR con el prellenado de GET git/pr (título y cuerpo editables por repo, link de la PR existente) y POST git/pr mostrando el link por repo, y en proyectos con hasMergeDev el botón principal es Correr merge-dev (POST steps con merge_dev); botones de los pasos del agente (Planificar, Ejecutar, QA, Corregir, Cerrar, Completar) leídos de PARITY_CATALOG y lanzados con POST /api/chats/:id/steps, solo los que aplican al tipo de chat; Borrar trabajo con la vista previa (GET work/delete-preview: ramas, commits sin pushear, archivos sin commitear) en un modal danger con casilla para borrar las ramas remotas, y POST work/delete. Mismas reglas de deshabilitado con motivo que T2.3.

**Evidence**:
- Summary: Pestaña Git completa: Ver cambios (diff por repo, ver más por archivo, desde el repo, Commit y Crear PR), Descartar con confirmación danger que nombra cada archivo (ConfirmModal compartido en ui/), Crear PR con prellenado editable, link y archivos con secretos, Correr merge-dev como botón principal con hasMergeDev, pasos del agente leídos de PARITY_CATALOG por tipo de chat y Borrar trabajo con vista previa y casilla de ramas remotas; el chat archivado queda en solo lectura.
- Validation: npm run build -w apps/web
- Validation: npm test (web 294 pasan; spec recorre PARITY_CATALOG)
- Validation: npm run typecheck
- Validation: npm run lint
- Validation: npm run format:check
- Files changed: `apps/web/src/app/chats/git/git-tab.ts`, `apps/web/src/app/chats/git/repo-card.ts`, `apps/web/src/app/chats/git/diff.modal.ts`, `apps/web/src/app/chats/git/discard.modal.ts`, `apps/web/src/app/chats/git/pr.modal.ts`, `apps/web/src/app/chats/git/delete-work.modal.ts`, `apps/web/src/app/chats/git/git.service.ts`, `apps/web/src/app/chats/git/git-logic.ts`, `apps/web/src/app/chats/git/git-logic.spec.ts`, `apps/web/src/app/ui/confirm-modal.ts`, `apps/web/src/app/ui/modal.ts`, `apps/web/src/app/chats/chat.page.ts`

**Verdict**: pass

---
#### T2.5: Configuración → Repositorio: repos con su base y pull por repo

**Status**: done

**Description**: En projects/settings.page.ts (caso repository) y repo-actions.section.ts: listar project_repos (GET /api/projects/:id/repos) con ruta y rama base editable (PATCH /api/projects/:id/repos/:repoId), botón Detectar repos (POST repos/detect) y el pull del clon base (POST /api/projects/:id/pull) mostrando el resultado en la fila de cada repo (actualizado, sin cambios, rechazado por cambios locales o divergencia, con el error). Las acciones mutantes van con CSRF y muestran progreso; el pull no ofrece commit ni instalación en el clon base.

**Evidence**:
- Summary: Configuración → Repositorio lista la raíz y los hijos con su base editable, Detectar repos y un pull que muestra el resultado en la fila de cada repo, también con la raíz rechazada (la API ahora manda repos en el 409/502).
- Validation: npm run build -w apps/web
- Validation: npm test (api 1197, web 304 pasan; spec repos-logic y test del 409 con filas)
- Validation: npm run typecheck
- Validation: npm run lint
- Validation: npm run format:check
- Files changed: `apps/web/src/app/projects/repo-actions.section.ts`, `apps/web/src/app/projects/project-repos.section.ts`, `apps/web/src/app/projects/projects.service.ts`, `apps/web/src/app/projects/repos-logic.ts`, `apps/web/src/app/projects/repos-logic.spec.ts`, `apps/api/src/projects/pull.ts`, `apps/api/src/projects/pull-routes.ts`, `apps/api/test/project-pull.test.ts`

**Verdict**: pass

---
### P3 — Verificación del sprint

> Dejar lista la guía del recorrido manual de la web y verificar el build completo (R7, R3).

#### T3.1: Guía del recorrido manual y verificación del build

**Status**: done

**Description**: Escribir en docs/panel-desarrollo.md la guía del recorrido manual de esta etapa: en un worktree de ventas (raíz en main y fe-ventas/be-ventas en dev) recorrer la pestaña Git (estado, ver cambios, commit, traer base, push, descartar), los filtros de la sidebar, Configuración → Repositorio, el icono de uso (incluido el degradado) y Crear PR real en agents-panel desde la web, con qué mirar en cada paso y cómo anotar el resultado; sin secretos. Correr npm run build (api y web), typecheck, lint, test y format:check en la raíz y dejar la salida resumida como evidencia. Revisar con kyro analyze que R6 y R7 tengan escenarios cubiertos por tareas de este sprint.

**Evidence**:
- Summary: docs/panel-desarrollo.md tiene la guía del recorrido manual (pestaña Git, filtros, Repositorio, icono de uso con degradado y Crear PR real en agents-panel) con qué mirar y cómo anotar. Build, typecheck, lint, test (api 1197, web 304, shared 8) y format:check pasan en la raíz. kyro analyze solo reporta S27 (R9, sprint 4); R6 y R7 sin hallazgos.
- Validation: npm run build
- Validation: npm run typecheck
- Validation: npm run lint
- Validation: npm test
- Validation: npm run format:check
- Validation: kyro analyze: sin R6 ni R7 sin escenario
- Files changed: `docs/panel-desarrollo.md`

**Verdict**: pass

---

## Unfinished work

_None — every task is done with a passing verdict._

## Learnings

_No learnings recorded._

## Resolved Debt

_No debt resolved in this sprint._

## Recommendations for Sprint 4

_None recorded._
