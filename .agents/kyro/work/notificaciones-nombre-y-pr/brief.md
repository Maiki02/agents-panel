# Notificaciones: renombrar en un modal · PR con descripción detallada

## Pedido del usuario

> En notificaciones, quitemos el input del nombre.
> Si se quiere cambiar el nombre, se debe apretar "Renombrar" y eso abre el modal con un input y un botón de confirmar.
>
> Por otro lado, necesito que agreguemos que los PR en la descripción, tenga información detallada.

## Decisiones tomadas con el usuario (09/10/2026)

- **Contenido de la descripción de la PR:** objetivo del work o scope y cada tarea con su título y qué se hizo (el resumen de la evidencia de Kyro). No se agregan validaciones, archivos, commits ni hallazgos de la revisión.
- **Cómo se arma:** lo arma el panel leyendo el estado de Kyro (`work.json` del work, `sprint.json` y los snapshots de sprint del scope). Determinístico, sin sesión del agente ni cupo de Claude.
- **Alcance:** la PR que abre el piloto con el merge genérico y el texto precargado de **Crear PR** (pestaña Git), que sigue siendo editable antes de enviar. La PR que abre la skill `merge-dev` de un proyecto queda fuera (el cuerpo lo escribe esa skill).

## Qué se espera

1. **Notificaciones (web).** Cada dispositivo de la lista deja de mostrar el input del nombre. El botón «Renombrar» abre un modal (el componente `Modal` de `apps/web/src/app/ui`) con un input del nombre precargado y un botón de confirmar; confirmar llama a `PATCH /api/push/subscriptions/:id`, cierra el modal y refresca la lista. Confirmar queda deshabilitado con el nombre vacío o igual al actual, o con la llamada en curso; un error se muestra sin cerrar el modal. Probar y Quitar no cambian.
2. **Descripción de la PR (API).** Un armador puro del cuerpo en Markdown a partir del estado de Kyro: objetivo y una sección de tareas con el título de cada una y el resumen de su evidencia (o su descripción si no la tiene; las tareas descartadas se marcan como tales). Para un scope, las tareas de los sprints cerrados agrupadas por sprint. Si Kyro no se puede leer, el cuerpo cae al texto actual (nunca rompe la PR). El piloto lo usa en `prText` y `GET …/git/pr` (`prPreview`) lo usa como cuerpo precargado cuando el trabajo tiene work o scope de Kyro; un pedido directo sigue con la lista de commits.
3. **Docs.** `docs/plan.md` anota el cambio.

## Fuera de alcance

- Cambiar la API de push o el modal de agregar dispositivo.
- Que el agente redacte la descripción; validaciones, archivos, commits y hallazgos en el cuerpo.
- El cuerpo de las PR de `merge-dev`.
