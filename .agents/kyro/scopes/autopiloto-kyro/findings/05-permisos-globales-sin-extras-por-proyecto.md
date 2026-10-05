# Los permisos de comandos son globales

- **Severidad:** media.
- **Archivos:** `apps/api/src/agent/permissions.ts` (`ALLOWED_BASH_COMMANDS` fija: git, gh, npm, go, kyro; `READ_COMMANDS` de lectura con ruta validada agregados en el sprint 6 de `proyectos-y-versiones`), `apps/api/src/projects/repo.ts`, `apps/api/src/db/migrations.ts`.
- **Comportamiento visible:** en un proyecto con `uv`/`python` (expedientes-ai) el agente no puede correr los tests; `curl` está denegado siempre.
- **Recomendación:** columnas `allowed_commands` y `allowed_hosts` en `projects`, política = base + extras − denegados fijos, parser de `curl` restringido y tab Permisos con TOTP.
- **Validación:** tests del parser por cada flag prohibida y por los denegados fijos.
