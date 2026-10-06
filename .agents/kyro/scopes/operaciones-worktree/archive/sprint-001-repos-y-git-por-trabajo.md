---
title: 'operaciones-worktree — Sprint 1: Repos del proyecto y operaciones git por trabajo (WS11)'
date: '2026-10-06'
scope: 'operaciones-worktree'
sprint: 1
slug: 'repos-y-git-por-trabajo'
outcome: 'shipped'
type: 'sprint-archive'
---

# Sprint 1: Repos del proyecto y operaciones git por trabajo (WS11)

> Closed: 2026-10-06
> Outcome: shipped

## Objective

Que la API conozca los repos de cada proyecto con su rama base, actualice el clon base repo por repo, y ofrezca por trabajo estado, commit de archivos elegidos, traer base, traer la propia rama, push y reinstalar dependencias, seguras frente al agente y al piloto y registradas en el Timeline.

## Definition of Done

- Todas las tareas en done con evidencia y review pass.
- npm run typecheck, npm run lint y npm test pasan en la raíz.
- Ninguna ruta nueva es pública y todas las mutantes exigen CSRF.
- Ningún camino nuevo usa --force, rebase ni toca archivos ignorados.

## Phases

### P1 — Repos del proyecto

> Tabla project_repos con detección de repos hijos, rama base por repo y pull del clon base por repo (R1).

#### T1.1: Migración project_repos, repositorio y detección de repos hijos

**Status**: done

**Description**: Agregar la migración 20 `project_repos` (id, project_id con ON DELETE CASCADE, path relativo, base_branch, created_at, updated_at, UNIQUE(project_id, path)). La fila de la raíz usa path '.' y la base del proyecto. Crear `ProjectRepoRepository` (listar por proyecto, upsert de detección que conserva la base editada de filas existentes y borra las que ya no existen salvo la raíz, actualizar base_branch). Crear `detectRepos(repoPath)` que devuelve las carpetas de primer nivel (no ocultas) que contienen `.git` y que la raíz ignora (`git check-ignore -q -- <carpeta>` por execFile). Al quedar un proyecto en `ready` (alta o clonado) se corre la detección; los hijos nuevos toman la base del proyecto por defecto. Sumar el tipo `ProjectRepo` a `packages/shared`.

**Evidence**:
- Summary: Migracion 20 project_repos con siembra de la raiz, ProjectRepoRepository, detectRepos con check-ignore, deteccion al quedar ready y tipo ProjectRepo en shared
- Validation: npm run typecheck: ok
- Validation: npm run test -w @agents-panel/api: 1076 passed
- Files changed: `apps/api/src/db/migrations.ts`, `apps/api/src/projects/repos-repo.ts`, `apps/api/src/projects/repos.ts`, `apps/api/src/projects/service.ts`, `packages/shared/src/index.ts`, `apps/api/test/project-repos.test.ts`, `apps/api/test/db.test.ts`, `apps/api/src/app.ts`, `apps/api/src/cli/commands.ts`

**Verdict**: pass

---
#### T1.2: Rutas de repos y pull del clon base por repo

**Status**: done

**Description**: Rutas `GET /api/projects/:id/repos`, `POST /api/projects/:id/repos/detect` y `PATCH /api/projects/:id/repos/:repoId` (solo `baseBranch`, validada; 400 si es inválida, 404 si el repo no es del proyecto). Extender `PullService.pullBase` para que corra `pullFastForward` en cada repo de project_repos (la raíz primero) con su base y devuelva el resultado por repo (`{ path, baseBranch, result | error }`); un repo rechazado (cambios locales, divergencia, falta la carpeta) no corta a los demás. Mantener la compatibilidad de la respuesta actual para la raíz que usa la web (`apps/web/src/app/projects/repo-actions.ts`) o adaptarla en el mismo cambio.

**Evidence**:
- Summary: Rutas GET repos, POST repos detect y PATCH repos por id. PullService pullBase hace pull ff-only por repo con la raíz primero y resultado por repo sin cortar a los demás. Web adaptada con PullBaseResult
- Validation: npm run typecheck -w @agents-panel/api: ok
- Validation: npm test -w @agents-panel/api: 62 archivos pasan
- Validation: npm run build -w @agents-panel/web: ok
- Files changed: `apps/api/src/projects/pull.ts`, `apps/api/src/projects/repos-routes.ts`, `apps/api/src/app.ts`, `packages/shared/src/index.ts`, `apps/web/src/app/projects/repo-actions.ts`, `apps/api/test/project-pull.test.ts`, `apps/api/test/guard.test.ts`, `apps/api/test/cli.test.ts`

**Verdict**: pass

---
### P2 — Operaciones git por trabajo

> Servicio y rutas por chat para estado, commit, traer base, traer rama, push y reinstalar dependencias, con 409 frente al agente o el piloto y entrada en el Timeline (R2, R8).

#### T2.1: Primitivas git compartidas y helper de remoto bare para tests

**Status**: done

**Description**: Extender `createGit` en `apps/api/src/pilot/git-ops.ts` (la misma fuente que usa el piloto, D26) con: `status(cwd)` (rama, archivos de `git status --porcelain=v1 -z` con su estado, y adelante/atrás de `origin/<rama>` con `git rev-list --left-right --count`, null si no hay remota), `commitFiles(cwd, files, message)` (`git add -- <archivos>` y `git commit -m <mensaje> -- <archivos>`; rechaza lista vacía, rutas absolutas, segmentos '..', rutas fuera del repo y archivos ignorados por `git check-ignore`), `pullBranch(cwd, branch)` (`git pull --no-rebase --no-edit origin <rama>`, nombre validado como en `pushArgs`), `abortMerge(cwd)` (`git merge --abort`) y `changedFiles(cwd, from, to)` (`git diff --name-only from to`). Llevar a `apps/api/test/helpers.ts` un helper `makeRepoWithRemote()` (origin bare, clon de trabajo en una rama feature y un segundo clon para simular cambios remotos) a partir de los montajes de `pilot-git-ops.test.ts` / `pilot-merge.test.ts`.

**Evidence**:
- Summary: Primitivas RepoGit en createGit y makeRepoWithRemote con 5 tests de remoto bare
- Validation: typecheck y vitest test/pilot 187 passed
- Files changed: `apps/api/src/pilot/git-ops.ts`, `apps/api/test/helpers.ts`, `apps/api/test/pilot-git-ops.test.ts`

**Verdict**: pass

---
#### T2.2: Servicio WorktreeOps: guardas, repos del trabajo, operaciones y Timeline

**Status**: done

**Description**: Crear `apps/api/src/worktrees/ops.ts` con `WorktreeOps`, que resuelve el chat a su worktree y sus repos (raíz + `childRepos(worktree)`, cada uno con la base de project_repos por path; un hijo sin fila usa la base del proyecto) y expone: `status(chatId)`, `commit(chatId, repo, files, message)`, `pullBase(chatId, repo?)`, `pullBranch(chatId, repo?)`, `push(chatId, repo?)` y `reinstall(chatId)`. Guardas: 404 si el chat no tiene worktree; 409 con motivo si `AgentManager.isRunning(chatId)`, si el run del piloto está en `active`, `queued` o `waiting_quota`, si hay mantenimiento de Kyro, o si ya hay una operación en curso en ese chat. Pull con conflicto: `git merge --abort`, devuelve los archivos en conflicto y `askAgent: true`. Tras un pull que cambió `package-lock.json`, `go.sum`, `uv.lock`, `pnpm-lock.yaml` o `yarn.lock` en cualquier repo, corre `reinstall` sola (D22). `reinstall` extrae de `createWorktree` una función `runSetup(project, path, log)` y vuelve a escribir los `.env` del proyecto como al crear el trabajo. La rama de push de un hijo es su rama actual (validada). Commit: valida Conventional Commits y devuelve un aviso si no cumple, sin bloquear. Cada operación registra una transición con `actor: 'user'`, `record: true`, `data.{op, repo, result}` y la salida recortada a 8000 caracteres, sin cambiar el estado fino del trabajo.

**Evidence**:
- Summary: Servicio WorktreeOps con status, commit, pullBase, pullBranch, push y reinstall. Guardas 404 y 409, conflicto abortado con askAgent, reinstalacion automatica por lockfile, aviso de Conventional Commits y Timeline con actor user. runSetup extraido de createWorktree y writeProjectEnv compartido con ChatService.
- Validation: npm run test en apps/api: 63 archivos y 1101 tests OK
- Validation: npm run typecheck en apps/api OK
- Validation: eslint sin errores en los archivos de T2.2
- Files changed: `apps/api/src/worktrees/ops.ts`, `apps/api/src/worktrees/create.ts`, `apps/api/src/chats/service.ts`, `apps/api/test/worktree-ops.test.ts`
- Notes: Sin fila de estado fino no se escribe entrada de Timeline. El actor de la fila de estado pasa a user al registrar. Errores de lint previos de T2.1 en pull.ts y project-pull.test.ts no se tocaron.

**Verdict**: pass

---
#### T2.3: Rutas git por chat

**Status**: done

**Description**: Registrar `GET /api/chats/:id/git` (estado por repo), `POST /api/chats/:id/git/commit` (`{ repo, files, message }`), `POST /api/chats/:id/git/pull-base` y `POST /api/chats/:id/git/pull-branch` (`{ repo? }`), `POST /api/chats/:id/git/push` (`{ repo? }`) y `POST /api/chats/:id/setup`. Validar el body con el esquema de Fastify (repo es un path relativo que tiene que coincidir con uno de los repos del trabajo, nunca una ruta libre; files es un arreglo no vacío de strings; message no vacío y acotado). Mapear errores: 404 chat o repo inexistente, 409 guardas, 400 entrada inválida, 422 git rechazó (push rechazado, sin remoto) con la salida recortada. Sumar las rutas al guard test.

**Evidence**:
- Summary: Rutas git por chat con esquema Fastify, mapeo de errores 404 409 400 422, guard test y cli test actualizados
- Validation: npm run typecheck
- Validation: npm run lint
- Validation: npm test
- Files changed: `apps/api/src/chats/git-routes.ts`, `apps/api/src/app.ts`, `packages/shared/src/index.ts`, `apps/api/test/worktree-git-routes.test.ts`, `apps/api/test/guard.test.ts`

**Verdict**: pass

---
### P3 — Docs del sprint

> Dejar escrito lo que cambió en la API y el modelo de datos.

#### T3.1: Documentar repos del proyecto y operaciones git por trabajo

**Status**: done

**Description**: Sumar a `docs/plan.md` (etapa 6 / scope operaciones-worktree) una entrada con project_repos, la detección, el pull por repo, las rutas git por chat, las guardas 409 y la reinstalación por lockfile. Si alguna transición o evento nuevo se muestra en el Timeline, describirlo en `docs/estados.md`. Agregar a `docs/panel-desarrollo.md` cómo probar las rutas desde el túnel (curl con cookie y CSRF) si aplica.

**Evidence**:
- Summary: Documentacion de repos del proyecto y rutas git por trabajo en los tres docs
- Validation: Revision manual sin secretos
- Files changed: `docs/plan.md`, `docs/estados.md`, `docs/panel-desarrollo.md`

**Verdict**: pass

---

## Unfinished work

_None — every task is done with a passing verdict._

## Learnings

- Prettier hay que correrlo antes del QA: el formato quedó roto en 5 archivos nuevos

## Resolved Debt

_No debt resolved in this sprint._

## Recommendations for Sprint 2

- Vincular escenarios a R3-R9 al planificar los próximos sprints
