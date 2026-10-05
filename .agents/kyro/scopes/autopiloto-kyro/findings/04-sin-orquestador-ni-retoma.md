# No hay orquestador: un turno por chat y, al reiniciar, espera un mensaje

- **Severidad:** alta.
- **Archivos:** `apps/api/src/agent/manager.ts` (un turno por chat, tope de 4 sesiones, `MaintenanceError`), `apps/api/src/chats/repo.ts` (los chats `running` pasan a `interrupted` al arrancar), `apps/api/src/app.ts`, `apps/api/src/chats/service.ts` (el primer prompt manda leer la skill `kyro-forge` o `kyro-work`).
- **Comportamiento visible:** después de cada turno el trabajo queda `idle` hasta que el usuario escribe; si se reinicia el panel, queda `interrupted` y espera otro mensaje.
- **Recomendación:** tabla `autopilot_runs` y un bucle que lee el estado, elige rol y prompt, abre una sesión nueva y repite o frena; al arrancar retoma los pilotos activos con `resume`; tope de sesiones por sprint y detección de "sin avance". Ejecución por `kyro-forge` (sin `kyro-sprint-executor`).
- **Validación:** runner y Kyro falsos que recorren scope de 2 sprints, freno por pregunta, bloqueo, sin avance, reinicio a mitad y fin con y sin deuda.
