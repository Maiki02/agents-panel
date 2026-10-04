# Panel en desarrollo: cuenta, API, web y túnel

Cómo trabajar con el panel mientras todavía no está publicado con Funnel (etapa 6): crear la cuenta, levantar backend y frontend en la VM y verlos desde la PC en `localhost` por un túnel SSH. Para instalar la VM en sí, ver [`vm-setup.md`](vm-setup.md) (paso 10).

## Cómo encaja todo

```
PC (navegador)                      VM vm-ia
http://localhost:4200  ──túnel SSH──►  127.0.0.1:4200  ng serve (web)
                                          │  proxy /api
                                          ▼
                                       127.0.0.1:3000  Fastify (API) ──► SQLite, worktrees, Agent SDK
```

- Web y API escuchan solo en `127.0.0.1` de la VM: no hay puertos abiertos en Oracle (solo el 22). El túnel SSH es la única forma de llegar.
- El navegador habla solo con el puerto 4200; `ng serve` reenvía `/api` a la API (`apps/web/proxy.conf.json`).

## 1. Configuración de la API (una vez)

Se hace en la VM, en `apps/api/.env` (no se commitea). Si no existe:

```bash
cd ~/proyectos/agents-panel
umask 077
printf 'PANEL_SECRET_KEY=%s\nPANEL_ORIGIN=http://localhost:4200\nHOST=127.0.0.1\nPORT=3000\n' "$(openssl rand -base64 48)" > apps/api/.env
```

- `PANEL_SECRET_KEY` (≥ 32 bytes) cifra el secreto TOTP. **Si se cambia o se pierde, hay que rehacer el segundo factor de cada usuario** (`user:reset-2fa`).
- `PANEL_ORIGIN` tiene que ser **exactamente** la URL que se escribe en el navegador. Con el túnel de abajo es `http://localhost:4200`. Si se usa otro puerto local, cambiarlo acá y reiniciar la API.
- La clave no se muestra ni se pega en ningún lado. Variables opcionales (`PANEL_DATA_DIR`, `PANEL_WORKTREES_DIR`, TTL de sesión): ver `apps/api/.env.example`.

| Variable | Por defecto | Para qué sirve |
|---|---|---|
| `PANEL_PROJECTS_DIR` | `~/proyectos` | Carpeta donde el panel clona los proyectos agregados desde GitHub (`<carpeta>/<proyecto>`). Coincide con donde ya viven `ventas` y `agents-panel` en la VM. |
| `PANEL_MIN_FREE_DISK_GB` | `10` | Espacio libre mínimo (entero positivo, en GB) para empezar un clon; con menos, el proyecto queda en error «sin espacio». |
| `PANEL_KYRO_UPDATE_SCRIPT` | `scripts/vm/08-kyro-update.sh` del repo | Script que corre la actualización de Kyro (`POST /api/versions/kyro/update`). Se cambia para probar con uno falso. |

## 2. Crear la cuenta

No hay registro público: las cuentas se crean solo desde la terminal de la VM, y las crea la persona (elige la contraseña y escanea el QR; no se le pasan a un agente).

```bash
cd ~/proyectos/agents-panel
npm run -w @agents-panel/api cli -- user:create <usuario>
```

Qué pide, en orden:

1. **Contraseña** (mínimo 14 caracteres), dos veces, sin eco.
2. **Segundo factor:** muestra un QR en la terminal. Escanearlo con una app de autenticación (Google Authenticator, Authy, 1Password…) o cargar a mano la clave que figura debajo.
3. **Un código de 6 dígitos** de esa app para confirmar. Si es incorrecto, no se guarda nada y se puede repetir.
4. **10 códigos de recuperación**, que se muestran **una sola vez**: guardarlos en un gestor de contraseñas.

Si el QR se ve deformado, agrandar la terminal o usar la clave manual.

Mantenimiento de cuentas:

| Necesidad | Comando |
|---|---|
| Ver usuarios (marca los bloqueados) | `npm run -w @agents-panel/api cli -- user:list` |
| Olvidé la contraseña | `… cli -- user:reset-password <usuario>` (cierra sus sesiones) |
| Perdí el celular / el TOTP | `… cli -- user:reset-2fa <usuario>` (nuevo QR y nuevos códigos) |
| Bloqueado por intentos fallidos | `… cli -- user:unlock <usuario>` |

## 3. Registrar un proyecto (una vez por proyecto)

### Desde GitHub (API; la pantalla web llega en el sprint 2)

Con la API levantada y una sesión iniciada, `POST /api/projects` clona el repo en `PANEL_PROJECTS_DIR` (por defecto `~/proyectos`) y lo registra. Hace falta la cookie de sesión y el token CSRF de `GET /api/auth/me`, más el header `Origin` igual a `PANEL_ORIGIN`:

```json
{
  "repo": "owner/repo",
  "name": "mi-proyecto",
  "displayName": "Mi Proyecto",
  "baseBranch": "dev",
  "setupCommand": "bash scripts/panel-setup.sh"
}
```

- Solo `repo` es obligatorio: `owner/repo` o `https://github.com/owner/repo` (con o sin `.git`). El resto es opcional: `name` (kebab-case; si falta sale del repo), `displayName` (nombre visible), `baseBranch` (si falta, la rama por defecto del clon) y `setupCommand`.
- Cualquier otro campo (por ejemplo una ruta de carpeta) o un repo que no sea de GitHub se rechaza con 400: el destino lo decide siempre el panel.
- **202**: el clon sigue en segundo plano y el proyecto está en `cloning`. **201**: la carpeta ya existía con ese origin y se adoptó (queda `ready`). **409**: el proyecto ya existe, o la carpeta existe con otro origin.
- Seguir el estado con `GET /api/projects/:id` (`cloning`, `ready` o `error` con `statusDetail`). Si falló, `POST /api/projects/:id/retry`. Un chat sobre un proyecto que no está `ready` responde 409.
- `GET /api/projects/:id` incluye `suggestedSetupCommand` (`bash scripts/panel-setup.sh`) cuando el repo trae ese script y el setup está vacío. No se aplica solo: se guarda con `PATCH /api/projects/:id` (`displayName`, `baseBranch`, `setupCommand`).
- `hasKyro` indica si el repo trae `.agents/kyro/`; en ese caso se inicializa Kyro al quedar listo y, si falla, `kyroWarning` lo avisa sin revertir el proyecto.
- Requiere `gh` autenticado en la VM (`gh auth status`) y al menos `PANEL_MIN_FREE_DISK_GB` GB libres.

### Una carpeta ya clonada (CLI)

`project:add` sigue sirviendo para registrar un repo que ya está en disco:

```bash
npm run -w @agents-panel/api cli -- project:add <nombre> <ruta-del-repo> <rama-base> ["comando de setup"]
# NovaGent (multi-repo):
npm run -w @agents-panel/api cli -- project:add novagent ~/proyectos/ventas dev "bash scripts/panel-setup.sh"
npm run -w @agents-panel/api cli -- project:list   # id, nombre, nombre visible, estado, ruta y rama base
```

Detalle del comando de setup y de `panel-setup.sh` en `vm-setup.md` (paso 10) y en `CLAUDE.md`.

### `.env` de desarrollo del proyecto (API; la pantalla web llega en el sprint 4)

El panel guarda los `.env` de desarrollo de cada proyecto cifrados y los escribe (modo 600) en cada worktree nuevo, después del setup. Se manejan en `/api/projects/:id/env` con la sesión, el token CSRF y el `Origin` de siempre; subir, reemplazar y borrar piden además un código **TOTP nuevo** de la app (uno que no se haya usado para entrar ni en otra acción).

Subir o reemplazar (`PUT`). El ejemplo usa valores falsos: nunca pegues un `.env` real en un doc, un issue o un chat.

```json
{
  "path": "backend/.env",
  "content": "DB_HOST=localhost\nAPI_KEY=valor-de-prueba\n",
  "totp": "123456",
  "applyToActive": false
}
```

- **201** si se creó, **200** si reemplazó uno con la misma ruta. Responde `{ "file": { "path", "keyNames", "updatedAt", "readable" } }`; con `"applyToActive": true` suma `applied`: por cada worktree activo del proyecto, `written` o `skipped` con el motivo.
- **400** con el motivo: ruta o nombre inválido (`.env.production`, `.env.example`, `../.env`…), contenido de más de 64 KB, con NUL o con una línea que no es `CLAVE=valor` (cita el número de línea), un campo de más, o una ruta que git **no** ignora en el clon (sumala al `.gitignore` del repo).
- **401** `{ "error": "invalid_totp" }`: falta el código, es incorrecto o ya se usó. Cuenta para el bloqueo por intentos (`user:unlock` si hace falta).
- **404** si el proyecto no existe; **409** si todavía no está `ready`.

Listar (`GET /api/projects/:id/env`): devuelve ruta, nombres de las claves, fecha y `readable`. El contenido no se puede ver: para cambiarlo, se vuelve a subir.

Borrar (`DELETE /api/projects/:id/env`, body `{ "path": "backend/.env", "totp": "123456" }`): **200**, o **404** si esa ruta no tiene `.env`.

Si se cambia `PANEL_SECRET_KEY`, los `.env` guardados quedan con `readable: false` y crear un chat en ese proyecto responde 422 hasta volver a subirlos. Si el setup no crea la carpeta de algún `.env` (por ejemplo `backend/`), crear el chat también responde 422 («falta la carpeta backend para backend/.env») y no queda nada creado.

### Actualizar Kyro (API; la pantalla web llega en el sprint 4)

`POST /api/versions/kyro/update` con la sesión, el token CSRF y `{ "code": "123456" }` (un TOTP vigente que no se haya usado) corre `scripts/vm/08-kyro-update.sh` con las raíces de los proyectos listos que tienen Kyro. Responde **202** `{ "runId": 1 }`, **401** `{ "error": "invalid_totp" }`, o **409** si hay sesiones corriendo (`running` trae la cantidad) o ya hay una actualización en curso. `GET /api/versions` muestra la versión instalada y la última publicada (`null` sin red), y `GET /api/maintenance-runs?kind=kyro-update` el historial con la salida recortada.

Para probarlo en desarrollo sin tocar el Kyro real de la VM, apuntar `PANEL_KYRO_UPDATE_SCRIPT` en `apps/api/.env` a un script propio (por ejemplo uno que imprima `KYRO_VERSION=9.9.9` y salga con 0 o con 1) y reiniciar la API. Mientras la corrida está `running`, crear un chat o mandar un mensaje responde 409. Para correr el script verdadero a mano: `bash scripts/vm/08-kyro-update.sh ~/proyectos/agents-panel` (ver `vm-setup.md`, paso 14).

## 4. Levantar backend y frontend en la VM

Cada uno en su sesión de tmux, para que sigan corriendo si se corta el SSH:

```bash
# API (con recarga al cambiar el código)
tmux new -d -s panel-api 'cd ~/proyectos/agents-panel && npm run dev -w @agents-panel/api'
# Web (ng serve, http://localhost:4200 dentro de la VM)
tmux new -d -s panel-web 'cd ~/proyectos/agents-panel && npm run start -w @agents-panel/web'
```

- Ver los logs: `tmux attach -t panel-api` (salir sin cortarlo: `Ctrl+b` y después `d`).
- Parar: `tmux kill-session -t panel-api` / `panel-web`.
- Comprobar: `curl http://127.0.0.1:3000/api/health` en la VM. El primer arranque de `ng serve` tarda unos segundos.
- Si cambian los tipos de `packages/shared`: `npm run build -w @agents-panel/shared` antes de reiniciar.
- Para probar el build compilado en vez del modo desarrollo: `npm run build` y `npm run start -w @agents-panel/api` (usa `dist/`).

Este modo es de desarrollo y no sobrevive a un reinicio de la VM. El servicio systemd es de la etapa 6.

## 5. Túnel SSH a la VM (desde la PC)

Requisito: poder entrar con `ssh oracle-vm` (alias en `C:\Users\<usuario>\.ssh\config`, ver [`vm-oracle.md`](vm-oracle.md)).

### Opción A: comando suelto (PowerShell)

```powershell
ssh -N -L 4200:127.0.0.1:4200 oracle-vm
```

- `-N` no abre shell: la ventana queda "colgada" mientras el túnel esté activo (es lo normal). `Ctrl+C` lo cierra.
- Abrir **`http://localhost:4200`** en el navegador e iniciar sesión.
- La cookie de sesión es `Secure`; los navegadores la aceptan en `localhost` aunque sea HTTP. No usar `127.0.0.1` ni la IP de la VM: `PANEL_ORIGIN` no coincidiría.

### Opción B: dejarlo en el `~/.ssh/config` de la PC

Así alcanza con `ssh oracle-vm-panel`:

```
Host oracle-vm-panel
    HostName <IP pública>
    User ubuntu
    IdentityFile C:\Users\<usuario>\.ssh\oracle-vm.key
    LocalForward 4200 127.0.0.1:4200
    ServerAliveInterval 30
    ExitOnForwardFailure yes
```

`ServerAliveInterval` evita que el túnel se corte por inactividad.

### Opción C: la API también en localhost (para ver o probar la API directo)

```powershell
ssh -N -L 4200:127.0.0.1:4200 -L 3000:127.0.0.1:3000 oracle-vm
```

Con eso `http://localhost:3000/api/health` responde desde la PC. Los endpoints protegidos siguen pidiendo sesión.

### Variante: web local, API en la VM

Si se desarrolla el frontend en la PC, alcanza con el túnel del puerto 3000 y levantar `npm run start -w @agents-panel/web` en la PC: el proxy ya apunta a `127.0.0.1:3000`. `PANEL_ORIGIN` sigue siendo `http://localhost:4200`.

## Problemas frecuentes

| Síntoma | Causa y arreglo |
|---|---|
| `bind [127.0.0.1]:4200: Address already in use` | Ya hay algo en el puerto 4200 de la PC (otro túnel o un `ng serve`). Cerrarlo o usar otro puerto (`-L 4300:127.0.0.1:4200`) y ajustar `PANEL_ORIGIN` a `http://localhost:4300`. |
| `Connection refused` al abrir `localhost:4200` | El túnel anda pero la web no está levantada en la VM: `tmux ls` y revisar `panel-web`. |
| La web carga pero el login da 502/504 | La API no está corriendo (`panel-api`) o escucha en otro puerto. |
| Login rechazado (403) aunque la contraseña es correcta | `PANEL_ORIGIN` no coincide con la URL del navegador. Corregir `apps/api/.env` y reiniciar la API. |
| La API no arranca: `PANEL_SECRET_KEY is required` | Falta o es corto el `.env` de `apps/api` (sección 1). |
| Cuenta bloqueada | `user:unlock <usuario>` (sección 2). |
| El túnel se cae solo | Usar la opción B (`ServerAliveInterval`). |
| `ssh` pide contraseña o falla | La IP pública efímera pudo cambiar: actualizar `HostName` (ver `vm-oracle.md`). |

## Seguridad

- El túnel no abre nada nuevo en Oracle ni cuesta nada.
- No exponer el 4200 ni el 3000 con `0.0.0.0` ni abrirlos en la lista de seguridad de Oracle: el login del panel está pensado para quedar detrás de Funnel (etapa 6), no para quedar abierto en la IP pública.
