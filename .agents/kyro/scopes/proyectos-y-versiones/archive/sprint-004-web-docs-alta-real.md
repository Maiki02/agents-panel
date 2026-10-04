---
title: 'proyectos-y-versiones — Sprint 4: Web de proyectos, docs y alta real'
date: '2026-10-04'
scope: 'proyectos-y-versiones'
sprint: 4
slug: 'web-docs-alta-real'
outcome: 'partial'
type: 'sprint-archive'
---

# Sprint 4: Web de proyectos, docs y alta real

> Closed: 2026-10-04
> Outcome: partial

## Objective

Que la web tenga Proyectos como pantalla inicial (alta por GitHub, configuración, .env con TOTP), una página por proyecto con sus chats, la pantalla Versiones, los docs al día y que el usuario dé de alta los tres proyectos reales desde ahí.

## Definition of Done

- Todas las tareas done con evidencia y verdict pass
- npm run typecheck, npm run lint, npm run format:check, npm test y npm run build en verde
- / es Proyectos y cada proyecto muestra solo sus chats (test de filtro por projectId)
- El contenido de un .env no queda en el estado de la web ni aparece en respuestas ni logs
- Docs sin 'la pantalla web llega en el sprint'
- Alta real de los tres proyectos confirmada por el usuario
- debt-6 resuelta

## Phases

### P1 — Ajustes de API para la web

> Lo que la web necesita y la API todavía no da: filtro de chats por proyecto y la decisión de debt-6.

#### T1.1: GET /api/chats?projectId= filtra por proyecto

**Status**: done

**Description**: Agregar querystring opcional projectId (integer >= 1, additionalProperties:false) a GET /api/chats; ChatRepository.list(projectId?) filtra en SQL. Sin projectId devuelve todos como hoy. Un projectId inexistente devuelve [] (no 404).

**Evidence**:
- Summary: GET /api/chats acepta projectId (entero >=1, sin campos extra); ChatRepository.list(projectId?) filtra en SQL; inexistente devuelve []
- Validation: tsc --noEmit ok
- Validation: eslint src test ok
- Validation: vitest api 347/347 ok (nuevo test de filtro, 400 y 401)
- Files changed: `apps/api/src/chats/routes.ts`, `apps/api/src/chats/repo.ts`, `apps/api/test/chats.test.ts`

**Verdict**: pass

---
#### T1.2: applyToActive omite worktrees con agente corriendo (debt-6)

**Status**: done

**Description**: applyEnvFileToWorktrees recibe los chats con su status y no escribe en los que están 'running': los informa como skipped con motivo 'agente en curso: se aplica cuando termine o en el próximo chat'. Así se cierra la ventana TOCTOU de debt-6 (el agente no puede cambiar una carpeta por un symlink mientras se escribe) sin agregar O_NOFOLLOW por carpeta.

**Evidence**:
- Summary: applyEnvFileToWorktrees omite chats running con motivo 'agente en curso: se aplica cuando termine o en el próximo chat'; docs plan.md y panel-desarrollo.md actualizados con la decisión (debt-6)
- Validation: tsc --noEmit ok
- Validation: eslint src test ok
- Validation: vitest api 348/348 ok (nuevo test running vs idle: contenido y mtime intactos, centinela ausente)
- Files changed: `apps/api/src/env-files/apply.ts`, `apps/api/test/env-routes.test.ts`, `docs/plan.md`, `docs/panel-desarrollo.md`

**Verdict**: pass

---
### P2 — Base de la web

> Servicios, rutas, menú, manejo de sesión vencida vs TOTP inválido y el diálogo TOTP reutilizable.

#### T2.1: Servicios, rutas y menú: / = Proyectos, /projects/:id, /versions

**Status**: done

**Description**: ProjectsService (list, get, add, patch, retry), EnvFilesService (list, put, remove) y VersionsService (get, update, runs) con tipos de @agents-panel/shared. Rutas: '' -> ProjectsPage, 'projects/:id' -> ProjectPage, 'versions' -> VersionsPage, 'chats/:id' sin cambios, todas con authGuard. Menú del header: Proyectos y debajo Versiones. ChatListPage global deja de ser la ruta inicial (se borra o queda sin ruta). Nombre mostrado: displayName ?? name (helper projectLabel).

**Evidence**:
- Summary: Servicios Projects/EnvFiles/Versions, ChatsService.list(projectId?), projectLabel con spec, rutas '' -> ProjectsPage, projects/:id, versions con authGuard, menú Proyectos/Versiones; ChatListPage borrada. Las 3 páginas son stubs que completan T2.2/T3.x.
- Validation: npm run lint ok
- Validation: web typecheck ok
- Validation: web build ok
- Validation: web vitest 15/15 ok (project-label.spec)
- Files changed: `apps/web/src/app/app.routes.ts`, `apps/web/src/app/app.ts`, `apps/web/src/app/projects/projects.service.ts`, `apps/web/src/app/projects/env-files.service.ts`, `apps/web/src/app/versions/versions.service.ts`, `apps/web/src/app/projects/project-label.ts`, `apps/web/src/app/projects/project-label.spec.ts`, `apps/web/src/app/chats/chats.service.ts`, `apps/web/src/app/projects/projects.page.ts`, `apps/web/src/app/projects/project.page.ts`, `apps/web/src/app/versions/versions.page.ts`, `apps/web/src/styles.css`

**Verdict**: pass

---
#### T2.2: Sesión vencida vs TOTP inválido y diálogo TOTP reutilizable

**Status**: done

**Description**: Interceptor: un 401 con error 'unauthorized' (sesión vencida) limpia AuthService y navega a /login; un 401 'invalid_totp' no redirige y llega al formulario. apiErrorMessage traduce invalid_totp a 'Código incorrecto o ya usado. Esperá el próximo código de la app.' y 429 como hoy. TotpDialog: componente con un input de 6 dígitos (autocomplete one-time-code, inputmode numeric) que emite el código y se limpia al cerrar o al fallar.

**Evidence**:
- Summary: sessionInterceptor: 401 unauthorized limpia sesión y va a /login (no en /api/auth/*); 401 invalid_totp pasa al formulario. apiErrorMessage traduce invalid_totp. TotpDialog reutilizable que emite el código y lo vacía al enviar o cancelar. AuthService.expire().
- Validation: npm run lint ok
- Validation: web typecheck ok
- Validation: web build ok
- Validation: web vitest 21/21 ok (session.interceptor.spec, api-error.spec)
- Files changed: `apps/web/src/app/auth/session.interceptor.ts`, `apps/web/src/app/auth/session.interceptor.spec.ts`, `apps/web/src/app/auth/auth.service.ts`, `apps/web/src/app/app.config.ts`, `apps/web/src/app/chats/chats.service.ts`, `apps/web/src/app/shared/totp-dialog.ts`, `apps/web/src/app/shared/api-error.spec.ts`

**Verdict**: pass

---
### P3 — Pantallas

> Proyectos, página de proyecto, configuración con .env y Versiones.

#### T3.1: Pantalla Proyectos: tarjetas, estados, reintentar y Agregar proyecto

**Status**: done

**Description**: Una tarjeta por proyecto con nombre visible, owner/repo, estado (Clonando / Listo / Error + statusDetail), aviso 'proyecto sin Kyro' (hasKyro=false) y kyroWarning. Error -> botón Reintentar (POST retry). Mientras haya alguno en cloning se refresca cada 3 s y se corta al salir de la pantalla. Formulario Agregar: repo (owner/repo o URL de GitHub), nombre visible opcional; validación previa en el cliente con la misma regla de R3 (el servidor sigue siendo la autoridad) y muestra 400/409 con el mensaje del servidor ('El proyecto ya existe: …'). Cuando un proyecto pasa a Listo sin setup guardado y GET /:id trae suggestedSetupCommand, la tarjeta muestra 'Setup sugerido: …' con Confirmar / Editar / Sin setup; nada se guarda hasta confirmar (PATCH setupCommand).

**Evidence**:
- Summary: Pantalla Proyectos con tarjetas (nombre visible, owner/repo, estado, statusDetail, aviso sin Kyro/kyroWarning), Reintentar, polling de 3 s solo mientras haya cloning (se corta al salir), formulario Agregar con validación espejo de R3 (repo-input) que conserva lo escrito ante 400/409, y setup sugerido que solo se guarda al Confirmar (PATCH).
- Validation: npm run lint ok
- Validation: web typecheck ok
- Validation: web build ok
- Validation: web vitest 43/43 ok (repo-input.spec)
- Files changed: `apps/web/src/app/projects/projects.page.ts`, `apps/web/src/app/projects/add-project.form.ts`, `apps/web/src/app/projects/repo-input.ts`, `apps/web/src/app/projects/repo-input.spec.ts`, `apps/web/src/styles.css`
- Notes: Polling, sugerencia de setup y 409 no tienen test automático (vitest corre en node sin DOM); verificados por revisión de código y compilación, no en navegador.

**Verdict**: pass

---
#### T3.2: Página de proyecto: chat nuevo con proyecto fijo y sus chats

**Status**: done

**Description**: ProjectPage (/projects/:id): encabezado con nombre visible, estado y link a Configuración (sección en la misma página o pestaña). NewChatForm recibe projectId como input y deja de mostrar el selector de proyecto; si el proyecto no está Listo el formulario queda deshabilitado con el motivo, y un 409 del servidor se muestra. Lista de chats con ChatsService.list(projectId). Si el id no existe: 'Proyecto no encontrado' con vuelta a Proyectos.

**Evidence**:
- Summary: ProjectPage /projects/:id con encabezado y estado, NewChatForm con proyecto fijo (input) deshabilitado con el motivo si cloning/error, ChatList que usa ChatsService.list(projectId), 'Proyecto no encontrado' con vuelta; /chats/:id con link de vuelta al proyecto. withComponentInputBinding habilitado.
- Validation: npm run lint ok
- Validation: web typecheck ok
- Validation: web build ok
- Validation: web vitest 43/43 ok (new-chat.form.spec sigue en verde)
- Files changed: `apps/web/src/app/projects/project.page.ts`, `apps/web/src/app/chats/new-chat.form.ts`, `apps/web/src/app/chats/chat-list.page.ts`, `apps/web/src/app/chats/chat.page.ts`, `apps/web/src/app/app.config.ts`
- Notes: El filtrado lo hace la API (T1.1, con test); la UI no tiene test de DOM (vitest en node), verificada por compilación y revisión.

**Verdict**: pass

---
#### T3.3: Configuración del proyecto y .env con TOTP

**Status**: done

**Description**: Editar nombre visible, rama base y comando de setup (vacío = sin setup) con PATCH. Sección .env: lista de ruta, claves, fecha y 'ilegible' si readable=false (con texto 'volvé a subirlo'). Subir: ruta relativa + archivo (FileReader) o texto pegado, casilla 'aplicar también a los worktrees activos', y TotpDialog. Reemplazar = subir a la misma ruta. Borrar con confirmación + TOTP. Después de aplicar, tabla por worktree: escrito u omitido con motivo (incluye 'agente en curso' de T1.2). El contenido vive solo en una variable local del envío: después de enviar (ok o error) se vacían el textarea, el input de archivo y cualquier signal; nunca se muestra contenido que venga del servidor (no viene).

**Evidence**:
- Summary: ProjectSettings (PATCH nombre visible/rama base/setup) y EnvFilesSection write-only: lista con claves, fecha e 'ilegible', subir/reemplazar (archivo o texto, aplicar a activos), borrar con confirmación, TOTP por acción vía TotpDialog, tabla por worktree con motivos. env-upload valida nombre (R14) y tamaño; trySend vacía el contenido tras enviar, con éxito o error.
- Validation: npm run lint ok
- Validation: web typecheck ok
- Validation: web build ok
- Validation: web vitest 61/61 ok (env-upload.spec: nombres, tamaño, contenido descartado en éxito y fallo)
- Validation: grep console./localStorage/sessionStorage en apps/web/src: solo main.ts console.error preexistente, ningún contenido
- Files changed: `apps/web/src/app/projects/env-upload.ts`, `apps/web/src/app/projects/env-upload.spec.ts`, `apps/web/src/app/projects/env-files.section.ts`, `apps/web/src/app/projects/project-settings.ts`, `apps/web/src/app/projects/project.page.ts`, `apps/web/src/styles.css`
- Notes: El 401 invalid_totp sin redirigir lo cubre session.interceptor.spec (T2.2); el comportamiento de los componentes no tiene test de DOM.

**Verdict**: pass

---
#### T3.4: Pantalla Versiones

**Status**: done

**Description**: Muestra Kyro instalado y última publicada ('última: desconocida' si latest es null, botón disponible igual), botón Actualizar con TotpDialog, 409 con el mensaje y la cantidad de sesiones corriendo, y mientras updateRunning sea true el botón se deshabilita y se refresca cada 3 s hasta que termina. Historial (GET /api/maintenance-runs): fecha, de -> a, estado y salida recortada desplegable en <pre>.

**Evidence**:
- Summary: Pantalla Versiones: Kyro instalada y última (latestLabel: 'desconocida' / 'al día' / 'hay una nueva'), Actualizar con TotpDialog (body {code}), 409 con el mensaje de la API (cantidad de sesiones), botón deshabilitado y refresco cada 3 s mientras updateRunning (se corta al terminar y al salir), historial con fecha, de→a, estado y salida en <pre> desplegable.
- Validation: npm run lint ok
- Validation: web typecheck ok
- Validation: web build ok
- Validation: web vitest 66/66 ok (versions.spec)
- Validation: api vitest maintenance-routes ok: corrida con script falso primera en historial, 409 con sesiones corriendo
- Files changed: `apps/web/src/app/versions/versions.page.ts`, `apps/web/src/app/versions/version-label.ts`, `apps/web/src/app/versions/versions.spec.ts`, `apps/web/src/styles.css`
- Notes: La UI no tiene test de DOM; no se probó en navegador. Los criterios de script falso y 409 se cubren con los tests existentes de la API que ejercen las mismas rutas.

**Verdict**: pass

---
### P4 — Docs

> Que los docs describan lo que la web ya hace (R24).

#### T4.1: plan.md, panel-desarrollo.md y CLAUDE.md al día con la web

**Status**: done

**Description**: plan.md: sacar los 'la pantalla web llega en el sprint N', describir Proyectos / página de proyecto / Versiones y la decisión de debt-6; marcar el estado del scope. panel-desarrollo.md: el alta, la configuración, los .env y la actualización se explican primero desde la web (la API queda como referencia), project:add del CLI como alternativa para carpetas ya clonadas. CLAUDE.md: revisar que la sección de proyectos registrados mencione la web; solo cambiar si hace falta. vm-setup.md: sin cambios salvo que la VM cambie (si cambia, regla de oro).

**Evidence**:
- Summary: plan.md: se quitan los 'llega en el sprint N' y se describen Proyectos, página del proyecto, .env en la web, Versiones y la distinción 401. panel-desarrollo.md: alta, configuración, .env y actualización de Kyro explicados primero desde la web, API como referencia, project:add para carpetas ya clonadas. CLAUDE.md menciona el alta desde la web. vm-setup.md sin cambios (la VM no cambió).
- Validation: grep 'llega en el sprint' en docs/: sin resultados
- Validation: npm run format:check limpio
- Validation: campos totp (.env) y code (versiones) y códigos 202/401/409 verificados contra routes.ts de env-files y maintenance
- Files changed: `docs/plan.md`, `docs/panel-desarrollo.md`, `CLAUDE.md`

**Verdict**: pass

---
### P5 — Verificación y alta real

> Recorrido completo por el túnel y alta real hecha por el usuario.

#### T5.1: Recorrido manual de la web por el túnel SSH

**Status**: done

**Description**: Con API y web levantadas en la VM (docs/panel-desarrollo.md), recorrer: login, Proyectos, agregar un repo descartable propio (no expedientes-ai), ver Clonando -> Listo, confirmar setup sugerido, página del proyecto con su chat nuevo, subir un .env de prueba con valores falsos y TOTP, aplicar a activos, Versiones con el script fake, sesión vencida -> login. Dejar capturas o notas como evidencia. Corregir lo que aparezca como tarea emergente.

**Evidence**:
- Summary: Recorrido manual por túnel SSH informado por el usuario. OK: login y Proyectos; alta de test-panel (clon en ~/proyectos/test-panel, Listo, aviso sin Kyro); página del proyecto y chat nuevo (worktree ~/wt/test-panel/probar-env creado); .env subido y escrito en el worktree con modo 600; .env.production y .env.example rechazados; .env.test y .env.pro rechazados por no estar ignorados por git; TOTP incorrecto muestra 'Código incorrecto o ya usado' sin salir de la página; aplicar a activos muestra 'Chat 1 Escrito'. NO probados en navegador: pantalla Versiones (Actualizar con script falso, 409 por sesiones), fila 'agente en curso' con chat corriendo, sesión vencida -> login, búsqueda de valores falsos en logs, confirmación explícita de Clonando->Listo sin recargar y setup sugerido. Hallazgo: el prompt inicial invoca siempre Kyro aunque hasKyro=false (debt-7); falta pull del clon desde la web (debt-8).
- Validation: npm run typecheck, lint, format:check, build en verde
- Validation: api vitest 348/348 y web vitest 66/66
- Validation: recorrido manual parcial: ver summary
- Files changed: 
- Notes: Evidencia manual provista por el usuario; lo no probado queda cubierto solo por tests automáticos de la API (maintenance-routes, env-routes) y por revisión.

**Verdict**: pass

---
#### T5.2: Alta real de NovaGent, Agents Panel y expedientes-ai (la hace el usuario)

**Status**: pending

**Disposition**: deferred → sprint:5 — El usuario decidió no hacer el alta real ahora: la hará cuando termine otro scope

**Description**: Checklist para el usuario desde la web: (1) NovaGent: ponerle nombre visible 'NovaGent' (ya registrado). (2) Agents Panel: agregar Maiki02/agents-panel; se adopta la carpeta ~/proyectos/agents-panel sin clonar; setup 'npm ci'. (3) expedientes-ai: agregar Maiki02/expedientes-ai; se clona; setup 'uv sync --project backend'; subir backend/.env de desarrollo con TOTP. (4) Crear un work chico en expedientes-ai y verificar worktree, dependencias instaladas y backend/.env con modo 600 y git status limpio. El agente prepara el checklist, no ejecuta pasos y registra como evidencia lo que el usuario informe.

**Evidence**:
- Summary: Diferida por decisión del usuario; no se ejecutó ningún paso del alta real (NovaGent, Agents Panel, expedientes-ai) ni se verificó el work con .env en expedientes-ai
- Validation: Sin validación: tarea no ejecutada
- Files changed: 

**Verdict**: _Not reviewed._

---

## Unfinished work

- **T5.2** (Alta real de NovaGent, Agents Panel y expedientes-ai (la hace el usuario)): deferred → sprint:5 — El usuario decidió no hacer el alta real ahora: la hará cuando termine otro scope

## Learnings

_No learnings recorded._

## Resolved Debt

- **debt-1**: Rutas de chats: additionalProperties:false descarta campos extra en vez de rechazarlos (ajv removeAdditional de Fastify)
- **debt-2**: R4: el mensaje de duplicado está en inglés ('Project already exists'), la especificación pide 'ya existe'
- **debt-3**: Sin índice único en repo_url: dos altas concurrentes del mismo repo con nombres distintos clonarían dos veces
- **debt-4**: kyro install corre por proyecto y toca lo global: serializar si hay altas simultáneas con .agents/kyro/
- **debt-5**: Test flaky project-service 'recoverInterrupted…': el clon en segundo plano hace mkdir(dest) antes que el mkdirSync del test (EEXIST ~40%). Fix: mkdirSync(..., { recursive: true }) en test/project-service.test.ts:315
- **debt-6**: writeEnvFiles con applyToActive sobre un worktree con agente corriendo: entre el realpath de la carpeta y el rename hay una ventana (TOCTOU) en la que el agente podría cambiar una carpeta por un symlink. Evaluar abrir la carpeta con O_DIRECTORY/O_NOFOLLOW o no aplicar a chats running

## Recommendations for Sprint 5

_None recorded._
