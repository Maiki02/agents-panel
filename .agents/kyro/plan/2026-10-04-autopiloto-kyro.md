---
docType: plan
date: 2026-10-04
slug: autopiloto-kyro
title: Piloto automático de Kyro en el panel
maturedFrom: mature
agents: []
---

# Piloto automático de Kyro en el panel

## Core thesis

Una vez aprobado el plan, un scope o un work tiene que llegar solo a la PR: el panel encadena las sesiones de Kyro (modelo pensante para planificar, modelo ejecutor para ejecutar, QA, corregir, commitear y cerrar), toma por defecto la opción recomendada en cada gate rutinario y **solo frena por una decisión material, un costo o un bloqueo real**, avisando con una notificación push y dejando responder desde la web. Hoy cada gate rutinario de Kyro frena la sesión y obliga al usuario a escribir "Siguiente" desde una terminal.

## Problem / Motivation

- **Causa:** el ciclo de trabajo es siempre igual (idea → plan del scope → por cada sprint: task-context, sesión nueva, ejecución, QA, deuda, cierre, commit → plan del sprint siguiente → cierre del scope → `merge-dev`), pero el runtime de Kyro tiene gates escritos para preguntar al usuario: `qa-or-close.md` ("Ask the user whether to run the independent Kyro QA certification or close the sprint without it"), `kyro-sprint-executor` ("Ask the user for explicit approval. Closing a sprint is a lifecycle gate — never proceed past it on your own"), `close-sprint.md` (preguntar si cada regla aprendida es global) y `forge.md` con `await_scope_completion` ("Ask: complete the finished scope, or explicitly expand it"). Además el cambio de modelo y de sesión es manual (copiar el prompt de `kyro-task-context` a una sesión nueva).
- **Consecuencia:** en un scope de varios sprints el usuario hace de botón "Siguiente" decenas de veces, y el trabajo se para cada vez que no está mirando. En el panel es peor: `AskUserQuestion` hoy está **denegado** (no está en `SAFE_TOOLS` de `apps/api/src/agent/permissions.ts`), así que el agente ni siquiera puede preguntar.
- **Por qué ahora:** el panel ya corre sesiones del Agent SDK por worktree (etapa 4) y está terminando `proyectos-y-versiones` (proyectos, `.env`, versiones). Lo siguiente del plan es la etapa 5 (estados, aprobaciones con botones), que es la base que este piloto necesita. Hacerlo ahora evita construir gates manuales que después habría que automatizar.

## Current-state evidence

| Hecho | Fuente |
|---|---|
| Kyro expone el paso siguiente como dato: `nextAction` ∈ `clarify`, `plan_sprint`, `execute_task`, `review_task`, `qa_or_close`, `close_sprint`, `await_scope_completion`, `done` | `~/.agents/kyro/current/commands/forge.md` (tabla Route) |
| Los Work tienen su propio estado legible: `kyro work status --work <slug> --json` y `kyro work context-pack --work <slug> --json`; review exige un `--by` checker distinto del maker | `kyro work --help` (Kyro 6.1.0) |
| Gates que preguntan al usuario: QA o cerrar, aprobación de cierre de sprint, reglas globales, completar el scope, autorización de `repair` | `qa-or-close.md`, `kyro-sprint-executor/SKILL.md` §close, `close-sprint.md` paso 3, `forge.md`, `recover.md` |
| El runtime de Kyro vive en `~/.agents/kyro/current` y lo reemplaza `kyro update`; editarlo no persiste | `CLAUDE.md` del stub de skills (`kyro update`), `docs/plan.md` (Impacto en skills) |
| `close-sprint.md` ya indica que `plan_sprint` sigue en **sesión nueva** usando task-context | `skills/sprint-forge/assets/modes/close-sprint.md` (Hand off) |
| El runner llama `query()` con `cwd`, `settingSources`, `permissionMode: 'acceptEdits'`, `allowedTools`, `resume`, hook `PreToolUse` y `canUseTool`; no pasa `model` | `apps/api/src/agent/sdk-runner.ts` |
| El SDK (`@anthropic-ai/claude-agent-sdk` 0.3.289) acepta `model?: string` por `query()` y `canUseTool` puede devolver `updatedInput`; `AskUserQuestion` tiene tipos `AskUserQuestionInput/Output` | `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, `sdk-tools.d.ts` |
| Bash del agente limitado a `git`, `gh`, `npm`, `go`, `kyro` (+ filtros tras pipe); sin `oci`, `tailscale`, `curl`, `terraform` | `apps/api/src/agent/permissions.ts` |
| `AgentManager`: un turno por chat, tope 4 sesiones, estado grueso `running/idle/error/interrupted/cancelled`; al reiniciar, `running` → `interrupted` y espera un mensaje | `apps/api/src/agent/manager.ts`, `docs/estados.md` (Estado de sesión del MVP) |
| El primer mensaje del chat manda al agente a leer `kyro-forge` o `kyro-work` porque el SDK no registra los slash commands en la VM; `ChatKind = 'scope' \| 'work'` | `apps/api/src/chats/service.ts`, `packages/shared/src/index.ts` |
| Catálogo de estados finos con `madurando_idea`, `esperando_aprobacion_plan`, `esperando_aprobacion_cierre`, `bloqueado`, `interrumpido`, `sin_cupo_de_uso`; todavía no implementado (tabla `worktree_state` planeada) | `docs/estados.md` |
| `merge-dev` de ventas: commitea lo pendiente sin preguntar, trae `origin/dev` a `feature-<scope>` con `merge --no-ff`, valida si el merge trajo cambios, push y `gh pr create --base dev`; mergea la raíz a `main` | `~/proyectos/ventas/.claude/skills/merge-dev/SKILL.md` |
| La versión del backend de ventas está en `be-ventas/pkg/consts/config.go` (`ProjectVersion = "1.13.0"`) y la expone `/health` | `be-ventas/pkg/consts/config.go:7`, `internal/adapters/handlers/http/health.go:36` |
| agents-panel y judiciar no tienen rama `dev` ni particularidades de merge; `projects.base_branch` ya existe por proyecto | Usuario (04/10/2026), `apps/api/src/projects/repo.ts` |
| El scope actual planea `/projects/:id` con chats filtrados por proyecto, pero no tarjetas de worktree con estado ni timeline | `.agents/kyro/plan/2026-10-04-proyectos-versiones-env.md` (WS5) |
| `proyectos-y-versiones` ya entrega (sprint 5): layout `/projects/:id` con sidebar **Chats** (botón Nuevo chat + lista con título, `scope|work · rama` y badge de estado de sesión) y **Configuración** en tabs General/Environment; componentes `Modal`, `Tabs`, `Button`, `Badge`, `Icon`; tokens en `tokens.css` | `sprint.json` R27–R30, `apps/web/src/app/chats/{chat-sidebar,status}.ts`, `docs/identidad-visual.md` |
| El sprint 6 de ese scope cubre: proyecto sin Kyro, **Inicializar Kyro** desde la web, **pull del clon base** (`fetch` + `pull --ff-only`, rechaza con cambios locales o divergencia) y borrado; además debt-7 (pedido directo sin Kyro) y debt-8 (pull del clon base) | `sprint.json` roadmap n=6, `debt[]` |
| Hoy no existe commit, pull ni push desde la web; el badge del chat muestra el estado de la **sesión** (`En curso`, `En espera`, `Error`…) | `apps/web/src/app/chats/status.ts` |
| En ventas, `fe-ventas/` y `be-ventas/` son repos hijos ignorados por la raíz (`.gitignore`) y su rama base es `dev`; la raíz usa `main` | `ventas/.gitignore`, `git rev-parse` en la VM |
| Las dependencias se instalan por worktree con el comando de setup del proyecto (`npm ci`, `uv sync --project backend`, `panel-setup.sh`), que debe ser idempotente; el clon base no las necesita para crear worktrees | `CLAUDE.md` (Proyectos registrados), `sprint.json` R8/R25 |
| El SDK expone el uso del plan: `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })` devuelve `rate_limits.five_hour` / `seven_day` / `seven_day_opus` / `seven_day_sonnet` con `utilization` (0–100) y `resets_at`, leídos del endpoint de uso de claude.ai; además cada sesión emite `rate_limit_event` (`status` allowed/allowed_warning/rejected, `rateLimitType`, `utilization`, `resetsAt`) | `sdk.d.ts` (`SDKControlGetUsageResponse`, `SDKRateLimitEvent`), SDK 0.3.289 |
| Web Push: hipótesis de que funciona con el HTTPS de Funnel y sin costo (servicios push de los navegadores); en iOS exige agregar el panel a la pantalla de inicio | Hipótesis a validar en WS8 |

## Who it's for

- **Primario: el usuario (único operador del panel).** Necesita decidir solo tres cosas: aprobar el plan, responder decisiones materiales (producto, arquitectura, costo) y aceptar o no la deuda que quedó al final. Todo lo demás lo tiene que ver avanzar, desde la PC o el celular, sin escribir "Siguiente".
- **Secundario: los agentes de cada worktree.** Necesitan saber qué gates están pre-aprobados y cuándo deben frenar, con una política escrita que no dependa de interpretar texto.

## What success looks like

1. Un scope de 3+ sprints, iniciado desde una idea en la web, llega a PR(s) abiertas sin ningún mensaje del usuario salvo la aprobación del plan, siempre que no surja una decisión material y no quede deuda. *Falso éxito:* el piloto "avanza" porque saltea QA o cierra sprints con tareas sin `pass`; se detecta porque cada sprint archivado debe tener QA corrido y `kyro analyze` sin CRITICAL/HIGH.
2. Cada plan de sprint corre con el modelo pensante y cada ejecución con el modelo ejecutor, en sesiones SDK distintas. *Falso éxito:* todo en una sola sesión larga; se detecta por `sdk_session_id` y `model` registrados por paso.
3. Cuando el agente necesita una decisión, en menos de un minuto llega una notificación push (con el navegador cerrado) y la pregunta se responde con botones en la web; el agente sigue con esa respuesta. *Falso éxito:* la pregunta se resuelve sola o el agente sigue con una suposición; se detecta porque toda pregunta queda en `pending_questions` con su respuesta y quién la dio.
4. Un Work recorre plan → ejecución → QA/review → commit → cierre → merge sin intervención.
5. Si el último sprint cierra sin deuda abierta, el scope se completa y se mergea solo. Si hay deuda abierta, frena una sola vez con la lista.
6. En ventas, cada merge que incluye be-ventas sube `ProjectVersion` según los commits; en agents-panel y judiciar no se toca ninguna versión.
7. En la página del proyecto, cada worktree es una tarjeta con su estado actual; al abrirla se ven su timeline y su chat.

## Product laws / invariants

| Ley | Falla que previene |
|---|---|
| L1. El paso siguiente se decide por señales verificables (`nextAction` de Kyro, `kyro work status`, git, `gh`, eventos del SDK), nunca por el texto del agente | Bucles o saltos de fase por una frase mal interpretada |
| L2. Ningún gate de calidad se saltea: QA corre en cada sprint, no se cierra con CRITICAL/HIGH de `kyro analyze`, y Kyro sigue siendo dueño de sus escrituras (CLI) | "Automatizar" a costa de cerrar trabajo roto |
| L3. Nada que pueda cambiar costos corre sin OK: el allowlist de Bash no suma `oci`, `tailscale`, `terraform` ni `curl`, y la política obliga a preguntar si una tarea lo requiere | Cargos en la cuenta Pay As You Go de Oracle o en otros proveedores |
| L4. El agente nunca corre con `bypassPermissions`; el piloto pre-aprueba gates de Kyro, no permisos de herramientas | Que el piloto sea una puerta para ejecutar cualquier cosa desde una URL pública |
| L5. Una pregunta material nunca se auto-responde: queda pendiente hasta que el usuario responde, sin timeout | Decisiones de producto tomadas por el agente |
| L6. Una sesión que termina sin avanzar el estado y sin preguntar frena el piloto (`bloqueado`, "sin avance") | Bucles infinitos que consumen el límite de la suscripción |
| L7. Commits solo al cerrar un sprint (o cuando el usuario lo pide), en la rama `feature/<slug>` del worktree (y `feature-<slug>` de los repos hijos). El agente puede pushear la rama de su worktree en cualquier repo, y el usuario también desde la web; nunca `push --force`, rebase de ramas pusheadas ni push directo a la rama base fuera de lo que ya hace la `merge-dev` del proyecto | Historia reescrita o commits de trabajo a medias en ramas compartidas |
| L8. Antes de abrir una PR, la rama trae la rama base (`git pull --no-rebase origin <base>`) y los conflictos se resuelven en la rama; si hay lógica de negocio de los dos lados, frena | PRs no mergeables o conflictos resueltos a ciegas |
| L9. Lo propio de un proyecto (versión de ventas, repos hijos) vive en el repo del proyecto (`merge-dev` propia), no en el panel | Que el panel acumule reglas de cada proyecto |
| L10. El piloto sobrevive a cerrar el navegador y a reiniciar el panel: al arrancar, los pilotos activos se retoman solos | Trabajo parado porque nadie miraba |

## Observable success and failure guarantees

| Situación | Comportamiento |
|---|---|
| Camino feliz scope | Idea (pensante) → aprobación del plan → INIT (pensante) → por sprint: plan (pensante, sesión nueva) → ejecución+QA+deuda+commit+cierre (ejecutor, sesión nueva sembrada con task-context) → … → `await_scope_completion` sin deuda → `scope complete` → merge → `pr_lista` |
| Camino feliz work | Idea opcional → `kyro work create/plan` (pensante) → ejecución+review+commit+close (ejecutor) → merge → `pr_lista` |
| Deuda corregible en el sprint | Se corrige en el mismo sprint (tarea emergente) y se re-valida; no se pregunta |
| Deuda no corregible (necesita decisión, costo o algo externo) | `kyro debt defer` con motivo; aparece en el timeline y se presenta al final |
| Fin del scope con deuda abierta | Estado `esperando_aprobacion_cierre`, push, lista de deuda; aceptar → `scope complete --accept-open-debt --reason …` y merge; no aceptar → queda frenado para que el usuario decida |
| `nextAction = clarify` o `AskUserQuestion` | `esperando_respuesta` / `esperando_aclaracion`, push, botones en la web; la respuesta vuelve al agente |
| Tarea `blocked` tras 3 rondas de corrección | `bloqueado` con la tarea y el último error, push |
| `repair integrity` con findings | `bloqueado` ("Kyro pide reparar estado"), push; nunca se aplica solo |
| Sesión termina sin cambio de estado y sin pregunta | `bloqueado` ("sin avance"), push (L6) |
| Tope de sesiones por sprint alcanzado (config, por defecto 6) | `bloqueado` ("demasiadas sesiones en el sprint"), push |
| Límite de uso de la suscripción | `sin_cupo_de_uso`; reintenta solo cada 15 min |
| Panel o VM reiniciados | Pilotos activos → se retoman con `resume` del paso en curso (L10) |
| Conflicto de merge con lógica de ambos lados, build roto tras traer la base, secretos en el diff | Frena según `merge-dev`/merge genérico, push |
| Tope de 4 sesiones paralelas lleno | `en_cola` hasta que se libere una |
| Pausa manual | `pausado`; reanudar retoma el paso |

## Outcome-based scope

### In

1. **Preguntas desde la web:** `AskUserQuestion` permitido vía `canUseTool`, guardado como pregunta pendiente, mostrado con botones (más texto libre) y respondido por la API.
2. **Modelos por rol:** en Configuración, por proveedor (hoy solo Claude), un **modelo pensante** y un **modelo ejecutor**; cada chat puede cambiarlos al crearse.
3. **Chat de tipo Idea** que crea su worktree, corre `kyro-idea` con el modelo pensante y termina en `esperando_aprobacion_plan` con botones "Aprobar y crear scope" / "Aprobar y crear work" / "Pedir cambios".
4. **Orquestador (piloto automático)** para scope y work: decide el paso por `nextAction` / `kyro work status`, abre una sesión nueva por paso con el modelo del rol, siembra la ejecución con el prompt de task-context, inyecta la política de gates, detecta los frenos, retoma tras reinicios y se puede pausar o apagar por chat.
5. **Política de gates pre-aprobados** (texto versionado en el panel): QA siempre; cierre de sprint aprobado si QA es `APPROVED`/`APPROVED WITH NOTES` y `analyze` limpio; reglas nuevas solo de scope (las candidatas a globales se listan al final); deuda: se corrige si se puede, si no se posterga; commit al cerrar el sprint; completar el scope solo si no hay deuda abierta.
6. **Cierre y merge:** si el proyecto trae su skill `merge-dev`, se usa; si no, merge genérico: commit de lo pendiente, `git pull --no-rebase origin <base_branch>` en `feature/<slug>`, resolución de conflictos, validación si entraron cambios, push y `gh pr create --base <base_branch>`.
7. **Estado fino mínimo + timeline:** tabla `worktree_state` y eventos de transición, con fase, sprint n/m, tarea n/m, rol/modelo y motivo de cada freno.
8. **Web (sobre el layout de `proyectos-y-versiones`):** la sidebar **Chats** es la lista de trabajos del proyecto; cada ítem muestra **solo su estado** (D18, D21). Al abrirlo, la vista tiene pestañas **Chat**, **Timeline** y **Git** (D19). Formulario de chat nuevo con tipo (Idea, Scope, Work, Consulta), interruptor de piloto y modelos. Configuración del proyecto suma las tabs **Repositorio** (pull del clon base y repos hijos con su rama base, D20) y **Modelos**. Preguntas, aprobación de plan y de deuda en modales.
9. **Notificaciones Web Push** (service worker + VAPID) cuando el piloto frena o termina en `pr_lista`.
10. **ventas `merge-dev`:** subida de `ProjectVersion` por commits (cambio en el repo ventas, entregado como Kyro Work en ese repo).
11. **Operaciones git desde la web** (D19, D20): por worktree, estado por repo, commit con selección de archivos, traer la rama base, traer la propia rama, push y reinstalar dependencias; por proyecto, pull del clon base (lo construye el sprint 6 de `proyectos-y-versiones`; acá se extiende a repos hijos).
12. **Tres niveles de estado con una sola etiqueta visible** (D21): proyecto, trabajo (worktree) y sesión.
13. **Criterios de UI** registrados en `docs/identidad-visual.md` (D23) y aplicados a todas las pantallas nuevas.
14. **Indicador de uso de proveedores** en el header, accesible desde todas las pantallas (D24).
15. **Paridad manual:** toda acción que hace el agente o el piloto tiene su botón (catálogo en D26), incluida **Crear PR** (D25).
16. **Docs y reglas:** `docs/plan.md`, `docs/estados.md`, `docs/panel-desarrollo.md`, `CLAUDE.md` (regla de commits) y `docs/vm-setup.md` si se agregan variables o claves en la VM.

### Explicitly out

- **Otros proveedores** (OpenCode, Pi, otros modelos): el modelo de datos los admite (proveedor + modelo), pero solo se implementa Claude (decisión 1 de `plan.md`).
- **Piloto desde la terminal de la PC** (scripts sh con `claude -p`): duplicaría la lógica y no llega a la web. Seguimiento posible.
- **Modificar el runtime de Kyro:** se sobreescribe con `kyro update`; la política se pasa por prompt.
- **Mergear PRs automáticamente en GitHub:** el resultado sigue siendo PRs que el usuario revisa (decisión base del panel).
- **Limpieza automática de worktrees mergeados, PR checks y `pr_cambios_pedidos`:** siguen en las etapas 5/6.
- **Commit, push o instalar dependencias en el clon base del proyecto:** el clon base solo se actualiza (pull); el trabajo se hace en worktrees (D20, D22).
- **Mergear la PR en GitHub desde el panel:** la PR la revisa y mergea el usuario en GitHub (decisión base); el panel solo muestra su estado y checks.
- **Correr comandos arbitrarios desde la web:** las validaciones (build, tests) se le piden al agente.
- **Resolver conflictos de git desde la web:** un pull con conflicto se aborta y se ofrece pedírselo al agente (D19).
- **Consumo por scope y topes de uso de la suscripción** más allá del tope de sesiones por sprint.

## Closed decisions with rationale

| # | Decisión | Evidencia / razón | Costo de la alternativa descartada | Consecuencia |
|---|---|---|---|---|
| D1 | El piloto es un **orquestador en la API del panel** (TypeScript), no una skill ni scripts sh | Una skill corre dentro de una sola sesión: no abre sesiones nuevas ni cambia de modelo. Los scripts no llegan a la web. El panel ya maneja sesiones SDK, eventos y SSE | Más código en el panel que una skill | El estado del piloto vive en SQLite y sobrevive al navegador |
| D2 | El paso se decide por `nextAction` (scope) y `kyro work status --json` (work) después de cada turno | Son datos de la CLI (L1); `docs/estados.md` ya lo prevé | Interpretar texto del agente es frágil | WS1 fija los nombres reales de los campos con fixtures (pendiente de `plan.md`) |
| D3 | Una sesión SDK nueva por paso: plan de sprint con el **pensante**; ejecución + QA + deuda + commit + cierre con el **ejecutor** en una sola sesión sembrada con el prompt de task-context | Es el flujo actual del usuario y lo que pide `close-sprint.md` | QA en la misma sesión es menos independiente | El rol de QA queda configurable más adelante sin romper el modelo |
| D4 | Los gates de Kyro se pre-aprueban con una **política escrita** en el prompt; Kyro no se modifica | El runtime se reemplaza con `kyro update` | Si Kyro cambia el texto de un gate, la política puede quedar desfasada | La política es un archivo versionado del panel con test de que menciona cada gate conocido; un gate nuevo no cubierto termina en pregunta (no se saltea) |
| D5 | QA siempre en cada sprint | El usuario: "¿por qué no ejecutamos el worker de QA?" | Más uso de la suscripción por sprint | L2 |
| D6 | Deuda: se corrige si se puede sin decisión nueva, costo ni dependencia externa; si no, `defer` con motivo y se presenta al final | Pedido del usuario | Un sprint puede alargarse corrigiendo deuda | El timeline muestra la deuda postergada |
| D7 | Fin del scope: sin deuda abierta → `scope complete` + merge automáticos; con deuda → una sola pregunta | Pedido del usuario (04/10/2026) | Ninguno relevante | `--accept-open-debt` solo con OK explícito |
| D8 | Commits al cerrar cada sprint o cuando el usuario lo pide | Pedido del usuario | Cambia la regla de `CLAUDE.md` ("solo cuando el usuario lo pide") | Se actualiza `CLAUDE.md` en este scope |
| D9 | Preguntas por `AskUserQuestion` interceptado en `canUseTool`: se guarda, se espera la respuesta y se devuelve como `updatedInput` | El SDK admite `updatedInput`; hoy la herramienta está denegada | Hipótesis a confirmar en WS1; si falla, alternativa: denegar con el mensaje "el usuario respondió: …" | Sin timeout (L5); si el panel se reinicia con una pregunta pendiente, el `resume` hace que el agente vuelva a preguntar |
| D10 | Notificaciones con **Web Push** (VAPID + service worker), no solo la Notification API | Con la pestaña cerrada o el celular bloqueado la Notification API no avisa | En iOS hay que agregar el panel a la pantalla de inicio | Las claves VAPID son secretos: van en el `.env` del panel, no en docs. Cada aviso se manda a **todas las suscripciones** del usuario, no al dispositivo desde donde se mandó el prompt (PC con el navegador abierto, Android aunque Chrome esté cerrado). Configuración → Notificaciones lista los dispositivos suscritos (nombre editable, fecha, Probar, Quitar), y una suscripción que el servicio push rechaza como vencida (404/410) se borra sola |
| D11 | Modelos por rol: **pensante** y **ejecutor**, por proveedor, con valor por defecto global (Opus 5.5 / Sonnet 5.5) y cambio por chat | Pedido del usuario | Ninguno | Cada evento de sesión registra el modelo usado |
| D12 | Chat de tipo **Idea** crea el worktree desde el inicio; el plan aprobado se convierte en scope o work en ese mismo worktree | Un worktree = un scope o work (`plan.md` decisión 3); evita mover archivos | Un worktree puede crearse para una idea que se descarta | Descartar la idea = cancelar el chat (se borra el worktree con la limpieza existente) |
| D13 | Merge: skill `merge-dev` del proyecto si existe; si no, merge genérico hacia `base_branch` con `git pull --no-rebase origin <base>` antes de la PR | Pedido del usuario: "primero se hace un pull de la rama base para resolver merges y luego se crea la PR"; agents-panel y judiciar no tienen `dev` (L8, L9) | Dos caminos de merge | Cuando un proyecto cree `dev`, se cambia su `base_branch` |
| D14 | ventas: si be-ventas entra al merge, se sube `ProjectVersion` **según los commits** (`origin/dev..feature-<scope>`): con cambio incompatible (`!` o `BREAKING CHANGE`) sube el major, con algún `feat` el minor y si no el patch. Se calcula **después** de traer `origin/dev`, partiendo de la versión de dev | Pedido del usuario (04/10/2026); calcular antes haría chocar dos features paralelas | Una PR más tarde puede necesitar recalcular si dev cambia otra vez (`merge-dev` lo hace en cada corrida) | Commit `chore(version): <x.y.z>` en be-ventas; fe y raíz no se tocan |
| D15 | Ítem de trabajo en la sidebar = **solo el estado actual**; al abrirlo, Chat + Timeline (+ Git) | Pedido del usuario | Menos información a primera vista | El sprint n/m, la tarea n/m y la deuda se ven en el Timeline |
| D16 | Al arrancar el panel, los pilotos activos se retoman solos | El usuario quiere poder cerrar el navegador (L10) | Una sesión que rompió algo vuelve a arrancar | El tope de sesiones por sprint (L6) corta reintentos en bucle |
| D17 | **Push permitido de la rama del worktree**, en cualquier repo (raíz y repos hijos): lo hace el agente (el piloto pushea después de cada commit de cierre de sprint) y el usuario con un botón "Pushear" en la vista del worktree | Pedido del usuario (04/10/2026): "puede pushear la rama del worktree la IA, no importa el repo". Pushear cada sprint además deja una copia fuera de la VM (`plan.md`, "Si se reinicia la VM") | Las ramas `feature/*` quedan visibles en GitHub antes de la PR | Solo `git push` (con `-u` la primera vez) de la rama actual del worktree; un push rechazado se resuelve con `pull --no-rebase` y se reintenta, nunca `--force`. Se actualiza `CLAUDE.md` (sección Git) |
| D18 | **No se agrega una sección "Worktrees"**: la sidebar **Chats** es la lista de trabajos. Un chat de scope, work o idea es dueño de un worktree (1:1); una consulta no tiene worktree. Las sesiones SDK del piloto (plan, ejecución por sprint) son tramos dentro del mismo chat, marcados en el Timeline con rol y modelo | Hoy chat ↔ worktree ya es 1:1 (`chats.worktree_path`, `branch`); dos listas con los mismos elementos se desincronizan y duplican navegación | Para ver "solo worktrees" hay que filtrar | Filtro rápido en la sidebar: Activos · Te toca · Terminados · Todos. Si algún día un worktree tiene varios chats, se revisa |
| D19 | **Operaciones git por worktree** (pestaña Git), por cada repo del worktree (raíz + repos hijos): ver estado (rama, cambios, adelante/atrás del remoto); **Commit** (elegir archivos, mensaje, valida formato Conventional Commits con aviso, no bloqueo); **Traer `<base>`** (`git pull --no-rebase origin <base del repo>`); **Traer mi rama** (`git pull --no-rebase origin <rama>`, por si se pusheó desde otra máquina); **Push** (D17); **Reinstalar dependencias** (vuelve a correr el setup). Un pull con conflicto se aborta (`git merge --abort`), lista los archivos y ofrece "Pedirle al agente que lo resuelva" | Pedido del usuario: cubrir commit, pull y push "según worktree o según proyecto"; el usuario mencionó "quizás hay que pullear dev" | Resolver conflictos desde la web exigiría un editor de merge | Todo por `execFile` sin shell; ramas y rutas salen de la base, no del usuario; 409 si el agente del worktree está corriendo o el piloto no está en pausa; cada operación queda en el Timeline con su salida recortada |
| D20 | **Operaciones git por proyecto** (Configuración → Repositorio): solo **Pull** del clon base en su rama base (el del sprint 6, `--ff-only`, rechaza cambios locales o divergencia), extendido a los repos hijos. Repos de un proyecto = raíz + carpetas de primer nivel que son repos git e ignoradas por la raíz; cada uno con su rama base (por defecto la del proyecto; en ventas `fe-ventas` y `be-ventas` → `dev`) | El clon base es la fuente de los worktrees y referencia de los clones (`--reference`); editarlo rompería esa garantía. ventas tiene bases distintas por repo | Una pantalla más de configuración | Los repos hijos se detectan al registrar o al pedir "Detectar repos" y se guardan editables (tabla `project_repos`). El merge genérico (D13) y "Traer `<base>`" usan la base de cada repo |
| D21 | **Tres estados, una etiqueta:** (1) **proyecto**: Clonando · Listo · Error, más transitorios Actualizando (pull) e Inicializando Kyro; (2) **trabajo** (worktree): el catálogo fino de `estados.md`; (3) **sesión** (`chats.status`): técnico, nunca se muestra como estado principal de un chat con worktree. Cada ítem muestra **una** etiqueta: la del trabajo si tiene worktree, la de la sesión si es una consulta. Las etiquetas son descriptivas ("Esperando tu respuesta", "Probando · go test", "Cerrando sprint 2/4") y el color sale de **quién actúa** | Hoy el badge muestra el estado de sesión ("En espera") que no dice nada del trabajo. `estados.md` ya separa proyecto y worktree | Mapear sesión→trabajo agrega lógica | `estados.md` suma la tabla de los tres niveles y el mapeo; la lista del proyecto marca cuántos trabajos te esperan |
| D22 | **Dependencias:** no hay botón "Descargar dependencias" en el proyecto. Se instalan por worktree con el setup (estado `instalando_dependencias`). La pestaña Git del worktree tiene **Reinstalar dependencias**, y después de "Traer `<base>`" o "Traer mi rama" el panel la corre sola si cambió un lockfile (`package-lock.json`, `go.sum`, `uv.lock`, `pnpm-lock.yaml`, `yarn.lock`). Al registrar un proyecto sin setup y con un lockfile, Configuración → General sugiere el comando (`npm ci`, `go mod download`, `uv sync`) como hoy sugiere `panel-setup.sh` | Ningún flujo trabaja sobre el clon base: los worktrees parten de él pero instalan lo suyo. Instalar en el clon base gastaría disco y CPU sin uso | Una consulta libre sobre el clon base no puede correr tests | Si una consulta necesita correr algo, se crea un work. La sugerencia de setup sigue sin aplicarse sola |
| D23 | **Criterios de UI** (en `docs/identidad-visual.md`, rigen desde ahora para pantallas nuevas y lo existente al tocarlo): anatomía de tarjeta e ítem de lista, colores de estado por actor, acciones, confirmaciones, operaciones largas, estados vacíos y celular | Pedido del usuario: seguir la UI de `proyectos-y-versiones` y dejar registradas las mejoras | Retocar pantallas existentes cuando se toquen | Ver el doc; el sprint 6 de `proyectos-y-versiones` ya puede usarlos |
| D24 | **Indicador de uso** en el header (icono visible en todas las pantallas). Al hacer click, un panel por proveedor (hoy Claude) con barra y hora de reinicio de la **ventana de 5 h**, la **semanal** y, si vienen, las semanales por modelo (Opus/Sonnet). El icono muestra el % de 5 h con el tono de la UI: `ok` < 70 %, `warn` ≥ 70 %, `danger` ≥ 90 % o `rejected`. Fuentes: (1) a pedido, `usage_…({ skipBehaviors: true })` en una sesión corta sin prompt, con caché de 60 s en la API; (2) pasiva, el último `rate_limit_event` de cualquier sesión, guardado en la base. Se muestra "actualizado hace X" | Pedido del usuario ("como en Orca"). El SDK ya trae los datos y son los de la cuenta, así que incluyen el uso desde la PC y el celular | La llamada es experimental y puede cambiar de nombre; lanzar un proceso por consulta cuesta CPU | Si la llamada falla o cambia, queda el dato pasivo con su antigüedad (degradado, no roto). El piloto usa `resetsAt` para retomar `sin_cupo_de_uso` en la hora exacta en vez de reintentar cada 15 min. `GET /api/usage` con sesión (guard). Sin costo: no es un servicio pago |
| D25 | **Botón Crear PR** en la pestaña Git: por cada repo del trabajo con commits que no están en su base, push y `gh pr create --base <base del repo> --head <rama>` con título y cuerpo prellenados (título del scope/work en formato Conventional Commits, cuerpo desde `git log <base>..HEAD --no-merges`), editables en un modal. Si la PR ya existe, muestra su link y el push la actualiza. Antes trae la base (L8); si hay conflicto, frena como en D19 | Pedido del usuario: "por si el agente se olvida de hacer la PR" | Un formulario más | Resultado por repo con el link; queda en el Timeline. En proyectos con `merge-dev` propia (ventas) el botón principal es **Correr merge-dev** (lanza al agente con esa skill, porque hace pasos propios como la versión y el merge de la raíz) y Crear PR queda como alternativa |
| D26 | **Paridad manual:** todo lo que hace el agente o el piloto tiene un botón. Las acciones deterministas (git, `gh`, `kyro` CLI, setup) las ejecuta el panel con el **mismo servicio** que usa el orquestador, y cada una registra en el Timeline quién la hizo (vos / piloto / agente). Los pasos que necesitan razonar (planificar, ejecutar, QA, corregir deuda, merge-dev) son botones que lanzan ese paso del agente. Mientras el piloto o el agente corren, los botones se ven deshabilitados con el motivo; para usarlos se pausa el piloto | Pedido del usuario: "toda función que haga el agente también debe estar manual". Un solo servicio garantiza que manual y automático hacen lo mismo | Más superficie de UI | Catálogo de acciones abajo; cada fila nueva del piloto debe sumar su botón |
| D27 | **Ver cambios (diff)** por repo del trabajo, en la pestaña Git: archivos cambiados sin commitear y diff contra la base, de solo lectura; también desde el modal de Commit y de Crear PR | Revisar desde el celular antes de commitear o abrir una PR; hoy no hay forma sin SSH | Diff grande en un teléfono | Se recorta por archivo con "ver más"; nunca muestra archivos ignorados (los `.env`) |
| D28 | **Descartar cambios** de archivos sin commitear (`git restore`, y borrar los no rastreados elegidos) y **Borrar trabajo** (worktree + ramas locales; las remotas solo si se marca) como acciones manuales con confirmación `danger` | Hoy no hay cómo deshacer lo que dejó el agente sin SSH; la limpieza automática es de la etapa 6 | Riesgo de perder trabajo | Modal que nombra cada archivo o rama; rechaza archivos ignorados; Borrar trabajo exige que no haya sesión corriendo y avisa si hay commits sin pushear |
| D29 | **El piloto no usa `kyro-sprint-executor`.** Cada sesión de ejecución entra por `kyro-forge` y sigue el `nextAction` (`execute_task`, `review_task`, `qa_or_close`, `close_sprint`), que ya registra evidencia y review con el CLI (`record-evidence`, `review`); QA va por la skill `kyro-qa` (en el SDK no hay slash commands, ver `chats/service.ts`). Antes de arrancar un paso el panel corre `kyro capabilities --json` y frena si faltan `record-evidence` o `review` | `kyro-sprint-executor` es "manual-only" y pensada para ejecutar **fuera** del flujo forge; sus gates (aprobar el cierre, QA opcional) son justo los que el piloto pre-aprueba, así que no aporta. El forge cubre lo mismo (maker/checker, 3 rondas, `blocked`) | Se pierde su handshake de capacidades, que se replica en el panel | Una sola ruta de ejecución para scope y work. El test de WS5 verifica que la sesión de ejecución no invoca esa skill |

### Catálogo de acciones (paridad manual, D26)

| Acción | Quién la hace en automático | Botón manual | Dónde | Lo ejecuta |
|---|---|---|---|---|
| Crear trabajo (worktree + setup + `.env`) | Al crear el chat | Nuevo chat | Sidebar | Panel |
| Aprobar plan → scope o work | — (siempre vos) | Aprobar y crear scope / work, Pedir cambios | Chat | Panel + agente |
| Planificar siguiente sprint | Piloto (pensante) | Planificar sprint | Timeline | Agente |
| Ejecutar sprint | Piloto (ejecutor) | Ejecutar sprint | Timeline | Agente |
| QA | Piloto | Correr QA | Timeline | Agente |
| Corregir o postergar deuda | Piloto (D6) | Corregir ahora · Postergar · Aceptar, por deuda | Timeline | Agente / `kyro debt` |
| Cerrar sprint | Piloto | Cerrar sprint | Timeline | Agente |
| Completar scope / cerrar work | Piloto (D7) | Completar scope | Timeline | `kyro scope complete` / `kyro work close` |
| Reparar estado de Kyro | Nunca solo | Reparar (muestra la vista previa y pide confirmación) | Timeline | `kyro repair` |
| Ver cambios | — | Ver cambios | Git | Panel |
| Commit | Piloto al cerrar sprint (D8) | Commit | Git | Panel |
| Traer base / traer mi rama | `merge-dev` o merge genérico | Traer `<base>` · Traer mi rama | Git | Panel |
| Push | Piloto (D17) | Push | Git | Panel |
| Crear PR | Merge genérico / `merge-dev` | Crear PR · Correr merge-dev | Git | Panel / agente |
| Reinstalar dependencias | Tras un pull con lockfile cambiado (D22) | Reinstalar dependencias | Git | Panel |
| Descartar cambios | Nunca solo | Descartar | Git | Panel |
| Responder pregunta o permiso | — (siempre vos) | Botones de la pregunta | Chat | Panel |
| Pausar, reanudar o apagar el piloto; cancelar el turno | Piloto (frenos) | Pausar · Reanudar · Apagar · Cancelar | Header del trabajo | Panel |
| Retomar tras reinicio | Piloto (D16) | Reanudar | Header del trabajo | Panel |
| Borrar trabajo | Etapa 6 (limpieza al mergear) | Borrar trabajo | Header del trabajo | Panel |
| Pull del clon base | — | Pull | Configuración → Repositorio | Panel |
| Aplicar `.env` a trabajos activos | — | Ya existe (Environment) | Configuración | Panel |

## Constraints and tradeoffs

- **Costo US$0:** Web Push usa los servicios push de los navegadores (sin costo); no se agrega infraestructura en Oracle. Cualquier cambio que no cumpla esto se consulta (`CLAUDE.md`, regla de costos).
- **Límite de uso compartido:** el piloto consume el mismo límite de la suscripción que el uso manual (riesgo de `plan.md`). QA siempre y sesiones nuevas suben el consumo; el tope de sesiones por sprint lo acota.
- **VM 2 OCPU / 12 GB:** el tope de 4 sesiones paralelas sigue; el piloto se encola.
- **Seguridad:** la URL es pública. Responder preguntas y activar el piloto requieren sesión y CSRF (rutas no públicas, test del guard). Aceptar deuda y completar el scope no exige TOTP (no exponen secretos ni cambian costos).
- **Systemd es de la etapa 6:** hasta tenerlo, "cerrar el navegador" funciona pero cerrar la terminal donde corre el panel no. Se recomienda adelantar el servicio systemd o documentar `tmux` como paso intermedio.
- **Kyro Work requiere checker distinto del maker** (`--by`): la política usa actores distintos para evidencia y review.

## Risks, failure modes and degradation

| Riesgo | Disparador | Impacto | Prevención / contención | Señal |
|---|---|---|---|---|
| El agente pregunta de más | Política poco clara | El piloto frena sin sentido | Política con ejemplos de "no preguntar"; métricas de preguntas por sprint en el timeline | Muchas `pending_questions` triviales |
| El agente no pregunta cuando debe | Decide solo algo material | Producto distinto al pedido | Política explícita de qué es material + ADR (`kyro adr`) para cada decisión tomada sola, visible en el timeline | ADRs nuevos en el sprint |
| Kyro cambia un gate | `kyro update` | Política desfasada, el agente pregunta o se traba | Test de política vs gates conocidos; gate no cubierto → pregunta; L6 corta el bucle | `bloqueado` "sin avance" tras un update |
| Bucle de sesiones | Error repetido | Consume la suscripción | L6 + tope de sesiones por sprint | Contador de sesiones en el timeline |
| `updatedInput` no sirve para `AskUserQuestion` | Comportamiento del SDK | Las preguntas no vuelven al agente | Spike en WS1 antes de construir; alternativa de D9 | Test del spike |
| Conflicto de versión en ventas | Dos features suben `ProjectVersion` | PR con conflicto | D14 (calcular después de traer dev) | Conflicto en `config.go` |
| Push no llega | Permiso denegado o iOS sin PWA | El usuario no se entera del freno | La lista de proyectos marca "te toca actuar"; prueba de notificación en Configuración | Suscripción ausente o error del push service |
| La lectura de uso cambia en el SDK | Llamada experimental renombrada o quitada | El panel de uso no se actualiza a pedido | Fuente pasiva (`rate_limit_event`) + "actualizado hace X"; test de contrato que falla al actualizar el SDK | Error en `GET /api/usage` |
| Operación git de la web pisa al agente | Pull o commit mientras el agente edita | Estado del repo inconsistente | 409 si hay sesión corriendo o piloto activo sin pausa (D19) | Respuesta 409 con el motivo |
| Repos hijos mal detectados | Carpeta git no ignorada o anidada más profundo | Pull o push incompleto | Lista editable en Repositorio (D20); solo primer nivel e ignorados | Repo faltante en la pestaña Git |
| Reinicio a mitad de un commit o cierre | Corte de luz o despliegue | Estado a medias | Los verbos de Kyro son retomables (`close-sprint` con los mismos inputs); `repair` con findings frena (no se aplica solo) | `bloqueado` "Kyro pide reparar estado" |

## Execution blueprint

Orden por dependencia y por reducción de incertidumbre. Cada workstream cierra con su gate.

**WS1. Spike y fixtures** (sin dependencias)
- Confirmar en la VM: respuesta a `AskUserQuestion` vía `canUseTool` + `updatedInput`; `model` por `query()`; salida JSON de `kyro context-pack --json` (`nextAction`, sprint actual, total de sprints, tarea n/m, deuda) y de `kyro work status --json`.
- Entregable: fixtures JSON en `apps/api/test/fixtures/` y una nota en `docs/plan.md` cerrando el pendiente "confirmar campos de `kyro status --json`".
- *Gate:* test que parsea las fixtures; prueba manual documentada de una pregunta respondida.

**WS2. Preguntas desde la web** (depende de WS1)
- Tabla `pending_questions` (chat, tool_use_id, preguntas, respuesta, respondida_por, fechas); `AskUserQuestion` sale de la lista de denegadas solo por `canUseTool`, que espera la respuesta; `GET/POST /api/chats/:id/questions`; evento SSE.
- *Gate:* tests con runner fake: pregunta → pendiente → respuesta → el runner recibe la respuesta; ruta sin sesión da 401 (test del guard).

**WS3. Modelos por rol** (depende de WS1)
- Configuración de proveedor + modelo pensante + modelo ejecutor (con valores por defecto), override por chat; `SdkRunner` pasa `model`; cada evento de sesión guarda rol y modelo.
- *Gate:* tests de que cada paso usa el modelo de su rol.

**WS4. Estado fino mínimo y timeline** (depende de WS1)
- Tabla `worktree_state` + eventos de transición; lector de Kyro (`context-pack` / `work status`) después de cada turno; fase, sprint n/m, tarea n/m, deuda postergada.
- *Gate:* tests con fixtures; `docs/estados.md` actualizado (detección real de cada estado usado y estado `bloqueado` con motivos "sin avance" y "demasiadas sesiones").

**WS5. Orquestador y política** (depende de WS2–WS4)
- Tabla `autopilot_runs` (chat, activo, paso, sesiones por sprint); bucle: leer estado → elegir rol y prompt → sesión nueva → leer estado → repetir o frenar. Paso de plan del sprint con el pensante que termina generando el prompt de task-context; paso de ejecución con el ejecutor sembrado con ese prompt.
- Política de gates como archivo versionado (D4–D8) inyectado en cada sesión; test que verifica que cubre los gates conocidos.
- Frenos (tabla de garantías), retoma al arrancar (D16), pausa/reanudar/apagar.
- *Gate:* tests con runner y Kyro fakes que recorren: scope de 2 sprints sin frenos, freno por pregunta, freno por `blocked`, "sin avance", reinicio a mitad, fin con y sin deuda.

**WS6. Idea → aprobación → scope/work** (depende de WS5)
- `ChatKind` suma `idea`; prompt inicial con `kyro-idea`; detección de plan escrito (archivo nuevo en `.agents/kyro/plan/` del worktree) → `esperando_aprobacion_plan`; acciones aprobar como scope, aprobar como work, pedir cambios.
- *Gate:* test de las tres acciones con fakes.

**WS7. Cierre y merge** (depende de WS5)
- Push de la rama del worktree después de cada commit de cierre de sprint (D17), en todos los repos del worktree que tengan commits nuevos; endpoint `POST /api/chats/:id/push` para el botón de la web (sesión + CSRF).
- Fin sin deuda → `kyro scope complete --yes` (o `kyro work close`) → paso de merge: skill `merge-dev` del proyecto si existe en el worktree; si no, merge genérico (D13).
- *Gate:* tests del selector de merge y del prompt genérico; prueba real en agents-panel con un work chico que termina en PR a `main`.

**WS8. Web y notificaciones** (depende de WS2–WS7)
- `/projects/:id`: tarjetas de worktree con solo el estado; vista del worktree con timeline + chat; preguntas con botones; aprobación de plan y de deuda; formulario de chat nuevo (tipo, piloto, modelos); Configuración de modelos y de notificaciones.
- Web Push: envío a todas las suscripciones (D10), lista de dispositivos con Probar y Quitar, borrado de suscripciones vencidas; claves VAPID en el `.env` del panel (`.env.example` con valores falsos), service worker, `POST /api/push/subscriptions`, envío al frenar y en `pr_lista`.
- *Gate:* specs de componentes; build de la web; recorrido manual por el túnel SSH; un prompt mandado desde la PC que frena hace llegar el push a la PC (navegador abierto) y al Android con Chrome cerrado; una suscripción vencida se borra.

**WS9. ventas: `merge-dev` con versión** (independiente; Kyro Work en el repo `ventas`)
- Paso nuevo en la sección de be-ventas, después de traer `origin/dev` y antes del push: calcular la subida según D14 sobre `git log origin/dev..feature-<scope> --no-merges`, editar `ProjectVersion` en `be-ventas/pkg/consts/config.go`, `go build ./...`, commit `chore(version): <x.y.z>`; si be-ventas no participa, no se toca nada. Ajustes de worktree pendientes de la etapa 3 (no restaurar rama en worktree).
- *Gate:* corrida de prueba sobre una rama con un `feat` (minor) y otra con solo `fix` (patch).

**WS11. Repos del proyecto y operaciones git** (depende de WS4; el pull del clon base lo entrega el sprint 6 de `proyectos-y-versiones`)
- Tabla `project_repos` (ruta relativa, rama base) con detección de repos hijos; tab Repositorio (lista editable + Pull por repo).
- API por worktree: `GET /api/chats/:id/git` (estado por repo), `POST …/git/commit` (repo, archivos, mensaje), `…/git/pull-base`, `…/git/pull-branch`, `…/git/push`, `…/setup` (reinstalar dependencias); 409 con agente corriendo; resultado por repo; conflicto → `merge --abort` + archivos.
- Reinstalación automática si cambió un lockfile (D22).
- *Gate:* tests con repos temporales y remoto bare: commit de archivos elegidos, pull con conflicto abortado, push sin `--force`, 409 con agente corriendo, lockfile cambiado → setup corrido; guard test de rutas nuevas.

**WS12. Estados de tres niveles y criterios de UI** (con WS4 y WS8)
- `docs/estados.md`: tabla proyecto / trabajo / sesión, mapeo a una etiqueta y tono por actor (D21). Etiquetas en un solo módulo compartido de la web.
- `docs/identidad-visual.md`: sección de criterios (D23).
- *Gate:* spec de la función que elige la etiqueta (consulta → sesión, trabajo → estado fino) y del tono por actor.

**WS13. Uso de proveedores** (depende de WS1)
- Spike en WS1: confirmar que la llamada de uso funciona en una sesión sin prompt y cuánto tarda.
- Tabla `provider_usage` (proveedor, ventana, utilización, reinicio, fuente, fecha); guardar cada `rate_limit_event`; `GET /api/usage` con caché de 60 s; el piloto usa `resetsAt` para `sin_cupo_de_uso`.
- Web: icono en el header con el % de 5 h y su tono; panel con las barras (componente compartido, criterios de `identidad-visual.md`).
- *Gate:* tests con fixtures de la respuesta y del evento; degradado si la llamada falla; spec del tono por umbral.

**WS14. Paridad manual y acciones extra** (depende de WS5 y WS11)
- Servicio único de acciones con actor (vos / piloto / agente) usado por el orquestador y por la API; botones del catálogo; Crear PR (D25); Ver cambios (D27); Descartar y Borrar trabajo (D28).
- *Gate:* test que recorre el catálogo y verifica que cada acción del orquestador tiene ruta manual; tests de Crear PR (PR nueva y existente) con `gh` falso; tests de descarte (rechaza ignorados) y de borrado (rechaza con sesión corriendo).

**WS10. Docs y reglas** (al final, salvo `estados.md` que va con WS4)
- `docs/plan.md` (piloto, modelos por rol, merge, etapas), `docs/panel-desarrollo.md` (VAPID, cómo probar push), `CLAUDE.md` (commits al cerrar sprint, push de la rama del worktree por el agente o desde la web, frenos del piloto), `docs/vm-setup.md` + bitácora si cambia algo en la VM (Costos: US$0).
- *Gate:* revisión de que cada decisión D1–D16 está reflejada en un doc.

## Acceptance and validation matrix

| Resultado / ley | Escenario | Evidencia | Validación |
|---|---|---|---|
| Éxito 1, L2 | Scope de 2+ sprints recorre todo sin mensajes del usuario | Timeline: cada sprint con plan (pensante), QA y cierre; PR abierta | Test del orquestador con fakes + corrida real en agents-panel |
| Éxito 2, D3, D11 | Plan y ejecución en sesiones distintas con su modelo | `sdk_session_id` y `model` por paso | Test WS3/WS5 |
| Éxito 3, L5, D9, D10 | Pregunta → push → respuesta en la web → el agente sigue | Fila en `pending_questions` con respuesta; push recibido | Test WS2 + prueba manual WS8 |
| Éxito 4 | Work de punta a punta | `kyro work status` en `completed`; PR | Test con fakes + work real |
| Éxito 5, D7 | Último sprint sin deuda → merge solo; con deuda → una pregunta | Estado final `pr_lista` o `esperando_aprobacion_cierre` | Test WS5/WS7 |
| Éxito 6, D14, L9 | Merge en ventas con `feat` sube minor; con `fix`, patch; sin be-ventas, nada | Diff de `config.go` y commit `chore(version)` | Gate WS9 |
| Éxito 7, D15 | Tarjeta con estado; click → timeline + chat | Captura de pantalla | Recorrido manual WS8 |
| D18, D21 | Ítem de la sidebar muestra el estado del trabajo (no "En espera"); consulta muestra el de la sesión | Captura + spec de la etiqueta | Spec WS12 + recorrido manual |
| D19 | Commit de archivos elegidos, traer base, traer rama, push y reinstalar por repo del worktree | Timeline con cada operación y su resultado | Tests WS11 + recorrido en un worktree de ventas (raíz `main`, hijos `dev`) |
| D20 | Pull del clon base y de sus repos hijos desde Repositorio | Resultado por repo | Test WS11 |
| D22 | Traer base con lockfile cambiado → reinstala dependencias | Evento de setup en el Timeline | Test WS11 |
| D24 | Icono de uso con % de 5 h y panel con 5 h y semanal; degradado si falla la llamada | Captura + respuesta de `/api/usage` | Tests WS13 + recorrido manual |
| D25 | Crear PR abre una PR por repo con commits, o muestra la existente | Links por repo en el Timeline | Test WS14 + PR real en agents-panel |
| D26 | Cada acción del orquestador tiene botón y el Timeline registra el actor | Test del catálogo | Test WS14 |
| D27, D28 | Ver cambios sin `.env`; descartar y borrar con confirmación | Specs y tests | WS14 |
| L1 | El paso cambia solo por señales de la CLI | El orquestador no lee texto del agente | Test: un texto engañoso no cambia el paso |
| L3, L4 | Allowlist intacto; nunca `bypassPermissions` | `permissions.ts` sin binarios nuevos | Test existente de permisos + test de que el piloto no cambia `permissionMode` |
| L6 | Sesión sin avance → `bloqueado` | Evento de transición | Test WS5 |
| L7, D17 | Commit solo al cerrar sprint, en `feature/<slug>`; push de esa rama (agente y botón), nunca `--force` ni de otra rama | `git log` del worktree y del remoto | Test con git real en un repo temporal con remoto bare |
| L8, D13 | Pull de la base antes de la PR; conflicto con lógica de ambos lados frena | Evento de merge | Test del merge genérico con repo temporal en conflicto |
| L10, D16 | Reinicio con piloto activo → se retoma | Evento "retomado" | Test de arranque |

## Forge handoff

- **Objetivo del scope:** que un scope o work, después de aprobar su plan desde la web, llegue solo a la PR usando un modelo pensante para planificar y uno ejecutor para ejecutar, y que frene solo por decisiones materiales, costos o bloqueos, avisando por push y respondiendo desde la web.
- **Requisitos candidatos:** R1 preguntas desde la web · R2 modelos por rol · R3 estado fino mínimo + timeline · R4 orquestador + política de gates · R5 Idea → aprobación → scope/work · R6 cierre y merge (skill del proyecto o genérico) · R7 web (tarjetas, timeline, formularios, configuración) · R8 Web Push · R9 docs y `CLAUDE.md` · R10 repos del proyecto y operaciones git por worktree y por proyecto · R11 estados de tres niveles con una etiqueta · R12 criterios de UI aplicados · R13 indicador de uso de proveedores · R14 paridad manual (catálogo, Crear PR, Ver cambios, Descartar, Borrar trabajo).
- **Aparte:** WS9 es un Kyro Work en el repo `ventas` (puede correr en paralelo).
- **No objetivos:** otros proveedores, piloto desde terminal, modificar Kyro, mergear PRs en GitHub, limpieza automática y checks de PR.
- **Dependencias:** cerrar `proyectos-y-versiones` (layout `/projects/:id`, componentes de UI y, del sprint 6, pull del clon base e Inicializar Kyro); Kyro 6.1.0 instalado en la VM.
- **Orden sugerido de sprints:** S1 WS1+WS2 · S2 WS3+WS4 · S3 WS5 · S4 WS6+WS7 · S5 WS11+WS12 · S6 WS13+WS14 · S7 WS8 · S8 WS10 y cierre. WS13 (uso) puede adelantarse: solo depende del spike de WS1.
- **Seguimiento no bloqueante:** piloto desde la terminal de la PC; QA con el modelo pensante en una sesión aparte; adelantar systemd de la etapa 6.

## Quality gate

| Criterio | Puntaje |
|---|---:|
| Thesis and causality | 14/15 |
| Grounding and evidence | 14/15 |
| Clarity and no ambiguity | 14/15 |
| Observable outcomes | 14/15 |
| Invariants and failures | 9/10 |
| Decisions and tradeoffs | 10/10 |
| Scope coherence | 9/10 |
| Executable handoff | 9/10 |
| **Total** | **93/100** (puntaje de antes de sumar D17–D29 y WS11–WS14; pendiente re-puntuar al cerrar los puntos abiertos) |

Fuentes revisadas: `CLAUDE.md`, `docs/plan.md`, `docs/estados.md`, `.agents/kyro/plan/2026-10-04-proyectos-versiones-env.md`, `apps/api/src/agent/{sdk-runner,manager,permissions}.ts`, `apps/api/src/chats/service.ts`, `packages/shared/src/index.ts`, tipos del Agent SDK 0.3.289, runtime de Kyro 6.1.0 (`commands/forge.md`, `task-context.md`, `sprint-forge/assets/modes/{qa-or-close,close-sprint}.md`, `protocols/gates.md`, `kyro-sprint-executor/SKILL.md`, `kyro work --help`), `ventas/.claude/skills/merge-dev/SKILL.md`, `be-ventas/pkg/consts/config.go`. Dos hipótesis quedan explícitas y se validan primero (WS1: respuesta de `AskUserQuestion`; WS8: Web Push sin costo). No quedan contradicciones materiales.
