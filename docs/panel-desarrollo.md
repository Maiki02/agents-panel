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

### Probar una pregunta del agente

Para ver de punta a punta que el agente pregunta y que tu respuesta vuelve a su sesión (con la API y la web levantadas, sección 4):

1. En un proyecto, **Nuevo chat → Pedido directo** y pedí, por ejemplo: «Usá AskUserQuestion una vez para preguntarme mi color favorito con las opciones Rojo y Azul y después decime qué elegí».
2. En el chat aparece una tarjeta con un botón por opción y el campo **Otra respuesta**, el badge del encabezado dice **Esperando tu respuesta** (ámbar) y el chat sigue «en curso». Enviar queda deshabilitado, con el motivo al lado, hasta que elijas algo. No vence: podés dejarla abierta.
3. Elegí una opción (o escribí en «Otra respuesta») y **Enviar**. La tarjeta pasa al historial como pregunta y respuesta y el agente sigue y cita lo que elegiste.
4. Para ver el 409, mandá otra vez el POST de abajo: la pregunta ya está respondida.
5. Para ver la cancelación: repetí el pedido y apretá **Cancelar** sin responder, la pregunta queda cancelada y el chat «Cancelado». Si en cambio reiniciás la API (`dev-panel.sh`) con la pregunta abierta, queda cancelada y el chat «Interrumpido»; al mandar un mensaje, el agente retoma y la vuelve a preguntar.

Referencia de la API (piden sesión, CSRF y `Origin`):

| Acción | Llamada | Respuestas |
|---|---|---|
| Listar | `GET /api/chats/:id/questions` | **200** lista de `{ id, toolUseId, questions, status, answer, answeredBy, createdAt, answeredAt }` (`status`: `pending`, `answered`, `cancelled`) |
| Responder | `POST /api/chats/:id/questions/:qid/answer` `{ "answer": { "<texto de la pregunta>": { "selected": ["Azul"], "text": null } } }` | **200** la pregunta respondida, **400** si la opción no existe, falta una pregunta o no hay respuesta, **404** si el chat o la pregunta no existen o son de otro chat, **409** si ya fue respondida o cancelada |

Hay una entrada por pregunta; cada una lleva `selected` (opciones elegidas, una sola si no es de selección múltiple) y/o `text` (hasta 2000 caracteres). Para repetir los spikes que confirmaron el método contra el SDK real (suscripción de la VM, sin tocar el repo): `npx tsx apps/api/scripts/spike-ask-question.ts` y `npx tsx apps/api/scripts/spike-forge-policy.ts` desde `apps/api`.

### Probar modelos por rol, estado y permisos por proyecto

Recorrido manual del sprint 2 de `autopiloto-kyro` (con la API y la web levantadas, sección 4). La web de modelos y el estado fino son del sprint 5: por ahora se ven por la API y la base. La base está en `~/.local/share/agents-panel/panel.sqlite` (`sqlite3` en la VM) y las rutas piden sesión, CSRF y `Origin`, como las de la tabla de arriba.

**A. Modelos por rol y sesiones**

1. Abrí un chat de tipo **Work** (o Scope) en un proyecto con Kyro y esperá a que el primer turno termine. Mandá un segundo mensaje y esperá otra vez.
2. `GET /api/chats/:id` trae `models` (`provider`, `thinker`, `executor`): por defecto `claude-opus-5-5` y `claude-sonnet-5-5`.
3. En la base: `SELECT role, model, sdk_session_id, result FROM agent_sessions WHERE chat_id = <id> ORDER BY id;`. Tienen que verse **dos sesiones**: la primera `thinker` con Opus y la segunda `executor` con Sonnet, cada una con su `sdk_session_id` y `result = 'idle'`. En `GET /api/chats/:id/events` aparecen los eventos `session_started { role, provider, model }` y no debería aparecer `model_mismatch` (si aparece, el modelo que informó `system:init` no es el pedido).
4. Para un override: `PUT /api/projects/:id/models` con `{ "provider": "claude", "thinker": "claude-sonnet-5-5", "executor": "claude-haiku-4-5-20251001" }` y creá otro chat; o `POST /api/chats` con `"models": { "executor": "claude-haiku-4-5-20251001" }`. Un modelo fuera del catálogo da 400 y no crea nada. Cambiar el proyecto después no cambia los modelos de un chat ya creado.
5. Un **Pedido directo** corre siempre con el ejecutor y no tiene estado fino (`GET /api/chats/:id/state` da 404).

**B. Estado fino y Timeline**

1. En el chat Work del paso anterior: `GET /api/chats/:id/state` devuelve el estado (por ejemplo `escribiendo_codigo` con `taskDone`/`taskTotal`) y `GET /api/chats/:id/timeline` las transiciones en orden: `creando_worktree` e `instalando_dependencias` (actor `system`) y los estados que leyó de Kyro al terminar cada turno (actor `agent`, con rol y modelo).
2. Si el agente pregunta, el estado pasa a `esperando_respuesta` y al responder vuelve al anterior (actor `user`). Si reiniciás la API con un turno en curso, el trabajo queda `interrumpido` (actor `system`).

**C. Permisos por proyecto**

1. **Proyectos → tu proyecto → Configuración → Permisos**. Se ven la base, los comandos y hosts extra (vacíos), la lista de los que nunca se habilitan (`oci`, `sudo`, `ssh`…) y, si el repo tiene `uv.lock`, `pyproject.toml`, `Makefile` o `Cargo.toml`, las sugerencias.
2. Tocá **Agregar** en una sugerencia (o escribí un comando como `uv`). No se guarda: **Guardar cambios** pide el código de la app. Probá también un nombre inválido (`/usr/bin/uv`, `uv run`) y uno denegado (`sudo`): la pantalla explica por qué no se puede.
3. Con el comando guardado, abrí un chat del proyecto y pedile al agente que lo corra (por ejemplo `uv --version`): se ejecuta. Sin guardarlo, queda un evento `permission_denied`. Pedile también `curl https://example.com`: queda `permission_denied` porque el host no está listado; agregalo en **Hosts de curl** y vuelve a funcionar (solo GET/HEAD). `curl http://localhost:3000` anda sin configurar nada.

Al terminar, contale al agente qué pasó en cada paso: el resultado se registra en Kyro (`debt-1` y la tarea T4.3 del sprint 2).

### Probar el piloto automático (por la API)

Recorrido del sprint 3 de `autopiloto-kyro`. La web del piloto (interruptor, pausar, preguntas con botones) es del sprint 5: por ahora se maneja por la API con la sesión y el token CSRF de una sesión de la web (sección 4). Pruebalo primero con un **Work de prueba** que solo cambie un archivo de doc (D31: el piloto se estrena con el usuario mirando), nunca con un scope real.

1. **Activar:** `POST /api/chats` con `"kind": "work"`, `"autopilot": true` y un pedido chico (por ejemplo «agregá una línea al README»). Un pedido directo con `autopilot: true` da 400.
2. **Mirar:** `GET /api/chats/:id/autopilot` trae `{ run, maxSessionsPerSprint }` (`run.status`, `run.step`, `run.sessionsInSprint`, `run.stopReason`); `GET /api/chats/:id/state` y `/timeline` traen el estado fino y las transiciones con actor `pilot`.
3. **Pausar y seguir:** `POST /api/chats/:id/autopilot` con `{ "action": "pause" }`: el turno en curso termina y el piloto no abre el siguiente (estado `pausado`). `{ "action": "resume" }` lo retoma (también si estaba `stopped`: el tope de sesiones y el motivo se reinician). `{ "action": "off" }` lo apaga y el chat queda en modo manual; vuelve a encenderse con `resume`. Una acción que no corresponde al estado da 409.
4. **En la base** (`~/.local/share/agents-panel/panel.sqlite`): `SELECT step, role, model, policy_version, result FROM agent_sessions WHERE chat_id = <id> ORDER BY id;` muestra una sesión por paso (plan con Opus, ejecución y cierre con Sonnet) y `SELECT * FROM autopilot_runs WHERE chat_id = <id>;` el estado del piloto.
5. **Frenos:** el piloto se detiene con el motivo en `run.stopReason` (por ejemplo, deuda abierta, un conflicto o un build roto; el cierre y el merge se prueban en la sección siguiente). Si frena por `sin_avance` o `tope_de_sesiones`, resolvelo y mandá `resume`.
6. **Reinicio:** con el piloto a mitad de un paso, matá la API y levantala de nuevo: retoma solo el mismo paso con `resume` de su sesión (sin mensaje tuyo). Un run pausado o apagado no se retoma.
7. El tope de sesiones por sprint sale de `PILOT_MAX_SESSIONS_PER_SPRINT` en el `.env` de la API (6 por defecto).

**Importante:** hasta tener el servicio systemd (etapa 6), cerrar la terminal donde corre la API la corta y con ella el piloto. Levantala dentro de `tmux` (`tmux new -s panel`, y desconectate con `Ctrl-b d`) para que sobreviva a cerrar la conexión SSH; si la VM se reinicia, al levantar la API los pilotos activos se retoman solos.

### Probar una Idea, su aprobación y el cierre con merge

Recorrido del sprint 4 de `autopiloto-kyro`. **Usá siempre un repo de prueba** (un clon descartable con Kyro inicializado y un remoto que no sea el real: por ejemplo un repo vacío tuyo en GitHub, o un remoto *bare* local), nunca `ventas` ni este repo. Con `gh` autenticado solo hace falta para abrir la PR; el panel nunca la mergea. Se maneja por la API con la sesión y el token CSRF de la web (sección 4) hasta el sprint 5.

1. **Preparar el repo de prueba:** registralo en **Proyectos → Nuevo proyecto**, con rama base `main`. Opcional: `PATCH /api/projects/:id` con `{ "validateCommand": "npm test" }` (o cualquier comando que termine en 0) para ver la validación; sin él, el Timeline anota que no hubo validación.
2. **Crear la Idea:** `POST /api/chats` con `"kind": "idea"`, un `slug` y el pedido. No lleva `autopilot` (con `true` da 400: el piloto se prende al aprobar) y un proyecto sin Kyro da 409. El estado queda en `madurando_idea` (`GET /api/chats/:id/state`).
3. **Esperar el plan:** el agente (modelo pensante, skill `kyro-idea`) escribe **un** documento en `.agents/kyro/<docType>/`. Cuando el turno termina, el estado pasa a `esperando_aprobacion_plan` y `GET /api/chats/:id/idea` trae `{ state, path, documents, content }`. Si escribe dos documentos queda `bloqueado` con la lista; si no escribe ninguno, sigue `madurando_idea`.
4. **Decidir** con `POST /api/chats/:id/idea`:
   - `{ "action": "request_changes", "text": "…" }`: el texto vuelve a la misma sesión y el estado a `madurando_idea` (sin texto da 400).
   - `{ "action": "approve_work" }`: el panel corre `kyro work create --id <slug> --from <ruta> --by <usuario> --json`; el chat pasa a `work` y el piloto arranca con la planificación.
   - `{ "action": "approve_scope" }`: el chat pasa a `scope` y el piloto abre un paso `init` (kyro-forge en modo INIT sobre el documento) y sigue con el sprint 1.
   - Fuera de `esperando_aprobacion_plan` da 409; sin sesión 401 y sin CSRF 403. Cada decisión queda en `GET /api/chats/:id/timeline` con actor `user`, la ruta y el usuario.
5. **Seguir el piloto** como en la sección anterior. Al terminar cada sprint verificá que la rama quedó en el remoto (`git ls-remote origin feature/<slug>`) y que la base del remoto no se movió.
6. **Cierre del scope:** sin deuda abierta el panel corre `kyro scope complete --yes` y commitea solo `.agents/kyro/` (`chore(kyro): completar scope <slug>`). Con deuda abierta frena **una vez** en `esperando_aprobacion_cierre` con la lista en el Timeline; para seguir, `POST /api/chats/:id/autopilot` con `{ "action": "accept_debt", "reason": "…" }` (el motivo es obligatorio). Un work en `ready_to_close` se cierra con `kyro work close --outcome completed`.
7. **Merge:** para probar un conflicto, adelantá la base del remoto con un cambio sobre el mismo archivo que tocó la rama: aparece `trayendo_dev` → `resolviendo_conflictos` (sesión `merge` del ejecutor) → `validando_post_merge` → `abriendo_pr` → `pr_lista`. La URL queda en el Timeline y en `autopilot_runs.pr_urls`. Si el repo de prueba tiene `.claude/skills/merge-dev/SKILL.md`, el piloto usa esa skill (sesión `merge_dev`).
8. **Frenos para forzar:** un `validate_command` que falla → `build_roto` (sin PR); un `.env` o un token de mentira en el diff → `secretos` (el Timeline lista archivo y tipo, nunca el valor); un worktree sin `origin` → `git`; un informe de QA sin `Verdict:` → `qa_sin_aprobar`. Cada uno se resuelve y se retoma con `resume`.
9. **Reinicio en la fase de merge:** con el piloto en `trayendo_dev`, matá la API y levantala: lee `autopilot_runs.phase = 'merge'` y retoma el merge (el pull, el push y la PR son idempotentes: una PR abierta de la rama se reusa).
10. **Limpieza:** el panel no borra nada solo. Cerrá la PR de prueba a mano y borrá la rama del remoto y el worktree de prueba.

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
