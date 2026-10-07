# Reanudar el piloto desbloquea y sigue

Al apretar Reanudar, un work o scope frenado vuelve a ejecutarse solo en lugar de quedar bloqueado otra vez.

## Problema

- **Scope en `qa_or_close` (chat 3, `operaciones-worktree`):** para el paso de cierre el piloto pide `kyro context-pack --kyro-scope <s> --task --verbosity detailed --json`. `--task` sin id pide la próxima tarea y en `qa_or_close` no hay: Kyro responde `No next task in handoff` y el piloto frena con `kyro_bloqueado` en cada Reanudar.
- **Work con una tarea bloqueada en Kyro (chat 4, `capacidad-y-tiempos`, W7):** el agente bloqueó W7 con `kyro work block`. Reanudar pone el piloto activo, pero Kyro sigue en `resolve_blocker` y el piloto frena enseguida con `tarea_bloqueada`. Nada saca la tarea del bloqueo desde la web.

## Regla nueva

- El `context-pack` de un scope lleva `--task <id>` solo cuando Kyro tiene próxima tarea (`nextTaskId`); sin tarea (cierre, fix) se pide sin `--task`.
- Reanudar (o encender) el piloto es la señal de que la persona resolvió lo que frenaba. Si en la primera lectura después de eso un work está en `resolve_blocker`, el piloto corre `kyro work unblock --work <w> --task <nextTaskId> --expect-revision <n> --by user`, lo anota en el Timeline y abre la sesión de ejecución con el motivo del bloqueo anterior en el prompt. Solo en esa primera lectura: si el agente vuelve a bloquear la tarea, el piloto frena como siempre hasta el próximo Reanudar.
- Si `kyro work unblock` falla, el piloto frena con `kyro_bloqueado` y el error.

## Fuera de alcance

- Desbloquear tareas de un scope (Kyro no tiene `unblock` para scopes).
- Sumar `du`, `df` o `free` a los comandos base del agente: se habilitan por proyecto en la configuración de permisos.
