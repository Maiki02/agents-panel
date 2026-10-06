# 02 · Repos hijos y pull del clon base

- **Severidad:** media
- **Archivos:** `apps/api/src/projects/pull.ts`, `apps/api/src/projects/pull-routes.ts`, `apps/api/src/projects/git.ts`, `apps/api/src/pilot/merge-phase.ts` (`childRepos`), `apps/api/src/db/migrations.ts` (última: 19), `apps/web/src/app/projects/repo-actions.section.ts`

## Resumen

`POST /api/projects/:id/pull` (`PullService.pullBase`, `--ff-only`) ya actualiza el clon base, pero solo la raíz. No existe la tabla `project_repos` ni la rama base por repo hijo; `childRepos` solo corre sobre un worktree y asume la base del proyecto.

## Comportamiento visible

En ventas (raíz `main`, `fe-ventas` y `be-ventas` en `dev`) el pull del clon base deja los hijos desactualizados, y "Traer base" en un worktree usaría la rama equivocada para los hijos.

## Recomendación

Migración 20 con `project_repos` (proyecto, ruta relativa, rama base), detección al registrar o a pedido ("Detectar repos": primer nivel, con `.git`, ignorados por la raíz), lista editable en Configuración → Repositorio y Pull por repo. El merge genérico y "Traer base" leen la base de cada repo (D20).

## Validación

Test con un clon base que tiene un repo hijo ignorado con otra rama base; pull por repo con resultado individual; rechazo con cambios locales o divergencia.
