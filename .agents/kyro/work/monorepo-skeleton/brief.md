# Work: esqueleto del monorepo (npm workspaces, TypeScript strict, lint)

Dejar armado el monorepo de agents-panel con npm workspaces (`apps/api`, `apps/web`, `packages/shared`), TypeScript en modo `strict` y lint funcionando desde la raíz, según "Stack y convenciones de código" de `CLAUDE.md` y la estructura de `docs/plan.md`. Es la base sobre la que arranca la etapa 4 (Panel MVP); no incluye funcionalidad del panel.

## Context

- `CLAUDE.md`: todo TypeScript con `strict: true`, Node 24 LTS, npm workspaces. `apps/api` = Fastify + Claude Agent SDK + SQLite; `apps/web` = Angular (standalone + signals); `packages/shared` = tipos compartidos entre API y web.
- `docs/plan.md`, "Estructura del repo" y "Arquitectura": el backend compila y sirve el frontend Angular; escucha en `127.0.0.1:3000`.
- Hoy el repo solo tiene docs y `scripts/vm/`. `.gitignore` ya cubre `node_modules/`, `dist/`, `.angular/`, `.env*` y SQLite. `.gitattributes` fuerza LF.
- Código y comentarios técnicos en inglés; docs en español.

## Scope

- Raíz: `package.json` con `workspaces` y `engines.node >=24`, `.nvmrc`, `tsconfig.base.json` (strict + opciones estrictas extra), scripts `build`, `typecheck`, `lint`, `format`/`format:check` que recorren todos los workspaces.
- Lint: ESLint flat config (`eslint.config.js`) con `typescript-eslint` type-aware para todo el repo y `angular-eslint` para `apps/web`; Prettier para formato.
- `packages/shared` (`@agents-panel/shared`): paquete TS que compila a `dist/` con un tipo de ejemplo (p. ej. `HealthResponse`) consumible desde api y web.
- `apps/api` (`@agents-panel/api`): Fastify mínimo con `GET /api/health` que responde un `HealthResponse` de shared, escuchando en `127.0.0.1:3000`. Script `dev` y `build`. Sin auth, sin SDK, sin SQLite todavía (solo dependencias que el esqueleto use).
- `apps/web` (`@agents-panel/web`): app Angular standalone + signals mínima (un componente raíz), compila con `ng build`, importa un tipo de shared.
- `README.md`: sección corta de cómo instalar, compilar y lintear.

## Tasks

- **W1 — Raíz del monorepo**: workspaces, `tsconfig.base.json`, ESLint + Prettier, scripts raíz.
- **W2 — packages/shared**: paquete de tipos compartidos que compila.
- **W3 — apps/api**: Fastify con `/api/health` usando shared.
- **W4 — apps/web**: Angular standalone + signals usando shared, con angular-eslint.
- **W5 — Verificación y README**: `npm ci`, `build`, `typecheck` y `lint` limpios desde la raíz; README actualizado.

## Out of scope

- Login, 2FA, sesiones, CSRF (etapa 4).
- Integración con Claude Agent SDK, SQLite, SSE, orquestador.
- Que la API sirva el build de Angular, systemd, Tailscale Funnel (etapa 6).
- Tests más allá de lo que el esqueleto necesite; CI de GitHub Actions.
- Cualquier cambio en la VM fuera del repo.
