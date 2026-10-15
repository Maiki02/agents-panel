# Ajustes de la tarjeta Tarea actual y de las fases

## Pedido

1. Si la tarea actual no tiene ID, la tarjeta no muestra «Sin id»: queda «Planificando», porque estamos en la parte del Plan.
2. La tarea que muestra la tarjeta no es la real: el agente dice que implementa W5 y la tarjeta muestra «0/6 · W1 · Escribiendo código». La tarjeta tiene que seguir la tarea en curso mientras el turno corre, no solo al terminar.
3. Las fases (Idea, Plan, Ejecución, QA, Cierre, Merge, PR) se muestran como una línea de tiempo vertical (decisión del usuario): puntos unidos por una línea, las fases hechas con ✓, la actual resaltada con lo que se está haciendo, las que faltan en gris.

## Causa encontrada (punto 2)

`WorktreeStateTracker` lee Kyro solo en `turnFinished`. Durante un turno largo en el que el agente avanza de W1 a W5, el estado guardado sigue con el `taskId` y el progreso del inicio. Además, para un Work, la tarea en curso es la que `kyro work status` lista en `summary.inProgress` (o `awaitingReview`), que es la señal verificable a preferir sobre `nextTaskId`.

## Criterios

- Sin `taskId`, la tarjeta no muestra «Sin id»; en el Plan dice «Planificando».
- Después de cada comando `kyro` que el agente corre por Bash dentro del turno, el panel vuelve a leer Kyro y actualiza tarea y progreso (sin romper el turno si la lectura falla).
- Para un Work, la tarea mostrada es la que está en curso o esperando revisión según Kyro.
- Las fases se ven como línea de tiempo vertical en el panel de información; el modo horizontal del stepper sigue igual donde se use.
- Tests de API y web actualizados; `docs/estados.md` refleja la lectura durante el turno.
