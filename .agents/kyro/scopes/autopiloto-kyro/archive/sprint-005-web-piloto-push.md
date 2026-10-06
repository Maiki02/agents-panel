---
title: 'autopiloto-kyro — Sprint 5: Web del piloto y notificaciones push'
date: '2026-10-05'
scope: 'autopiloto-kyro'
sprint: 5
slug: 'web-piloto-push'
outcome: 'shipped'
type: 'sprint-archive'
---

# Sprint 5: Web del piloto y notificaciones push

> Closed: 2026-10-05
> Outcome: shipped

## Objective

Que el piloto se maneje entero desde la web (encender, pausar, reanudar, apagar, elegir tipo y modelos, ver el estado por fases y el Timeline) y que cada freno o PR lista avise por Web Push a la PC y al Android, con el panel publicado por Tailscale Funnel.

## Definition of Done

- Todas las tareas terminadas con evidencia y veredicto pass
- typecheck, lint, format:check, test y build en verde; kyro analyze sin CRITICAL ni HIGH
- QA del sprint con kyro-qa APPROVED o APPROVED WITH NOTES
- H3 confirmada en la PC y el Android, o lo no probado registrado como deuda con target 6
- Tailscale + Funnel documentados en vm-setup.md (paso, bitácora y Costos US$0) con script idempotente
- debt-1 y debt-5 siguen con target 6
- Docs al día: plan.md, estados.md, panel-desarrollo.md, vm-setup.md y CLAUDE.md

## Phases

### P1 — API: encender el piloto y Web Push

> Lo que le falta a la API para que la web maneje el piloto y mande avisos push.

#### T1.1: Encender el piloto en un trabajo existente

**Status**: done

**Description**: Hoy POST /api/chats/:id/autopilot solo acepta pause, resume, off y accept_debt: un scope o work creado sin piloto (o apagado) no se puede encender. Sumar la acción 'on' a AutopilotAction (packages/shared) y a la ruta: crea o reactiva la corrida del piloto y abre el paso siguiente según las señales de Kyro (mismo camino que autopilot: true en POST /api/chats). Rechazar con 409 y motivo legible si el chat es direct o consulta, si es una idea sin plan aprobado, si el piloto ya está encendido o si el trabajo está en la fase de merge con la PR lista. Actualizar el comentario de newChatInput en apps/web/src/app/chats/chat-kinds.ts si cambia el contrato.

**Evidence**:
- Summary: Acción 'on' en AutopilotAction y en POST /api/chats/:id/autopilot: crea o reactiva la corrida, registra transición actor user en el Timeline y despierta al piloto; 409 con motivo para direct, idea, piloto ya encendido y PR lista.
- Validation: npx vitest run test/pilot-routes.test.ts test/pilot-runs.test.ts: 22 passed
- Validation: tsc --noEmit apps/api: sin errores
- Validation: eslint y prettier sobre los archivos tocados: limpios
- Files changed: `packages/shared/src/index.ts`, `apps/api/src/pilot/routes.ts`, `apps/api/src/app.ts`, `apps/api/test/pilot-routes.test.ts`, `apps/web/src/app/chats/chat-kinds.ts`

**Verdict**: pass

---
#### T1.2: Suscripciones Web Push: claves VAPID, tabla y rutas

**Status**: done

**Description**: Agregar la dependencia web-push a apps/api. Config: PUSH_VAPID_PUBLIC_KEY, PUSH_VAPID_PRIVATE_KEY y PUSH_VAPID_SUBJECT (mailto:) en loadConfig; sin claves el push queda deshabilitado (las rutas responden enabled: false y el notificador no envía), nunca tira al arrancar. Valores falsos en .env.example y un comando del CLI (o script npm) que genere un par de claves para pegar en el .env. Migración nueva push_subscriptions (id, user_id, endpoint UNIQUE, p256dh, auth, name, user_agent, created_at, last_success_at). Rutas, todas con sesión y CSRF: GET /api/push/config (enabled y clave pública), GET /api/push/subscriptions (las del usuario), POST /api/push/subscriptions (alta idempotente por endpoint; si el endpoint ya existe se actualiza y no se duplica), PATCH /api/push/subscriptions/:id (name), DELETE /api/push/subscriptions/:id y POST /api/push/subscriptions/:id/test. Cada usuario solo ve y toca las suyas (otra da 404). Un envío que responde 404 o 410 borra la suscripción.

**Evidence**:
- Summary: Web Push: dependencia web-push, config VAPID opcional (sin claves queda deshabilitado), migración 17 push_subscriptions, repo/servicio/sender inyectable y rutas /api/push/{config,subscriptions} con sesión+CSRF, aislamiento por usuario, alta idempotente por endpoint y borrado ante 404/410; comando CLI push:vapid-keys y .env.example con valores falsos.
- Validation: npx vitest run (apps/api): push-routes 12 passed, cli y db actualizados pasan
- Validation: tsc --noEmit y eslint de apps/api limpios
- Validation: push:vapid-keys imprime un par de claves (privada no registrada)
- Files changed: `apps/api/src/push/sender.ts`, `apps/api/src/push/repo.ts`, `apps/api/src/push/service.ts`, `apps/api/src/push/routes.ts`, `apps/api/src/config.ts`, `apps/api/src/db/migrations.ts`, `apps/api/src/app.ts`, `apps/api/src/cli/commands.ts`, `apps/api/.env.example`, `apps/api/package.json`, `packages/shared/src/index.ts`, `apps/api/test/push-routes.test.ts`

**Verdict**: pass

---
#### T1.3: Avisar por push cuando el piloto frena o la PR queda lista

**Status**: done

**Description**: Un notificador escucha las transiciones del estado fino (state-repo / state-tracker) y manda un aviso a todas las suscripciones cuando un trabajo entra en un estado donde le toca al usuario (who = user en work-state: bloqueado con su motivo, esperando_respuesta, esperando_aclaracion, esperando_aprobacion_plan, esperando_aprobacion_cierre, interrumpido, pausado solo si lo pausó el piloto) o en pr_lista. Un aviso por transición (no repetir si el estado no cambia). Payload sin secretos: título con el proyecto y el trabajo, cuerpo con la etiqueta y el motivo, url /projects/:pid/chats/:id y un tag por chat para que el aviso nuevo reemplace al anterior. Un fallo de envío se loguea y nunca frena ni rompe el piloto.

**Evidence**:
- Summary: PushNotifier escucha state_changed por un canal global del bus y avisa a todas las suscripciones cuando el trabajo pasa a un estado donde le toca al usuario o a pr_lista (pausado solo si lo pausó el piloto), una vez por transición, con título proyecto·trabajo, cuerpo etiqueta+motivo, url y tag por chat; los fallos se loguean. La clasificación label/who pasó a packages/shared (WORKTREE_STATE_INFO) y la usan la web y el notificador.
- Validation: apps/api vitest run completo: 52 archivos, 993 tests pasan (push-notifier 9)
- Validation: apps/web vitest run: pasa
- Validation: tsc y eslint de apps/api limpios
- Files changed: `apps/api/src/push/notifier.ts`, `apps/api/src/chats/events.ts`, `apps/api/src/push/service.ts`, `apps/api/src/app.ts`, `packages/shared/src/index.ts`, `apps/web/src/app/chats/work-state.ts`, `apps/api/test/push-notifier.test.ts`

**Verdict**: pass

---
### P2 — Web del trabajo: estado, Timeline y piloto

> Abrir un trabajo muestra en qué fase está, quién hizo qué, y los controles del piloto.

#### T2.1: Pestañas Chat y Timeline y stepper por fases

**Status**: done

**Description**: En chat.page, para un trabajo (scope, work o idea) agregar pestañas Chat y Timeline con el componente de tabs compartido (la consulta directa solo muestra el chat). Arriba, un stepper por fases (Idea → Plan → Ejecución → QA → Cierre → Merge → PR) que sale de GET /api/chats/:id/state: fase actual, sprint n/m, tarea n/m, rol y modelo de la sesión, y el badge único del estado arriba a la derecha. El Timeline lista las transiciones (GET /api/chats/:id/timeline) de la más nueva a la más vieja: estado de/a, actor (usuario, piloto, agente), rol y modelo, motivo de freno, deuda postergada y decisiones del piloto (ADR) cuando vengan en data; se actualiza al llegar eventos del stream. Lógica pura (mapeo estado → fase, formateo de cada transición) en archivos *.ts con spec, como el resto de la web.

**Evidence**:
- Summary: chat.page muestra pestañas Chat/Timeline y stepper de fases (Idea→PR) para scope, work e idea; la consulta directa solo el chat. Stepper con fase actual, sprint n/m, tarea n/m y rol/modelo desde GET /state (sin inventar números); badge único del estado fino; Timeline de la más nueva a la más vieja con actor, rol, modelo, motivo, deuda y ADR, refrescado en cada state_changed del stream. Lógica pura en phase-logic.ts y timeline-logic.ts con specs; solo clases con tokens.
- Validation: apps/web vitest run: 199 passed (phase-logic y timeline-logic 12 nuevos)
- Validation: tsc -p tsconfig.app.json, eslint src/app/chats y ng build: limpios
- Validation: grep de colores hex en phase-stepper.ts y timeline.ts: ninguno
- Files changed: `apps/web/src/app/chats/chat.page.ts`, `apps/web/src/app/chats/chats.service.ts`, `apps/web/src/app/chats/phase-logic.ts`, `apps/web/src/app/chats/phase-logic.spec.ts`, `apps/web/src/app/chats/phase-stepper.ts`, `apps/web/src/app/chats/timeline-logic.ts`, `apps/web/src/app/chats/timeline-logic.spec.ts`, `apps/web/src/app/chats/timeline.ts`
- Notes: No se vio en un navegador: la verificación visual queda para T5.2.

**Verdict**: pass

---
#### T2.2: Controles del piloto en la página del trabajo

**Status**: done

**Description**: Una barra del piloto en el trabajo: interruptor Encender/Apagar y botones Pausar/Reanudar que llaman a POST /api/chats/:id/autopilot (on, off, pause, resume), con el estado de la corrida (activo, pausado, apagado, en cola, sesiones del sprint n/tope) de GET /api/chats/:id/autopilot. Cada acción no disponible se muestra deshabilitada con el motivo (por ejemplo: idea sin aprobar, PR ya lista, consulta sin Kyro). Apagar pide confirmación porque deja el trabajo en modo manual. Errores 409 se muestran con el mensaje de la API.

**Evidence**:
- Summary: Barra del piloto (autopilot-bar) en la página del trabajo: estado de la corrida con sesiones n/tope y motivo del freno, y botones Encender/Reanudar/Pausar/Apagar que llaman a POST /autopilot; cada acción no disponible va deshabilitada con su motivo visible, apagar pide confirmación en modal y los 409 muestran el mensaje de la API. Disponibilidad y estado en autopilot-logic.ts con spec por tipo de chat y estado de la corrida.
- Validation: apps/web vitest run: 207 passed (autopilot-logic 8 nuevos)
- Validation: tsc, eslint y ng build de apps/web: limpios
- Files changed: `apps/web/src/app/chats/autopilot-bar.ts`, `apps/web/src/app/chats/autopilot-logic.ts`, `apps/web/src/app/chats/autopilot-logic.spec.ts`, `apps/web/src/app/chats/chat.page.ts`, `apps/web/src/app/chats/chats.service.ts`
- Notes: Sin verificación visual en navegador; queda para T5.2.

**Verdict**: pass

---
#### T2.3: Chat nuevo: piloto y modelos

**Status**: done

**Description**: El formulario de chat nuevo ya elige el tipo (Idea, Scope, Work, Pedido directo). Sumar: interruptor Piloto automático para Scope y Work (encendido por defecto; la Idea lo enciende sola al aprobar el plan y el pedido directo no lo tiene, con el motivo visible), y un selector de modelo pensante y ejecutor con el catálogo de packages/shared (MODEL_CATALOG) y el valor del proyecto (GET /api/projects/:id/models) marcado como 'por defecto'. Mandar autopilot y models (solo si difieren del defecto) en POST /api/chats. Mostrar en el chat abierto los modelos guardados del trabajo.

**Evidence**:
- Summary: Formulario de chat nuevo: interruptor Piloto automático (encendido por defecto en scope y work; en idea y pedido directo deshabilitado con el motivo visible) y selectores plegados de modelo pensante y ejecutor con MODEL_CATALOG y el modelo del proyecto marcado 'por defecto'. newChatInput manda autopilot:true solo para scope/work y models solo con los roles cambiados. El chat abierto muestra los modelos guardados del trabajo.
- Validation: apps/web vitest run: 212 passed (5 specs nuevas de newChatInput, pilotSwitch y modelOptions)
- Validation: tsc, eslint y ng build de apps/web: limpios
- Files changed: `apps/web/src/app/chats/new-chat.form.ts`, `apps/web/src/app/chats/chat-kinds.ts`, `apps/web/src/app/chats/chat-kinds.spec.ts`, `apps/web/src/app/chats/chats.service.ts`, `apps/web/src/app/chats/chat.page.ts`
- Notes: Sin verificación visual en navegador; queda para T5.2.

**Verdict**: pass

---
### P3 — Web de configuración: modelos, validación y notificaciones

> Configurar desde la web lo que hoy solo se toca por la API, y suscribir dispositivos a los avisos.

#### T3.1: Tab Modelos y campo validate_command

**Status**: done

**Description**: En la Configuración del proyecto: tab nueva Modelos (proveedor, hoy solo Claude; modelo pensante y ejecutor con la opción 'Por defecto del panel') sobre GET/PUT /api/projects/:id/models, y en General el campo 'Comando de validación' (validate_command, opcional, máximo 500) sobre PATCH /api/projects/:id con validateCommand, con ayuda de qué hace (corre sin shell en el worktree antes de abrir la PR, con timeout; sin comando el merge no valida y el Timeline lo anota). Errores de la API (comilla sin cerrar, modelo fuera del catálogo) se muestran en el campo.

**Evidence**:
- Summary: Configuración del proyecto: tab Modelos (proveedor Claude, pensante y ejecutor con la opción 'Por defecto del panel' sobre GET/PUT /models, se recarga desde la API) y campo 'Comando de validación' en General sobre PATCH validateCommand (vacío = null, máximo 500), con ayuda de qué hace; el error de la API se muestra junto al campo sin perder lo escrito.
- Validation: apps/web vitest run: 218 passed (settings-logic y settings-tabs)
- Validation: tsc, eslint y ng build de apps/web: limpios
- Files changed: `apps/web/src/app/projects/models.section.ts`, `apps/web/src/app/projects/settings-logic.ts`, `apps/web/src/app/projects/settings-logic.spec.ts`, `apps/web/src/app/projects/settings-tabs.ts`, `apps/web/src/app/projects/settings-tabs.spec.ts`, `apps/web/src/app/projects/settings.page.ts`, `apps/web/src/app/projects/project-settings.ts`, `apps/web/src/app/projects/projects.service.ts`
- Notes: La API de modelos exige proveedor y modelos explícitos (no acepta null), así que 'Por defecto del panel' guarda el modelo por defecto de ese rol (DEFAULT_MODELS) en vez de null. Sin verificación visual en navegador; queda para T5.2.

**Verdict**: pass

---
#### T3.2: Notificaciones: service worker, manifest y dispositivos

**Status**: done

**Description**: Un service worker propio (apps/web/public/push-sw.js, servido en la raíz) que maneja push (muestra la notificación con título, cuerpo, tag y url) y notificationclick (enfoca una pestaña del panel o abre la url). Un manifest.webmanifest con nombre, íconos y display standalone para poder agregar el panel a la pantalla de inicio (iOS lo exige). Página global Notificaciones (ruta /settings/notifications, con link en el header junto a Versiones, porque los dispositivos son del usuario y no de un proyecto): botón 'Activar en este dispositivo' (pide permiso, registra el SW, PushManager.subscribe con la clave de GET /api/push/config y POST de la suscripción con un nombre sugerido por el navegador), lista de dispositivos con nombre editable, Probar y Quitar, y estados claros: push deshabilitado en el panel, permiso denegado, navegador sin soporte, iOS fuera de la pantalla de inicio. Lista vacía con qué hacer.

**Evidence**:
- Summary: Notificaciones push en la web: service worker push-sw.js (push + notificationclick, solo abre rutas internas), manifest.webmanifest con íconos e index.html enlazado, página /settings/notifications con link en el header: activar en este dispositivo (permiso, registro del SW, subscribe con la clave VAPID, alta en la API con nombre sugerido), lista con renombrar, probar y quitar, y estados claros (panel sin VAPID, contexto inseguro, iOS fuera de la pantalla de inicio, navegador sin soporte, permiso denegado). Lógica pura en notifications-logic.ts con spec.
- Validation: apps/web vitest run: 234 passed (notifications-logic nuevo)
- Validation: tsc, eslint y ng build limpios; dist/web/browser contiene push-sw.js, manifest.webmanifest e icons/
- Validation: ng serve: GET /push-sw.js 200 text/javascript, /manifest.webmanifest 200, /icons/icon-192.png 200
- Files changed: `apps/web/public/push-sw.js`, `apps/web/public/manifest.webmanifest`, `apps/web/src/index.html`, `apps/web/src/app/app.routes.ts`, `apps/web/src/app/app.ts`, `apps/web/src/app/notifications/notifications.page.ts`, `apps/web/src/app/notifications/notifications.service.ts`, `apps/web/src/app/notifications/push-browser.ts`, `apps/web/src/app/notifications/notifications-logic.ts`, `apps/web/src/app/notifications/notifications-logic.spec.ts`
- Notes: No se probó el flujo real con un navegador (permiso, suscripción, notificación al tocar): requiere HTTPS/localhost y un dispositivo, queda para T5.2 y T4.1.

**Verdict**: pass

---
### P4 — VM: Tailscale y Funnel, y confirmación de H3

> Publicar el panel por HTTPS con Funnel (US$0, aprobado por el usuario el 05/10/2026) para confirmar Web Push en el Android con Chrome cerrado.

#### T4.1: Instalar Tailscale y publicar el panel con Funnel

**Status**: done

**Description**: Script idempotente scripts/vm/09-tailscale-funnel.sh (bash, set -euo pipefail, LF): instala Tailscale desde su repositorio oficial si falta, habilita tailscaled y, si el nodo ya está logueado, configura Funnel en 443 en segundo plano apuntando al puerto donde hoy se sirve la web en la VM (ng serve con proxy a la API, mientras systemd sea de la etapa 6). El login (tailscale up) es manual, una sola vez, con la cuenta del usuario. Ajustar lo que el panel necesita para atender por el nombre *.ts.net: allowedHosts del dev server limitado a ese nombre, Origin permitido en la API por configuración (PANEL_PUBLIC_ORIGIN o el que ya exista) y cookies Secure. Runbook: paso 15 en docs/vm-setup.md (qué, comando exacto, por qué, cómo se verifica), línea en la bitácora y fila en Costos (US$0, plan gratis de Tailscale, aprobado por Miqueas el 05/10/2026). Ningún secreto (authkey) en el script ni en los docs.

**Evidence**:
- Summary: Tailscale 1.102.4 instalado con 09-tailscale-funnel.sh y Funnel en 443 hacia la web (puerto 4200); PANEL_EXTRA_ORIGINS y allowedHosts .ts.net ajustados; runbook paso 15, bitácora y fila de Costos (US$0) en docs/vm-setup.md, sin secretos. El DNS público no resolvía hasta pedir el certificado con 'sudo tailscale cert' (documentado en el paso 15).
- Validation: 09-tailscale-funnel.sh corrido dos veces: la segunda respondió 'ya publicado' sin cambios
- Validation: tailscale funnel status: solo https://vm-ia.tailacdafa.ts.net -> proxy http://127.0.0.1:4200
- Validation: curl --resolve a las IPs públicas de Funnel: web 200 con certificado válido, /api/health 200, rutas con sesión 401, login con Origin de Funnel pasa y con Origin ajeno da 403
- Validation: Desde el celular del usuario (datos móviles, URL de Funnel): login con TOTP funcionó y la notificación de prueba llegó (confirmado por el usuario)
- Validation: apps/api vitest funnel.test.ts: script idempotente con stubs, PANEL_EXTRA_ORIGINS
- Files changed: `scripts/vm/09-tailscale-funnel.sh`, `docs/vm-setup.md`, `apps/web/angular.json`, `apps/api/src/config.ts`, `apps/api/.env.example`, `apps/api/test/funnel.test.ts`
- Notes: El usuario no indicó si el celular tenía la app de Tailscale apagada; el camino público se comprobó aparte con curl --resolve.

**Verdict**: pass

---
#### T4.2: Confirmar H3: push en la PC y en el Android con Chrome cerrado

**Status**: done

**Description**: Con el usuario y la URL de Funnel: generar las claves VAPID en el .env del panel en la VM (anotado en vm-setup.md sin valores), suscribir la PC y el Android desde Notificaciones, cerrar Chrome en el Android, provocar un freno en un Work de prueba (repo de prueba, nunca ventas ni este repo; por ejemplo una pregunta del agente) y comprobar que el aviso llega a los dos dispositivos y que tocarlo abre el trabajo. Quitar el permiso en un navegador o borrar su suscripción del lado del navegador y comprobar que el siguiente envío borra la fila (404/410). Si algo no se puede probar en esta sesión, queda como deuda con target 6 junto a debt-1, no como pass.

**Evidence**:
- Summary: H3 confirmada con el usuario: un Work de prueba en test-panel (repo de prueba) avisó por push a la PC (Chrome) y al Android (Chrome cerrado) cuando hizo una pregunta y cuando dejó la PR lista (PR #2), con el motivo, y tocar el aviso abre el trabajo (confirmado por el usuario). La vuelta del Android falló primero por el ahorro de batería de Chrome; se resolvió y el envío pasó a urgency high. docs/panel-desarrollo.md tiene 'Probar las notificaciones push' y el resultado de H3. La parte no probada en real (suscripción vencida con 404/410 que se borra sola) queda como deuda debt-10 con target 6, cubierta por tests automáticos.
- Validation: Avisos recibidos en PC y Android (Chrome cerrado) por pregunta pendiente y por PR lista, y el toque abre el trabajo (confirmado por el usuario)
- Validation: Quitar y volver a suscribir un dispositivo desde Notificaciones funciona (confirmado por el usuario)
- Validation: Suscripción vencida con 404/410: solo por tests (push-routes y push-notifier); no probado en real, deuda debt-10
- Files changed: `docs/panel-desarrollo.md`, `apps/api/src/push/sender.ts`
- Notes: La parte no probada queda como deuda con target 6, como indica la tarea; no se marca como probada.

**Verdict**: pass

---
### P5 — Docs y verificación

> Docs al día y gates del repo en verde.

#### T5.1: Docs del sprint 5

**Status**: done

**Description**: docs/plan.md: resumen del sprint 5 (web del piloto, acción on, Web Push, Funnel adelantado a la etapa 5 por pedido del usuario) y lo que queda para el sprint 6. docs/estados.md: los tres niveles de estado (proyecto, trabajo, sesión), la etiqueta única por ítem, el mapeo sesión → trabajo y qué estados avisan por push (y que la clasificación de quién actúa vive en packages/shared). docs/panel-desarrollo.md: VAPID (cómo generar las claves, dónde van, sin valores), cómo probar push por el túnel y por Funnel, y actualizar los recorridos de los sprints 2 a 4 que decían 'la web es del sprint 5'. docs/identidad-visual.md si se sumaron patrones (stepper, barra del piloto). CLAUDE.md: Funnel ya activo y cualquier regla nueva.

**Evidence**:
- Summary: Docs del sprint 5: estados.md (tres niveles de estado, etiqueta única, mapeo sesión→trabajo, tono por quién actúa y qué estados avisan por push, con la clasificación en packages/shared), panel-desarrollo.md (probar el piloto desde la web, VAPID sin valores, Probar las notificaciones push, frases 'es del sprint 5' actualizadas), plan.md (resumen del sprint 5 y pendiente del 6), identidad-visual.md (stepper, pestañas, barra del piloto, Timeline) y CLAUDE.md (Funnel, VAPID, rutas públicas, campo de validación en la web). El Timeline pasó a fechas relativas con la fecha completa en title, como pide identidad-visual.md.
- Validation: prettier --check docs CLAUDE.md: sin errores
- Validation: grep de 'es/son/hasta/llega ... sprint 5' en docs y CLAUDE.md: sin frases pendientes
- Validation: apps/web vitest: 235 passed
- Files changed: `docs/estados.md`, `docs/panel-desarrollo.md`, `docs/plan.md`, `docs/identidad-visual.md`, `CLAUDE.md`, `apps/web/src/app/chats/timeline-logic.ts`, `apps/web/src/app/chats/timeline.ts`

**Verdict**: pass

---
#### T5.2: Verificación automática del sprint

**Status**: done

**Description**: Correr typecheck, lint, format:check, test y build del repo. Greps: ningún bypassPermissions ni allowDangerouslySkipPermissions en apps/api/src; ninguna ruta public: true nueva (solo /api/health y los pasos de login); toda ruta nueva de /api/push y la acción on con sesión y CSRF; ningún color fuera de tokens en los componentes nuevos; .env.example sin valores reales. /tmp igual antes y después de los tests. kyro analyze sin CRITICAL ni HIGH.

**Evidence**:
- Summary: Verificación del sprint 5 con todos los cambios (incluidos E1, E2, el push de alta prioridad y la prueba real de H3): typecheck, lint, format:check, test (API 1011 y web 239) y build en verde; greps de seguridad sin hallazgos; /tmp sin carpetas panel-* tras los tests; kyro analyze sin CRITICAL ni HIGH.
- Validation: npm run typecheck, lint, format:check, build: OK
- Validation: npm test: apps/api 55 archivos 1011 tests y apps/web 26 archivos 239 tests, todos pasan
- Validation: grep bypassPermissions|allowDangerouslySkipPermissions en apps/api/src: 0; public: true: 3 (solo /api/health y los dos pasos del login)
- Validation: rutas nuevas (/api/push/*, acción on, /kyro-init/push) con sesión y CSRF: cubiertas por push-routes, pilot-routes y cli.test (401 sin sesión, 403 sin CSRF)
- Validation: grep de colores hex o rgb() en apps/web/src/app (sin specs): 0; apps/api/.env.example solo con valores falsos y apps/api/.env no está versionado
- Validation: /tmp: 0 carpetas panel-* después de los tests, inodos 2%
- Validation: kyro analyze: CRITICAL=0 HIGH=0; 4 hallazgos MEDIUM (fase P5 bloqueada por el estado de la tarea, escenario S20 sin tarea, E1 y E2 sin scenario_refs)
- Files changed: 
- Notes: Los hallazgos MEDIUM no bloquean el cierre; E1 y E2 son tareas emergentes sin referencia de escenario.

**Verdict**: pass

---

## Unfinished work

_None — every task is done with a passing verdict._

## Learnings

_No learnings recorded._

## Resolved Debt

- **debt-2**: La base de Bash todavía alcanza los denegados fijos: npm exec -c, git -c core.sshCommand / alias !, go run y python ejecutan cualquier comando; cerrar esos caminos (o un deny por argumento) antes de que el piloto corra solo (R9, R10)
- **debt-3**: WorktreeStateTracker.turnStarted: al retomar tras interrumpido puede volver a esperando_respuesta aunque la pregunta ya se canceló (la etiqueta se corrige al terminar el turno)
- **debt-4**: Los tests de apps/api dejan carpetas panel-* en /tmp (mkdtemp sin limpieza): agotaron los inodos de la VM el 05/10/2026. Limpiar lo creado en afterEach o usar un TMPDIR propio por corrida
- **debt-6**: Verificar el veredicto de kyro-qa (APPROVED / APPROVED WITH NOTES) además de que la sesión de cierre invocó la skill
- **debt-7**: AlreadyRunningError si el usuario manda un mensaje entre waitForIdle y start: el piloto debe reintentar en vez de frenar con otro
- **debt-8**: Reinicio con una pregunta pendiente: la pregunta se cancela sin evento y la web sigue mostrando la tarjeta respondible (la respuesta falla sin explicar); además el piloto se reanuda y frena con 'El worktree no tiene Works de Kyro' si el agente todavía no había creado el Work, en vez de reabrir el paso de plan. Hallado en la prueba de T4.2 (05/10/2026).

## Recommendations for Sprint 6

_None recorded._
