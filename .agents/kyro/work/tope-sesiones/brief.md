# El tope de sesiones cuenta solo las sesiones sin avance

Un sprint con muchas tareas corre completo sin frenar por el tope de sesiones, y un bucle sin avance se sigue cortando a las 6.

## Problema

- Cada sesión de ejecución hace una sola tarea. El tope `PILOT_MAX_SESSIONS_PER_SPRINT` (6) cuenta todas las sesiones del sprint, así que un sprint de 8 tareas frena con `tope_de_sesiones` aunque cada sesión haya avanzado (chat 3, `operaciones-worktree`: sprint 1 y sprint 2).
- El tope es la red de seguridad contra bucles, pero la defensa contra «no avanza» ya es `sin_avance` y el progreso real es que Kyro cierre una tarea.

## Regla nueva

- El contador de sesiones del sprint vuelve a empezar cuando la sesión anterior fue una ejecución que cerró una tarea (`tasksDone` subió entre la lectura de Kyro al empezar esa sesión y la de ahora). Lo aplican igual la decisión del piloto y el registro de la sesión nueva.
- Las sesiones `fix` y las reanudadas por un reinicio no reinician el contador: un bucle de correcciones o de reinicios se sigue cortando en el tope.
- El tope y su variable no cambian (6 por defecto): ahora es «6 sesiones seguidas sin cerrar una tarea».

## Fuera de alcance

- Subir el valor por defecto del tope.
