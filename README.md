# agents-panel

Panel web para mandar pedidos a Claude Code desde cualquier dispositivo y seguir cada feature (scope o work de Kyro) de punta a punta: planificación, ejecución, QA y PR a `dev`. Corre en la VM `vm-ia` (Oracle) y se publica con Tailscale Funnel.

- [Plan](docs/plan.md)
- [Estados de un worktree](docs/estados.md)
- [Crear la VM en Oracle](docs/vm-oracle.md)
- [Runbook de la VM](docs/vm-setup.md)

Estado: esqueleto del monorepo. Todavía no hay funcionalidad del panel.

## Estructura

| Carpeta | Paquete | Qué es |
| --- | --- | --- |
| `apps/api` | `@agents-panel/api` | Backend Fastify (más adelante: Agent SDK + SQLite) |
| `apps/web` | `@agents-panel/web` | Frontend Angular (standalone + signals) |
| `packages/shared` | `@agents-panel/shared` | Tipos compartidos entre API y web |

Monorepo con npm workspaces, TypeScript `strict` (base en `tsconfig.base.json`), ESLint (`typescript-eslint` con tipos y `angular-eslint` en la web) y Prettier.

## Desarrollo

Requisitos: Node 24 (`.nvmrc`) y npm 11.

```bash
npm ci                 # instalar dependencias de todos los workspaces
npm run build          # compilar shared, api y web
npm run typecheck      # chequeo de tipos de todos los workspaces
npm run lint           # ESLint en todo el repo
npm run format:check   # Prettier (npm run format para corregir)
```

API:

```bash
npm run dev -w @agents-panel/api     # modo desarrollo (tsx watch)
npm run start -w @agents-panel/api   # build compilado (dist/)
curl http://127.0.0.1:3000/api/health
```

Escucha solo en `127.0.0.1:3000`; se cambia con las variables `HOST` y `PORT`.

Web:

```bash
npm run start -w @agents-panel/web   # ng serve en http://localhost:4200
```

`packages/shared` se compila a `dist/`: después de cambiar sus tipos, correr `npm run build -w @agents-panel/shared` (o `npm run build`).
