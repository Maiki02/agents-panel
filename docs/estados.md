# Estados de un worktree

Cada scope o work de Kyro corre en su propio worktree. El panel muestra en todo momento **un estado** por worktree, más un **detalle** opcional (por ejemplo, `probando · go test ./internal/cart`) y **quién tiene que actuar**: el agente, el sistema o vos.

Regla de oro: el estado se deduce de señales verificables (Kyro, git, `gh`, hooks del Agent SDK, el propio orquestador), nunca del texto que escribe el agente.

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
| `instalando_dependencias` | Instalando dependencias | S | Script de setup (`go mod download`, `npm install`) | `planificando` |

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
| `esperando_respuesta` | Te hizo una pregunta | Vos | El agente usó `AskUserQuestion` | estado anterior |

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

## Cómo lo implementa el panel

- **Fuente de verdad del estado:** tabla `worktree_state` en SQLite (estado, detalle, desde cuándo, estado previo). Cada cambio se guarda como evento y se manda por SSE.
- **Hooks del Agent SDK:** `PreToolUse` y `PostToolUse` clasifican los comandos `Bash` (build, test, git, gh, kyro) y actualizan el estado. El hook de build **espera** en el semáforo de builds, y eso genera `en_cola_build`.
- **Kyro:** después de cada `record-evidence`, `review` o fin de turno se corre `kyro context-pack --json` para leer `nextAction` y el avance n/m.
- **GitHub:** sondeo de `gh pr list` / `gh pr checks` cada pocos minutos para los estados de PR.
- **Arranque del panel:** toda sesión que estaba activa pasa a `interrumpido`, y los builds en cola se vuelven a encolar.

Pendiente: confirmar los nombres exactos de `nextAction` y los campos de `kyro status --json` en la VM.

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

**Mapeo a los estados finos (etapa 5):** `running` pasa a ser cualquiera de los estados de Preparación/Planificación/Ejecución/QA según las señales de Kyro, git y `gh`; `idle` se mapea al estado en que quedó la fase (o `esperando_usuario` si el agente pidió algo); `interrupted` y `cancelled` equivalen a las transversales `interrumpido` y `cancelado`; `error` es la transversal `error`. La tabla `worktree_state` se agrega encima: `chats.status` sigue siendo el estado de la *sesión*, no del *worktree*.
