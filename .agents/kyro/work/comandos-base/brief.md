# du, df y free en la base de comandos

Todos los proyectos pueden correr du, df y free sin configurar nada: son de solo lectura y los works de medición de disco y RAM los necesitan.

## Regla nueva

- `ALLOWED_BASH_COMMANDS` suma `du`, `df` y `free` (cualquier argumento; no escriben nada).
- Los comandos extra guardados de un proyecto que ya son de la base (o que nunca se habilitan) no se devuelven como extra: así un proyecto que tenía `du` guardado puede seguir guardando su lista sin el error «ya forma parte de la base».

## Fuera de alcance

- `node`, `npx` y `tsx` (ejecutan código arbitrario: se habilitan por proyecto si hacen falta).
