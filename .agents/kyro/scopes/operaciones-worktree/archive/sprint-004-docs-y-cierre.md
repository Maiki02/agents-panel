---
title: 'operaciones-worktree — Sprint 4: Documentación y cierre (WS10)'
date: '2026-10-07'
scope: 'operaciones-worktree'
sprint: 4
slug: 'docs-y-cierre'
outcome: 'shipped'
type: 'sprint-archive'
---

# Sprint 4: Documentación y cierre (WS10)

> Closed: 2026-10-07
> Outcome: shipped

## Objective

Que docs/plan.md, docs/estados.md, docs/panel-desarrollo.md y CLAUDE.md reflejen las decisiones D18 a D28 tal como quedaron implementadas (repos del proyecto, operaciones manuales con el servicio único, Crear PR, ver cambios, descartar y borrar, indicador de uso por cuenta y web de operaciones), con una matriz de verificación que lo pruebe y el scope listo para cerrarse.

## Definition of Done

- Todas las tareas en done con evidencia y review pass.
- Cada decisión D18 a D28 y cada requisito R1 a R9 está descrito en un doc, verificado con la matriz de T2.1.
- npm run build, typecheck, lint, test y format:check pasan en la raíz.
- kyro analyze del scope sin hallazgos abiertos de R9.
- Ningún doc tiene secretos y docs/vm-setup.md no cambia (Costos US$0).

## Phases

### P1 — Documentación del scope

> Llevar a los docs lo que los sprints 1 a 3 implementaron y todavía no está escrito, y corregir lo que quedó viejo (R9).

#### T1.1: docs/plan.md: uso de proveedores, web de operaciones y estado del scope

**Status**: done

**Description**: Completar docs/plan.md con lo que falta del scope: (1) una sección o subsección del indicador de uso (D24): tabla provider_usage (migración 21) con la última observación por cuenta, proveedor y ventana; fuentes pasiva (rate_limit_event de cualquier sesión, guardado con el account_id de la sesión, ADR-0002) y a pedido (sesión corta del SDK sin prompt, caché 60 s, una lectura en vuelo por cuenta, timeout); degradado al dato guardado con degraded true y su antigüedad, nunca 500 (ADR-0015); GET /api/usage con sesión y sin CSRF (?refresh=1); tono ok/warn/danger con los umbrales 70 % y 90 % o rejected compartido por API y web (usageTone); el piloto retoma sin_cupo_de_uso a resetsAt + 60 s y, sin resetsAt futuro, a los 15 min (ADR-0016). (2) La web de operaciones: sin sección Worktrees, filtros Activos · Te toca · Terminados · Todos de la sidebar Chats con el mapeo por who (D18, ADR-0013), pestaña Git con tarjeta por repo y todos los botones leídos de PARITY_CATALOG deshabilitados con motivo (D19, D26), y Configuración → Repositorio con repos, base editable, Detectar repos y pull con resultado por fila también cuando la raíz falla (D20, ADR-0014, ADR-0017); criterios de UI de D23 con referencia a docs/identidad-visual.md. (3) En Etapas/Pendientes: resumen de los sprints 2 y 3 del scope si falta (como el del sprint 1 en la misma lista), cambiar la entrada «Siguiente scope: operaciones-worktree» para que diga que quedó implementado, y marcar qué parte de la etapa 6 cubrió este scope (si alguna) sin dar por hechas las que no (backup de SQLite, topes configurables, limpieza de worktrees mergeados).

**Evidence**:
- Summary: docs/plan.md describe el indicador de uso (provider_usage, fuentes, caché 60 s, degradado, GET /api/usage, tono 70/90, retomada por resetsAt), los filtros, la pestaña Git y Repositorio, y suma los resúmenes de los sprints 2 y 3, el scope marcado como implementado y la etapa 6 sin darla por hecha.
- Validation: npm run format:check pasa
- Validation: datos verificados contra apps/api/src/usage, packages/shared/src/usage.ts, migración 21, autopilot.ts y apps/web chat-filter-logic, git-logic, repos-logic
- Files changed: `docs/plan.md`

**Verdict**: pass

---
#### T1.2: docs/estados.md: retomada por resetsAt y filtros por quién actúa

**Status**: done

**Description**: Actualizar docs/estados.md: quitar o corregir el pendiente que dice que el piloto reintenta sin_cupo_de_uso cada 15 minutos (hoy retoma a resetsAt + 60 s, de la sesión o de provider_usage de la cuenta del run, y sin resetsAt futuro a los 15 min; el Timeline muestra la hora de retomada); documentar cómo la sidebar agrupa los chats en Activos, Te toca y Terminados a partir del who de WORKTREE_STATE_INFO y, para consultas, de Chat.status (ADR-0013); revisar que las entradas del Timeline de las operaciones manuales (data.op, actor, borrado manual, archivado) sigan igual al código y corregir lo que no.

**Evidence**:
- Summary: docs/estados.md: sin_cupo_de_uso retoma a resetsAt + 60 s (respaldo 15 min), agrupado de la sidebar por who y Chat.status (ADR-0013), data.op delete en el borrado manual; el aviso push de sin_cupo_de_uso se aclara como no hecho.
- Validation: npm run format:check pasa
- Validation: contrastado con autopilot.ts, chat-filter-logic.ts y worktrees/ops.ts
- Files changed: `docs/estados.md`

**Verdict**: pass

---
#### T1.3: CLAUDE.md y docs/panel-desarrollo.md: reglas de las operaciones manuales y del uso

**Status**: done

**Description**: Sumar a CLAUDE.md, en pocas líneas y en la sección que corresponda (Seguridad del panel o una nueva de operaciones), las reglas que tiene que respetar cualquier cambio futuro: las acciones sobre un trabajo pasan por el servicio único WorktreeOps con actor y cada acción nueva del piloto suma su fila en PARITY_CATALOG y su botón (D26); las operaciones manuales dan 409 si el agente corre o el piloto está active, queued o waiting_quota; ninguna fuerza un push, hace rebase, pushea otra rama que la del trabajo, commitea o instala en el clon base, ni lee o toca archivos ignorados; el uso de proveedores se mide por account_id (ya dicho en Cuentas de Claude: enlazar sin repetir). En docs/panel-desarrollo.md: cómo probar GET /api/usage (con sesión, ?refresh=1, qué se ve en degradado) y revisar que la guía del recorrido manual del sprint 3 y la del sprint 1 sigan correctas y sin secretos; dejar explícito que el recorrido manual en ventas y la PR real en agents-panel los hace el usuario antes de completar el scope (ADR-0015, ADR-0018).

**Evidence**:
- Summary: CLAUDE.md suma la sección Operaciones sobre un trabajo (servicio único con actor, catálogo, 409, invariantes de push/rebase/clon base/ignorados, uso por account_id); panel-desarrollo.md explica cómo probar GET /api/usage, el degradado y que el recorrido manual y la PR real los hace el usuario.
- Validation: npm run format:check pasa
- Validation: sin secretos: solo variables COOKIES/CSRF/ORIGIN
- Files changed: `CLAUDE.md`, `docs/panel-desarrollo.md`

**Verdict**: pass

---
### P2 — Verificación y cierre

> Probar que cada decisión del scope quedó en un doc y que el repo sigue verde, para que el scope pueda completarse (R9).

#### T2.1: Matriz D18–D28 contra los docs y verificación final

**Status**: done

**Description**: Armar una matriz (en la evidencia, no en un doc nuevo) con cada decisión D18 a D28 y los requisitos R1 a R9, indicando el doc y la sección donde quedó descrita; si alguna falta, completarla en el doc correspondiente. Confirmar que el scope no cambió nada en la VM (docs/vm-setup.md y su bitácora sin cambios, Costos US$0). Correr npm run build, typecheck, lint, test y format:check en la raíz y kyro analyze del scope (sin hallazgos de R9/S27). Dejar en la evidencia que el recorrido manual en ventas y la PR real en agents-panel quedan para el usuario antes de completar el scope.

**Evidence**:
- Summary: Matriz D18-D28 y R1-R9 (doc y sección). D18: plan.md «Web de operaciones» + estados.md «Agrupado de la sidebar». D19: plan.md sprint 1 «Rutas git por trabajo» y «Web de operaciones» (pestaña Git); estados.md «Operaciones manuales». D20: plan.md sprint 1 «project_repos» y «Pull del clon base por repo» + «Web de operaciones» (Repositorio). D21: estados.md «Tres niveles de estado y etiqueta única». D22: plan.md sprint 1 «Reinstalación». D23: plan.md «Web de operaciones» + identidad-visual.md «Criterios de pantallas». D24: plan.md «Indicador de uso de los proveedores» + panel-desarrollo.md «Probar el indicador de uso» + estados.md sin_cupo_de_uso. D25: plan.md «Servicio de acciones» (git/pr, Correr merge-dev). D26: plan.md «Servicio de acciones» (PARITY_CATALOG) + CLAUDE.md «Operaciones sobre un trabajo». D27: plan.md tabla de rutas (git/diff). D28: plan.md tabla de rutas (discard, work/delete) + estados.md «Borrado manual» y «Chat archivado». R1: plan.md sprint 1. R2: plan.md sprint 1 + panel-desarrollo.md. R3: plan.md rutas del sprint 2. R4: plan.md rutas del sprint 2. R5: plan.md catálogo + resumen sprint 2. R6: plan.md Indicador de uso. R7: plan.md Web de operaciones + recorrido en panel-desarrollo.md. R8: CLAUDE.md «Operaciones sobre un trabajo» + plan.md guardas. R9: los cuatro docs (S27). docs/vm-setup.md no cambió en el scope (último cambio en 2fc6061, anterior; ningún commit del scope lo toca) y los Costos siguen en US$0. El recorrido manual en ventas y la PR real en agents-panel quedan para el usuario antes de completar el scope (ADR-0015, ADR-0018).
- Validation: npm run build ok
- Validation: npm run typecheck ok
- Validation: npm run lint ok
- Validation: npm test ok (web 304 tests; api y shared sin fallos)
- Validation: npm run format:check ok
- Validation: kyro analyze --kyro-scope operaciones-worktree: no semantic issues found (sin hallazgos de R9/S27)
- Files changed: `docs/plan.md`, `docs/estados.md`, `docs/panel-desarrollo.md`, `CLAUDE.md`

**Verdict**: pass

---

## Unfinished work

_None — every task is done with a passing verdict._

## Learnings

_No learnings recorded._

## Resolved Debt

_No debt resolved in this sprint._

## Recommendations for Sprint 5

_None recorded._
