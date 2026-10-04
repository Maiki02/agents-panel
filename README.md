# agents-panel

Panel web para mandar pedidos a Claude Code desde cualquier dispositivo y seguir cada feature (scope o work de Kyro) de punta a punta: planificación, ejecución, QA y PR a `dev`. Corre en la VM `vm-ia` (Oracle) y se publica con Tailscale Funnel.

- [Plan](docs/plan.md)
- [Estados de un worktree](docs/estados.md)
- [Crear la VM en Oracle](docs/vm-oracle.md)
- [Runbook de la VM](docs/vm-setup.md)
- [Panel en desarrollo: cuenta, API/web y túnel SSH](docs/panel-desarrollo.md)

Estado: panel MVP (etapa 4): login con contraseña + TOTP, scopes y works en worktrees propios con una sesión del Agent SDK, streaming en vivo, historial y resume. Falta lo de las etapas 5 y 6 (estados finos, PRs, Funnel, systemd).

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
npm test               # tests (vitest) de los workspaces que los tengan
```

API:

```bash
npm run dev -w @agents-panel/api     # modo desarrollo (tsx watch)
npm run start -w @agents-panel/api   # build compilado (dist/)
curl http://127.0.0.1:3000/api/health
```

Escucha solo en `127.0.0.1:3000`; se cambia con las variables `HOST` y `PORT`.

Configuración: copiar `apps/api/.env.example` a `apps/api/.env` y completar `PANEL_SECRET_KEY` (mínimo 32 bytes) y `PANEL_ORIGIN`. Sin ellas la API y el CLI no arrancan. La base SQLite vive en `PANEL_DATA_DIR` (por defecto `~/.local/share/agents-panel`).

### Correr el panel en desarrollo

```bash
cp apps/api/.env.example apps/api/.env       # completar PANEL_SECRET_KEY (openssl rand -base64 48) y PANEL_ORIGIN
npm run -w @agents-panel/api cli -- user:create <usuario>
npm run -w @agents-panel/api cli -- project:add <nombre> <ruta-del-repo> <rama-base> ["comando de setup"]
npm run dev -w @agents-panel/api              # API en 127.0.0.1:3000
npm run start -w @agents-panel/web            # web en http://localhost:4200 (proxy /api → API)
```

Desde otra máquina, por túnel SSH: `ssh -L 4200:127.0.0.1:4200 <host>` y abrir `http://localhost:4200`. La cookie es `Secure`, que los navegadores aceptan en `localhost`. `PANEL_ORIGIN` tiene que coincidir con la URL que se usa en el navegador.

Cada chat crea un worktree en `~/wt/<proyecto>/<slug>` (rama `feature/<slug>`) y corre una sesión del Agent SDK con permisos acotados (lista de comandos permitidos; nunca modo sin permisos). El SDK reutiliza el login de Claude Code de la máquina.

### Usuarios (CLI)

No hay registro público: los usuarios se crean solo desde la terminal del servidor.

```bash
npm run -w @agents-panel/api cli -- user:create <usuario>          # contraseña (mín. 14) + TOTP + 10 códigos de recuperación
npm run -w @agents-panel/api cli -- user:list                      # lista usuarios (marca los bloqueados)
npm run -w @agents-panel/api cli -- user:reset-password <usuario>  # nueva contraseña y cierra sus sesiones
npm run -w @agents-panel/api cli -- user:reset-2fa <usuario>       # nuevo TOTP y códigos de recuperación
npm run -w @agents-panel/api cli -- user:unlock <usuario>          # levanta el bloqueo por intentos fallidos
```

`user:create` pide la contraseña dos veces (sin eco), muestra el QR para la app de autenticación y pide un código para confirmar; si es incorrecto no guarda nada. Los códigos de recuperación se muestran una sola vez.

Web:

```bash
npm run start -w @agents-panel/web   # ng serve en http://localhost:4200
```

`packages/shared` se compila a `dist/`: después de cambiar sus tipos, correr `npm run build -w @agents-panel/shared` (o `npm run build`).
