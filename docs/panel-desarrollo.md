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

### Desde la web (lo normal)

En **Proyectos** (la pantalla inicial) apretá **Nuevo proyecto**: se abre un modal donde pegás la **URL completa** del repo (`https://github.com/usuario/repo`; con `/tree/<rama>` al final se toma esa rama como base) y, si querés, un nombre visible. Se cierra con la cruz, con Esc o al agregar. La tarjeta pasa de *Clonando* a *Listo* (o *Error* con el motivo y un botón Reintentar) sin recargar, con el estado a la derecha y el link al repo. Si el repo trae `scripts/panel-setup.sh`, la tarjeta sugiere `bash scripts/panel-setup.sh`: confirmalo, editalo o elegí *Sin setup*; hasta entonces no se guarda nada. Un valor que no sea una URL de GitHub se rechaza en el formulario y en la API.

Al elegir un proyecto (`/projects/:id`) se abre su página, con un riel lateral **Chats** y **Configuración**. En **Chats**, a la izquierda están el botón **Nuevo chat** y la lista de chats del proyecto (título, rama y estado); por defecto se abre *Nuevo chat*, y si ya habías elegido un chat, al volver al proyecto se reabre ese. En **Configuración** hay dos pestañas: **General** (nombre visible, rama base y comando de setup; vacío = sin setup) y **Environment** (los `.env`, explicados más abajo). La actualización de Kyro está en **Versiones**, en el menú de arriba.

### Desde la API (referencia)

Lo que hace la web es `POST /api/projects`, que clona el repo en `PANEL_PROJECTS_DIR` (por defecto `~/proyectos`) y lo registra. Hace falta la cookie de sesión y el token CSRF de `GET /api/auth/me`, más el header `Origin` igual a `PANEL_ORIGIN`:

```json
{
  "repo": "owner/repo",
  "name": "mi-proyecto",
  "displayName": "Mi Proyecto",
  "baseBranch": "dev",
  "setupCommand": "bash scripts/panel-setup.sh"
}
```

- Solo `repo` es obligatorio: la URL completa `https://github.com/owner/repo` (con o sin `.git`; la web pide esta forma) o, como referencia de la API, `owner/repo`. Si la URL trae `/tree/<rama>` (por ejemplo `https://github.com/owner/repo/tree/dev` o `…/tree/feature/x`), esa rama es la base del proyecto; un `baseBranch` explícito gana sobre la de la URL. Otros caminos (`/blob/…`), ramas con caracteres raros, query o fragmento se rechazan con 400. El resto es opcional: `name` (kebab-case; si falta sale del repo), `displayName` (nombre visible), `baseBranch` (si falta, la rama por defecto del clon) y `setupCommand`.
- Cualquier otro campo (por ejemplo una ruta de carpeta) o un repo que no sea de GitHub se rechaza con 400: el destino lo decide siempre el panel.
- **202**: el clon sigue en segundo plano y el proyecto está en `cloning`. **201**: la carpeta ya existía con ese origin y se adoptó (queda `ready`). **409**: el proyecto ya existe, o la carpeta existe con otro origin.
- Seguir el estado con `GET /api/projects/:id` (`cloning`, `ready` o `error` con `statusDetail`). Si falló, `POST /api/projects/:id/retry`. Un chat sobre un proyecto que no está `ready` responde 409.
- `GET /api/projects/:id` incluye `suggestedSetupCommand` (`bash scripts/panel-setup.sh`) cuando el repo trae ese script y el setup está vacío. No se aplica solo: se guarda con `PATCH /api/projects/:id` (`displayName`, `baseBranch`, `setupCommand`).
- `hasKyro` indica si el repo trae `.agents/kyro/`; en ese caso se inicializa Kyro al quedar listo y, si falla, `kyroWarning` lo avisa sin revertir el proyecto. Sin Kyro, crear un chat `work` o `scope` responde 409; `direct` se acepta siempre. Para agregarle Kyro, ver «Operar un proyecto».
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

### `.env` de desarrollo del proyecto

Desde la web: página del proyecto → Configuración → pestaña **Environment**. Elegí la ruta dentro del proyecto (`.env`, `backend/.env`, `.env.local`…), cargá el archivo o pegá el texto, marcá si querés aplicarlo también a los worktrees activos y confirmá en el modal con el código TOTP de la app (uno nuevo por acción; si es incorrecto el modal sigue abierto y solo volvés a escribir el código). El panel no muestra el contenido de ningún `.env`: se lista ruta, claves y fecha; para cambiar uno se sube de nuevo, y para quitarlo se usa Borrar (también con TOTP). Un `.env` marcado «ilegible» hay que volver a subirlo. Después de aplicar a los activos se ve una tabla por worktree: escrito u omitido con el motivo (por ejemplo «agente en curso».

Referencia de la API:

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

- **201** si se creó, **200** si reemplazó uno con la misma ruta. Responde `{ "file": { "path", "keyNames", "updatedAt", "readable" } }`; con `"applyToActive": true` suma `applied`: por cada worktree activo del proyecto, `written` o `skipped` con el motivo. Los chats con el agente corriendo se omiten («agente en curso: se aplica cuando termine o en el próximo chat»); reciben el archivo en su próximo chat.
- **400** con el motivo: ruta o nombre inválido (`.env.production`, `.env.example`, `../.env`…), contenido de más de 64 KB, con NUL o con una línea que no es `CLAVE=valor` (cita el número de línea), un campo de más, o una ruta que git **no** ignora en el clon (sumala al `.gitignore` del repo).
- **401** `{ "error": "invalid_totp" }`: falta el código, es incorrecto o ya se usó. Cuenta para el bloqueo por intentos (`user:unlock` si hace falta).
- **404** si el proyecto no existe; **409** si todavía no está `ready`.

Listar (`GET /api/projects/:id/env`): devuelve ruta, nombres de las claves, fecha y `readable`. El contenido no se puede ver: para cambiarlo, se vuelve a subir.

Borrar (`DELETE /api/projects/:id/env`, body `{ "path": "backend/.env", "totp": "123456" }`): **200**, o **404** si esa ruta no tiene `.env`.

Si se cambia `PANEL_SECRET_KEY`, los `.env` guardados quedan con `readable: false` y crear un chat en ese proyecto responde 422 hasta volver a subirlos. Si el setup no crea la carpeta de algún `.env` (por ejemplo `backend/`), crear el chat también responde 422 («falta la carpeta backend para backend/.env») y no queda nada creado.

### Operar un proyecto

Desde la página del proyecto, **Configuración**:

- **Repositorio → Traer cambios de GitHub:** actualiza el clon base de la VM (solo fast-forward), para que los worktrees nuevos partan de lo último que subiste. Si el clon tiene cambios locales o se desvió de GitHub no hace nada y lo explica.
- **Repositorio → Inicializar Kyro** (solo si el proyecto no lo tiene): pide un código TOTP y crea la rama `chore/kyro-init` en su propio worktree (`~/wt/<proyecto>/kyro-init`) con un commit. Revisala, pusheala y mergeala a la rama base; mientras tanto el proyecto sigue sin Kyro. Las skills de Kyro no se copian al proyecto: son globales de la VM y el panel las enlaza en `~/.claude/skills` después de instalar. Para descartarla: `git worktree remove ~/wt/<proyecto>/kyro-init` y `git branch -D chore/kyro-init` en el clon.
- **General → Borrar proyecto:** modal con el nombre del proyecto y un código TOTP. Borra el clon, los worktrees, los chats y los `.env` cifrados de la VM; no toca GitHub. Si hay trabajo sin commitear o sin pushear (en el clon, en un worktree o en un repo hijo), o una sesión corriendo, no borra nada y lista los motivos: commiteá y pusheá (o cancelá la sesión) y repetí. Una carpeta fuera de `PANEL_PROJECTS_DIR` se desregistra pero no se borra.

Un proyecto sin Kyro solo ofrece **Pedido directo** al crear un chat (sin skill de Kyro); con Kyro ofrece Work, Scope y Pedido directo.

Referencia de la API (todas piden sesión, CSRF y `Origin`):

| Acción | Llamada | Respuestas |
|---|---|---|
| Traer cambios | `POST /api/projects/:id/pull` | **200** `{ status, before, after, commits, ahead, output }`, **409** (cambios locales, otra rama, divergencia, no listo), **502** (git falló) |
| Inicializar Kyro | `POST /api/projects/:id/kyro-init` `{ "code": "123456" }` | **200** `{ branch, path, commit }`, **401** `invalid_totp`, **409**, **500** si `kyro install` falló (no queda nada) |
| Borrar | `DELETE /api/projects/:id` `{ "name": "mi-proyecto", "code": "123456" }` | **200** `{ cloneRemoved }`, **400** nombre distinto, **401** `invalid_totp`, **409** `{ error, blockers, running }`, **500** borrado a medias (reintentable) |

### Actualizar Kyro

Desde la web: menú **Versiones**. Muestra la versión instalada y la última publicada, y un icono de refresh (**Actualizar Kyro**) que abre el modal de código TOTP. Si hay sesiones corriendo (409 con la cantidad), el aviso aparece dentro del modal. Mientras actualiza, el icono gira y queda deshabilitado, la pantalla se refresca sola y el historial de corridas muestra la salida desplegable.

Referencia de la API:

`POST /api/versions/kyro/update` con la sesión, el token CSRF y `{ "code": "123456" }` (un TOTP vigente que no se haya usado) corre `scripts/vm/08-kyro-update.sh` con las raíces de los proyectos listos que tienen Kyro. Responde **202** `{ "runId": 1 }`, **401** `{ "error": "invalid_totp" }`, o **409** si hay sesiones corriendo (`running` trae la cantidad) o ya hay una actualización en curso. `GET /api/versions` muestra la versión instalada y la última publicada (`null` sin red), y `GET /api/maintenance-runs?kind=kyro-update` el historial con la salida recortada.

Si algún proyecto tiene cambios locales fuera de `.agents/kyro/`, esa raíz se saltea (el resto y la parte global se actualizan igual) y la corrida lo informa dentro de su detalle; limpiá esos cambios y actualizá de nuevo. Si el update deja `.agents/kyro/project.json` modificado, el proyecto muestra «Kyro actualizado en el clon: hay cambios por commitear»: se commitea con un work o con el botón Commit de un worktree, no a mano sobre el clon base.

Para probarlo en desarrollo sin tocar el Kyro real de la VM, apuntar `PANEL_KYRO_UPDATE_SCRIPT` en `apps/api/.env` a un script propio (por ejemplo uno que imprima `KYRO_VERSION=9.9.9` y salga con 0 o con 1) y reiniciar la API. Mientras la corrida está `running`, crear un chat o mandar un mensaje responde 409. Para correr el script verdadero a mano: `bash scripts/vm/08-kyro-update.sh ~/proyectos/agents-panel` (ver `vm-setup.md`, paso 14).

## 4. Levantar backend y frontend en la VM

Lo más simple, desde cualquier carpeta de la VM: `bash ~/proyectos/agents-panel/scripts/dev-panel.sh`. Mata las sesiones `panel-api` y `panel-web` si existen, compila `packages/shared`, levanta la API y la web cada una en su sesión de tmux y espera a que `/api/health` responda. Sirve también para reiniciar después de cambiar código. A mano, lo mismo (hay que estar parado en el repo):


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
