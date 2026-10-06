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

Estado de implementación al 05/10/2026 (scope `autopiloto-kyro`, sprint 2 `modelos-estado-permisos`). El estado fino solo existe para chats de tipo **scope**, **work** e **idea** (un chat Idea madura el plan y, al aprobarse, pasa a ser un scope o un work); un pedido directo tiene únicamente el estado de sesión (`chats.status`) y `GET /api/chats/:id/state` y `/timeline` le responden 404.

### Tablas

- **`worktree_state`** (migración 10, una fila por chat, `ON DELETE CASCADE`): `state`, `detail`, `phase`, `sprint_current`/`sprint_closed`/`sprint_total`, `task_done`/`task_total`, `open_debt`, `blocked_reason`, `actor`, `role`, `model`, `since` (cuándo empezó el estado actual) y `previous_state`. Es la fuente de verdad del estado.
- **`autopilot_runs`** (migración 12, una fila por chat con piloto, `ON DELETE CASCADE`): `status` (`active`, `paused`, `off`, `stopped`, `waiting_quota`, `queued`, `finished`), `step` actual (`init`, `plan`, `execute`, `fix`, `close`, `merge`, `merge_dev`, `manual`), `sprint_n`, `sessions_in_sprint`, `last_fingerprint` (JSON con las señales de Kyro antes del paso), `stop_reason`, `retry_at`, `policy_version`, `seed_path` (el documento de la idea aprobada como scope, hasta que abre el paso `init`; migración 14), `phase` (`merge` desde que el trabajo se completa, para que un reinicio la retome) y `pr_urls` (las PR abiertas; migración 16). Es el estado del piloto: sobrevive al reinicio. `agent_sessions` suma `step` y `policy_version`. El actor `pilot` escribe las transiciones del piloto.
- **`worktree_transitions`** (migración 10, el Timeline): `from_state`, `to_state`, `reason`, `actor`, `role`, `model`, `data` (JSON con las señales: `nextAction`, `nextTaskId`, `waitingOn`) y `created_at`. El actor es obligatorio y la base lo valida (`user`, `pilot`, `agent`, `system`).
- **`agent_sessions`** (migración 9): una fila por sesión del SDK con `role` (`thinker` o `executor`), `provider`, `model`, `sdk_session_id`, `sprint_n` (lo asigna el piloto del sprint 3), `started_at`, `ended_at` y `result`. El piloto cuenta estas filas por sprint para el tope de sesiones.
- `WorktreeStateRepository.transition()` escribe fila y transición en una sola transacción y publica el evento `state_changed` (también guardado en `chat_events`) por el SSE del chat. Repetir el mismo estado con otro detalle o avance **solo actualiza la fila**, sin sumar transición.
- Eventos de sesión: `session_started { role, provider, model }` al abrir cada turno y `model_mismatch { requested, reported }` si `system:init` informa otro modelo.

### Qué estados se detectan hoy y con qué señal

| Estado | Señal | Actor de la transición |
|---|---|---|
| `creando_worktree`, `instalando_dependencias` | Se creó el worktree y corrió el setup (con los pasos en `data.steps`) | `system` |
| `planificando` | Empieza el primer turno de un scope o work | `agent` |
| `planificando` · `esperando_aclaracion` · `escribiendo_codigo` · `revisando_tarea` · `qa` · `cerrando_sprint` · `esperando_aprobacion_cierre` · `terminado` | `nextAction` de Kyro al terminar cada turno (tabla de abajo) | `agent` |
| `bloqueado` (`kyro_bloqueado`) | `context-pack` informa un blocker | `agent` |
| `planificando` · `escribiendo_codigo` · `revisando_tarea` · `bloqueado` (`tarea_bloqueada`) · `cerrando` · `terminado` | `nextAction` de `kyro work status` (un Work) | `agent` |
| `esperando_respuesta` | Hay una fila `pending_questions` pendiente | `agent` al preguntar; `user` al responder (vuelve al estado anterior) |
| `planificando` · `escribiendo_codigo` … (abre el paso) | El piloto abre una sesión nueva (`session_started` con `step`, `role`, `model` y `policyVersion`) | `pilot` (con `data.step` y `data.policyVersion`) |
| `madurando_idea` | Primer turno de un chat Idea (la idea la inicia el usuario); el fin del turno sin documento nuevo la deja en el mismo estado, y un mensaje nuevo con el plan ya escrito la devuelve acá | `user` al empezar; `agent` al terminar el turno |
| `esperando_aprobacion_plan` | Terminó un turno de una idea sin pregunta pendiente y `git status` / `git diff` contra la base muestran **exactamente un** `.md` nuevo o cambiado en `.agents/kyro/<docType>/` (sin `scopes/`, `work/`, `trace/` ni `qa/`); la ruta queda en `detail` y `data.path` | `agent` |
| `bloqueado` (`otro`) | Una idea terminó con más de un documento candidato: el detalle lista las rutas | `agent` |
| `planificando` (decisión del plan) | `POST /api/chats/:id/idea` con `approve_scope` o `approve_work`; el Timeline guarda `data.{action, path, userId, username}` | `user` |
| `madurando_idea` (cambios al plan) | `POST /api/chats/:id/idea` con `request_changes` y el texto, que viaja como turno nuevo del pensante | `user` |
| `bloqueado` (`kyro_bloqueado`, decisión) | `kyro work create` rechazó el work: el chat sigue siendo Idea | `system` |
| `cerrando` | El panel (no el agente) completa el scope (`kyro scope complete --yes`) o cierra el work (`kyro work close … --yes`) y commitea `.agents/kyro/` | `pilot` |
| `esperando_aprobacion_cierre` (con deuda) | `await_scope_completion` sin sprint abierto y con deuda abierta: el piloto frena **una vez**; la lista (id, título, prioridad) va en `data.debt` de la entrada del Timeline | `pilot` |
| `cerrando` (deuda aceptada) | `POST /api/chats/:id/autopilot { action: 'accept_debt', reason }` corre `kyro scope complete --accept-open-debt --reason … --yes`; el Timeline guarda quién aceptó, el motivo y la deuda aceptada | `user` |
| `trayendo_dev` | Empieza la fase de merge: `git pull --no-rebase origin <base>` (genérico) o la sesión `merge_dev` del proyecto | `pilot` |
| `resolviendo_conflictos` | El pull dejó rutas sin mergear (`git diff --diff-filter=U`) o `MERGE_HEAD`: se abre la sesión `merge` del ejecutor (`data.conflicts`) | `pilot` |
| `validando_post_merge` | El pull trajo commits y el proyecto tiene `validate_command` (se corre sin shell y su salida recortada queda en el evento `validation`); sin comando, la entrada dice que no hubo validación | `pilot` |
| `abriendo_pr` | `git push -u origin <rama>` y `gh pr list` / `gh pr create` (una PR abierta de la rama se reusa) | `pilot` |
| `pr_lista` | La PR (o las PR de la raíz y de los repos hijos) quedó abierta: `data.prUrl` / `data.prUrls`, también en `autopilot_runs.pr_urls` | `pilot` |
| `mergeada` | El merge-dev terminó y la rama de la raíz ya está en `origin/<base>` sin PR abierta (`git merge-base --is-ancestor`) | `pilot` |
| `terminado` (run terminado) | El run quedó `finished` sin pasar por la fase de merge (un trabajo cuyo Kyro ya estaba `done`) | `pilot` |
| `en_cola` | El piloto quiso abrir un paso y las 4 sesiones del panel estaban ocupadas; se reintenta al liberarse una | `pilot` |
| `sin_cupo_de_uso` | La sesión terminó con un `rate_limit_event` rechazado o un resultado de límite de uso; `data.retryAt` trae el reintento (a los 15 minutos) | `pilot` |
| `pausado` | El usuario pausó el piloto (`POST /api/chats/:id/autopilot { action: 'pause' }`); el turno en curso termina y no se abre el siguiente | `pilot` |
| `bloqueado` (`sin_avance`) | Una sesión terminó sin que cambie el fingerprint de Kyro (`nextAction`, tarea, sprint, tareas hechas, deuda, pendientes de review) y sin pregunta respondida | `pilot` |
| `bloqueado` (`tope_de_sesiones`) | El sprint llegó al tope (`PILOT_MAX_SESSIONS_PER_SPRINT`, 6 por defecto); también tras reinicios repetidos | `pilot` |
| `bloqueado` (`qa_sin_aprobar`) | La sesión de cierre cerró el sprint y `.agents/kyro/qa/<scope>/sprint-<n>.md` falta, es un symlink, no empieza con `Verdict: <VEREDICTO>` o el veredicto no es APPROVED ni APPROVED WITH NOTES | `pilot` |
| `bloqueado` (`qa_sin_correr`) | La sesión de cierre cerró el sprint (creció el ledger) sin un `tool_use` de la skill `kyro-qa` | `pilot` |
| `bloqueado` (`kyro_bloqueado`) | Faltan verbos en `kyro capabilities --json` (`record-evidence`, `review`, `close-sprint`, `analyze`, `context-pack`) o `kyro analyze`/`context-pack --task` fallaron | `pilot` |
| `bloqueado` (`integridad_kyro`) | Un blocker de Kyro pide `repair`: nunca se aplica solo | `pilot` |
| `bloqueado` (`otro`) | La sesión terminó con error o el piloto falló; el detalle trae el motivo | `pilot` |
| `interrumpido` | Al arrancar el panel, el chat estaba `running` | `system`; al retomar con un mensaje vuelve al estado anterior con actor `user` |
| `error` | Falló la lectura de Kyro (el detalle trae el motivo) o la sesión terminó con error | `system` |

Mientras no exista el piloto (sprint 3), cuando un turno termina el siguiente movimiento es del usuario: la transición guarda `data.waitingOn = 'user'`. Un turno cancelado deja el estado como estaba. Un fallo del seguimiento de estado nunca rompe el turno ni el chat.

**Mapeo `nextAction` → estado** (función pura `mapKyroState`, `apps/api/src/kyro/map-state.ts`; solo recibe datos de la CLI, nunca texto del agente):

| Scope | Estado | Fase |
|---|---|---|
| `init`, `plan_sprint` | `planificando` | planificación |
| `clarify` | `esperando_aclaracion` | planificación |
| `execute_task` | `escribiendo_codigo` | ejecución |
| `review_task` | `revisando_tarea` | ejecución |
| `qa_or_close` | `qa` | QA |
| `close_sprint` (Kyro 6.1.0 no lo emite) | `cerrando_sprint` | QA |
| `await_scope_completion` | `esperando_aprobacion_cierre` | cierre |
| `done` | `terminado` | cierre |

| Work | Estado | Fase |
|---|---|---|
| `plan_tasks` | `planificando` | planificación |
| `execute_task` | `escribiendo_codigo` | ejecución |
| `review_task` | `revisando_tarea` | ejecución |
| `resolve_blocker` | `bloqueado` (`tarea_bloqueada`, el texto de Kyro va en el detalle) | ejecución |
| `ready_to_close` | `cerrando` | cierre |
| `done` | `terminado` | cierre |

Fases guardadas: `planificacion`, `ejecucion`, `qa`, `cierre` (las de preparación y merge llegan con sus estados). El avance (`sprint n/m`, `tarea n/m`, deuda abierta) sale del mismo `kyro status full` y del `sprint.json` del scope.

**Ids agregados al catálogo** respecto de la tabla de arriba: `cerrando` (un Work listo para cerrar con `kyro work close`) y `terminado` (Kyro informa `done`: la parte de Kyro terminó; el trabajo sigue hasta la PR en las etapas siguientes).

### Motivos de bloqueo

El estado `bloqueado` guarda un `blocked_reason` de este catálogo (`BlockedReason` en `packages/shared`):

| Motivo | Cuándo | Quién lo dispara |
|---|---|---|
| `sin_avance` | Una sesión terminó sin que el estado de Kyro avanzara y sin preguntar | Piloto (sprint 3) |
| `tope_de_sesiones` | Un sprint llegó al tope de sesiones (por defecto 6) | Piloto (sprint 3) |
| `tarea_bloqueada` | Un Work en `resolve_blocker`, o una tarea que tras 3 rondas de corrección quedó `blocked` | Lector de Kyro |
| `kyro_bloqueado` | `context-pack` informa un blocker | Lector de Kyro |
| `integridad_kyro` | Hallazgo de integridad de Kyro: `repair` nunca se aplica solo | Piloto (sprint 3) |
| `qa_sin_aprobar` | El informe de QA del cierre falta o su veredicto no es una aprobación (R7, R8) | Piloto (sprint 4) |
| `qa_sin_correr` | Una sesión de cierre cerró el sprint sin invocar la skill `kyro-qa` (R8) | Piloto (sprint 3) |
| `git` | Falló un commit, pull, push o `gh`, no hubo commit nuevo tras el cierre de un sprint, la base local se movió durante el cierre, o el worktree no tiene remoto; el detalle trae la salida | Piloto (sprint 4) |
| `secretos` | `scanSecrets` encontró un `.env`, una clave o un token en el diff contra la base, en lo pendiente o en un repo hijo; el detalle lista **solo archivos y tipos**, nunca el valor | Piloto (sprint 4) |
| `conflicto` | La sesión `merge` terminó con rutas sin mergear o con el merge abierto | Piloto (sprint 4) |
| `build_roto` | El `validate_command` falló o se pasó del tiempo después de traer cambios de la base: no se abre la PR | Piloto (sprint 4) |
| `merge_sin_pr` | El `merge-dev` terminó y no hay PR abierta ni la rama llegó a la base | Piloto (sprint 4) |
| `otro` | Cualquier otro freno con su motivo en el detalle | Piloto |

El lector de Kyro deja `kyro_bloqueado` y `tarea_bloqueada`; el piloto del sprint 3 suma `sin_avance`, `tope_de_sesiones`, `integridad_kyro`, `qa_sin_correr` y `otro`. El sprint 4 suma `qa_sin_aprobar`, `git`, `secretos`, `conflicto`, `build_roto` y `merge_sin_pr`.

### Qué estados todavía no se detectan

- **Builds y tests** (`en_cola_build`, `buildeando`, `probando`, `corrigiendo`, `registrando_evidencia`): necesitan los hooks `PreToolUse`/`PostToolUse` y el semáforo de builds. Llegan con la etapa 5.
- **Permisos** (`esperando_permiso`): hoy solo se registra `permission_denied`; aprobar con botones es de la etapa 5.
- **PR después de abierta** (`en_cola_merge_raiz`, `mergeando_raiz`, `pr_checks_fallidos`, `pr_cambios_pedidos`): necesitan el sondeo de `gh` y mergear la PR, que no es del panel todavía (etapa 5). El resto de la fase de merge (`trayendo_dev`, `resolviendo_conflictos`, `validando_post_merge`, `abriendo_pr`, `pr_lista`) ya lo escribe el piloto.
- **Cierre** (`mergeada`, `limpiando`, `archivado`, `revisar`): limpieza automática, etapas 5 y 6.
- **Aviso** de `sin_cupo_de_uso` y la hora exacta de reinicio del límite (`resetsAt`): scope `operaciones-worktree`; hoy el piloto reintenta cada 15 minutos.
- **Idea** (`madurando_idea`, `esperando_aprobacion_plan`): chat de tipo Idea, sprint 4; ya se escriben ambos: el primer turno la deja con actor `user` y el fin del turno no cambia el estado (T2.1); `esperando_aprobacion_plan` se escribe cuando git muestra exactamente un documento nuevo o cambiado de `kyro-idea` y no hay pregunta pendiente (T2.2); con varios queda `bloqueado` (`otro`) y con ninguno sigue en `madurando_idea`. Las decisiones sobre el plan (T2.3): aprobar como scope o work pasa a `planificando` (actor `user`, con la ruta y el usuario en el Timeline) y pedir cambios vuelve a `madurando_idea`; si `kyro work create` falla queda `bloqueado` (`kyro_bloqueado`).

## Tres niveles de estado y etiqueta única (sprint 5)

La web muestra **una sola etiqueta por ítem** (sidebar, cabecera del chat), descriptiva y en español. Hay tres niveles y cada ítem usa solo el que le corresponde:

| Nivel | De qué es | Etiquetas | Dónde vive |
|---|---|---|---|
| **Proyecto** | Un proyecto registrado | Clonando, Listo, Error (más Actualizando e Inicializando Kyro mientras corre esa operación) | `projects.status` y `project-label.ts` de la web |
| **Trabajo** | Un scope, work o idea (tiene worktree) | El catálogo fino de arriba (`planificando`, `qa`, `bloqueado`, `pr_lista`…) | `worktree_state` y `WORKTREE_STATE_INFO` de `packages/shared` |
| **Sesión** | Un pedido directo (consulta sin worktree) o un trabajo que todavía no tiene estado fino | En curso, En espera, Error, Interrumpido, Cancelado | `chats.status` y `status.ts` de la web |

**Mapeo sesión → trabajo.** El estado de sesión no se muestra cuando el trabajo tiene estado fino: `running` es el estado del paso en curso (planificando, escribiendo código, QA…), `idle` es el estado en que quedó la fase, una pregunta pendiente es `esperando_respuesta`, `interrupted` es `interrumpido` y `cancelled` es `cancelado`. Un pedido directo no tiene estado fino: muestra el de sesión. La sidebar (`sidebarBadge`) y la cabecera del chat eligen así: estado fino si lo hay, estado de sesión si no.

**Tono por quién actúa.** Cada estado del catálogo lleva `who` en `WORKTREE_STATE_INFO` (`packages/shared`): `working` (acento), `user` (ámbar: te toca a vos), `ok`, `waiting` (neutro) o `error`. La web usa esa clasificación para el color del `Badge` y el notificador de la API la usa para decidir qué avisa: **la clasificación vive en un solo lugar** y los dos lados no se desincronizan.

**Qué estados avisan por Web Push.** `PushNotifier` (`apps/api/src/push/notifier.ts`) escucha los eventos `state_changed` y manda un aviso a todos los dispositivos suscriptos cuando el trabajo entra en un estado con `who = user` (`esperando_aclaracion`, `esperando_aprobacion_plan`, `esperando_aprobacion_cierre`, `esperando_permiso`, `esperando_respuesta`, `pr_checks_fallidos`, `interrumpido`, `bloqueado`, `revisar`), en `pausado` **solo si lo pausó el piloto** (una pausa del usuario no es noticia) o en `pr_lista`. Un aviso por transición: repetir el mismo estado no reenvía. `sin_cupo_de_uso` no avisa (lo hace `operaciones-worktree` con la hora de reinicio). El aviso lleva título `proyecto · trabajo`, cuerpo con la etiqueta y el motivo, la URL del trabajo y un `tag` por chat (el aviso nuevo reemplaza al anterior); nunca lleva secretos. Un fallo de envío se loguea y no frena al piloto; un 404 o 410 del servicio de push borra la suscripción.

### Operaciones manuales (git por trabajo)

Las operaciones git manuales de un trabajo (commit, traer base, traer la propia rama, push, reinstalar dependencias; `apps/api/src/worktrees/ops.ts`) **no cambian el estado fino**: cada una deja una entrada en el Timeline (`worktree_transitions`) que repite el estado actual con actor `user`, motivo `Git: <operación> en <repo> (ok|error)`, y en `data` la operación, el repo, el resultado y la salida recortada a 8000 caracteres (más `files` y `warning` en un commit). Si el trabajo todavía no tiene estado fino no se anota nada. Mientras el agente corre, hay mantenimiento de Kyro u otra operación en el chat, o el piloto está en `active`, `queued` o `waiting_quota`, la operación se rechaza con 409 y no deja entrada porque no ejecutó nada. Sin estados ni eventos nuevos en el catálogo.

### Cómo se lee Kyro

- **Kyro:** después de cada turno se corre en el worktree (`execFile` con argv, sin shell, con timeout) `kyro context-pack --kyro-scope <s> --json` y `kyro status full --kyro-scope <s> --json` para leer `nextAction` y el avance; el scope sale de `activeScope` en `.agents/kyro/local.json` del worktree. Si las dos lecturas no coinciden en `nextAction`, se vuelve a leer una vez. Un Work se lee con `kyro work status --work <slug> --json` (el único Work de `.agents/kyro/work/`). Una salida inesperada o un fallo de la CLI deja el estado `error` con el detalle.
- **Hooks del Agent SDK:** `PreToolUse` y `PostToolUse` clasificarán los comandos `Bash` (build, test, git, gh, kyro) y actualizarán el estado. El hook de build **espera** en el semáforo de builds, y eso genera `en_cola_build` (etapa 5).
- **GitHub:** sondeo de `gh pr list` / `gh pr checks` cada pocos minutos para los estados de PR (etapa 5).
- **Arranque del panel:** toda sesión que estaba activa pasa a `interrumpido` (con una transición de actor `system`); los builds en cola se vuelven a encolar (etapa 5).

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

**Mapeo a los estados finos (sprint 5, ver «Tres niveles de estado»):** `running` pasa a ser cualquiera de los estados de Preparación/Planificación/Ejecución/QA según las señales de Kyro, git y `gh`; `idle` se mapea al estado en que quedó la fase; una pregunta pendiente (`pending_questions`) es `esperando_respuesta` y la sesión sigue `running` mientras espera (el turno no terminó); `interrupted` y `cancelled` equivalen a las transversales `interrumpido` y `cancelado`; `error` es la transversal `error`. La tabla `worktree_state` se agrega encima: `chats.status` sigue siendo el estado de la *sesión*, no del *worktree*.
