---
docType: plan
date: 2026-10-05
slug: capacidad-y-tiempos
title: Capacidad de la VM y tiempos de cada trabajo
maturedFrom: mature
agents: []
---

# Capacidad de la VM y tiempos de cada trabajo

## Core thesis

El panel lanza trabajo en paralelo sobre una VM con disco y RAM fijos (cupo gratis), pero no muestra cuánto ocupa cada proyecto, cuánto queda libre ni cuánto trabajó la máquina en cada scope o work. Por eso el usuario decide a ciegas si abrir otro trabajo, qué limpiar y cuánto le cuesta cada pedido. Mostrar el disco y la RAM en la página Proyectos y la fecha de creación y el tiempo de ejecución neto en cada tarjeta de chat convierte esas decisiones en lecturas directas, sin entrar por SSH.

## Problem / Motivation

- **Disco:** hoy la única medición es el espacio libre al clonar (`statfs` contra `minFreeDiskGb`). No hay forma de ver desde la web qué proyecto ocupa más, ni cuánto pesan sus worktrees (cada uno con su `node_modules`, estimado en 2–5 GB en `docs/plan.md`). Pasarse de los 200 GB del cupo se cobra (cuenta Pay As You Go).
- **RAM:** el cupo es de 12 GB más 8 GB de swap y los builds compiten por ella (Angular, aprox. 3–4 GB). Antes de abrir otra sesión el usuario no sabe si le alcanza.
- **Tiempo:** un trabajo con piloto automático puede durar horas, con pausas en las que espera al usuario. Sin un tiempo neto no se puede comparar el costo real de un scope contra otro ni detectar uno que se colgó trabajando.
- **Por qué ahora:** el piloto (scope `autopiloto-kyro`) ya corre trabajos solos de punta a punta y en paralelo (hasta 4 sesiones). Cuanto más corre sin supervisión, más hace falta medir.

## Current-state evidence

| Hecho | Fuente | Confianza |
|---|---|---|
| Cada chat de scope, work o idea es un worktree en `~/wt/<proyecto>/<slug>`, creado con `git worktree add` desde el repositorio en `~/proyectos/<proyecto>` | `apps/api/src/worktrees/create.ts:106-145`, `apps/api/src/config.ts:116-125` | Alta |
| Los directorios son configurables: `PANEL_WORKTREES_DIR` (defecto `~/wt`) y `PANEL_PROJECTS_DIR` (defecto `~/proyectos`) | `apps/api/src/config.ts`, `apps/api/.env.example` | Alta |
| El único dato de disco que existe es el espacio libre (`diskFreeBytes` con `statfs`) al dar de alta un proyecto | `apps/api/src/projects/service.ts:68-71, 366-368` | Alta |
| `Chat` ya trae `createdAt` y `updatedAt` | `packages/shared/src/index.ts:174-191` | Alta |
| `agent_sessions` guarda `started_at` y `ended_at` de cada sesión de IA; al arrancar el panel cierra todas las que quedaron abiertas | `apps/api/src/db/migrations.ts` (`agent_sessions`), `apps/api/src/chats/sessions-repo.ts:87` | Alta |
| La sesión sigue abierta mientras la IA espera una respuesta a `AskUserQuestion` (sin timeout) | `docs/plan.md` (preguntas del agente desde la web) | Alta |
| `pending_questions` guarda `created_at` y `answered_at` de cada pregunta | `apps/api/src/db/migrations.ts:190-209` | Alta |
| Los pasos del panel sin IA (setup, `kyro analyze`, `git pull`, `validate_command`, escaneo de secretos, push, PR) no guardan inicio ni fin. Algunos dejan un evento suelto (`git_push`) | `apps/api/src/pilot/autopilot.ts`, `apps/api/src/pilot/merge-phase.ts`, `apps/api/src/worktrees/validate.ts` | Alta |
| La cola (`en_cola`), el cupo de uso (`sin_cupo_de_uso`) y las aprobaciones del usuario ocurren entre sesiones | `docs/plan.md` (sprint 3 y sprint 4), `docs/estados.md` | Alta |
| Las tarjetas de chat son los ítems de la barra lateral de cada proyecto: título, tipo y rama, insignia de estado, recarga cada 4 s | `apps/web/src/app/chats/chat-sidebar.ts`, `apps/web/src/app/chats/status.ts` | Alta |
| La página Proyectos lista tarjetas de proyecto y recarga cada 3 s | `apps/web/src/app/projects/projects.page.ts` | Alta |
| Medición del 05/10/2026: `ventas` 1,2 GB, `agents-panel` 626 MB, `test-panel` 252 KB, `~/wt` 68 KB; disco 18 GB usados de 193 GB; RAM 9,7 GB disponibles de 11 GB; swap 8 GB | `du -sh`, `df -h /`, `free -h` en `vm-ia` | Alta (instantánea) |
| Un `du` recursivo sobre worktrees con `node_modules` tarda segundos o más | Hipótesis por tamaño estimado; validar en la VM | Media |

## Who it's for

- **Usuario del panel (operador único hoy):** decide si abre otro trabajo, qué proyecto o worktree limpiar y cuánto le llevó la máquina cada pedido.
- **Secundario, la regla de costos del repo:** el uso de disco visible ayuda a no pasarse del cupo gratis de 200 GB.

Decisiones que tiene que poder tomar mirando la web:
1. ¿Me alcanza el disco y la RAM para otro trabajo?
2. ¿Qué proyecto o qué worktrees ocupan más?
3. ¿Cuándo empezó este trabajo y cuánto trabajó la máquina en él?

## What success looks like

- La página Proyectos muestra arriba una barra de **disco** con los tramos Proyectos, Worktrees, Otros y Libre, cuyos valores suman el total del disco ±1 %.
- Debajo hay una barra de **RAM** con los tramos «Sesiones de IA y builds», «Panel», «Otros» y «Disponible», más el swap usado sobre el total.
- Cada tarjeta de proyecto muestra «Repositorio X GB · Worktrees Y GB». La suma de los «Repositorio» da el tramo Proyectos (±1 %, más carpetas sueltas que no son proyectos registrados, que van a Otros dentro del tramo). La suma de los «Worktrees» da el tramo Worktrees.
- Cada tarjeta de chat muestra la fecha de creación y el **tiempo de ejecución**: sesiones de IA más pasos del panel, menos las esperas de preguntas.
- **Cómo se detecta un éxito falso:**
  - Un chat que esperó 1 hora una respuesta y trabajó 5 minutos muestra unos 5 minutos, no 65.
  - Un tamaño que todavía no se midió muestra «Midiendo…», nunca 0.
  - Un fallo de medición muestra «sin dato», no el último valor como si fuera actual. El último valor queda con su hora de medición visible.

## Product laws / invariants

| Regla | Falla que previene |
|---|---|
| L1. El tiempo de ejecución nunca incluye esperas por el usuario: preguntas abiertas, cola, cupo de uso ni aprobaciones de plan, deuda o PR | Inflar el costo de un trabajo por el tiempo de respuesta del usuario |
| L2. Una medición ausente o fallida se muestra como «Midiendo…» o «sin dato», nunca como 0 | Creer que hay espacio libre o que no trabajó nada |
| L3. Cada valor de disco muestra cuándo se midió | Decidir con un dato viejo sin saberlo |
| L4. Medir es solo lectura: no borra, no mueve, no cambia la VM, no instala paquetes | Romper la regla de oro de la VM y la regla de costos |
| L5. Las rutas nuevas exigen sesión (y CSRF si mutan, como «Recalcular») | Exponer la estructura de la VM por la URL pública de Funnel |
| L6. Medir el disco nunca bloquea una consulta de la API | Página Proyectos lenta o colgada mientras corre `du` |
| L7. Un intervalo abierto (sesión o paso en curso, pregunta sin responder) se cuenta hasta «ahora», y un reinicio del panel lo cierra con la hora del reinicio | Tiempos que crecen para siempre tras un corte |
| L8. Los tamaños se calculan sin seguir symlinks y sin contar dos veces un mismo archivo | Totales que superan el disco real |

## Observable success and failure guarantees

| Situación | Comportamiento |
|---|---|
| Éxito | Barras y tarjetas con valores y hora de medición del disco |
| Primer arranque, sin medición todavía | «Midiendo…» en la barra de disco y en las tarjetas. La RAM aparece de inmediato |
| Proyecto sin worktrees | «Worktrees 0 B» (medido, no ausente) |
| Carpeta del proyecto borrada a mano o ilegible | «Repositorio sin dato» en esa tarjeta, el resto sigue andando |
| `du` o `/proc` fallan | El tramo afectado queda «sin dato» y el error va al log. La página no se rompe |
| Chat creado antes de esta función (sin pasos del panel medidos) | Tiempo con prefijo «≈» y una ayuda que dice que solo cuenta las sesiones de IA |
| Chat trabajando | El tiempo avanza en cada recarga (4 s) |
| Chat esperando una pregunta | El tiempo queda quieto |
| Pedido directo | Mismo cálculo: sesiones más pasos del panel (setup) menos preguntas |
| «Recalcular» mientras ya hay una medición en curso | No arranca otra. Responde que está midiendo |

## Outcome-based scope

### In

1. Medición de disco por proyecto (repositorio y worktrees por separado) y del disco total (Proyectos, Worktrees, Otros, Libre), en segundo plano y guardada.
2. Medición de RAM por función («Sesiones de IA y builds», «Panel», «Otros», «Disponible») y del swap, en cada consulta.
3. Barras de disco y RAM en la página Proyectos y el dato por proyecto en cada tarjeta, con la leyenda «Repositorio X GB · Worktrees Y GB».
4. Registro de inicio y fin de cada paso del panel sin IA.
5. Tiempo de ejecución neto y fecha de creación en cada tarjeta de chat.
6. Actualización de `docs/plan.md` (capacidad de la VM y funcionalidades del panel).

### Explicitly out

- Alertas o avisos push por disco o RAM llenos: primero hay que ver los datos reales. Queda como seguimiento.
- Historial y gráficos de uso en el tiempo: no responden ninguna de las tres decisiones.
- CPU: no se pidió, y su lectura instantánea es ruidosa.
- Limpieza de worktrees mergeados: ya está planificada aparte (`docs/plan.md`, «Limpieza al mergear»).
- Costo en dinero o tokens por trabajo: el pedido es de tiempo.
- RAM por proyecto: se descartó (decisión D3).

## Closed decisions with rationale

| # | Decisión | Motivo / evidencia | Costo de la alternativa descartada | Consecuencia |
|---|---|---|---|---|
| D1 | Tiempo de ejecución = sesiones de IA + pasos del panel − esperas de preguntas (opción B del usuario) | El usuario quiere el trabajo de la máquina, no solo el de la IA. Las sesiones quedan abiertas mientras se espera una respuesta (evidencia) | La opción A (solo IA) escondía builds de hasta 15 min. La C (dos números) sumaba ruido a la tarjeta | Hay que medir los pasos del panel, que hoy no tienen inicio ni fin |
| D2 | Por proyecto se muestran «Repositorio» y «Worktrees» por separado (opción C), con esa leyenda y nunca «clon» | El usuario dijo que «clon» es confuso. Separado se ve qué parte se libera al limpiar worktrees | Un solo número escondía el peso de los worktrees | Dos mediciones por proyecto |
| D3 | RAM por función: «Sesiones de IA y builds» (procesos cuyo `cwd` está bajo el directorio de worktrees), «Panel» (el proceso de la API y sus hijos que no están en worktrees, más el servidor web del panel), «Otros» y «Disponible», más el swap (opción B) | La RAM es de procesos, no de carpetas. El panel corre en `~/proyectos/agents-panel` y aparecería como «proyecto» | La A mezclaba el panel con los proyectos. La C no decía qué consume | Sin RAM en las tarjetas de proyecto |
| D4 | El disco se mide en segundo plano y se guarda: cada 10 minutos, al crear o borrar un worktree o un proyecto, y con «Recalcular» | Un `du` sobre `node_modules` es lento y la página recarga cada 3 s | Medir en cada consulta trababa la API | Los datos pueden tener hasta 10 minutos. Por eso se muestra la hora (L3) |
| D5 | La RAM se lee en cada consulta (`/proc/meminfo` y `/proc/<pid>/{cwd,status}`) | Es barato y cambia rápido | — | Sin caché de RAM |
| D6 | «Otros» del disco = usado total (`statfs`) − Proyectos − Worktrees | El tramo cierra la suma sin medir todo el disco | Medir el disco entero sería lento | Si las mediciones son viejas, «Otros» absorbe la diferencia. La hora visible lo explica |
| D7 | Los chats viejos muestran el tiempo con «≈» (solo sesiones de IA) | No hay datos de los pasos del panel antes de esta función. Reconstruirlos desde eventos sueltos sería inventar | Ocultar el tiempo perdía un dato real | Mostrar un dato honesto antes que uno completo |
| D8 | Vehículo de ejecución: un Kyro Work nuevo, independiente del sprint 6 de `autopiloto-kyro` | `CLAUDE.md`: Work para cambios acotados. No comparte código pendiente con ese sprint | Meterlo en el scope activo lo alargaba sin relación | Se crea sin activarlo (pedido del usuario) |

## Constraints and tradeoffs

- **Plataforma:** Linux ARM (Ubuntu). `/proc` y `du` (coreutils) están disponibles. No se instala nada (L4). Si se instalara, aplicaría la regla de oro de la VM.
- **Costo:** US$0. Solo lectura.
- **Ejecución:** `du` por `execFile` sin shell, con rutas internas del panel (nunca entrada del usuario) y con timeout. Se puede elegir hacerlo en Node puro si resulta más simple de probar.
- **Rendimiento:** solo una medición de disco a la vez. La corre el panel, no el agente, así que la lista de comandos del agente no aplica. Bajarle la prioridad (`nice`) es opcional.
- **Seguridad:** las rutas nuevas van detrás de sesión. No se exponen rutas absolutas de la VM a la web, solo nombres de proyecto y números.
- **Stack:** TypeScript `strict`, Fastify, SQLite con migración nueva si hace falta guardar los pasos y las mediciones, Angular standalone con signals, tipos en `packages/shared`.

## Risks, failure modes and degradation

| Riesgo | Disparador | Impacto | Contención | Señal |
|---|---|---|---|---|
| `du` lento o pesado | Muchos worktrees con `node_modules` | CPU en uso durante builds | En segundo plano, una medición a la vez, intervalo de 10 min, timeout | Duración de la medición en el log |
| Pasos del panel sin medir | Un paso nuevo del piloto que no se instrumenta | Tiempo subestimado | Una única función envoltorio para medir pasos, y un test que recorre los pasos del merge | Un test que falla si un paso no deja inicio y fin |
| Intervalos superpuestos | Un paso del panel corre mientras hay una sesión abierta | Tiempo contado dos veces | El cálculo une los intervalos (unión) antes de restar las preguntas | Test con intervalos superpuestos |
| Pregunta fuera de toda sesión | Datos inconsistentes | Tiempo negativo | Solo se resta la intersección con los intervalos de trabajo, con un piso de 0 | Test |
| `cwd` de un proceso ilegible | Procesos de otro usuario | RAM mal atribuida | Se cuenta en «Otros» | — |
| Hardlinks o symlinks | Caché de npm, enlaces | Totales inflados | Sin seguir symlinks, y `du` cuenta cada inodo una vez por llamada | Totales ≤ usado del disco |

## Execution blueprint

1. **W1. Tiempos: registro de pasos del panel (API).**
   - **Objetivo:** cada paso sin IA guarda inicio y fin por chat.
   - **Entradas:** `createWorktree` (setup), el bucle del piloto (`kyro analyze`, push) y la fase de merge (pull, `validate_command`, escaneo de secretos, `merge-dev` o merge genérico, PR).
   - **Entregable:** tabla o registro de pasos con `chat_id`, tipo de paso, inicio y fin, y su cierre al reiniciar el panel (L7).
   - **Gate:** tests de API que verifican que cada paso deja su intervalo.
2. **W2. Tiempos: cálculo del tiempo neto (API y shared).** Depende de W1.
   - **Objetivo:** unión de intervalos (sesiones y pasos) menos la intersección con las esperas de preguntas, con los abiertos contados hasta «ahora».
   - **Entregable:** una función pura con tests, más el campo en `Chat` (por ejemplo, el tiempo en ms y la marca «aproximado») que devuelve el listado de chats.
   - **Gate:** tests de la función pura con superposición, pregunta abierta, sesión abierta, chat viejo y pregunta fuera de sesión.
3. **W3. Tiempos: tarjeta de chat (web).** Depende de W2.
   - **Objetivo:** fecha de creación (formato local corto) y tiempo de ejecución (`1 h 12 min`, `≈` si es aproximado) en cada ítem de la barra lateral.
   - **Gate:** specs de formato y del caso aproximado.
4. **W4. Disco (API).** Independiente de W1 a W3.
   - **Objetivo:** medición en segundo plano por proyecto (repositorio y worktrees) y totales del disco, guardada con su hora. Ruta de lectura con sesión y acción «Recalcular» con sesión y CSRF.
   - **Gate:** tests con un medidor inyectable (sin `du` real), «sin dato» ante un error y que no corran dos mediciones a la vez.
5. **W5. RAM (API).** Independiente.
   - **Objetivo:** lectura de `/proc` con la atribución de D3.
   - **Gate:** tests con un `/proc` simulado (fixtures).
6. **W6. Página Proyectos (web).** Depende de W4 y W5.
   - **Objetivo:** barras de disco y RAM con leyenda y valores, «Repositorio X GB · Worktrees Y GB» en cada tarjeta, la hora de medición y «Recalcular».
   - **Gate:** specs de la lógica de las barras (porcentajes, estados vacío y sin dato).
7. **W7. Docs y verificación en la VM.**
   - **Objetivo:** actualizar `docs/plan.md` y comparar los valores de la web con `du -sh`, `df` y `free` en `vm-ia`.
   - **Gate:** diferencia ≤1 % en disco y coherencia de la RAM con `free`.

Orden sugerido: W4 → W5 → W6 (lo visible y sin dependencias), después W1 → W2 → W3, y al final W7.

## Acceptance and validation matrix

| Resultado o regla | Escenario | Evidencia | Método |
|---|---|---|---|
| Barra de disco | Proyectos + Worktrees + Otros + Libre = total | Valores de la web contra `df` | Test de la lógica y prueba en la VM |
| Por proyecto | `ventas` muestra «Repositorio ~1,2 GB · Worktrees …» | Contra `du -sh` | Prueba en la VM (W7) |
| Barra de RAM | Con una sesión corriendo, «Sesiones de IA y builds» > 0 | Contra `ps` | Fixtures y prueba en la VM |
| L1 | Pregunta abierta 1 h dentro de una sesión de 65 min → unos 5 min | Resultado de la función pura | Test unitario |
| D1 | `validate_command` de 3 min suma 3 min | Intervalo del paso | Test de API |
| L2 | Sin medición → «Midiendo…»; error → «sin dato» | Render | Spec web |
| L3 | Hora de medición visible | Render | Spec web |
| L5 | Ruta de capacidad sin sesión → 401; «Recalcular» sin CSRF → 403 | Respuesta HTTP | Test de API |
| L6 | La consulta responde aunque haya una medición en curso | Tiempo de respuesta | Test con un medidor lento simulado |
| L7 | Reinicio con un paso abierto → se cierra con la hora del reinicio | Fila cerrada | Test de API |
| L8 | Symlink a una carpeta grande → no suma | Total | Test con un medidor real sobre una carpeta temporal |
| D7 | Chat viejo → «≈» | Render | Spec web |

## Forge handoff

- **Objetivo del work:** mostrar en la web la capacidad de la VM (disco por proyecto y total, y RAM por función) y la fecha de creación y el tiempo de ejecución neto de cada trabajo.
- **Requisitos candidatos:**
  - R1. Disco por proyecto, repositorio y worktrees por separado.
  - R2. Barra de disco Proyectos, Worktrees, Otros y Libre.
  - R3. Barra de RAM por función, más el swap.
  - R4. Registro de los pasos del panel.
  - R5. Tiempo neto por chat.
  - R6. Fecha y tiempo en la tarjeta de chat.
  - R7. Rutas con sesión y CSRF.
  - R8. Docs.
- **Fuera de alcance:** alertas, historial, CPU, limpieza de worktrees, costo en dinero o tokens, RAM por proyecto.
- **Dependencias:** ninguna externa. No toca la VM ni los costos.
- **Restricciones de orden:** W1 antes de W2 antes de W3. W4 y W5 antes de W6. W7 al final.
- **Seguimiento no bloqueante:** alertas por umbral de disco o RAM con Web Push, una vez vistos los datos reales.

## Quality gate

| Criterio | Puntos |
|---|---:|
| Tesis y causa | 14/15 |
| Evidencia | 14/15 |
| Claridad | 14/15 |
| Resultados observables | 14/15 |
| Reglas y fallas | 9/10 |
| Decisiones | 10/10 |
| Alcance | 9/10 |
| Entrega | 8/10 |
| **Total** | **92/100** |

- **Evidencia revisada:** `apps/api/src/worktrees/create.ts`, `apps/api/src/config.ts`, `apps/api/src/projects/service.ts`, `apps/api/src/db/migrations.ts`, `apps/api/src/chats/sessions-repo.ts`, `apps/api/src/pilot/autopilot.ts`, `packages/shared/src/index.ts`, `apps/web/src/app/chats/chat-sidebar.ts`, `apps/web/src/app/projects/projects.page.ts`, `docs/plan.md`, y mediciones `du`, `df` y `free` en `vm-ia` del 05/10/2026.
- No quedan contradicciones materiales. Las decisiones D1 a D3 las tomó el usuario. D4 a D8 son defaults técnicos con su motivo.
