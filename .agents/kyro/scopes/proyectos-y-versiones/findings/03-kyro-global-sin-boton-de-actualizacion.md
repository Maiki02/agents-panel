# Kyro es global de la VM y se actualiza a mano

- **Resumen:** CLI en `~/.npm-global/bin/kyro` (6.1.0 = última publicada), runtime en `~/.agents/kyro/current`, skills enlazadas con `scripts/vm/06-kyro-skills.sh`. No hay script de actualización ni registro de corridas; actualizar con una sesión activa cambia el runtime debajo del agente.
- **Severidad:** media.
- **Archivos afectados:** `scripts/vm/` (nuevo `08-kyro-update.sh`), `apps/api/src/agent/manager.ts` (conteo de sesiones y bloqueo), nueva ruta de versiones, tabla `maintenance_runs`, `CLAUDE.md` (regla de la bitácora).
- **Recomendación:** script idempotente invocado por el panel con TOTP; 409 con sesiones activas; verificar a mano la secuencia de `kyro update` en 6.x (hipótesis H1) antes de escribirlo.
- **Validación:** tests con script falso; segunda corrida real sin cambios.
