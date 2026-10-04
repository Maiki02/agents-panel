---
title: 'proyectos-y-versiones — Sprint 1: Proyectos: modelo y alta por GitHub'
date: '2026-10-04'
scope: 'proyectos-y-versiones'
sprint: 1
slug: 'proyectos-api'
outcome: 'shipped'
type: 'sprint-archive'
---

# Sprint 1: Proyectos: modelo y alta por GitHub

> Closed: 2026-10-04
> Outcome: shipped

## Objective

Que la API registre proyectos desde GitHub (clon en segundo plano o adopción de una carpeta existente) con estados, nombre visible y setup sugerido, y que la VM tenga uv instalado, sin tocar todavía la web.

## Definition of Done

- Todas las tareas terminadas con evidencia y veredicto pass.
- `npm run typecheck`, `npm run lint`, `npm run format:check` y `npm test` pasan en la raíz.
- Ninguna ruta nueva responde sin sesión: guard.test.ts las recorre y la allowlist pública no cambió.
- Ningún comando nuevo usa shell: todo va por execFile con argv (se verifica con grep de exec/shell:true en el código nuevo y en la revisión).
- No se clonó ni registró ningún repo real durante el sprint (los tests usan un remoto falso y la prueba manual un repo descartable).
- `uv` está instalado en la VM por 07-uv.sh con segunda corrida idempotente, y vm-setup.md tiene el paso, la bitácora y la fila de Costos (US$0).

## Phases

### P1 — Verificar las hipótesis a mano

> Cerrar las dudas de gh y de Kyro sobre un repo descartable antes de escribir el servicio de alta.

#### T1.1: Probar gh repo clone y kyro install --init-workspace sobre un repo descartable

**Status**: done

**Description**: Con un repo git local descartable creado en el scratchpad (nunca expedientes-ai ni ningún repo real del usuario), comprobar: (a) qué hace `gh repo clone --help` con la rama por defecto y el directorio destino, y cómo se ve su error con un owner/repo inexistente (código de salida y stderr); (b) si `kyro install --scope workspace --init-workspace --yes` con el CLI global, corrido con cwd en un repo que tiene .agents/kyro/, deja el workspace listo (local.json) y es idempotente; (c) qué comando y salida usa `kyro doctor` para validarlo. Anotar los hallazgos (comando exacto, salida recortada, código de salida) en el contexto de la fase siguiente y en el paso de vm-setup.md que se escriba en T5.1.

**Evidence**:
- Summary: gh repo clone <owner/repo> <dir> (argv): ok exit 0 (origin https://github.com/<o>/<r>.git, rama por defecto del remoto); dir existente no vacío: exit 1 'fatal: destination path ... already exists' + 'failed to run git: exit status 128'; owner/repo inexistente: exit 1, stderr "GraphQL: Could not resolve to a Repository with the name '<o>/<r>'. (repository)", no crea la carpeta. kyro install --scope workspace --init-workspace --yes (CLI global 6.1.0) en un clon con .agents/kyro/: exit 0, crea local.json (gitignored, git status limpio); 2da corrida exit 0, solo cambia installedAt. kyro doctor: 13 PASS, exit 0. Hallazgo: kyro install también refresca runtime y skills globales (~/.agents/kyro/current, ~/.agents/skills/*), misma versión.
- Validation: gh repo clone octocat/Hello-World (repo público ajeno, en scratchpad): exit 0
- Validation: gh repo clone con owner/repo inexistente: exit 1, mensaje GraphQL anotado
- Validation: kyro install x2 en clon descartable con .agents/kyro/: exit 0 ambas, 2da sin cambios salvo installedAt (gitignored)
- Validation: kyro doctor: exit 0, 13 PASS
- Files changed: 
- Notes: Desviación del criterio 3 aceptada por el usuario: kyro install refrescó ~/.agents (misma versión 6.1.0, es la misma operación que usa la actualización de Kyro). Repo real intacto. Clon exitoso probado con octocat/Hello-World (público, ajeno) en scratchpad; el usuario lo aceptó como repo descartable. No se modificó ningún archivo del repo (evidencia corregida: sin --file).

**Verdict**: pass

---
### P2 — Modelo, configuración y tipos

> Dejar la base y los tipos listos para todo el scope (sprints 1 a 3) sin perder el proyecto existente.

#### T2.1: Migración: columnas de projects y tablas project_env_files y maintenance_runs

**Status**: done

**Description**: Agregar una migración numerada nueva en migrations.ts que: (1) amplíe projects con display_name (nullable), repo_url (nullable, URL canónica https://github.com/owner/repo), status ('cloning' | 'ready' | 'error', NOT NULL, default 'ready' para las filas existentes) y status_detail (nullable); (2) cree project_env_files(project_id, rel_path, ciphertext, iv, tag, key_names, updated_at, UNIQUE(project_id, rel_path)) con clave foránea a projects; (3) cree maintenance_runs(id, kind, from_version, to_version, status, output, started_at, finished_at). Las dos últimas las usan los sprints 2 y 3; se crean ahora porque el plan agrupa todo el modelo en una migración. Actualizar el tipo Project de packages/shared con displayName, repoUrl, status y statusDetail y exportar ProjectStatus.

**Evidence**:
- Summary: Migración v4 en migrations.ts: projects += display_name, repo_url, status (NOT NULL DEFAULT 'ready', CHECK cloning|ready|error), status_detail; tablas project_env_files (FK a projects, UNIQUE(project_id, rel_path)) y maintenance_runs. Project de shared con displayName/repoUrl/status/statusDetail y export de ProjectStatus; toProject() mapea las columnas nuevas. Tests: base v3 con fila novagent migra conservando datos y queda ready; UNIQUE y FK de project_env_files; CHECK de status; segunda corrida sin cambios.
- Validation: npm run typecheck (shared, api, web): sin errores
- Validation: vitest run test/db.test.ts: 8 passed
- Validation: vitest run (api completo): 12 archivos, 86 tests passed
- Files changed: `apps/api/src/db/migrations.ts`, `apps/api/src/projects/repo.ts`, `packages/shared/src/index.ts`, `apps/api/test/db.test.ts`, `apps/api/test/worktrees.test.ts`
- Notes: worktrees.test.ts no estaba en taskFiles: se ajustó el literal Project para el tipo nuevo. project_env_files lleva además id INTEGER PRIMARY KEY (rowid explícito).

**Verdict**: pass

---
#### T2.2: Configuración PANEL_PROJECTS_DIR y umbral de espacio libre

**Status**: done

**Description**: Sumar a Config el directorio donde se clonan los proyectos (PANEL_PROJECTS_DIR, por defecto ~/proyectos, con la misma expansión de ~ que PANEL_WORKTREES_DIR) y el umbral de espacio libre (PANEL_MIN_FREE_DISK_GB, entero positivo, por defecto 10). Documentar ambas variables en apps/api/.env.example (valores falsos) y en la tabla de entorno de docs/panel-desarrollo.md. Hacer que makeApp de los tests pase un directorio temporal como PANEL_PROJECTS_DIR.

**Evidence**:
- Summary: Config suma projectsDir (PANEL_PROJECTS_DIR, default ~/proyectos con expandHome) y minFreeDiskGb (PANEL_MIN_FREE_DISK_GB vía positiveInt, default 10). Documentadas en .env.example (valores falsos, comentadas) y en la tabla de entorno de docs/panel-desarrollo.md. makeApp de los tests pasa un tmpdir como PANEL_PROJECTS_DIR y lo devuelve. Tests de config: defaults, expansión de ~, y ConfigError con 0, abc, -5, 1.5.
- Validation: npm run typecheck (shared, api, web): sin errores
- Validation: vitest run (api completo): 12 archivos, 91 tests passed
- Files changed: `apps/api/src/config.ts`, `apps/api/.env.example`, `docs/panel-desarrollo.md`, `apps/api/test/helpers.ts`, `apps/api/test/db.test.ts`
- Notes: Tests de config agregados en db.test.ts (donde ya vivían los de loadConfig), no estaba en taskFiles pero sí era archivo ya tocado.

**Verdict**: pass

---
### P3 — Servicio de alta de proyectos

> Parsear y validar el repo, adoptar o clonar en segundo plano y llevar el estado del proyecto, con toda la lógica probada contra un remoto falso.

#### T3.1: Parser y normalizador de repos de GitHub

**Status**: done

**Description**: Crear un módulo puro (src/projects/github.ts) que reciba la entrada del usuario (owner/repo, https://github.com/owner/repo, con o sin .git y con barra final) y devuelva { owner, repo, slug: 'owner/repo', httpsUrl } o lance ProjectError con mensaje claro. Reglas: owner ^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$; repo ^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$ y distinto de '.' y '..'; solo host github.com; se rechazan otros hosts, esquemas (file://, ssh, git@), rutas con más de dos segmentos, credenciales en la URL y espacios. Exportar también normalizeOrigin(url) que lleve https y ssh de GitHub (con o sin .git) a la misma forma para compararlos.

**Evidence**:
- Summary: src/projects/github.ts: parseGithubRepo (owner/repo o https://github.com/owner/repo con o sin .git y barra final → {owner, repo, slug, httpsUrl}) y normalizeOrigin (https, scp git@ y ssh:// de GitHub → https minúsculas, null si no es GitHub). Rechaza con ProjectError: otros hosts/subdominios, http/file/ssh/git@, credenciales, puerto, query/fragment, más de 2 segmentos, espacios/control, owner o repo que empiecen con '-' o '.', '..', límites 39/100. Tests de tabla en test/github.test.ts (67 casos).
- Validation: tsc --noEmit (api): sin errores
- Validation: eslint src test (api): sin errores
- Validation: prettier --check: ok
- Validation: vitest run api completo: 13 archivos, 158 tests passed (67 del parser)
- Files changed: `apps/api/src/projects/github.ts`, `apps/api/test/github.test.ts`
- Notes: Módulo puro: solo importa ProjectError de repo.ts. Nada se ejecuta.

**Verdict**: pass

---
#### T3.2: ProjectService: adopción, clon en segundo plano y estados

**Status**: done

**Description**: Crear src/projects/service.ts con ProjectService (usa ProjectRepository, Config y un 'cloner' inyectable que por defecto ejecuta `gh repo clone <owner/repo> <destino>` con execFile). add({ repo, name?, displayName?, baseBranch?, setupCommand? }): valida con github.ts; deriva el nombre interno kebab-case del repo si falta (misma regla que ProjectRepository.add) y rechaza duplicados con 409 ('ya existe'); el destino es <projectsDir>/<nombre>. Si el destino existe: lo adopta solo si es repo git y normalizeOrigin(origin) coincide con el pedido (queda ready tras verificar la rama base), si no responde 409 sin tocar nada. Si no existe: verifica espacio libre (fs.statfs) contra el umbral, inserta el proyecto en 'cloning' y clona en segundo plano; al terminar verifica origin y rama base (si no se pidió, usa la rama actual del clon) y pasa a 'ready'; ante cualquier fallo pasa a 'error' con status_detail recortado a 500 caracteres y borra el destino solo si lo creó el servicio. retry(id) vuelve a clonar un proyecto en error. recoverInterrupted() pasa los 'cloning' a 'error' ('interrumpido'). update(id, { displayName?, baseBranch?, setupCommand? }). suggestedSetup(project) devuelve 'bash scripts/panel-setup.sh' si el repo tiene scripts/panel-setup.sh, si no null.

**Evidence**:
- Summary: src/projects/service.ts: ProjectService con cloner inyectable (default: gh repo clone <slug> <dest> por execFile) y freeSpace inyectable (fs.statfs). add(): valida con github.ts, deriva nombre kebab-case, 'ya existe' (409) por nombre o repo_url, adopta carpeta existente solo si es raíz de repo git con origin normalizado igual (si no 409 sin tocar nada), si no existe verifica espacio ('sin espacio'), inserta 'cloning' y clona en segundo plano; al terminar verifica origin y rama base (o la actual) y pasa a ready; ante fallo error con detalle (stderr de gh) recortado a 500 y borra solo la carpeta creada (dentro de projectsDir). retry(), recoverInterrupted() ('interrumpido', limpia la carpeta parcial), update() (verifica la rama), suggestedSetup(), whenIdle() para tests. repo.ts: ProjectConflictError (409), ProjectNotFoundError, PROJECT_NAME_RE y métodos findByName/findByRepoUrl/listByStatus/insertGithub/setStatus/updateFields; ProjectRepository.add se mantiene.
- Validation: tsc --noEmit (api): sin errores
- Validation: eslint src test (api): sin errores
- Validation: vitest run test/project-service.test.ts: 24 passed (remoto bare local, sin red ni repos reales)
- Validation: vitest run api completo: 14 archivos, 182 tests passed
- Files changed: `apps/api/src/projects/service.ts`, `apps/api/src/projects/repo.ts`, `apps/api/test/project-service.test.ts`
- Notes: Mientras clona, base_branch queda '' si no se pidió (NOT NULL); T3.3 rechaza chats con 409 mientras no sea ready. recoverInterrupted borra la carpeta del 'cloning' interrumpido porque ese estado solo lo crea el clon del servicio. No se cableó aún en app.ts/rutas (tareas siguientes).

**Verdict**: pass

---
#### T3.3: Inicializar Kyro al registrar solo si el repo trae .agents/kyro/

**Status**: done

**Description**: Tras pasar a 'ready' (clon o adopción), si el repo tiene .agents/kyro/, ejecutar con execFile el comando de inicialización de Kyro verificado en T1.1 con cwd en el repo; si no lo tiene, no ejecutar nada y marcar el proyecto con hasKyro=false (se calcula al leer, no se guarda). La falla de Kyro no revierte el proyecto: queda 'ready' y el detalle se guarda en status_detail como aviso. Exponer hasKyro y kyroWarning en el tipo Project de la respuesta.

**Evidence**:
- Summary: ProjectService.initKyro: tras pasar a ready (clon, adopción o retry-adopción), si el repo trae .agents/kyro/ ejecuta por execFile 'kyro install --scope workspace --init-workspace --yes' con cwd en el repo (comando verificado en T1.1); si no, no ejecuta nada. Falla del inicializador no revierte ni borra: queda ready con 'Kyro: <detalle>' en status_detail. Project (shared) suma hasKyro (se calcula al leer con existsSync, no se guarda) y kyroWarning (status_detail cuando está ready). Inicializador inyectable (kyroInit) para tests.
- Validation: tsc via npm run typecheck (shared, api, web): sin errores
- Validation: eslint src test (api): sin errores
- Validation: vitest run api completo: 14 archivos, 186 tests passed (4 nuevos de Kyro: con .agents/kyro, sin, falla, adopción)
- Files changed: `apps/api/src/projects/service.ts`, `apps/api/src/projects/repo.ts`, `packages/shared/src/index.ts`, `apps/api/test/project-service.test.ts`, `apps/api/test/worktrees.test.ts`
- Notes: repo.ts (toProject) calcula hasKyro/kyroWarning, worktrees.test.ts ajustado al tipo nuevo; ninguno estaba en taskFiles. Reutiliza el hallazgo de T1.1: kyro install refresca también lo global de la VM.

**Verdict**: pass

---
### P4 — Rutas de la API, creación de chats y CLI

> Exponer el alta por la API con sesión obligatoria, bloquear chats sobre proyectos no listos y que el CLI use el mismo servicio.

#### T4.1: Rutas de proyectos: alta, detalle, edición y reintento

**Status**: done

**Description**: En projects/routes.ts agregar POST /api/projects (body: repo, name?, displayName?, baseBranch?, setupCommand?; responde 202 con el proyecto en 'cloning', 201 si se adoptó), GET /api/projects/:id (incluye suggestedSetupCommand cuando setup_command es null), PATCH /api/projects/:id (displayName, baseBranch, setupCommand) y POST /api/projects/:id/retry (solo desde 'error'). GET /api/projects devuelve el proyecto con sus campos nuevos. Esquemas JSON con additionalProperties:false y límites de largo. Mapear ProjectError a 400/404/409 con un manejador acotado. Registrar el servicio en app.ts y llamar a recoverInterrupted() al arrancar, junto a chats.markRunningAsInterrupted().

**Evidence**:
- Summary: projects/routes.ts: POST /api/projects (202 cloning, 201 adoptado), GET /api/projects/:id (con suggestedSetupCommand solo si setup_command es null y está ready), PATCH /api/projects/:id (displayName, baseBranch, setupCommand), POST /api/projects/:id/retry; GET /api/projects con los campos nuevos. Esquemas con additionalProperties:false y largos; como el ajv de Fastify descarta en silencio las propiedades extra, un preValidation onlyKeys las rechaza con 400 (p. ej. repoPath). ProjectError→400, ProjectNotFoundError→404, ProjectConflictError→409 con un manejador por ruta (sin setErrorHandler global). app.ts crea el ProjectService (inyectable por AppDeps.projectService) y llama recoverInterrupted() en onReady. Tests: alta 202→ready, adopción 201/409, 400 para 11 entradas sin llamar al cloner, PATCH (rama inexistente 400, 404), retry (409/404/200), sugerencia de setup, interrumpidos al arrancar, 401 sin sesión; guard.test comprueba que las rutas de proyectos están registradas y no son públicas.
- Validation: npm run typecheck (shared, api, web): sin errores
- Validation: eslint src test (api): sin errores
- Validation: vitest run api completo: 14 archivos, 206 tests passed
- Files changed: `apps/api/src/projects/routes.ts`, `apps/api/src/app.ts`, `apps/api/test/projects.test.ts`, `apps/api/test/guard.test.ts`, `apps/api/test/helpers.ts`, `apps/api/test/cli.test.ts`
- Notes: cli.test.ts (lista de rutas que mutan) y helpers.ts (projectService en makeApp) no estaban en taskFiles; la allowlist de cli.test se amplió a propósito con las 3 rutas de proyectos. Hallazgo: additionalProperties:false en Fastify NO rechaza extras (los quita); las rutas de chats existentes tienen el mismo comportamiento, no se tocaron (deuda posible).

**Verdict**: pass

---
#### T4.2: Rechazar chats sobre proyectos que no están listos

**Status**: done

**Description**: En ChatService.create, después de encontrar el proyecto y antes de validar el slug o tocar git, responder ChatError 409 ('El proyecto todavía no está listo: <estado>') si project.status no es 'ready'.

**Evidence**:
- Summary: ChatService.create responde ChatError 409 'El proyecto todavía no está listo: <estado>' si project.status !== 'ready', justo después de encontrar el proyecto y antes de validar el slug, reservar capacidad o crear el worktree. Tests: proyecto cloning y error → 409, sin chats, sin chat_events, sin carpeta de worktree y sin llamadas al runner; proyecto ready sigue creando el chat (201).
- Validation: tsc --noEmit y eslint src test (api): sin errores
- Validation: vitest run test/chats.test.ts: 11 passed
- Validation: vitest run api completo: 14 archivos, todos passed
- Files changed: `apps/api/src/chats/service.ts`, `apps/api/test/chats.test.ts`

**Verdict**: pass

---
#### T4.3: CLI project:add reutiliza el servicio

**Status**: done

**Description**: Hacer que project:add del CLI use ProjectService.adopt (registro de una carpeta local ya clonada, con las mismas validaciones y estado 'ready') en lugar de llamar directo a ProjectRepository.add, y que project:list muestre estado y nombre visible. No cambiar la firma de project:add <name> <repoPath> <baseBranch> [setupCommand].

**Evidence**:
- Summary: ProjectService.adopt({name, repoPath, baseBranch, setupCommand}) delega en ProjectRepository.add (una sola implementación de validación y alta; proyecto ready). El CLI project:add usa service.adopt con la misma firma y los mismos mensajes (Not a git repository, Base branch not found, Project already exists). project:list imprime id, nombre interno, nombre visible ('-' si falta), estado, ruta y rama base. CliDeps suma projectConfig opcional (cli.ts le pasa projectsDir y umbral).
- Validation: tsc --noEmit y eslint src test (api): sin errores
- Validation: vitest run api completo: 14 archivos, 210 tests passed (los 'project:add' existentes sin cambios en sus expectativas + 1 nuevo de project:list)
- Files changed: `apps/api/src/cli/projects.ts`, `apps/api/src/cli/commands.ts`, `apps/api/src/cli.ts`, `apps/api/src/projects/service.ts`, `apps/api/test/projects.test.ts`
- Notes: cli.ts y service.ts no estaban en taskFiles. En tests projectConfig queda sin definir (adopt no usa el directorio de clones).

**Verdict**: pass

---
### P5 — uv en la VM y documentación del sprint

> Dejar uv instalado por un script idempotente y documentado, y los docs al día con lo que cambió el sprint.

#### T5.1: Script scripts/vm/07-uv.sh y paso en vm-setup.md

**Status**: done

**Description**: Escribir scripts/vm/07-uv.sh (bash, set -euo pipefail, LF) que instale uv en ~/.local/bin si falta (o lo actualice con `uv self update` si ya está) y verifique con `uv --version`; sin sudo y sin tocar nada fuera del home. Agregar a docs/vm-setup.md el paso nuevo (qué se hizo, comando exacto, por qué y cómo se verifica), la línea de bitácora con fecha y resultado y la fila en la tabla Costos (US$0, sin recursos de Oracle). Correr el script dos veces en la VM y anotar el resultado real en la bitácora.

**Evidence**:
- Summary: scripts/vm/07-uv.sh (bash, set -euo pipefail, LF, sin root): instala uv con el instalador oficial de astral.sh en ~/.local/bin (UV_NO_MODIFY_PATH=1, el instalador verifica el checksum) o, si ya existe, corre uv self update. Ejecutado dos veces en la VM: 1ª instaló uv 0.12.23 aarch64 (uv y uvx); 2ª 'already on version v0.12.23 (the latest)', mismos sha256 de uv y uvx, .bashrc/.profile intactos. docs/vm-setup.md: paso 12 (qué, comando, por qué, verificación), paso 13 con los hallazgos de T1.1 (gh repo clone y kyro install), fila de Costos (US$0) y dos líneas de bitácora con el resultado real.
- Validation: bash -n scripts/vm/07-uv.sh: ok; sin CRLF; sin la palabra sudo
- Validation: bash scripts/vm/07-uv.sh (1ª corrida): exit 0, uv --version = 0.12.23
- Validation: bash scripts/vm/07-uv.sh (2ª corrida): exit 0, sin cambios (mismos sha256, 'latest version')
- Validation: ls -l/mtime de ~/.bashrc y ~/.profile: sin cambios
- Files changed: `scripts/vm/07-uv.sh`, `docs/vm-setup.md`
- Notes: Cambio real en la VM (uv en ~/.local/bin), costo US$0, autorizado por la tarea y sin recursos de Oracle. El instalador baja el script con curl a un archivo temporal y no se hace pipe a sh.

**Verdict**: pass

---
#### T5.2: Docs del sprint: plan.md, panel-desarrollo.md y estados

**Status**: done

**Description**: Actualizar docs/plan.md (el registro de proyectos pasa a hacerse desde la API/web y reemplaza la idea de .panel/project.yaml; estados clonando/listo/error; PANEL_PROJECTS_DIR) y docs/panel-desarrollo.md (cómo se agrega un proyecto por la API mientras la web no lo tenga, y que project:add sigue sirviendo para carpetas ya clonadas). Si se agregó algún estado visible al flujo del worktree, reflejarlo en docs/estados.md; los estados del proyecto no son estados de worktree, así que solo se menciona la diferencia.

**Evidence**:
- Summary: plan.md: 'Registro de proyectos' reescrito (alta por GitHub desde API/web, solo GitHub, gh repo clone por execFile, PANEL_PROJECTS_DIR/PANEL_MIN_FREE_DISK_GB, estados cloning/ready/error, adopción por origin, setup sugerido y no automático, Kyro solo si hay .agents/kyro/, project:add para carpetas ya clonadas); .panel/project.yaml queda mencionado solo como idea descartada. panel-desarrollo.md: sección 3 con el alta por la API (body, campos opcionales, 202/201/409/400, seguimiento, retry, PATCH, suggestedSetupCommand, hasKyro) y project:add/project:list para carpetas locales. estados.md: nota que distingue el estado del proyecto del estado de worktree.
- Validation: grep project.yaml en docs/*.md: solo la mención 'se descartó' en plan.md
- Validation: grep de valores secretos en los 3 docs: sin resultados; textos en español
- Validation: Rutas, campos y códigos de los docs contrastados con routes.ts y los tests de proyectos (202/201/409/400, suggestedSetupCommand, hasKyro/kyroWarning)
- Files changed: `docs/plan.md`, `docs/panel-desarrollo.md`, `docs/estados.md`
- Notes: El estado del proyecto no se agregó al catálogo de estados.md (no es estado de worktree), solo la diferencia. No se tocó CLAUDE.md (regla de bitácora es del sprint 3).

**Verdict**: pass

---

## Unfinished work

_None — every task is done with a passing verdict._

## Learnings

_No learnings recorded._

## Resolved Debt

_No debt resolved in this sprint._

## Recommendations for Sprint 2

_None recorded._
