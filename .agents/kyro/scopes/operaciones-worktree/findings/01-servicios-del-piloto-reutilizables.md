# 01 · Servicios del piloto reutilizables para la paridad manual

- **Severidad:** media (define la base de todo el scope)
- **Archivos:** `apps/api/src/pilot/git-ops.ts`, `apps/api/src/pilot/merge.ts`, `apps/api/src/pilot/merge-phase.ts`, `apps/api/src/pilot/github-cli.ts`, `apps/api/src/pilot/secrets.ts`, `apps/api/src/worktrees/validate.ts`, `apps/api/src/worktrees/create.ts`, `apps/api/src/kyro/reader.ts`, `apps/api/src/worktrees/state-repo.ts`

## Resumen

El piloto (scope `autopiloto-kyro`, completado) ya tiene casi todas las operaciones deterministas como servicios internos: `push` sin force con nombre de rama validado, `pull --no-rebase` de la base, `commitPending`, detección de conflictos (`unmergedPaths`, `mergeInProgress`), `scanWorktreeSecrets`, `runValidation`, creación y búsqueda de PR con `gh` (`realGh`), `completeScope` / `closeWork`, y `childRepos(worktree)`. Ninguno está expuesto como ruta por chat.

## Comportamiento visible

Hoy la web no tiene ninguna operación git por trabajo: si el piloto falla en commit, pull, push o PR, solo queda SSH (D31).

## Recomendación

D26 exige un **servicio único de acciones** usado por el piloto y por la API. Extraer o envolver estas funciones en ese servicio (con actor `user` / `pilot` / `agent` y entrada del Timeline con `record: true`) en lugar de duplicarlas. Faltan: pull de la propia rama (`origin/<rama>`), listado de estado por repo (rama, cambios, adelante/atrás), commit con archivos elegidos, `merge --abort` al haber conflicto en un pull manual, y una función de setup aislada para un worktree existente (hoy el setup solo corre dentro de `createWorktree`).

## Validación

Tests con repos temporales y remoto bare (ya hay montajes en `project-pull.test.ts`, `pilot-git-ops.test.ts` y `pilot-merge.test.ts`; conviene llevar uno a `apps/api/test/helpers.ts`).
