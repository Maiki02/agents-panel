---
title: 'autopiloto-kyro — Sprint 1: Preguntas desde la web y confirmación de hipótesis'
date: '2026-10-05'
scope: 'autopiloto-kyro'
sprint: 1
slug: 'preguntas-web'
outcome: 'shipped'
type: 'sprint-archive'
---

# Sprint 1: Preguntas desde la web y confirmación de hipótesis

> Closed: 2026-10-05
> Outcome: shipped

## Objective

El agente de un trabajo puede preguntar y el usuario responde desde la web con botones, y quedan confirmadas las hipótesis H1 (respuesta por updatedInput) y H2 (kyro-forge con política avanza sin preguntar) y los campos reales de Kyro.

## Definition of Done

- Todas las tareas están done con evidencia y veredicto pass.
- H1 y H2 están confirmadas o descartadas con su alternativa, documentadas en docs/plan.md.
- Una pregunta del agente se guarda, se responde desde la web y el agente continúa, con runner falso en tests.
- typecheck, lint, format:check, tests y build pasan; ninguna ruta pública nueva.
- El recorrido manual con una sesión real está hecho o registrado como deuda diferida.

## Phases

### P1 — Spikes y fixtures (WS1)

> Confirmar las hipótesis H1 y H2 y fijar los campos reales de Kyro antes de construir encima.

#### T1.1: Spike H1: respuesta de AskUserQuestion por updatedInput y model por query() en la VM

**Status**: done

**Description**: Escribir un script de spike reproducible (apps/api/scripts/spike-ask-question.ts, corrido con node en la VM) que abra una sesión real del Agent SDK en un directorio temporal, deje pasar AskUserQuestion desde el hook PreToolUse, espere la respuesta dentro de canUseTool y la devuelva como updatedInput, y compruebe que el agente continúa con esa respuesta. El mismo script acepta --model para confirmar que query() respeta model (sonnet vs opus) leyendo el modelo del mensaje system:init. Si updatedInput no sirve, probar la alternativa: denegar con el mensaje 'el usuario respondió: …'. Registrar el resultado y el método elegido en docs/plan.md (sección de la etapa 4/5) y en el comentario de cabecera del script.

**Evidence**:
- Summary: Spike en la VM (SDK 0.3.289): AskUserQuestion pasa el hook PreToolUse (devuelve {}), canUseTool espera y responde con updatedInput {...input, answers:{pregunta:respuesta}} y el agente continúa en la misma sesión. El respaldo deny 'el usuario respondió: …' también funciona. model en query() se respeta (system:init: claude-opus-5-5 y claude-sonnet-5-5). Método elegido y versión documentados en docs/plan.md (etapa 4) y en la cabecera del script.
- Validation: npx tsx apps/api/scripts/spike-ask-question.ts con método updatedInput: pregunta, respuesta y continuación impresas; exit 0
- Validation: corrida con modelo claude-opus-5-5: system:init model=claude-opus-5-5; método deny con claude-sonnet-5-5: continúa OK
- Validation: tsc strict sobre scripts/: sin errores
- Files changed: `apps/api/scripts/spike-ask-question.ts`, `docs/plan.md`
- Notes: El script usa mkdtemp + rm, settingSources vacío y permissionMode default (nunca bypassPermissions); no está en el include de tsconfig, se tipó con un tsconfig temporal.

**Verdict**: pass

---
#### T1.2: Fixtures reales de kyro context-pack --json y kyro work status --json con su parser

**Status**: done

**Description**: Capturar la salida real de kyro context-pack --kyro-scope <scope> --json en cada nextAction alcanzable (plan_sprint, execute_task, review_task, qa_or_close, close_sprint, await_scope_completion, clarify) usando un scope descartable en un repo temporal, y de kyro work status --work <slug> --json y kyro work context-pack --json. Guardarlas en apps/api/test/fixtures/kyro/ y escribir un parser tipado (apps/api/src/kyro/state.ts) que devuelva nextAction, sprint actual, total de sprints, tarea n/m y deuda abierta, con test contra las fixtures. Cerrar el pendiente de docs/plan.md y docs/estados.md sobre los campos exactos.

**Evidence**:
- Summary: Capturé la salida real de Kyro 6.1.0 en un repo temporal con un scope y un Work descartables (capture.sh, reproducible): context-pack y status full para plan_sprint, execute_task, review_task, qa_or_close, await_scope_completion, done y clarify (más sprint 2 con 1 cerrado), y work status/context-pack para plan_tasks, execute_task, in_progress, review_task, resolve_blocker, ready_to_close y closed. Parser tipado apps/api/src/kyro/state.ts (nextAction, sprint actual/cerrados/total, tarea n/m, deuda, bloqueos) con KyroStateError ante JSON inesperado o context-pack y status en desacuerdo. Hallazgo: close_sprint está en el esquema pero Kyro 6.1.0 nunca lo emite (tras qa_or_close, close-sprint pasa a plan_sprint o await_scope_completion) e init tampoco se observa; el total de sprints no lo imprime ningún comando y sale de sprint.json (roadmap, ledger). docs/plan.md y docs/estados.md ya no marcan los campos como pendientes.
- Validation: bash apps/api/test/fixtures/kyro/capture.sh: genera 36 fixtures sin error
- Validation: vitest test/kyro-state.test.ts: 26 pasan; suite completa de apps/api: 456 pasan
- Validation: tsc strict, eslint y prettier sin errores en src/kyro, test y scripts
- Files changed: `apps/api/src/kyro/state.ts`, `apps/api/test/kyro-state.test.ts`, `apps/api/test/fixtures/kyro/capture.sh`, `docs/plan.md`, `docs/estados.md`
- Notes: Criterio 1 parcial: no hay fixture de close_sprint ni de init porque Kyro 6.1.0 no los emite; no se inventó una. El test lo fija (unreachable = init, close_sprint). Los tests solo leen fixtures y no tocan .agents/kyro/ de este repo.

**Verdict**: pass — [object Object]

---
#### T1.3: Spike H2: una sesión con kyro-forge y una política mínima avanza sin preguntar

**Status**: done

**Description**: En un repo temporal con un scope descartable (sprint planificado, una tarea trivial), abrir una sesión real del SDK con el primer prompt que manda leer la skill kyro-forge (como chats/service.ts buildInitialPrompt) más un borrador de política de gates (QA sí, cierre aprobado, reglas solo del scope, deuda corregible se corrige), y comprobar que ejecuta la tarea, registra evidencia y review y llega a qa_or_close o close_sprint sin pedir confirmación. Registrar qué gates preguntaron igual, el texto de la política que funcionó y las salidas de context-pack observadas, para que el sprint 3 parta de ahí.

**Evidence**:
- Summary: Spike H2 confirmado: en un repo temporal con un scope descartable, una sesión real del SDK (Sonnet 5.5) con el primer prompt del panel (leer la skill kyro-forge), los permisos reales del panel y la política de gates ejecutó la tarea, registró evidencia y review por CLI y se detuvo en qa_or_close sin ninguna pregunta. Control sin política: tampoco preguntó pero se detuvo en review_task (la política aporta el permiso de hacer el review y la orden de parar en qa_or_close). Documentado en docs/plan.md: política probada, gates que preguntaron (ninguno; QA, cierre, reglas globales y scope completo no se ejercitaron y quedan para el sprint 3), llamadas denegadas (cat con ~, redirecciones, echo), kyro repair prepare espontáneo (la política debe prohibir repair apply) y salidas de context-pack observadas.
- Validation: npx tsx apps/api/scripts/spike-forge-policy.ts con política: exit 0, 0 preguntas, context-pack final qa_or_close, hola.txt creado
- Validation: mismo script con la opción no-policy: 0 preguntas, termina en review_task
- Validation: tsc strict sobre scripts/ y prettier: sin errores; git status del repo sin cambios en .agents/kyro más allá de este scope
- Files changed: `apps/api/scripts/spike-forge-policy.ts`, `docs/plan.md`
- Notes: Todo corrió en repos temporales (borrados). Sin kyro-sprint-executor en el spike ni bypassPermissions. Una sola sesión por variante; no se probaron QA ni cierre.

**Verdict**: pass

---
### P2 — Preguntas en la API (WS2)

> Guardar las preguntas del agente, esperarlas y responderlas por la API sin ampliar lo público.

#### T2.1: Tabla pending_questions y repositorio de preguntas

**Status**: done

**Description**: Agregar la migración siguiente (version 7) con la tabla pending_questions (id, chat_id con FK a chats, tool_use_id, questions en JSON, status pending|answered|cancelled, answer en JSON, answered_by con FK a users, created_at, answered_at; único por chat y tool_use_id) y un QuestionRepository en apps/api/src/chats/questions-repo.ts con crear, responder (atómico, una sola vez), listar por chat, obtener y cancelar las pendientes de un chat. Validar que la respuesta corresponde a las opciones de la pregunta o es texto libre.

**Evidence**:
- Summary: Migración 7 (pending_questions) con FK a chats (ON DELETE CASCADE) y a users, único por chat y tool_use_id, status pending|answered|cancelled y CHECKs que impiden una respuesta sin answered_by ni answered_at. QuestionRepository (apps/api/src/chats/questions-repo.ts): create, get, listByChat, answer (UPDATE atómico solo sobre filas pending; la segunda respuesta lanza QuestionNotPendingError) y cancelPending, más parseAskedQuestions (1-4 preguntas, 2-4 opciones), validateAnswer (opciones existentes, máximo una salvo multiSelect, texto libre recortado hasta 2000) y toSdkAnswers (formato answers del spike H1). Tipos AskedQuestion, QuestionAnswer, PendingQuestion en packages/shared. Sin timeout: la pregunta sigue pending con el paso del tiempo.
- Validation: npm test -w @agents-panel/api -- questions-repo db: 42 pasan (migración 7 sobre 1-6, foreign_key_check vacío, doble respuesta rechazada, respuesta inválida rechazada y no guardada)
- Validation: npm test -w @agents-panel/api: 482 pasan (29 archivos)
- Validation: tsc strict de api y web, eslint y prettier sin errores
- Files changed: `apps/api/src/db/migrations.ts`, `apps/api/src/chats/questions-repo.ts`, `apps/api/test/questions-repo.test.ts`, `apps/api/test/db.test.ts`, `packages/shared/src/index.ts`
- Notes: Hubo que reconstruir packages/shared/dist (ignorado por git) para que api vea los tipos nuevos. Las expectativas de db.test.ts de las migraciones 5-6 pasaron a incluir la 7. La API HTTP para responder es T2.2.

**Verdict**: pass

---
#### T2.2: AskUserQuestion pasa por el hook y canUseTool espera la respuesta del usuario

**Status**: done

**Description**: Hacer asíncronos canUseTool (RunParams) y el hook PreToolUse, agregar updatedInput (o el método que confirme T1.1) a PermissionDecision, dejar pasar AskUserQuestion en el hook y resolverla en AgentManager: guardar la pregunta con QuestionRepository, registrar y publicar el evento question_asked, esperar la respuesta y devolverla al runner, y registrar question_answered. Cancelar el trabajo o abortar la señal cancela la pregunta pendiente. Actualizar FakeRunner para simular una pregunta.

**Evidence**:
- Summary: canUseTool de RunParams ahora es async y PermissionDecision admite updatedInput (método confirmado por el spike H1). El hook PreToolUse deja pasar AskUserQuestion sin decidir (para no preguntar dos veces) y AgentManager la resuelve: guarda la pregunta con QuestionRepository, registra y publica question_asked, espera sin timeout y devuelve la respuesta como updatedInput {...input, answers}; answerQuestion(questionId, answer, userId) valida, guarda quién respondió, registra question_answered y despierta el turno. Cancelar el trabajo o abortar la señal cancela la pregunta (question_cancelled) y el turno termina cancelled; una pregunta sin turno vivo (reinicio) se cancela en vez de responderse, y al arrancar el panel se cancelan todas las pendientes. Sin QuestionRepository la herramienta sigue denegada. FakeRunner admite scripts async.
- Validation: npm test -w @agents-panel/api: 491 pasan (29 archivos), incluidos 9 tests nuevos de AskUserQuestion y los de permisos existentes
- Validation: tsc strict, eslint y prettier sin errores en api
- Validation: corrida real con SdkRunner + AgentManager + settingSources project/user: pregunta pendiente, respuesta Azul, eventos question_asked y question_answered, el agente continuó con la respuesta (script temporal, borrado)
- Files changed: `apps/api/src/agent/runner.ts`, `apps/api/src/agent/sdk-runner.ts`, `apps/api/src/agent/manager.ts`, `apps/api/src/chats/questions-repo.ts`, `apps/api/src/app.ts`, `apps/api/test/fake-runner.ts`, `apps/api/test/agent.test.ts`
- Notes: permissions.ts no cambia: decide() sigue denegando AskUserQuestion y solo el manager la intercepta antes. Tres llamadas de tests existentes pasaron a await por el canUseTool async. La ruta HTTP para responder es de T2.3.

**Verdict**: pass

---
#### T2.3: Rutas de preguntas, retoma tras reinicio y guard

**Status**: done

**Description**: Agregar GET /api/chats/:id/questions (pendientes y respondidas) y POST /api/chats/:id/questions/:qid/answer con esquema validado (respuesta por pregunta: opciones elegidas y/o texto), 404 si no existe, 409 si ya fue respondida o cancelada, answered_by del usuario de la sesión, sin ampliar la allowlist pública. Al arrancar el panel, las preguntas pendientes de chats que quedan interrupted pasan a cancelled (el agente vuelve a preguntar al reanudar). Incluir las rutas nuevas en guard.test.ts.

**Evidence**:
- Summary: Rutas GET /api/chats/:id/questions (todas las preguntas del chat, pendientes y respondidas) y POST /api/chats/:id/questions/:qid/answer (cuerpo { answer } validado por esquema y por las opciones de la pregunta, onlyKeys para rechazar campos desconocidos). ChatService.answerQuestion: 404 si el chat o la pregunta no existen o la pregunta es de otro chat, 409 si ya fue respondida o cancelada, 400 si la respuesta no corresponde a las opciones; answered_by es el usuario de la sesión. Rutas no públicas (el guard las cubre y la allowlist pública no cambia). Al arrancar el panel (app.ts) los chats running pasan a interrupted y todas las preguntas pendientes a cancelled; una pregunta sin turno vivo responde 409. scripts/ entra en tsconfig de api para que typecheck y lint cubran los spikes.
- Validation: npm test -w @agents-panel/api: 505 pasan (30 archivos), con 14 tests nuevos de rutas: 401 sin sesión, 403 sin CSRF, doble respuesta 409, otro chat 404, 400 por respuestas inválidas, reinicio con pregunta pendiente (cancelled + interrupted)
- Validation: guard.test.ts: rutas nuevas no públicas y lista pública sin cambios; cli.test.ts: allowlist de rutas mutantes actualizada con la nueva
- Validation: npx eslint . , npm run typecheck (shared, api, web) y prettier: sin errores
- Files changed: `apps/api/src/chats/routes.ts`, `apps/api/src/chats/service.ts`, `apps/api/src/app.ts`, `apps/api/test/questions-routes.test.ts`, `apps/api/test/guard.test.ts`, `apps/api/test/cli.test.ts`, `apps/api/test/chats.test.ts`, `apps/api/tsconfig.json`
- Notes: chats/repo.ts no cambió: el pase a interrupted ya existía y las preguntas se cancelan desde QuestionRepository.cancelAllPending (T2.2). La UI con botones es del sprint web (T4.x).

**Verdict**: pass

---
### P3 — Preguntas en la web (WS2)

> Mostrar y responder las preguntas desde el chat.

#### T3.1: La web muestra y responde las preguntas del agente

**Status**: done

**Description**: En el chat, mostrar la pregunta pendiente como una tarjeta con un botón por opción (selección simple o múltiple), campo de texto libre 'Otra respuesta' y botón Enviar; al enviar, deshabilitarla y mostrar la respuesta en el historial. Agregar a event-view los eventos question_asked y question_answered, un badge ámbar 'Esperando tu respuesta' en el encabezado del chat mientras haya una pendiente y los métodos del servicio de chats. Seguir docs/identidad-visual.md (tokens, Badge, Button, acciones deshabilitadas con motivo, celular).

**Evidence**:
- Summary: El chat muestra la pregunta pendiente como tarjeta (QuestionCard): un botón por opción (selección simple o múltiple con aria-pressed), campo 'Otra respuesta' y Enviar, deshabilitado con el motivo visible mientras falta responder. Al enviar queda en 'Enviando…' hasta que llega question_answered por SSE; entonces la tarjeta pasa al historial como pregunta + respuesta (burbuja del usuario) y question_cancelled se ve como aviso. event-view mapea question_asked, question_answered y question_cancelled, oculta la llamada cruda a AskUserQuestion y expone pendingQuestionIds; el encabezado del chat muestra un único badge ámbar 'Esperando tu respuesta' (chatBadge) mientras haya una pendiente. ChatsService.answerQuestion hace el POST. La lógica pura (toggle, texto libre, validación con motivo, cuerpo del POST, formato) está en question-logic.ts con spec. Estilos solo con tokens (.question* en components.css).
- Validation: npm test -w @agents-panel/web: 136 pasan (18 archivos), con specs nuevos de question-logic, event-view (preguntas) y chatBadge
- Validation: ng build de apps/web: compila los templates sin errores (encontró y se corrigió un acceso a null en la plantilla)
- Validation: grep de hex, rgb y hsl fuera de tokens.css: sin resultados; eslint, prettier y tsc de web sin errores
- Files changed: `apps/web/src/app/chats/question-card.ts`, `apps/web/src/app/chats/question-logic.ts`, `apps/web/src/app/chats/question-logic.spec.ts`, `apps/web/src/app/chats/chat.page.ts`, `apps/web/src/app/chats/chats.service.ts`, `apps/web/src/app/chats/event-view.ts`, `apps/web/src/app/chats/event-view.spec.ts`, `apps/web/src/app/chats/status.ts`, `apps/web/src/app/chats/status.spec.ts`, `apps/web/src/styles/components.css`
- Notes: No se probó en un navegador (no hay specs de componente en el repo; la lógica visible es pura y está testeada). La lógica pura quedó en question-logic.ts en vez de question-card.ts para no importar Angular desde event-view; el spec es question-logic.spec.ts. No se agregó ChatsService.questions(): el estado pendiente sale del replay de eventos.

**Verdict**: pass

---
### P4 — Docs y verificación

> Dejar docs al día y verificar todo el sprint.

#### T4.1: Docs del sprint: estados, plan y panel-desarrollo

**Status**: done

**Description**: Actualizar docs/estados.md (la pregunta pendiente como señal verificable del estado esperando_respuesta, su fuente en pending_questions y el estado de sesión mientras espera), docs/plan.md (preguntas desde la web, método confirmado en T1.1, allowlist pública sin cambios, referencia a los spikes) y docs/panel-desarrollo.md (cómo probar una pregunta de punta a punta).

**Evidence**:
- Summary: docs/estados.md: la fila esperando_respuesta se detecta por pending_questions con status pending, y una sección nueva describe la tabla (migración 7), cuándo nace, qué muestra la web, cómo sale (POST de respuesta, 409), la cancelación y el reinicio, y la diferencia con esperando_permiso; el mapeo de sesión aclara que sigue running mientras espera y se corrigió el nombre viejo esperando_usuario. docs/plan.md: Permisos y preguntas actualizado y un bloque nuevo en la etapa 4 con el método confirmado (updatedInput), las rutas, la allowlist pública sin cambios, el enlace al plan autopiloto-kyro y la referencia a los spikes H1/H2 y a las fixtures. docs/panel-desarrollo.md: sección 'Probar una pregunta del agente' con pasos de punta a punta, referencia de la API y cómo repetir los spikes.
- Validation: grep esperando_usuario en docs: sin resultados; prettier --check docs sin errores
- Validation: Lectura cruzada con T1.1-T1.3: método updatedInput, versión 0.3.289, política probada, gates sin ejercitar, close_sprint no emitido por Kyro 6.1.0 y rutas coinciden entre los tres docs
- Files changed: `docs/estados.md`, `docs/plan.md`, `docs/panel-desarrollo.md`
- Notes: Sin cambios en la VM: no corresponde bitácora de vm-setup.md. Los pasos de panel-desarrollo.md para probar una pregunta no se ejecutaron en un navegador.

**Verdict**: pass

---
#### T4.2: Verificación automática del sprint

**Status**: done

**Description**: Correr typecheck, lint, format:check, tests y build de todo el repo; comprobar con grep que no hay colores hex fuera de tokens.css, que no hay rutas públicas nuevas y que ningún comando de la API usa shell. Dejar registrado el recorrido manual de punta a punta (chat real que pregunta, respuesta desde la web, el agente sigue) como pendiente del usuario si no se hace en el sprint.

**Evidence**:
- Summary: Todos los gates del repo pasan: typecheck (shared, api con scripts, web), eslint, prettier, tests (api 505, web 136) y build (shared, api, web). Greps: sin hex/rgb/hsl fuera de tokens.css; las únicas rutas públicas siguen siendo health, login y totp (guard.test.ts y cli.test.ts lo fijan); todo comando externo usa execFile/execFileSync con argv, sin shell (los .exec que aparecen son db.exec de SQLite y RegExp.exec). Las rutas nuevas responden 401 sin sesión y 403 sin CSRF (questions-routes.test.ts). El recorrido manual en navegador no se hizo: queda como deuda debt-1 diferida al sprint 2 con su motivo.
- Validation: npm run typecheck, npm run lint, npm run format:check: exit 0
- Validation: npm test: api 505 y web 136 pasan; npm run build: exit 0
- Validation: grep hex fuera de tokens.css, public: true (3 rutas), child_process solo execFile: sin hallazgos
- Validation: kyro debt add + defer: debt-1 registrada para el recorrido manual con su motivo
- Files changed: 
- Notes: Criterio 3 cumplido por la vía de deuda diferida (el recorrido necesita navegador y el túnel del usuario).

**Verdict**: pass

---

## Unfinished work

_None — every task is done with a passing verdict._

## Learnings

- close_sprint no lo emite Kyro 6.1.0: el cierre se decide desde qa_or_close.
- El control sin política del spike H2 se detiene en review_task: la política debe autorizar el review.

## Resolved Debt

_No debt resolved in this sprint._

## Recommendations for Sprint 2

- El sprint 2 debe incluir en la política: quién hace el review, prohibir kyro repair apply y limpiar waiters al terminar el turno.
- Hacer el recorrido manual de preguntas (debt-1) al probar el sprint 2 desde la web.
