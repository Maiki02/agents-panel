# Estados de un worktree

Cada scope o work de Kyro corre en su propio worktree. El panel muestra en todo momento **un estado** por worktree, más un **detalle** opcional (por ejemplo, `probando · go test ./internal/cart`) y **quién tiene que actuar**: el agente, el sistema o vos.

Regla de oro: el estado se deduce de señales verificables (Kyro, git, `gh`, hooks del Agent SDK, el propio orquestador), nunca del texto que escribe el agente.

> **No confundir con el estado del proyecto.** Un *proyecto* tiene su propio estado, mucho más simple y previo a cualquier worktree: `cloning` (clonando), `ready` (listo) o `error` (ver [`plan.md`](plan.md), «Registro de proyectos»). No es un estado de worktree ni aparece en este catálogo: solo decide si se puede crear un chat (un proyecto que no está `ready` responde 409).

## Fases

Los estados se agrupan en seis fases, que son las que se ven en el stepper de la tarjeta:

`Preparación → Planificación → Ejecución → QA → Merge a dev → Cierre`

Además hay estados **transversales** (pausado, interrumpido, bloqueado, etc.) que pueden aparecer en cualquier fase. Cuando se resuelven, el worktree vuelve al estado en el que estaba.

## Catálogo

Actor: **A** = agente · **S** = sistema/panel · **Vos** = espera tu acción.

### Preparación

| id | Etiqueta | Actor | Se detecta por | Sale a |
|---|---|---|---|---|
| `en_cola` | En cola | S | No hay cupo de sesiones libres | `creando_worktree` |
| `creando_worktree` | Creando worktree | S | Orquestador corre `git worktree add` + clones de fe/be | `instalando_dependencias` |
| `instalando_dependencias` | Instalando dependencias | S | Script de setup (`go mod download`, `npm install`), y después el panel escribe los `.env` del proyecto | `planificando` |

Si el setup o la escritura de los `.env` fallan, el worktree no llega a existir: la creación del chat responde 422 con el motivo y se borran worktree, rama y chat (no queda en `error`, porque no hay chat). Motivos de los `.env`: «falta la carpeta X para Y» (el setup no creó la carpeta), «el .env Y está ilegible, volvé a subirlo» (se rotó `PANEL_SECRET_KEY` o el dato se alteró), una ruta que git no ignora en el worktree o una carpeta que sale del worktree. El evento `worktree_output` con `step: 'env'` registra solo las rutas escritas.

### Planificación

| id | Etiqueta | Actor | Se detecta por | Sale a |
|---|---|---|---|---|
| `madurando_idea` | Madurando la idea | A | Sesión corriendo `/kyro:idea` | `planificando` |
| `planificando` | Planificando | A | `/kyro:forge` en INIT/PLAN; `nextAction = plan_sprint` | `esperando_aclaracion`, `esperando_aprobacion_plan`, `escribiendo_codigo` |
| `esperando_aclaracion` | Necesita una aclaración | Vos | `nextAction = clarify` o marcadores `[NEEDS CLARIFICATION]` | `planificando` |
| `esperando_aprobacion_plan` | Plan listo para aprobar | Vos | Sprint planificado y gate de aprobación del panel activo | `escribiendo_codigo` o `planificando` (si pedís cambios) |

### Ejecución

| id | Etiqueta | Actor | Se detecta por | Sale a |
|---|---|---|---|---|
| `escribiendo_codigo` | Escribiendo código (tarea n/m) | A | `nextAction = execute_task`; ediciones de archivos | `en_cola_build`, `probando`, `registrando_evidencia` |
| `en_cola_build` | En cola para buildear | S | Hook `PreToolUse` detecta un build y espera cupo del semáforo de builds | `buildeando` |
| `buildeando` | Buildeando… | A | Comando en curso: `ng build`, `npm run *:build*`, `go build` | `escribiendo_codigo`, `probando`, `corrigiendo` |
| `probando` | Probando… (+ qué) | A | Comando en curso: `go test`, `vitest`, `ng test`, `eslint` | `escribiendo_codigo`, `registrando_evidencia`, `corrigiendo` |
| `corrigiendo` | Corrigiendo (ronda k/3) | A | Build/test fallido o `review --verdict fail` | `escribiendo_codigo`, `bloqueado` |
| `registrando_evidencia` | Registrando evidencia | A | `kyro record-evidence` en curso | `revisando_tarea` |
| `revisando_tarea` | Revisando tarea | A | `kyro review` en curso; `nextAction = review_task` | `escribiendo_codigo` (siguiente tarea), `corrigiendo`, `qa` |
| `esperando_permiso` | Pide permiso | Vos | `canUseTool` recibió una herramienta fuera de la lista permitida | estado anterior |
| `esperando_respuesta` | Te hizo una pregunta | Vos | Hay una fila de `pending_questions` con `status = pending` para el chat (ver abajo) | estado anterior |

### QA

| id | Etiqueta | Actor | Se detecta por | Sale a |
|---|---|---|---|---|
| `qa` | QA en curso | A | Sesión corriendo `/kyro:qa` | `corrigiendo`, `cerrando_sprint` |
| `cerrando_sprint` | Cerrando sprint (retro + archivo) | A | `nextAction = close_sprint`; `kyro close-sprint` | `esperando_aprobacion_cierre`, `planificando` (próximo sprint) |
| `esperando_aprobacion_cierre` | Cierre de scope para aprobar | Vos | Kyro pide aprobación del cierre | `trayendo_dev` |

### Merge a dev

| id | Etiqueta | Actor | Se detecta por | Sale a |
|---|---|---|---|---|
| `trayendo_dev` | Trayendo dev a la rama | A | `/merge-dev`: `git merge origin/dev` en fe/be | `resolviendo_conflictos`, `validando_post_merge`, `abriendo_pr` |
| `resolviendo_conflictos` | Resolviendo conflictos | A | Merge con conflictos en curso | `validando_post_merge`, `esperando_respuesta` |
| `validando_post_merge` | Validando después del merge | A | Build/tests tras traer dev (pasa por `en_cola_build`) | `abriendo_pr`, `corrigiendo` |
| `abriendo_pr` | Abriendo PRs | A | `git push` + `gh pr create` | `en_cola_merge_raiz` |
| `en_cola_merge_raiz` | En cola para mergear la raíz | S | Otro worktree está mergeando la raíz a `main` | `mergeando_raiz` |
| `mergeando_raiz` | Mergeando la raíz a main | A | `git merge --no-ff feature/<scope>` + push | `pr_lista` |
| `pr_lista` | PR lista para revisar | Vos | PRs abiertas, checks en verde | `pr_checks_fallidos`, `pr_cambios_pedidos`, `mergeada` |
| `pr_checks_fallidos` | Checks de la PR en rojo | A/Vos | `gh pr checks` con fallos | `corrigiendo` (si lo pedís) |
| `pr_cambios_pedidos` | Pediste cambios en la PR | A | Review "changes requested" en GitHub | `escribiendo_codigo` |

### Cierre

| id | Etiqueta | Actor | Se detecta por | Sale a |
|---|---|---|---|---|
| `mergeada` | PRs mergeadas | S | Todas las PRs del scope en estado `merged` | `limpiando` |
| `limpiando` | Borrando worktree | S | `git worktree remove` + borrado de ramas locales | `archivado`, `revisar` |
| `archivado` | Archivado | — | Worktree borrado; chat en solo lectura | (final) |

### Transversales

| id | Etiqueta | Actor | Cuándo | Al resolverse |
|---|---|---|---|---|
| `pausado` | Pausado | Vos | Lo pausaste desde el panel | Vuelve al estado anterior |
| `sin_cupo_de_uso` | Esperando cupo de la suscripción | S | Se alcanzó el límite de uso de Claude | Reanuda solo cuando se libera el límite |
| `interrumpido` | Interrumpido | Vos | La VM o el panel se reiniciaron con la sesión en curso | Reanudar (resume de la sesión) |
| `bloqueado` | Bloqueado | Vos | 3 rondas de corrección fallidas, o Kyro marcó la tarea `blocked` | Lo destrabás y reanuda |
| `revisar` | Revisar a mano | Vos | Limpieza frenada: cambios sin commitear o PR cerrada sin mergear | Lo resolvés y se archiva |
| `error` | Error | Vos | Fallo del sistema (git, red, disco lleno) con el mensaje | Reintentar |
| `cancelado` | Cancelado | — | Lo cancelaste desde el panel | (final) |

## Diagrama (camino feliz)

```mermaid
stateDiagram-v2
  [*] --> en_cola
  en_cola --> creando_worktree --> instalando_dependencias --> planificando
  planificando --> esperando_aclaracion --> planificando
  planificando --> esperando_aprobacion_plan --> escribiendo_codigo
  escribiendo_codigo --> en_cola_build --> buildeando --> probando
  probando --> corrigiendo --> escribiendo_codigo
  probando --> registrando_evidencia --> revisando_tarea
  revisando_tarea --> escribiendo_codigo: siguiente tarea
  revisando_tarea --> qa: sprint terminado
  qa --> cerrando_sprint --> esperando_aprobacion_cierre --> trayendo_dev
  trayendo_dev --> validando_post_merge --> abriendo_pr
  abriendo_pr --> en_cola_merge_raiz --> mergeando_raiz --> pr_lista
  pr_lista --> mergeada --> limpiando --> archivado --> [*]
```

### Pregunta pendiente (`esperando_respuesta`)

Es una señal verificable, no una frase del agente: el panel solo la da por cierta si existe la fila.

- **Fuente:** tabla `pending_questions` (migración 7): `chat_id`, `tool_use_id`, `questions` (JSON con las preguntas y sus opciones), `status` (`pending` · `answered` · `cancelled`), `answer`, `answered_by`, `created_at` y `answered_at`. Es única por chat y `tool_use_id`, y la base misma impide una respuesta sin `answered_by` ni `answered_at` (nadie responde por vos).
- **Cuándo nace:** el agente usa `AskUserQuestion`; el hook `PreToolUse` la deja pasar y `canUseTool` guarda la fila, publica el evento `question_asked` y **espera sin límite de tiempo**. Nunca se contesta sola.
- **Mientras espera:** el chat sigue en `running` (el turno no terminó) y la web muestra un único badge ámbar «Esperando tu respuesta» (tono `warn`: te toca a vos), más la tarjeta con un botón por opción y «Otra respuesta». `GET /api/chats/:id/questions` lista las preguntas del chat.
- **Cómo sale:** `POST /api/chats/:id/questions/:qid/answer` guarda la respuesta y quién la dio, registra `question_answered` y se la devuelve al agente **en la misma sesión** (`updatedInput`), que sigue con ella. Volver a responder da 409.
- **Si se cancela** (cancelar el trabajo, terminar el turno o reiniciar el panel) la fila pasa a `cancelled` y queda el evento `question_cancelled`. Tras un reinicio el chat queda `interrupted`; al reanudar con un mensaje, el agente vuelve a hacer la pregunta (con otro `tool_use_id`).
- **Qué la distingue de `esperando_permiso`:** el permiso viene de `canUseTool` con una herramienta fuera de la lista (`permission_denied`); la pregunta viene de `AskUserQuestion` y tiene su propia tabla. En el MVP del permiso solo se registra la denegación.

## Cómo lo implementa el panel

- **Fuente de verdad del estado:** tabla `worktree_state` en SQLite (estado, detalle, desde cuándo, estado previo). Cada cambio se guarda como evento y se manda por SSE.
- **Hooks del Agent SDK:** `PreToolUse` y `PostToolUse` clasifican los comandos `Bash` (build, test, git, gh, kyro) y actualizan el estado. El hook de build **espera** en el semáforo de builds, y eso genera `en_cola_build`.
- **Kyro:** después de cada `record-evidence`, `review` o fin de turno se corre `kyro context-pack --json` para leer `nextAction` y el avance n/m.
- **GitHub:** sondeo de `gh pr list` / `gh pr checks` cada pocos minutos para los estados de PR.
- **Arranque del panel:** toda sesión que estaba activa pasa a `interrumpido`, y los builds en cola se vuelven a encolar.

### Campos reales de Kyro (confirmados en la VM)

Confirmados el 05/10/2026 con Kyro 6.1.0, capturando la salida real de un scope y un Work descartables en un repo temporal (`apps/api/test/fixtures/kyro/capture.sh`). Todos los `--json` imprimen `{ ok, command, data }`; con `ok: false` viene `error: { code, message }`. El lector tipado es `apps/api/src/kyro/state.ts` (`parseScopeState`, `parseWorkState`).

**Scope.** Se combinan dos lecturas, que tienen que coincidir en `nextAction` (si no, el estado se movió entre las dos y se vuelve a leer):

| Dato | De dónde sale |
|---|---|
| `nextAction`, `nextTaskId`, `status`, `openDebtCount`, `blockers[].reason` | `kyro context-pack --kyro-scope <s> --json` → `data.*` |
| Sprint actual | `kyro status full --kyro-scope <s> --json` → `data.activeSprint.n` (`null` si no hay sprint activo) |
| Tarea n/m | `data.taskSummary.verified` / `data.taskSummary.total` del mismo `status full` |
| Reviews pendientes | `data.pendingReviewCount` del `status full` |
| Total de sprints, sprints cerrados | **Ningún comando los imprime**: salen de `roadmap.plannedSprintCount` y `ledger.length` de `sprint.json` (lectura, nunca escritura) |

`nextAction` de un scope que se observaron: `plan_sprint` (recién creado o con el sprint anterior cerrado), `clarify` (preguntas abiertas o marcadores `[NEEDS CLARIFICATION]`), `execute_task`, `review_task`, `qa_or_close`, `await_scope_completion` (hoja de ruta agotada, o sin tareas listas) y `done` (`status: completed`). **`close_sprint` existe en el esquema pero Kyro 6.1.0 nunca lo escribe**: tras `qa_or_close`, `kyro close-sprint` pasa directo a `plan_sprint` o `await_scope_completion`. Por eso el piloto decide el cierre desde `qa_or_close` y el parser igual lo acepta por si una versión futura lo emite. `init` tampoco se observa.

**Work** (`kyro work status --work <slug> --json` → `data`): `work.{id,revision,state}` (`state`: `draft`, `active`, `closed`), `nextAction`, `nextTaskId`, `blockedReason` y `summary.{verified,disposed,pending,inProgress,blocked,awaitingReview,unresolved}` (listas de ids; tarea n/m = verificadas + descartadas sobre el total). `nextAction` de un Work: `plan_tasks`, `execute_task`, `review_task`, `resolve_blocker` (con `blockedReason`), `ready_to_close` y `done` (con `closure`). Toda escritura de un Work pide `--expect-revision` con el `revision` leído acá.

## Estado de sesión del MVP (etapa 4)

Antes de que exista el estado fino, cada chat guarda un **estado grueso de sesión** en `chats.status`. Se deduce solo de lo que pasa con la sesión del Agent SDK, nunca del texto del agente:

| `chats.status` | Cuándo | Cómo sale |
|---|---|---|
| `running` | Hay un turno del agente en curso (`AgentManager.start`) | Termina el turno (`idle`), falla (`error`) o se cancela (`cancelled`) |
| `idle` | El turno terminó con `result:success`; espera el próximo mensaje | `POST /api/chats/:id/messages` (resume) |
| `error` | El SDK devolvió un `result` con error o la corrida lanzó una excepción (queda un evento `error`) | Mandar otro mensaje (resume) |
| `interrumpido` (`interrupted`) | Al arrancar el servidor el chat estaba `running` | Mandar un mensaje: retoma con el `sdk_session_id` guardado |
| `cancelado` (`cancelled`) | `POST /api/chats/:id/cancel` abortó el turno | Mandar un mensaje (resume) |

Un chat `running` rechaza nuevos mensajes con 409; y no puede haber más de 4 sesiones `running` a la vez (la quinta da 409).

**Mapeo a los estados finos (etapa 5):** `running` pasa a ser cualquiera de los estados de Preparación/Planificación/Ejecución/QA según las señales de Kyro, git y `gh`; `idle` se mapea al estado en que quedó la fase; una pregunta pendiente (`pending_questions`) es `esperando_respuesta` y la sesión sigue `running` mientras espera (el turno no terminó); `interrupted` y `cancelled` equivalen a las transversales `interrumpido` y `cancelado`; `error` es la transversal `error`. La tabla `worktree_state` se agrega encima: `chats.status` sigue siendo el estado de la *sesión*, no del *worktree*.
