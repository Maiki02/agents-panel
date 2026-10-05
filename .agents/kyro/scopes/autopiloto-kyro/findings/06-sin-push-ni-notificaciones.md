# No hay Web Push ni push de la rama del worktree

- **Severidad:** media.
- **Archivos:** `apps/web` (sin service worker ni suscripciones), `apps/api/src` (sin tabla de suscripciones ni claves VAPID), `apps/api/.env.example`.
- **Comportamiento visible:** cuando algo se traba nadie se entera hasta abrir la web; el agente no tiene definido pushear su rama.
- **Recomendación:** Web Push (VAPID + service worker) a todas las suscripciones con lista de dispositivos, Probar y Quitar y borrado de vencidas; el piloto pushea la rama del worktree después de cada commit de cierre de sprint, nunca con `--force`.
- **Validación:** hipótesis H3 (sin costo con el HTTPS de Funnel) y un aviso recibido en la PC y en Android con Chrome cerrado.
