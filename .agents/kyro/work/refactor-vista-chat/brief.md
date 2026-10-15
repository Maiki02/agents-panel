# Refactor de la vista de un chat/worktree: dos columnas y panel de información

## Pedido del usuario

Cuando estamos parados dentro de un chat/worktree, reorganizar la información:

- Dos columnas en laptop y desktop. Izquierda: el chat. Derecha: información del worktree.
- Hoy la cabecera tiene demasiadas cosas apiladas (slug, badge, proyecto · rama, modelos, stepper de 7 fases, "Tarea 4/4 · Ejecutor · modelo", barra del piloto con 4 botones grandes y una lista con el motivo de cada botón deshabilitado).

Lo que tiene que tener la columna derecha:

1. Nombre y estado de la rama.
2. Resumen de la línea temporal (Idea › Plan › Ejecución › QA › Cierre › Merge › PR).
3. **Nuevo:** la tarea actual con su id (por ejemplo T1.1 o W2) y qué se está haciendo con ella: planificando, ejecutando, QA/revisión o corrigiendo.
4. El piloto ocupa demasiado espacio y sus botones son demasiado llamativos: compactarlo.

Reorganizar siguiendo buenas prácticas (jerarquía visual, menos ruido, accesibilidad).

## Contexto técnico (verificado en el código)

- `apps/web/src/app/chats/chat.page.ts` arma hoy toda la cabecera (`.chat-top`), las pestañas Chat/Timeline/Git, el feed y el composer.
- `apps/web/src/app/chats/autopilot-bar.ts` muestra badge + 4 botones `primary`/`danger` + `<ul>` con el motivo de cada acción deshabilitada.
- `apps/web/src/app/chats/phase-stepper.ts` + `phase-logic.ts` (`stepperView`) dan las fases y "Sprint n/m · Tarea n/m · rol · modelo".
- La API ya lee `nextTaskId` de Kyro (`apps/api/src/kyro/state.ts`, scope y work), pero **no** se guarda en `worktree_state` ni viaja en `WorktreeState` (`packages/shared/src/index.ts`). El estado fino (`escribiendo_codigo`, `probando`, `corrigiendo`, `revisando_tarea`, `qa`, `planificando`…) ya existe y alcanza para decir qué se hace con la tarea.

## Restricciones

- El estado se deduce solo de señales verificables (Kyro, git, gh, hooks), nunca del texto del agente. Si cambia el modelo de estado se actualiza `docs/estados.md`.
- Angular standalone + signals, OnPush, tokens de `docs/identidad-visual.md` (Tailwind). TypeScript strict.
- En móvil la vista sigue en una columna.
- Las reglas del piloto (qué acción aplica y por qué) siguen en `autopilot-logic.ts`; el servidor sigue teniendo la última palabra (409).
- No se pierde ninguna función: Cancelar, pestañas Timeline/Git, tarjetas de aprobación, PR, banners y composer siguen disponibles.

## Criterio de terminado

- En ≥ lg el chat ocupa la columna izquierda y el panel de información la derecha; en móvil, una columna.
- El panel muestra rama + estado, resumen de fases, tarea actual con id y actividad, y un piloto compacto.
- Tests de la lógica nueva (vista de la tarea actual, controles del piloto visibles) y build/lint/test del monorepo en verde.
