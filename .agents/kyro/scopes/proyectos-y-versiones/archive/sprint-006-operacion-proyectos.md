---
title: 'proyectos-y-versiones — Sprint 6: Operación de proyectos: sin Kyro, inicializar, pull y borrado'
date: '2026-10-05'
scope: 'proyectos-y-versiones'
sprint: 6
slug: 'operacion-proyectos'
outcome: 'shipped'
type: 'sprint-archive'
---

# Sprint 6: Operación de proyectos: sin Kyro, inicializar, pull y borrado

> Closed: 2026-10-05
> Outcome: shipped

## Objective

Que un proyecto se opere completo desde la web: pedidos directos y sin tipos de Kyro cuando no lo tiene, inicialización de Kyro en una rama propia, pull del clon base y borrado seguro (sin trabajo sin pushear), y cerrar las pruebas manuales diferidas.

## Definition of Done

- Todas las tareas done con evidencia y veredicto pass
- Calidad: typecheck, lint, format:check, tests y build en verde; kyro analyze limpio
- debt-7, debt-8 y debt-9 resueltas
- El borrado nunca elimina trabajo sin pushear (probado con repos git reales)
- Docs actualizados en el mismo cambio

## Phases

### P1 — Chats sin Kyro (API)

> Tipo de chat 'direct' y reglas de tipos permitidos según hasKyro (debt-7).

#### T1.1: Tipo de chat 'direct' y prompt sin skill

**Status**: done

**Description**: Agregar el tipo 'direct' a ChatKind (packages/shared), a la validación de POST /api/chats y a buildInitialPrompt: el prompt va tal cual (el pedido del usuario), sin referencia a skills de Kyro ni a .agents/. Un proyecto sin Kyro (hasKyro=false) rechaza scope y work con 409 y un motivo en español; direct se acepta siempre (con y sin Kyro). Migrar el CHECK/valores de chats.kind si la base lo restringe.

**Evidence**:
- Summary: Tipo de chat 'direct': prompt sin skill, 409 para scope/work sin Kyro, migración 6 que reconstruye chats con foreign_keys apagadas
- Validation: typecheck, lint y format:check sin errores
- Validation: npx vitest api: 377/377 (incluye chats sin Kyro, direct con y sin Kyro y migración 6 conservando chat_events)
- Files changed: `packages/shared/src/index.ts`, `apps/api/src/chats/service.ts`, `apps/api/src/chats/routes.ts`, `apps/api/src/db/migrations.ts`, `apps/api/test/chats.test.ts`, `apps/api/test/db.test.ts`, `apps/api/test/helpers.ts`
- Notes: Los tests de chats scope/work ahora usan makeKyroRepo (repo con .agents/kyro). Web aún no ofrece 'direct' (T5.1).

**Verdict**: pass

---
#### T1.2: Permisos del agente en proyectos sin Kyro

**Status**: done

**Description**: Revisar ALLOWED_TOOLS y la política de canUseTool para los chats direct: lectura (cat/ls/grep/find vía Read, Grep, Glob y Bash de solo lectura) permitida sin pedir confirmación, escritura solo dentro del worktree, nunca bypassPermissions. Documentar la política.

**Evidence**:
- Summary: Bash admite ls, cat, head, tail, wc, grep y pwd como inicio de comando solo con argumentos dentro del worktree; sin variables, ~ ni globs. Vinculada al escenario S61.
- Validation: typecheck, lint y format:check sin errores (repo completo, 05/10/2026)
- Validation: npx vitest api: 417/417, incluido el test de la política de lectura (allow dentro, deny en /etc, .., ~, $HOME, globs, redirección y encadenado)
- Files changed: `apps/api/src/agent/permissions.ts`, `apps/api/test/agent.test.ts`
- Notes: Política válida para todos los chats. find queda denegado (-delete/-exec). Escribir fuera del worktree sigue denegado.

**Verdict**: pass

---
### P2 — Inicializar Kyro en rama propia

> Botón Inicializar Kyro que trabaja en un worktree dedicado y deja la rama commiteada.

#### T2.1: API: POST /api/projects/:id/kyro-init

**Status**: done

**Description**: Con código TOTP (misma verificación que Actualizar Kyro), crear un worktree chore/kyro-init desde la rama base, correr 'kyro install --scope workspace --init-workspace --yes' ahí bajo el KyroLock compartido, commitear los archivos generados (Conventional Commit, sin atribución de IA) y dejar la rama sin pushear. Responde con la rama y el path. Rechaza con 409 si el proyecto ya tiene Kyro, si no está 'ready', si hay una actualización de Kyro corriendo o si ya existe la rama chore/kyro-init. Si falla, borra el worktree creado y deja el proyecto intacto.

**Evidence**:
- Summary: POST /api/projects/:id/kyro-init: con TOTP crea el worktree chore/kyro-init, corre kyro install bajo KyroLock, commitea y deja la rama sin pushear; sin dejar restos si falla
- Validation: typecheck, lint y format:check sin errores
- Validation: npx vitest api: 385/385; test/kyro-branch.test.ts (7) con repos git reales: commit con .agents/kyro, clon base intacto, 401 sin/ con código inválido, fallo de install y 'sin archivos' sin worktree ni rama, 409 con Kyro/no listo/rama existente/init en curso, 404
- Files changed: `apps/api/src/projects/kyro-branch.ts`, `apps/api/src/projects/kyro-branch-routes.ts`, `apps/api/src/worktrees/create.ts`, `apps/api/src/app.ts`, `apps/api/test/kyro-branch.test.ts`, `apps/api/test/cli.test.ts`, `apps/api/test/helpers.ts`
- Notes: El instalador se inyecta en los tests (kyroInstaller): el kyro real no se corrió contra la VM. La ruta de 'kyro install' real en un worktree queda por probar a mano (T6.3). Hay ventana donde no se chequea si un chat esta corriendo: no hace falta, el init no toca worktrees de chats.

**Verdict**: pass

---
### P3 — Pull del clon base

> Traer lo subido a GitHub al clon base sin pisar nada (debt-8).

#### T3.1: API: POST /api/projects/:id/pull

**Status**: done

**Description**: Por execFile (sin shell) correr 'git fetch origin' y 'git pull --ff-only origin <base_branch>' en el clon base. Antes comprobar que la rama actual es la base y que no hay cambios locales en archivos versionados. Rechazar con 409 y motivo claro si el proyecto no está listo, hay cambios locales, la rama no es la base, hay divergencia o hay una actualización de Kyro corriendo. Responder resultado: ya al día, o commits traídos (antes y después) con salida recortada. Implementar como función reutilizable por repo (el scope del piloto automático la extiende a repos hijos).

**Evidence**:
- Summary: POST /api/projects/:id/pull: fetch + pull --ff-only del clon base por execFile; 409 con cambios locales versionados, otra rama o divergencia; informa commits traídos o 'al día'
- Validation: typecheck, lint y format:check sin errores
- Validation: npx vitest api: 397/397; project-pull.test.ts (12) con repos git reales (origin bare, clon, pusher): ff con N commits, al día, commits locales conservados, cambios locales/otra rama/divergencia sin tocar el clon, untracked no bloquea, rama tipo opción rechazada, 409/404/401/502 en la ruta
- Files changed: `apps/api/src/projects/git.ts`, `apps/api/src/projects/pull.ts`, `apps/api/src/projects/pull-routes.ts`, `apps/api/src/app.ts`, `apps/api/test/project-pull.test.ts`, `apps/api/test/cli.test.ts`
- Notes: Sin TOTP: solo fast-forward, no puede perder trabajo. Rechaza si hay actualización de Kyro corriendo (el script corre kyro install en cada proyecto). git.ts exporta git() y GitCommandError para reutilizar en T4.1. Extensión a repos hijos queda para el scope del piloto.

**Verdict**: pass

---
### P4 — Borrado seguro de proyectos

> Borrar registro, clon, worktrees y .env cifrados solo si no se pierde trabajo.

#### T4.1: Chequeo de trabajo sin pushear

**Status**: done

**Description**: Función que inspecciona el clon base y cada worktree del proyecto y devuelve la lista de bloqueos: cambios sin commitear (incluye archivos no versionados que no estén ignorados), commits que no están en ningún remoto (git log HEAD --not --remotes) y ramas locales sin upstream con commits propios. Solo lectura, por execFile. Un worktree cuya carpeta ya no existe no bloquea.

**Evidence**:
- Summary: findUnsavedWork: lista cambios sin commitear y commits sin pushear en el clon base, cada worktree y repos anidados un nivel; solo lectura por execFile
- Validation: typecheck, lint y format:check sin errores
- Validation: npx vitest api: 406/406; project-safety.test.ts (9) con repos git reales: limpio, sin commitear/untracked, rama sin pushear, pusheada deja de bloquear, base del clon, HEAD suelto, .env ignorado no cuenta, worktree sin carpeta no bloquea, repo hijo anidado
- Files changed: `apps/api/src/projects/safety.ts`, `apps/api/test/project-safety.test.ts`
- Notes: Un test encontró un bug propio (git() recorta el espacio inicial de ' M README.md'); corregido con regex. No hace fetch: un push hecho desde otra máquina y no traído se ve como sin pushear (falla del lado seguro). Repos hijos solo a un nivel de profundidad.

**Verdict**: pass

---
#### T4.2: API: DELETE /api/projects/:id

**Status**: done

**Description**: Con código TOTP y el nombre del proyecto en el cuerpo, borrar: rechazar con 409 si hay una sesión corriendo o bloqueos de T4.1 (devolver la lista en el cuerpo, sin borrar nada); si no, quitar worktrees (git worktree remove), la carpeta del clon (solo dentro del directorio de proyectos, mismo guardia que removeOwnFolder), los .env cifrados, los chats y el registro, en ese orden y con fallos parciales reportados. Rechaza si hay clonado en curso.

**Evidence**:
- Summary: DELETE /api/projects/:id con TOTP y nombre: borra worktrees, clon, chats, eventos, .env cifrados y registro; 409 con lista de bloqueos o sesión corriendo sin tocar nada
- Validation: typecheck, lint y format:check sin errores
- Validation: npx vitest api: 417/417; project-delete.test.ts (11) con repos git reales: borrado completo, 409 con commit sin pushear y éxito tras pushear, 409 con cambios sin commitear, 409 con sesión corriendo, 400 nombre incorrecto, 401 sin/ con código inválido, 400 campo extra, 404, 409 clonando, nombre visible aceptado, clon fuera de projectsDir se conserva, symlink no se sigue, fallo parcial reintentable
- Files changed: `apps/api/src/projects/delete.ts`, `apps/api/src/projects/delete-routes.ts`, `apps/api/src/projects/repo.ts`, `apps/api/src/app.ts`, `apps/api/test/project-delete.test.ts`, `apps/api/test/cli.test.ts`
- Notes: El código TOTP se verifica antes que el nombre (un 401 no revela nada). La carpeta del clon solo se borra si es un directorio real (sin symlink) hijo directo de projectsDir; si no, se desregistra y se conserva (cloneRemoved:false). Riesgo conocido y no cubierto: un chat creado justo mientras corre el borrado (ventana de milisegundos) podría dejar un worktree huérfano. Tras un fallo parcial el proyecto sigue registrado y se puede reintentar. Probado solo con repos temporales: el borrado real queda para T6.3 con un repo descartable.

**Verdict**: pass

---
### P5 — Web de operación

> Exponer todo en la web con los componentes de la identidad visual.

#### T5.1: Formulario de chat nuevo por tipo disponible

**Status**: done

**Description**: El selector de tipo muestra Scope, Work y Pedido directo si el proyecto tiene Kyro, y solo Pedido directo si no. Sin Kyro, mostrar un aviso con el botón Inicializar Kyro. Lógica pura de tipos disponibles en un archivo testeable.

**Evidence**:
- Summary: El formulario de chat nuevo ofrece Work, Scope y Pedido directo con Kyro, y solo Pedido directo (más aviso con enlace a Inicializar Kyro) sin Kyro; la sidebar muestra 'directo · rama'
- Validation: typecheck, lint y format:check sin errores
- Validation: web: 113/113 tests (chat-kinds.spec.ts nuevo: tipos por hasKyro, default, efectivo, parseo; status.spec con 'directo'); build en verde
- Files changed: `apps/web/src/app/chats/chat-kinds.ts`, `apps/web/src/app/chats/chat-kinds.spec.ts`, `apps/web/src/app/chats/new-chat.form.ts`, `apps/web/src/app/chats/status.ts`, `apps/web/src/app/chats/status.spec.ts`
- Notes: NO probado en un navegador: la lógica de tipos está testeada, el render del formulario no. El enlace 'Inicializar Kyro' apunta a la tab 'repository' de la configuración, que se crea en T5.2 (hasta entonces cae en General).

**Verdict**: pass

---
#### T5.2: Configuración: Repositorio y zona de borrado

**Status**: done

**Description**: Nueva tab Repositorio en la configuración del proyecto: botón Traer cambios de GitHub (pull, muestra el resultado o el motivo del rechazo) y botón Inicializar Kyro (si no tiene) con modal de TOTP que muestra al terminar la rama chore/kyro-init. Tab/zona General con 'Borrar proyecto': modal que pide escribir el nombre y el código TOTP, muestra la lista de bloqueos si el borrado se rechaza, y al terminar vuelve a Proyectos. El código se vacía al enviar, al cerrar y al fallar (R28).

**Evidence**:
- Summary: Configuración suma la tab Repositorio (Traer cambios de GitHub, Inicializar Kyro con modal TOTP que muestra la rama creada) y, en General, la zona de peligro con Borrar proyecto (modal con nombre + TOTP, lista de bloqueos del 409, vuelve a Proyectos)
- Validation: typecheck, lint y format:check sin errores
- Validation: web: 119/119 tests (repo-actions.spec.ts nuevo: resúmenes de pull y rama, coincidencia de nombre, lectura de bloqueos del 409; settings-tabs.spec con la tab repository); api 417/417; build en verde
- Validation: grep: sin colores hex/rgb fuera de tokens.css ni URLs externas nuevas
- Files changed: `apps/web/src/app/projects/repo-actions.section.ts`, `apps/web/src/app/projects/delete-project.modal.ts`, `apps/web/src/app/projects/project-danger-zone.ts`, `apps/web/src/app/projects/repo-actions.ts`, `apps/web/src/app/projects/repo-actions.spec.ts`, `apps/web/src/app/projects/projects.service.ts`, `apps/web/src/app/projects/settings.page.ts`, `apps/web/src/app/projects/settings-tabs.ts`, `packages/shared/src/index.ts`
- Notes: NO probado en un navegador ni contra la API real: solo la lógica pura tiene tests; los componentes están validados por typecheck, lint, build y revisión. El código TOTP se vacía al enviar y al cerrar (takeCode), como en los otros modales; el modal de borrado mantiene el nombre tipeado tras un error para reintentar. Tipos PullResult, KyroBranchResult y DeleteBlocker pasaron a packages/shared y la API los importa. Se verifica a mano en T6.3.

**Verdict**: pass

---
### P6 — Docs, verificación y pruebas manuales

> Documentar, verificar y resolver debt-9.

#### T6.1: Docs y reglas

**Status**: done

**Description**: Actualizar docs/plan.md (borrado deja de ser no-objetivo, tipo direct, pull, init en rama), docs/panel-desarrollo.md (cómo operar un proyecto desde la web), docs/estados.md si cambia algún estado, docs/identidad-visual.md si hay componentes nuevos, y el apartado de Proyectos registrados de CLAUDE.md (proyectos sin Kyro). Si se agrega algo a la VM, docs/vm-setup.md y la bitácora.

**Evidence**:
- Summary: Docs de pedido directo, Inicializar Kyro, Traer cambios y Borrar proyecto en plan.md, panel-desarrollo.md, CLAUDE.md e identidad-visual.md. Vinculada al escenario S62.
- Validation: prettier --check de docs y CLAUDE.md sin diferencias
- Validation: revisión contra el código: rutas, códigos de respuesta, rama chore/kyro-init, ruta del worktree y reglas de borrado coinciden con lo implementado
- Files changed: `docs/plan.md`, `docs/panel-desarrollo.md`, `CLAUDE.md`, `docs/identidad-visual.md`
- Notes: estados.md y vm-setup.md sin cambios (ningún estado nuevo, nada tocado en la VM). spec.nonGoals sigue listando 'Borrar proyectos': plan --update-active no edita nonGoals; R35 lo reemplaza.

**Verdict**: pass

---
#### T6.2: Verificación automática del sprint

**Status**: done

**Description**: Correr typecheck, lint, format:check, tests y build de todo el repo; grep de hex fuera de tokens.css y de URLs externas; kyro analyze.

**Evidence**:
- Summary: Verificación automática del repo completo tras T1.1-T6.1, E1 y E2. Vinculada a S65.
- Validation: typecheck sin errores; lint y format:check limpios
- Validation: npm test: api 427/427 y web 120/120; build en verde
- Validation: grep de hex/rgb fuera de tokens.css = 0; sin URLs externas ni Google Fonts en la web
- Validation: kyro analyze: no semantic issues found
- Files changed: `docs`
- Notes: NO probado en un navegador ni contra la API real; el kyro install real y el borrado real quedan para T6.3.

**Verdict**: pass

---
#### T6.3: Pruebas manuales diferidas (debt-9) y recorrido del sprint

**Status**: done

**Description**: Checklist que corre el usuario en la web, con la API real: (1) Versiones: Actualizar con script falso y 409 con un chat corriendo; (2) subir un .env con un chat corriendo y ver la fila 'agente en curso'; (3) buscar valores falsos del .env en los logs de la API; (4) recorrido nuevo: proyecto sin Kyro solo ofrece Pedido directo, Inicializar Kyro crea la rama, Traer cambios, y Borrar rechazado con trabajo sin pushear y aceptado en un proyecto descartable; (5) recorrido visual de lo del sprint 5 que no se vio en un navegador. Registrar cada resultado como evidencia.

**Evidence**:
- Summary: El usuario recorrió el checklist manual completo y reportó que todo anduvo bien
- Validation: Reporte del usuario (05/10/2026): 'Da todo bien'. Cubre los 9 puntos enviados: Actualizar Kyro con script falso y 409 con chat corriendo, raíz salteada, .env con chat corriendo, ausencia del valor falso en logs, proyecto sin Kyro (pedido directo e Inicializar Kyro), Traer cambios con rechazo por cambios locales, aviso de project.json, Borrar con rechazo por commit sin pushear y borrado tras pushear, y recorrido visual del sprint 5
- Files changed: 
- Notes: Evidencia declarada por el usuario, sin capturas ni salida por punto: no la puedo verificar por mi cuenta. No hubo fallas que registrar como deuda.

**Verdict**: pass

---

## Unfinished work

_None — every task is done with a passing verdict._

## Learnings

_No learnings recorded._

## Resolved Debt

- **debt-1**: Rutas de chats: additionalProperties:false descarta campos extra en vez de rechazarlos (ajv removeAdditional de Fastify)
- **debt-2**: R4: el mensaje de duplicado está en inglés ('Project already exists'), la especificación pide 'ya existe'
- **debt-3**: Sin índice único en repo_url: dos altas concurrentes del mismo repo con nombres distintos clonarían dos veces
- **debt-4**: kyro install corre por proyecto y toca lo global: serializar si hay altas simultáneas con .agents/kyro/
- **debt-5**: Test flaky project-service 'recoverInterrupted…': el clon en segundo plano hace mkdir(dest) antes que el mkdirSync del test (EEXIST ~40%). Fix: mkdirSync(..., { recursive: true }) en test/project-service.test.ts:315
- **debt-6**: writeEnvFiles con applyToActive sobre un worktree con agente corriendo: entre el realpath de la carpeta y el rename hay una ventana (TOCTOU) en la que el agente podría cambiar una carpeta por un symlink. Evaluar abrir la carpeta con O_DIRECTORY/O_NOFOLLOW o no aplicar a chats running
- **debt-7**: El prompt inicial del chat invoca siempre el flujo Kyro (kyro-work/kyro-forge) aunque el proyecto no tenga Kyro (hasKyro=false); el agente crea Work y archivos .agents/ en el worktree. Pendiente: pedido directo sin Kyro, 'Inicializar Kyro' desde la web, permisos de lectura (cat/ls/grep) y revisión independiente (scope del piloto automático)
- **debt-8**: Actualizar un proyecto desde GitHub desde la web (git fetch + pull --ff-only del clon base por execFile, rechazando si hay cambios locales o divergencia, y mostrando el resultado): hoy lo subido a GitHub después del clon no llega a la VM y los worktrees nuevos parten de un clon viejo
- **debt-9**: Pruebas manuales diferidas de T5.1, a hacer al final del Sprint 4 (resolver antes de cerrar): Versiones (Actualizar con script falso; 409 con un chat corriendo), fila 'agente en curso' al aplicar .env con chat corriendo, y ausencia de valores falsos del .env en los logs de la API. Ya confirmadas por el usuario: Clonando->Listo sin recargar y sesión vencida -> login

## Recommendations for Sprint 7

_None recorded._
