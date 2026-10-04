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

```bash
npm run -w @agents-panel/api cli -- project:add <nombre> <ruta-del-repo> <rama-base> ["comando de setup"]
# NovaGent (multi-repo):
npm run -w @agents-panel/api cli -- project:add novagent ~/proyectos/ventas dev "bash scripts/panel-setup.sh"
```

Detalle del comando de setup y de `panel-setup.sh` en `vm-setup.md` (paso 10) y en `CLAUDE.md`.

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
