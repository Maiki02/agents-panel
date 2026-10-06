---
title: 'autopiloto-kyro — Sprint 6: Docs, merge-dev de ventas y cierre'
date: '2026-10-06'
scope: 'autopiloto-kyro'
sprint: 6
slug: 'docs-ventas-cierre'
outcome: 'shipped'
type: 'sprint-archive'
---

# Sprint 6: Docs, merge-dev de ventas y cierre

> Closed: 2026-10-06
> Outcome: shipped

## Objective

Dejar el panel corriendo como servicio de producción detrás de Funnel, el merge-dev de ventas subiendo la versión, la deuda abierta resuelta y el piloto verificado con una corrida real, para poder completar el scope.

## Definition of Done

- Todas las tareas terminadas con evidencia y veredicto pass
- typecheck, lint, format:check, test y build en verde; kyro analyze sin CRITICAL ni HIGH
- QA del sprint con kyro-qa APPROVED o APPROVED WITH NOTES
- Funnel publica el servicio systemd (build de producción), no ng serve
- debt-1, debt-5, debt-9, debt-10 y debt-11 resueltas, o diferidas con OK explícito del usuario
- PR de ventas (R19) abierta y registrada en plan.md
- Docs al día: plan.md, vm-setup.md (paso 16, bitácora, Costos), panel-desarrollo.md, estados.md y CLAUDE.md

## Phases

### P1 — Producción: build y servicio systemd

> Que Funnel publique el build de producción servido por la API como servicio systemd, no ng serve, y que nunca corran dos APIs sobre la misma base.

#### T1.1: La API sirve la web compilada y corre una sola instancia por base

**Status**: done

**Description**: Sumar @fastify/static a apps/api para servir apps/web/dist/web/browser (ruta configurable PANEL_WEB_DIR; sin carpeta, no sirve nada y arranca igual). Fallback SPA: cualquier GET que no sea /api/* ni un archivo existente devuelve index.html. Todo /api/* sigue pasando por el guard deny-by-default: una ruta /api inexistente sin sesión da 401, nunca index.html. Encabezados de seguridad en los archivos estáticos (nosniff, frame-ancestors none o X-Frame-Options DENY, Referrer-Policy) y cache largo solo para archivos con hash. Además, un candado de instancia única sobre el directorio de datos (archivo de lock con el pid, liberado al salir): una segunda API sobre la misma base se niega a arrancar con un mensaje claro, para que el servicio y un tsx watch de desarrollo nunca retomen el mismo piloto dos veces.

**Evidence**:
- Summary: API sirve la web compilada (@fastify/static, PANEL_WEB_DIR, fallback SPA por notFoundHandler sin sumar rutas públicas, cache largo solo con hash) y candado de instancia única con recuperación de lock huérfano
- Validation: npm run typecheck (shared, api, web) sin errores
- Validation: eslint apps/api sin hallazgos
- Validation: vitest apps/api: 57 archivos, 1025 tests en verde (web-static y instance-lock nuevos)
- Files changed: `apps/api/package.json`, `apps/api/src/app.ts`, `apps/api/src/web-static.ts`, `apps/api/src/instance-lock.ts`, `apps/api/src/main.ts`, `apps/api/src/config.ts`, `apps/api/src/auth/guard.ts`, `apps/api/.env.example`, `apps/api/test/web-static.test.ts`, `apps/api/test/instance-lock.test.ts`
- Notes: Se tocó también auth/guard.ts: deja pasar solo GET/HEAD no-/api sin ruta cuando hay build. package-lock.json cambia por @fastify/static.

**Verdict**: pass

---
#### T1.2: Servicio systemd del panel y Funnel hacia el build

**Status**: done

**Description**: Script idempotente scripts/vm/10-panel-service.sh (bash, set -euo pipefail, LF): npm ci + npm run build, instala o actualiza /etc/systemd/system/agents-panel.service (User=ubuntu, WorkingDirectory=apps/api, node --env-file-if-exists=.env dist/main.js, PANEL_WEB_DIR al build, escucha solo 127.0.0.1:3000, Restart=on-failure), daemon-reload, enable y restart solo si algo cambió. Ajustar 09-tailscale-funnel.sh para recibir el puerto destino (por defecto 3000) y pasar Funnel de 4200 a 3000. Correrlo con el usuario presente (usa sudo), dos veces para probar idempotencia. Documentar en docs/vm-setup.md el paso 16 (qué, comando, por qué, cómo se verifica, cómo actualizar tras un pull y cómo convive con el desarrollo), bitácora y fila de Costos (US$0, sin cambios en Oracle).

**Evidence**:
- Summary: Servicio systemd agents-panel (API + web compilada en 127.0.0.1:3000) instalado con 10-panel-service.sh; Funnel pasó de 4200 a 3000; login con TOTP por la URL de Funnel confirmado por el usuario; CSP ajustado para la web compilada
- Validation: systemctl is-active agents-panel = active, is-enabled = enabled, NRestarts=0
- Validation: ss: 3000 solo en 127.0.0.1 y nada en 4200
- Validation: tailscale funnel status: https://vm-ia.tailacdafa.ts.net -> proxy http://127.0.0.1:3000
- Validation: Por Funnel: /api/health 200, /api/projects 401 sin cookie, login con TOTP confirmado por el usuario
- Validation: panel-service.test.ts y funnel.test.ts (stubs): 2ª corrida sin cambios, --restart, puerto ocupado; vitest apps/api 1030 en verde, eslint y tsc limpios
- Files changed: `scripts/vm/10-panel-service.sh`, `scripts/vm/agents-panel.service`, `scripts/vm/09-tailscale-funnel.sh`, `apps/api/test/panel-service.test.ts`, `apps/api/test/funnel.test.ts`, `docs/vm-setup.md`, `apps/web/angular.json`, `apps/api/src/auth/security.ts`
- Notes: Idempotencia en la VM real: el usuario confirmó la segunda corrida pero no vi su salida; lo que sí verifiqué es que la unidad conserva su fecha de instalación tras el --restart. La prueba de 'sin cambios' / 'activo, sin cambios' queda cubierta por el test con stubs. La web salía sin CSS por el CSP: se desactivó inlineCritical y se agregó style-src 'unsafe-inline'.

**Verdict**: pass

---
### P2 — Piloto: primer turno del Work y rm validado

> Que el agente no salga del worktree para aprender a crear un Work y que pueda borrar archivos del worktree sin abrir un agujero en la allowlist.

#### T2.1: Prompt del primer turno de un Work

**Status**: done

**Description**: En la prueba real del sprint 5 (test-panel, PR #2) el agente recibió 8 denegaciones al intentar leer fuera del worktree para aprender a crear la propuesta del Work, y dejó dos archivos sueltos en la PR. Leer los eventos permission_denied de ese trabajo en la base del panel (sin leer .env) para ver qué rutas buscó, y mejorar el prompt del primer turno (apps/api/src/chats/service.ts o pilot/prompts.ts, donde se arme) para que diga dónde está la skill kyro-work dentro de lo legible (~/.agents/skills), qué comando de Kyro crea la propuesta y que no deje archivos de trabajo fuera de .agents/kyro. Sin tocar la allowlist ni canUseTool.

**Evidence**:
- Summary: Prompt del primer turno de un Work (chat y pasos del piloto) con la guía legible, el comando de creación y la prohibición de archivos sueltos. Rutas intentadas en la prueba del sprint 5 (chat 1 y 2 del panel): Bash cat/ls/find/which/od y '~'/$()/globs (denegados por la allowlist), ~/.agents/kyro/current/commands/work.md y docs/work.md, /usr/lib/node_modules/kyro-ai/docs/work.md (fuera de lo legible), y archivos escritos en /tmp/readme-line-brief.md, /tmp/w1-evidence.json y .agents/briefs/. El prompt nuevo da la ruta absoluta legible de work.md (Read con rutas absolutas), dice que no se use ~, $(), ls, find, which ni od, nombra kyro work create/plan/record-evidence/review y manda escribir los insumos solo en .agents/kyro/inputs/ y borrarlos con git clean -f
- Validation: Leí los 17 eventos permission_denied de los chats 1 y 2 en la base del panel (solo type y payload, sin .env)
- Validation: pilot-prompts.test.ts y chats.test.ts: el prompt de Work nombra la ruta legible, el comando de creación, prohíbe /tmp y manda git clean
- Validation: git diff de apps/api/src/agent vacío: permissions.ts y la allowlist sin cambios
- Validation: vitest apps/api 1032 en verde, eslint y tsc limpios
- Files changed: `apps/api/src/pilot/prompts.ts`, `apps/api/src/chats/service.ts`, `apps/api/test/pilot-prompts.test.ts`, `apps/api/test/chats.test.ts`
- Notes: El efecto real (cero permission_denied en el primer turno) se verifica en T5.1. Hace falta recompilar y reiniciar el servicio para que lo tome.

**Verdict**: pass

---
#### T2.2: rm con ruta validada dentro del worktree (debt-5)

**Status**: done

**Description**: Sumar rm a la base de Bash del piloto como los comandos de lectura con ruta validada: cada operando, resuelto con realpath (siguiendo symlinks del directorio padre, sin seguir el último si es symlink), tiene que quedar dentro del worktree y no ser la raíz del worktree ni .git ni algo dentro de .git. Opciones permitidas: -f, -r/-R, -- y combinaciones cortas; cualquier otra opción, glob sin expandir, ~, $VAR, sustitución o redirección se deniega. Actualizar la política del piloto (hoy manda git rm y git clean) para que use rm validado solo para archivos no versionados.

**Evidence**:
- Summary: rm con ruta validada (checkRm): cada operando se resuelve con realpath del padre sin seguir el último componente y debe quedar dentro del worktree, no ser la raíz ni .git ni algo dentro de .git; solo -f/-r/-R/--; deniega globs, ~, variables, sustituciones, redirecciones, comillas en la ruta, '..', rm tras cd y envoltorios; un proyecto no puede agregarlo y su extra no evita la validación. Política del piloto v4 con rm validado y su límite
- Validation: permissions.test.ts nuevo (worktree real con symlink): permitidos rm archivo.txt, rm -f a b, rm -r carpeta/; denegados rm -rf ~, /, ../x, -r ., -r .git, $HOME/x, *, symlink que sale, --no-preserve-root /, env/xargs/nohup/timeout/sh -c
- Validation: npm test, git push y go test siguen permitidos (test)
- Validation: vitest apps/api 1036 en verde, eslint y tsc limpios
- Validation: Se ajustaron dos tests viejos que daban por sentado que rm siempre se denegaba (agent.test.ts:526 y permissions.test.ts 'uv run pytest && rm'), ahora usan una ruta fuera del worktree
- Files changed: `apps/api/src/agent/permissions.ts`, `apps/api/src/projects/permissions-routes.ts`, `apps/api/src/pilot/policy.ts`, `apps/api/test/permissions.test.ts`, `apps/api/test/agent.test.ts`, `apps/api/test/pilot-policy.test.ts`, `docs/plan.md`
- Notes: Límite conocido documentado en plan.md: validación previa a la ejecución (sin bloqueo contra un symlink creado entre ambas). Hace falta recompilar y reiniciar el servicio.

**Verdict**: pass

---
### P3 — Deuda menor del QA del sprint 5 (debt-11)

> Cerrar los menores del QA del sprint 5 que tienen arreglo en código.

#### T3.1: API: ref de kyro-init, respaldo de question_cancelled, tope de suscripciones y mensaje de on

**Status**: done

**Description**: (a) Leer el ref de chore/kyro-init sin dos execFileSync por lectura de proyecto: cache por proyecto invalidada al inicializar, pushear o borrar la rama (o lectura de .git/refs y packed-refs). (b) El respaldo de question_cancelled al arrancar corre una sola vez (marca persistida) o solo sobre preguntas pendientes, no recorre todos los eventos en cada arranque. (c) Tope de suscripciones push por usuario (10): la undécima da 409 con el motivo 'quitá un dispositivo'; volver a suscribir el mismo endpoint sigue siendo idempotente. (d) La acción on con el piloto en estado finished responde 409 con un mensaje que diga que el trabajo ya terminó, no uno genérico.

**Evidence**:
- Summary: (a) el ref de chore/kyro-init se lee de los archivos de refs (suelto y packed-refs) sin lanzar git, así que no hay caché que invalidar; (b) el respaldo de question_cancelled corre una sola vez con marca persistida (tabla app_flags, migración 18); (c) tope de 10 suscripciones push por usuario: la undécima da 409 'quitá un dispositivo', repetir un endpoint sigue idempotente; (d) 'on' con el piloto finished da 409 'El trabajo ya terminó…'
- Validation: kyro-init-pending.test.ts: con PATH sin git lee ref suelto, packed-refs, origin y borrado, y ve los cambios al instante
- Validation: restart-questions.test.ts: el segundo arranque no vuelve a recorrer eventos (marca app_flags)
- Validation: push-routes.test.ts: undécima 409 con motivo, mismo endpoint 200 sin duplicar, tope por usuario y se libera al borrar
- Validation: pilot-routes.test.ts: on con finished da 409 con el mensaje específico (de paso, los tests de 409 existentes ahora leen el campo error real, antes miraban message y no verificaban nada)
- Validation: vitest apps/api 1040 en verde, eslint y tsc limpios
- Files changed: `apps/api/src/projects/repo.ts`, `apps/api/src/app.ts`, `apps/api/src/db/flags.ts`, `apps/api/src/db/migrations.ts`, `apps/api/src/push/repo.ts`, `apps/api/src/push/routes.ts`, `apps/api/src/pilot/routes.ts`, `apps/api/test/kyro-init-pending.test.ts`, `apps/api/test/restart-questions.test.ts`, `apps/api/test/push-routes.test.ts`, `apps/api/test/pilot-routes.test.ts`, `apps/api/test/db.test.ts`
- Notes: E1/E2 sin scenario_refs: N/A (tareas archivadas e inmutables). Los archivos orientativos del task (kyro-init.ts, questions.ts, push/service.ts) no existían: las piezas viven en projects/repo.ts, app.ts y push/repo.ts+routes.ts. Hace falta recompilar y reiniciar el servicio (la migración 18 corre al arrancar).

**Verdict**: pass

---
#### T3.2: Tests de sender.ts y push-sw.js

**Status**: done

**Description**: Cubrir con tests apps/api/src/push/sender.ts (arma el payload, urgency high, TTL, traduce 404/410 a 'vencida' y otros errores a fallo sin tirar) con web-push inyectado, y la lógica del service worker apps/web/public/push-sw.js (mostrar la notificación con título, cuerpo, tag y url; notificationclick solo abre rutas internas y enfoca una pestaña existente) extrayendo la lógica pura a un módulo testeable o corriéndolo en un contexto simulado.

**Evidence**:
- Summary: Tests de sender.ts (web-push inyectado con vi.mock: payload, VAPID, urgency high, TTL 3600, 404/410 y 500 con su código, fallo de red sin tirar) y de push-sw.js (se carga el archivo real en un contexto vm con un self simulado: show con título/cuerpo/tag/url, clic solo a rutas internas, enfoca la pestaña existente). Los tests encontraron un hueco real: '/\\otro.com' pasaba el chequeo de ruta y el navegador lo lee como //otro.com (salía del panel); push-sw.js ahora rechaza barra invertida y caracteres de control. push-sw.js sigue siendo un archivo plano
- Validation: push-sender.test.ts: 404 y 410 devuelven ok:false con statusCode (el service los borra), 500 también pero con su código distinto, urgency high presente (5 tests)
- Validation: push-sw.spec.ts: https://otro.com, //otro.com, /\\otro.com, javascript: y no-strings van al inicio; ruta interna abre ventana; con pestaña abierta la enfoca y navega (16 tests)
- Validation: ng build copia push-sw.js a la raíz de dist; eslint y typecheck limpios; vitest api 1045 y web 255 en verde
- Files changed: `apps/api/test/push-sender.test.ts`, `apps/web/public/push-sw.js`, `apps/web/src/app/notifications/push-sw.spec.ts`
- Notes: El bypass /\\host se confirmó con new URL('/\\otro.com', origin) = https://otro.com/. Se agregó una función auxiliar en el SW (sin bundler).

**Verdict**: pass

---
### P4 — ventas: merge-dev con versión (R19)

> Que el merge-dev de ventas suba ProjectVersion de be-ventas según los commits, entregado como Kyro Work en ventas con PR.

#### T4.1: Kyro Work en ventas: versión en merge-dev, push y PR

**Status**: done

**Description**: En el repo ventas (/home/ubuntu/proyectos/ventas), con kyro-work y en una rama propia (nunca sobre la rama base): sumar a .claude/skills/merge-dev/SKILL.md el paso de versión para be-ventas y un script determinista (scripts/version-bump.sh, bash, set -euo pipefail, LF) que, después de traer origin/dev, parte de ProjectVersion de origin/dev en be-ventas/pkg/consts/config.go y calcula major (algún commit con '!' o BREAKING CHANGE), minor (algún feat) o patch (el resto) con los commits de origin/dev..rama; el commit es chore(version) solo en be-ventas. Si el merge no incluye be-ventas no se toca nada. Un test (scripts/version-bump.test.sh) arma repos temporales y cubre los tres casos de S20 más el breaking. Commitear, pushear la rama (nunca --force) y abrir la PR hacia la rama base del repo raíz con gh pr create. No correr merge-dev de verdad ni tocar dev de be-ventas.

**Evidence**:
- Summary: Work version-merge-dev hecho con kyro-work en ventas (rama feature/version-merge-dev, W1 y W2 con review pass de un checker distinto, Work cerrado completed): scripts/version-bump.sh, su test (S20) y el paso en la skill merge-dev. Rama pusheada sin --force. PR: https://github.com/Maiki02/NovaGent/pull/1 (hacia main). main y dev de ventas y dev de be-ventas sin cambios (mismos hashes antes y después)
- Validation: bash scripts/version-bump.test.sh: 22 chequeos OK — feat sube minor, solo fix/docs sube patch, merge sin be-ventas no toca la versión, ! y BREAKING CHANGE suben major, base en origin/dev, idempotente
- Validation: SKILL.md describe el paso después de traer origin/dev y antes de la PR de be-ventas, y el commit chore(version) solo en be-ventas (diff revisado)
- Validation: git rev-parse: main de ventas (e603710), origin/main y dev de be-ventas (cb3b5ca) iguales a antes; be-ventas sigue en 1.13.0
- Validation: docs/plan.md registra la PR como entrega de R19
- Files changed: `../ventas/scripts/version-bump.sh`, `../ventas/scripts/version-bump.test.sh`, `../ventas/.claude/skills/merge-dev/SKILL.md`, `../ventas/.agents/kyro/work/version-merge-dev/`, `docs/plan.md`
- Notes: La rama de ventas se llama feature/version-merge-dev (convención feature/<scope> de la raíz). No se corrió merge-dev real. La PR queda para que la revise y mergee el usuario.

**Verdict**: pass

---
### P5 — Corrida real, docs y verificación

> Comprobar con el servicio en producción que el piloto llega solo a la PR en un repo de prueba, dejar los docs al día y los gates en verde.

#### T5.1: Corrida real del piloto en test-panel: guía y deuda (diferida por el usuario)

**Status**: done

**Description**: La corrida real con el servicio queda diferida por decisión del usuario (06/10/2026). Esta tarea deja lista la prueba y registra lo no probado: sumar a docs/panel-desarrollo.md la guía paso a paso de la corrida real en test-panel (Scope chico con piloto, pregunta material con botón, reinicio del servicio a mitad de la ejecución, avisos push en PC y Android, suscripción vencida con Probar, qué mirar en la base y en el Timeline) y registrar con kyro debt cada verificación que no se hizo. No mergear nunca la PR de prueba. Nada de lo no probado se marca como probado.

**Evidence**:
- Summary: Definición de T5.1 cambiada con plan --update-active por decisión del usuario (06/10/2026): la corrida real queda diferida. Se dejó la guía paso a paso en docs/panel-desarrollo.md y la deuda explícita: debt-1 y debt-10 diferidas al sprint 7 con nota de que no se probó, y debt-12 a debt-15 nuevas (corrida real hasta pr_lista, R15 con el servicio, cero permission_denied en el primer turno, avisos push en PC y Android). NO se probó nada de la corrida real: la base solo tiene los chats del sprint 5 y el servicio se reinició a las 00:52 UTC sin ninguna corrida posterior
- Validation: docs/panel-desarrollo.md: sección 'Corrida real del piloto en test-panel (pendiente)' con 9 pasos, la regla de no mergear y la aclaración de que nada está probado
- Validation: kyro debt: debt-1 y debt-10 deferidas con nota; debt-12, 13, 14 y 15 abiertas con nota de no probado
- Validation: systemctl is-active agents-panel = active y /api/health 200 con el build actual
- Files changed: `docs/panel-desarrollo.md`
- Notes: Verificado por consulta a la base (solo lectura) y a GitHub: sin corrida nueva. El usuario dijo 'todo dio OK' y la base no lo respalda; se registró como no probado. Los criterios originales (pr_lista, retoma, botón, push, suscripción vencida) NO se cumplieron: quedan en las deudas.

**Verdict**: pass

---
#### T5.2: Docs del sprint 6 y cobertura de decisiones

**Status**: done

**Description**: docs/plan.md: resumen del sprint 6 (servicio y build, rm validado, prompt del Work, versión de ventas con su PR, corrida real) y etapa 6 actualizada (systemd hecho; backup de SQLite, topes configurables y limpieza siguen pendientes). docs/panel-desarrollo.md: cómo se corre ahora (servicio) y cómo desarrollar sin chocar con él (lock de instancia única). docs/estados.md si algún estado cambió. CLAUDE.md: la línea de Seguridad del panel que dice que Funnel publica ng serve pasa a describir el servicio. Revisar que cada decisión D1–D31 esté reflejada en algún doc (S27).

**Evidence**:
- Summary: Docs del sprint 6: plan.md (resumen del sprint 6, etapa 6 con systemd y Funnel hechos y pendientes backup/topes/limpieza, siguiente scope operaciones-worktree), panel-desarrollo.md (cómo se corre con el servicio, desarrollar sin chocar con el candado), vm-setup.md (Funnel al 3000, ng serve solo como desarrollo) y CLAUDE.md (excepción de commit/push del piloto, D8/D17, y Funnel publica el servicio). docs/estados.md sin cambios: este sprint no agregó ni cambió ningún estado
- Validation: npx prettier --check docs CLAUDE.md: All matched files use Prettier code style
- Validation: grep 'ng serve': CLAUDE.md:88 lo cita solo como modo de desarrollo; en vm-setup.md las menciones restantes son históricas (pasos 10/15) o del modo desarrollo; ninguna dice que Funnel publica ng serve hoy
- Validation: Cobertura D1-D31: D1 plan.md (orquestador, sprint 3); D2 estados.md y plan.md (nextAction); D3 plan.md (sesión SDK nueva); D4 plan.md (política v2/v3/v4); D5 plan.md (QA siempre); D6 y D7 plan.md (deuda y fin del scope); D8 y D17 CLAUDE.md (excepción del piloto, nueva) y plan.md; D9 plan.md y panel-desarrollo.md (preguntas); D10 vm-setup.md, plan.md, CLAUDE.md (Web Push); D11 plan.md y panel-desarrollo.md (modelos por rol); D12 plan.md y panel-desarrollo.md (Idea); D13 plan.md (merge-dev y genérico); D14 plan.md (versión de ventas, PR #1); D15 y D21 estados.md ('Tres niveles') y plan.md; D16 plan.md y estados.md (retoma); D23 identidad-visual.md (anatomía, actor); D29 plan.md (kyro-sprint-executor no se usa); D30 plan.md (permisos por proyecto); D18, D19, D20, D22, D24, D25, D26, D27, D28 y D31 pertenecen al scope siguiente operaciones-worktree: plan.md lo declara (nueva línea) y están descritas en .agents/kyro/plan/2026-10-04-autopiloto-kyro.md, no implementadas acá
- Files changed: `docs/plan.md`, `docs/panel-desarrollo.md`, `docs/vm-setup.md`, `CLAUDE.md`
- Notes: Se cambió una regla de CLAUDE.md (commits y push) porque D8 lo exigía en este scope y la memoria del usuario ya permite pushear la rama del worktree. El 'docs/estados.md si algún estado cambió' no aplicó. No se anotó el merge desde el panel, descartado por el usuario.

**Verdict**: pass

---
#### T5.3: Verificación automática del sprint

**Status**: done

**Description**: Correr npm run typecheck, lint, format:check, test y build. Greps: ningún bypassPermissions ni allowDangerouslySkipPermissions en apps/api/src; public: true solo /api/health y los dos pasos del login; colores solo de tokens en apps/web; .env.example sin valores reales; /tmp sin carpetas panel-* tras los tests. kyro analyze --kyro-scope autopiloto-kyro sin CRITICAL ni HIGH y kyro doctor --artifacts limpio.

**Evidence**:
- Summary: Verificación automática del sprint 6 en verde. Se corrigió formato (prettier --write) en 11 archivos del sprint que fallaban format:check, y la trazabilidad de E1 (analyze marcaba MEDIUM A001): escenario S48 sobre R6 enlazado con plan --update-active y E1 re-evidenciada
- Validation: npm run typecheck sin errores (shared, api, web)
- Validation: npx eslint . sin hallazgos y npm run format:check: All matched files use Prettier code style
- Validation: npm test: apps/api 59 archivos y 1045 tests, apps/web 27 archivos y 255 tests, todo en verde
- Validation: npm run build: Application bundle generation complete; dist de api con web-static e instance-lock
- Validation: Greps: sin bypassPermissions ni allowDangerouslySkipPermissions en apps/api/src; public: true solo en /api/health y los dos pasos del login (auth/routes.ts:47 y :88, app.ts:144); sin colores fuera de tokens en apps/web (solo el meta theme-color de index.html, que el navegador exige en hex); apps/api/.env.example solo con valores falsos; 0 carpetas /tmp/panel-* tras los tests
- Validation: kyro analyze --kyro-scope autopiloto-kyro: no semantic issues found (CRITICAL=0 HIGH=0 MEDIUM=0); kyro doctor --artifacts sin FAIL ni ERROR
- Files changed: 
- Notes: Los tests de este sprint reportan 1045 (api) y 255 (web).

**Verdict**: pass

---

## Unfinished work

_None — every task is done with a passing verdict._

## Learnings

- El QA encontró un riesgo real de confiabilidad en una pieza recién hecha (el lock por pid tras un reinicio sucio): auditar con el escenario de fallo en mente, no solo con el camino feliz.
- El usuario dio por probada una corrida que la base y GitHub no mostraban; verificar en la fuente antes de registrar algo como probado evitó una evidencia falsa.
- Un test que cargaba el service worker real encontró un bypass (/\\host) que la revisión de código no vio.
- Cambiar la definición de una tarea (plan --update-active) fue la vía correcta para diferir la corrida real sin falsear criterios.

## Resolved Debt

- **debt-2**: La base de Bash todavía alcanza los denegados fijos: npm exec -c, git -c core.sshCommand / alias !, go run y python ejecutan cualquier comando; cerrar esos caminos (o un deny por argumento) antes de que el piloto corra solo (R9, R10)
- **debt-3**: WorktreeStateTracker.turnStarted: al retomar tras interrumpido puede volver a esperando_respuesta aunque la pregunta ya se canceló (la etiqueta se corrige al terminar el turno)
- **debt-4**: Los tests de apps/api dejan carpetas panel-* en /tmp (mkdtemp sin limpieza): agotaron los inodos de la VM el 05/10/2026. Limpiar lo creado en afterEach o usar un TMPDIR propio por corrida
- **debt-5**: El Bash del piloto no tiene rm: habilitar un rm con ruta validada dentro del worktree (como los comandos de lectura). Mientras tanto la política manda git rm y git clean
- **debt-6**: Verificar el veredicto de kyro-qa (APPROVED / APPROVED WITH NOTES) además de que la sesión de cierre invocó la skill
- **debt-7**: AlreadyRunningError si el usuario manda un mensaje entre waitForIdle y start: el piloto debe reintentar en vez de frenar con otro
- **debt-8**: Reinicio con una pregunta pendiente: la pregunta se cancela sin evento y la web sigue mostrando la tarjeta respondible (la respuesta falla sin explicar); además el piloto se reanuda y frena con 'El worktree no tiene Works de Kyro' si el agente todavía no había creado el Work, en vez de reabrir el paso de plan. Hallado en la prueba de T4.2 (05/10/2026).
- **debt-9**: Hacer que el reinicio por cambios de código no corte pruebas largas: la API corre con tsx watch en desarrollo y cualquier edición en apps/api reinicia la sesión en curso (documentar o usar node sin watch durante pruebas del piloto).
- **debt-11**: QA sprint 5, menores: cachear o leer del sistema de archivos el ref de chore/kyro-init (hoy 2 execFileSync por lectura de proyecto sin Kyro); respaldo de question_cancelled recorre eventos en cada arranque; sin tope de suscripciones push por usuario; sender.ts y push-sw.js sin test; mensaje de la acción on con piloto finished; E1/E2 sin scenario_refs y S20 sin tarea.

## Recommendations for Sprint 7

- Hacer la corrida real en test-panel con el servicio (guía en docs/panel-desarrollo.md) apenas el usuario pueda y resolver debt-1, debt-10 y debt-12 a debt-15.
- Reiniciar el servicio (10-panel-service.sh --restart) para que tome el lock con boot_id y la política v4.
- Planificar el scope operaciones-worktree (D18 a D28, D31) con el piloto como primera prueba real.
- Pendientes de la etapa 6: backup de SQLite, topes configurables y limpieza automática.
