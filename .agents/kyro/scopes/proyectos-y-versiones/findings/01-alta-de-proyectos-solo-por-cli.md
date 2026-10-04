# Alta de proyectos solo por CLI y sin clonar

- **Resumen:** `ProjectRepository.add` exige una carpeta ya clonada y no clona; la API solo expone `GET /api/projects`. La tabla `projects` no tiene estado, nombre visible ni URL del repo.
- **Severidad:** alta (bloquea sumar expedientes-ai sin SSH).
- **Archivos afectados:** `apps/api/src/projects/repo.ts`, `apps/api/src/projects/routes.ts`, `apps/api/src/cli/projects.ts`, `apps/api/src/db/migrations.ts`, `packages/shared`.
- **Recomendación:** servicio de alta compartido por CLI y API (adopta o clona en segundo plano), migración con `display_name`, `repo_url`, `status`, `status_detail`; los proyectos existentes migran como `listo`.
- **Validación:** `db.test.ts` migra una base con `novagent`; tests de alta con remoto falso.
