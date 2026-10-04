---
title: 'proyectos-y-versiones — Sprint 3: Versiones y actualización de Kyro'
date: '2026-10-04'
scope: 'proyectos-y-versiones'
sprint: 3
slug: 'versiones-kyro'
outcome: 'shipped'
type: 'sprint-archive'
---

# Sprint 3: Versiones y actualización de Kyro

> Closed: 2026-10-04
> Outcome: shipped

## Objective

Que la API muestre la versión instalada y la última de Kyro y lo actualice con un script idempotente versionado, con TOTP, sin sesiones corriendo y bloqueando sesiones nuevas mientras corre, registrando cada corrida en maintenance_runs.

## Definition of Done

- Todas las tareas done con evidencia y verdict pass
- npm run typecheck, npm run lint, npm run format:check y npm test en verde
- 08-kyro-update.sh corrido dos veces en la VM sin cambios en la segunda, documentado en vm-setup.md con línea de bitácora
- Ninguna ruta nueva fuera del guard; el contenido de .env no aparece en maintenance_runs
- debt-3 y debt-4 resueltas o con disposición explícita

## Phases

### P1 — VM: H1 y script de actualización

> Confirmar la secuencia de actualización de Kyro 6.x y dejarla en un script idempotente documentado en el runbook.

#### T1.1: Verificar H1 y escribir scripts/vm/08-kyro-update.sh con su paso en el runbook

**Status**: done

**Description**: Verificar H1 a mano y documentar el resultado en docs/vm-setup.md (paso nuevo '14. Actualizar Kyro: scripts/vm/08-kyro-update.sh'). Hallazgo previo al plan (2026-10-04, kyro 6.1.0): 'kyro update --help' dice que verifica el registro, actualiza el paquete global si está atrás y refresca runtime + workspace actual; 'kyro update --check' y '--dry-run' no cambian nada. Escribir scripts/vm/08-kyro-update.sh (bash, set -euo pipefail, LF), idempotente: (1) npm i -g kyro-ai@latest; (2) por cada raíz recibida por argumento: validar que sea un directorio con .agents/kyro/ y correr 'kyro update --yes' con cwd en esa raíz; (3) bash 06-kyro-skills.sh (ruta relativa al propio script); (4) kyro doctor. Imprime al final una línea 'KYRO_VERSION=<x.y.z>' con la salida de 'kyro --version' para que la API lea la versión que realmente quedó. Sin argumentos, solo actualiza lo global, enlaza skills y corre doctor. Correrlo dos veces en la VM con las raíces de los proyectos con Kyro (agents-panel y NovaGent) y registrar ambas corridas en la bitácora.

**Evidence**:
- Summary: Escrito scripts/vm/08-kyro-update.sh (npm i -g, kyro update --yes por raíz, 06-kyro-skills.sh, kyro doctor, KYRO_VERSION al final); H1 verificada; paso 14, costo y 2 líneas de bitácora en docs/vm-setup.md
- Validation: bash -n OK, sin CRLF (shellcheck no instalado)
- Validation: raíz inexistente y /tmp: exit 1 con mensaje claro antes de tocar nada
- Validation: 2 corridas reales con agents-panel y ventas: exit 0, doctor 13/13 PASS, KYRO_VERSION=6.1.0, hash de symlinks idéntico
- Files changed: `scripts/vm/08-kyro-update.sh`, `docs/vm-setup.md`

**Verdict**: pass

---
### P2 — API: bloqueo de mantenimiento, versiones y actualización

> Rutas de Versiones con TOTP, L8 y registro en maintenance_runs, probadas con el script reemplazado por un fake.

#### T2.1: Bloqueo de mantenimiento en AgentManager y ChatService

**Status**: done

**Description**: Sumar a AgentManager un bloqueo de mantenimiento: tryBeginMaintenance() devuelve { ok: true } y activa el bloqueo solo si runningCount === 0 y no hay otro mantenimiento en curso; si no, devuelve { ok: false, running: n } (o reason 'maintenance'). endMaintenance() lo libera. Mientras está activo, start() lanza MaintenanceError (409, mensaje en español 'Kyro se está actualizando; probá de nuevo cuando termine'). ChatService.create lo chequea antes de crear el worktree (igual que hasCapacity) y sendMessage lo hereda de start(). Las rutas de chats mapean MaintenanceError a 409.

**Evidence**:
- Summary: AgentManager: MaintenanceError, tryBeginMaintenance/endMaintenance/inMaintenance (check y flag sincrónicos); start() lanza MaintenanceError; ChatService.create lo chequea antes del worktree y startTurn lo mapea a 409; AppDeps.manager inyectable para tests
- Validation: tsc --noEmit sin errores
- Validation: eslint src test sin hallazgos
- Validation: vitest run: 20 archivos, 308 tests OK (incluye 2 nuevos de bloqueo de mantenimiento: running=1 sin activar; 409 en create y mensajes sin worktree/rama/chat y recuperación tras endMaintenance)
- Files changed: `apps/api/src/agent/manager.ts`, `apps/api/src/chats/service.ts`, `apps/api/src/app.ts`, `apps/api/test/chats.test.ts`, `apps/api/test/helpers.ts`

**Verdict**: pass

---
#### T2.2: KyroVersions y MaintenanceRunRepository

**Status**: done

**Description**: Crear apps/api/src/maintenance/ con: MaintenanceRunRepository sobre la tabla maintenance_runs existente (create running con kind 'kyro-update' y from_version, finish con status 'ok'|'error', to_version y output, list más nuevo primero con límite, failInterrupted() que pasa las corridas 'running' a 'error' con output 'interrumpido'); y KyroVersions con installed() (execFile 'kyro' ['--version'], timeout 5 s) y latest() (execFile 'npm' ['view','kyro-ai','version'], timeout 10 s; sin red, error o salida que no es semver devuelve null). Ambos inyectables para tests. Recortar output a los últimos 16 KB en bytes UTF-8 con una marca de recorte.

**Evidence**:
- Summary: Nuevo apps/api/src/maintenance/: MaintenanceRunRepository (create/finish/findById/list newest-first/failInterrupted, output recortado a los últimos 16 KB en bytes UTF-8 con marca) y KyroVersions (installed/latest/info por execFile con timeouts 5 s/10 s, null ante error, timeout o no-semver; Exec inyectable). Tipos MaintenanceRun, MaintenanceStatus y KyroVersionInfo en packages/shared
- Validation: tsc --noEmit sin errores (tras rebuild de packages/shared)
- Validation: eslint src test sin hallazgos
- Validation: vitest run: 21 archivos, 318 tests OK (10 nuevos en maintenance.test.ts)
- Files changed: `apps/api/src/maintenance/runs.ts`, `apps/api/src/maintenance/versions.ts`, `packages/shared/src/index.ts`, `apps/api/test/maintenance.test.ts`

**Verdict**: pass

---
#### T2.3: KyroUpdater: corrida en segundo plano con lock compartido con kyro install (debt-4)

**Status**: done

**Description**: Crear apps/api/src/maintenance/updater.ts con KyroUpdater.start(): pide manager.tryBeginMaintenance() (si falla lanza UpdateBlockedError 409 con la cantidad de sesiones o 'ya hay una actualización en curso'), mide from_version, crea la fila 'running' y corre en segundo plano el script (execFile 'bash' [scriptPath, ...raíces], timeout 10 min) con las raíces de los proyectos 'ready' con hasKyro. Al terminar mide to_version con installed() (si falla, usa la línea KYRO_VERSION=), guarda status, to_version y salida recortada (stdout+stderr) y libera el bloqueo en finally. Devuelve el id de la corrida. whenIdle() para tests. Un KyroLock (mutex de promesas) compartido serializa la actualización con el kyroInit de ProjectService: la actualización espera a que termine un kyro install en curso y un alta que llega durante la actualización espera a que termine antes de su kyro install.

**Evidence**:
- Summary: Corrección QA: execute() protege runs.finish del catch (la corrida queda running y se recupera al arrancar); sin rechazos sin manejar. Test nuevo
- Validation: tsc y eslint sin hallazgos
- Validation: vitest api: 22 archivos, 346 tests OK (incluye falla de finish con bloqueo liberado y whenIdle resuelto)
- Files changed: `apps/api/src/maintenance/updater.ts`, `apps/api/test/maintenance.test.ts`

**Verdict**: pass

---
#### T2.4: Rutas de Versiones con TOTP, guard y recuperación al arrancar

**Status**: done

**Description**: Crear apps/api/src/maintenance/routes.ts: GET /api/versions → { kyro: { installed, latest, updateRunning } }; POST /api/versions/kyro/update con body { code } (onlyKeys) → ReauthVerifier.verify primero, después updater.start(); responde 202 { runId }, 409 { error, running } si hay sesiones o actualización en curso; GET /api/maintenance-runs?kind=kyro-update → lista más nueva primero (límite 50). Cablear en app.ts y llamar a runs.failInterrupted() al arrancar, junto a projectService.recoverInterrupted().

**Evidence**:
- Summary: Corrección QA: code opcional en el schema, así que POST sin code responde 401 invalid_totp; test exige 401 exacto. Además cache de 60 s de latest en KyroVersions (un npm view por minuto)
- Validation: tsc y eslint sin hallazgos
- Validation: vitest api: 22 archivos, 346 tests OK
- Files changed: `apps/api/src/maintenance/routes.ts`, `apps/api/src/maintenance/versions.ts`, `apps/api/test/maintenance-routes.test.ts`, `apps/api/test/maintenance.test.ts`

**Verdict**: pass

---
#### T2.5: Índice único en repo_url (debt-3)

**Status**: done

**Description**: Migración nueva: CREATE UNIQUE INDEX projects_repo_url_unique ON projects(lower(repo_url)) WHERE repo_url IS NOT NULL. ProjectRepository.create traduce la violación a ProjectError 'El proyecto ya existe: <repo>' (409, igual que el duplicado por nombre), así dos altas concurrentes del mismo repo con nombres distintos dejan una sola fila y un solo clon.

**Evidence**:
- Summary: Migración 5 projects_repo_url_unique (índice único sobre lower(repo_url) parcial, con check previo que falla con mensaje claro si hay repos duplicados, sin borrar filas); insertGithub traduce la violación a ProjectConflictError 'El proyecto ya existe: <repo>'. Base de desarrollo verificada en solo lectura: aún está en v3 (sin columna repo_url), así que no puede haber duplicados
- Validation: tsc --noEmit sin errores
- Validation: eslint src test sin hallazgos
- Validation: vitest run: 22 archivos, 344 tests OK (migración sobre base con urls nulas y distintas, no-op en la 2ª corrida, falla clara con duplicados sin borrar nada, dos altas concurrentes del mismo repo con otro nombre dejan un proyecto y un clon)
- Files changed: `apps/api/src/db/migrations.ts`, `apps/api/src/projects/repo.ts`, `apps/api/test/db.test.ts`, `apps/api/test/project-service.test.ts`

**Verdict**: pass

---
### P3 — Docs del tramo Versiones

> Dejar escrito lo que este sprint cambia: regla de bitácora para corridas desde el panel y API de Versiones.

#### T3.1: CLAUDE.md (regla D10), plan.md y panel-desarrollo.md para Versiones

**Status**: done

**Description**: CLAUDE.md, regla de oro: las actualizaciones de Kyro hechas desde el panel quedan en maintenance_runs y no suman línea a la bitácora; la bitácora registra la creación de 08-kyro-update.sh y los cambios de procedimiento. docs/plan.md: Versiones y la API (GET /api/versions, POST /api/versions/kyro/update con TOTP y L8, GET /api/maintenance-runs) y el resultado de H1. docs/panel-desarrollo.md: variable PANEL_KYRO_UPDATE_SCRIPT y cómo probar la actualización en desarrollo.

**Evidence**:
- Summary: CLAUDE.md: excepción D10 en la regla de oro (corridas desde el panel van a maintenance_runs, no a la bitácora). plan.md: sección Versiones y actualización de Kyro (3 rutas, TOTP, L8, KyroLock, historial, H1). panel-desarrollo.md: PANEL_KYRO_UPDATE_SCRIPT y cómo probar la actualización
- Validation: prettier --check limpio en CLAUDE.md, plan.md, panel-desarrollo.md y vm-setup.md
- Validation: contenido contrastado con el código: rutas, campo code, 202/401/409, timeouts 5s/10s/10min, 50 corridas, 16 KB, mensaje 409
- Files changed: `CLAUDE.md`, `docs/plan.md`, `docs/panel-desarrollo.md`

**Verdict**: pass

---

## Unfinished work

_None — every task is done with a passing verdict._

## Learnings

_No learnings recorded._

## Resolved Debt

- **debt-1**: Rutas de chats: additionalProperties:false descarta campos extra en vez de rechazarlos (ajv removeAdditional de Fastify)
- **debt-2**: R4: el mensaje de duplicado está en inglés ('Project already exists'), la especificación pide 'ya existe'
- **debt-5**: Test flaky project-service 'recoverInterrupted…': el clon en segundo plano hace mkdir(dest) antes que el mkdirSync del test (EEXIST ~40%). Fix: mkdirSync(..., { recursive: true }) en test/project-service.test.ts:315

## Recommendations for Sprint 4

_None recorded._
