# Los .env dependen de la copia principal y de cada script

- **Resumen:** `createWorktree` corre `setup_command` y nada más. Los `.env` los copia cada `panel-setup.sh` desde la copia principal (`ventas` copia `.env`, `.env.local`, `.env.development` de `be-ventas`). No hay forma de subirlos o rotarlos desde la web.
- **Severidad:** alta.
- **Archivos afectados:** `apps/api/src/worktrees/create.ts`, `apps/api/src/chats/service.ts`, nuevo módulo de cifrado y de validación, `apps/api/src/db/migrations.ts`.
- **Recomendación:** tabla `project_env_files` cifrada (AES-256-GCM con HKDF de `PANEL_SECRET_KEY`), escritura 0600 después del setup con `git check-ignore` y rollback si falta la carpeta.
- **Validación:** valor centinela ausente de respuesta, logs, `chat_events` y base en claro; rechazo de `.env.production`, `.env.example`, `../.env` y rutas no ignoradas.
