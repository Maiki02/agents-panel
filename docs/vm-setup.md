# Runbook de la VM

Todo lo que se instaló y configuró en la VM, en orden, para poder rehacerla desde cero. Regla del repo: ningún cambio en la VM queda fuera de este documento (ver `CLAUDE.md`).

## La VM

| Dato | Valor |
|---|---|
| Nombre | `vm-ia` |
| Proveedor / región | Oracle Cloud, Brazil East (São Paulo), AD-1 |
| Shape | VM.Standard.A1.Flex (Ampere, ARM64), 2 OCPU / 12 GB (tope Always Free desde 15/06/2026) |
| SO | Ubuntu 26.04 LTS, usuario `ubuntu` |
| Disco | 200 GB boot volume (tope gratis) |
| Red | Solo el puerto 22 abierto. IP pública efímera |
| Acceso | `ssh oracle-vm` desde la PC (alias en `~/.ssh/config` de Windows) |
| Seguridad base | Login solo con clave SSH, fail2ban, unattended-upgrades (configurado al crear la VM) |

La creación de la VM en Oracle (cuenta, instancia, red, IP, SSH, alerta de presupuesto) está en [`vm-oracle.md`](vm-oracle.md).

## Pasos

### 0. Copiar los scripts a la VM (desde la PC, PowerShell) — obligatorio antes del paso 1

```powershell
scp C:\Users\miqui\Proyectos\agent-panel\scripts\vm\*.sh oracle-vm:~/
```

Cuando el repo esté en GitHub, alcanza con clonarlo en la VM (`~/agents-panel`).

### 1. Base: `scripts/vm/01-base.sh`

```bash
bash ~/01-base.sh
```

| Qué | Cómo | Por qué |
|---|---|---|
| Paquetes base | `apt`: git, tmux, build-essential, curl, jq, unzip, xz-utils, ripgrep, sqlite3, time | Herramientas de trabajo y de los scripts |
| Swap 8 GB | `/swapfile` en `/etc/fstab`, `vm.swappiness=10` en `/etc/sysctl.d/99-agents-panel.conf` | Colchón para picos de RAM en builds de Angular |
| Node 24 LTS | Binario oficial en `/opt/node`, links en `/usr/local/bin` | Angular 21 y el panel. Versión fija, sin depender del apt de Ubuntu |
| npm global sin sudo | `npm config set prefix ~/.npm-global` | Instalar CLIs (Kyro) sin root |
| Go 1.25.x | Binario oficial en `/usr/local/go`, serie fijada en `GO_SERIES` | Misma serie que `go.mod` de be-ventas. Con go1.27, `go vet` (que corre dentro de `go test`) falla en código que en la PC pasa |
| GitHub CLI | Repo apt oficial de `cli.github.com` | PRs, checks y credenciales de git |
| Claude Code | Instalador nativo `claude.ai/install.sh` → `~/.local/bin/claude` | El agente |
| Kyro 6 | `npm i -g kyro-ai@latest` + `kyro install --agent claude` | Flujo de trabajo; en v6 las skills `kyro-*` van a `~/.claude/skills/` |
| PATH | Bloque `# >>> agents-panel >>>` en `~/.profile` y `~/.bashrc` | `~/.local/bin`, `~/.npm-global/bin`, `/usr/local/go/bin`, `~/go/bin` |
| git global | `user.name Maiki02`, `user.email`, `init.defaultBranch main`, `pull.rebase false` | Igual que en la PC; `merge-dev` usa `pull --no-rebase` |

El log de cada corrida queda en `~/agent-panel-setup.log`.

### 2. Logins (manuales, una sola vez)

| Qué | Comando en la VM | Nota |
|---|---|---|
| GitHub | `gh auth login` → GitHub.com → HTTPS → "Authenticate Git" Yes → login con navegador | Muestra un código de un solo uso; se carga en `github.com/login/device` desde la PC. El aviso "Failed to copy one-time code to clipboard" es normal (la VM no tiene portapapeles). Después de autorizar, Enter en la VM; que no abra un navegador también es normal |
| Claude | `claude` → `/login` → cuenta de claude.ai | Usa la suscripción. Abre una URL; se completa en el navegador y se pega el código |

### 3. NovaGent: `scripts/vm/02-novagent.sh`

```bash
bash ~/02-novagent.sh
```

- Configura git para usar las credenciales de `gh` (`gh auth setup-git`).
- Clona con `--filter=blob:none` (clon parcial: be-ventas tiene ~590 MB de historial por binarios viejos) y `--progress`. Clona en `~/proyectos/ventas`: NovaGent (raíz), y adentro `fe-ventas` y `be-ventas` en la rama `dev`. Mismo layout que en la PC.
- Instala dependencias (`go mod download`, `npm ci`).
- Inicializa Kyro en el workspace (crea el `local.json` de esta máquina; está en `.gitignore`).

### 4. Archivos que no están en git (desde la PC, PowerShell)

```powershell
# .env de desarrollo de be-ventas (nunca .env.production)
scp C:\Users\miqui\Proyectos\ventas\be-ventas\.env C:\Users\miqui\Proyectos\ventas\be-ventas\.env.local C:\Users\miqui\Proyectos\ventas\be-ventas\.env.development oracle-vm:~/proyectos/ventas/be-ventas/
# Agente global git-committer
ssh oracle-vm "mkdir -p ~/.claude/agents"
scp C:\Users\miqui\.claude\agents\git-committer.md oracle-vm:~/.claude/agents/
```

En la VM: `chmod 600 ~/proyectos/ventas/be-ventas/.env*`.

### 5. Verificación: `scripts/vm/03-verify.sh`

```bash
bash ~/03-verify.sh
```

Pasa si: `kyro doctor` OK, `go build ./... && go test ./...` OK y `npm run build:client` termina. Además deja anotados la memoria máxima del build y el uso de disco.

Para revisar el log desde la PC:

```powershell
mkdir C:\Users\miqui\Proyectos\agent-panel\.logs -Force
scp oracle-vm:~/agent-panel-setup.log C:\Users\miqui\Proyectos\agent-panel\.logs\
```

Mediciones de referencia (03/10/2026, Go 1.25.14): `go test ./...` OK (el paquete `services` tarda ~20 s); `npm run build:client` tarda **25–29 s** y usa **1,7–2,4 GB** de RAM como pico. Después de todo el setup: 1,5 GB de RAM en uso, swap sin usar, **15 GB de disco** usados de 193 GB.

### 6. Permisos de Claude Code: `scripts/vm/04-claude-permisos.sh`

```powershell
scp C:\Users\miqui\Proyectos\agent-panel\scripts\vm\04-claude-permisos.sh oracle-vm:~/
ssh oracle-vm "bash ~/04-claude-permisos.sh"
```

Sin esto, Claude pide permiso para cada comando y el flujo no es automático. Escribe en `~/.claude/settings.json` (con backup):

- `model: sonnet`: modelo por defecto. Con el plan Pro, Opus agota el límite de uso muy rápido; se usa `/model opus` solo cuando hace falta (por ejemplo, planificar un scope grande).
- `defaultMode: acceptEdits`: edita archivos sin preguntar.
- `additionalDirectories`: `~/.agents` (runtime de Kyro), `~/.claude`, `~/proyectos`, `/tmp`. Sin esto, Claude pide permiso cada vez que lee el runtime de Kyro, que está fuera de la carpeta del proyecto.
- **Permitido:** git, gh, go, npm/npx/node, kyro y comandos de lectura y archivos (ls, cat, rg, find, mkdir, cp, mv…).
- **Push y PRs (explícitos):** `git push` solo de ramas `feature-…` / `feature/…` y de `main` (raíz), `gh pr create/list/view/checks/edit`. Hacen falta reglas explícitas porque el modo auto considera riesgoso todo lo que sale a GitHub.
- **Bloqueado siempre:** push directo a `dev`, `git push --force`, `git rebase`, `gh pr merge` (las PRs las mergea el usuario), `sudo`, deploys (`npm run deploy*`, `sls deploy`) y leer `.env.production`.

### 7. Repo agents-panel en la VM

```bash
git clone https://github.com/Maiki02/agents-panel.git ~/proyectos/agents-panel
cd ~/proyectos/agents-panel && npx --yes kyro-ai@latest install --init-workspace --yes
```

Desde acá, los scripts de `scripts/vm/` se corren desde el repo clonado (`git pull` para actualizarlos). Ya no hace falta `scp`.

### 8. Claude desde la web: `scripts/vm/05-remote-control.sh`

```bash
tmux kill-session -t etapa2 2>/dev/null; tmux kill-session -t claude 2>/dev/null   # servers viejos, si quedaron
bash ~/proyectos/agents-panel/scripts/vm/05-remote-control.sh --install
```

- Levanta un server de **Remote Control** por proyecto, cada uno en su sesión de tmux: `rc-ventas` (`~/proyectos/ventas`, `--spawn same-dir`) y `rc-agents-panel` (`~/proyectos/agents-panel`, `--spawn worktree`: cada sesión nueva en su propio worktree).
- Todos con `--permission-mode auto` (permisos del paso 6).
- `--install` crea el servicio de usuario `claude-remote-control.service` y activa `loginctl enable-linger`, así los servers arrancan solos cuando se reinicia la VM, sin sesión SSH abierta.
- Marca cada carpeta como confiable en `~/.claude.json` (`hasTrustDialogAccepted`). Sin eso, el server de una carpeta nueva queda esperando `Trust …? [y/N]` dentro de tmux y no aparece en la web.
- **Uso:** en la PC, **claude.ai/code**. Cada server es un **entorno**: para una sesión nueva, *Nuevo* → selector de entorno (el botón que dice "Predeterminado") → el de la VM (`NovaGent`, `agents-panel`). "Predeterminado" solo es la nube de Anthropic, no la VM. Las sesiones existentes aparecen en *Recientes*.
- Una sesión que ya existía conserva su nombre (por ejemplo `vm-ia-parallel-acorn` en rc-ventas); el prefijo `rc-…` aplica a las nuevas.
- Ver un server: `tmux attach -t rc-ventas` (salir sin cortarlo: `Ctrl+b` y después `d`).
- Después de cambiar permisos (paso 6): `bash …/05-remote-control.sh --stop` y de nuevo sin flags.
- Para sumar un proyecto, agregar una línea en `PROJECTS` del script.

### 9. El Agent SDK reutiliza el login de Claude Code (verificación, sin cambios en la VM)

El panel usa `@anthropic-ai/claude-agent-sdk` (`apps/api/src/agent/sdk-runner.ts`). El SDK trae su propio binario de Claude Code (`@anthropic-ai/claude-agent-sdk-linux-arm64`, sale de `npm ci`) y **reutiliza la sesión de `~/.claude/.credentials.json`**: no hace falta `claude setup-token` ni una API key (el mensaje `system:init` informa `apiKeySource: "none"`, es decir, OAuth de la suscripción).

Verificación (costo: unos pocos tokens de la suscripción, US$0 extra): un script temporal fuera del repo corrió `SdkRunner` con `cwd` en un repo git de prueba. Resultado: el asistente respondió, `git status` se permitió, `curl` se negó por la allowlist (`permission_denied`) y la corrida terminó en `result:success`.

Si el login de la VM vence, el panel falla con error de autenticación del SDK; se renueva con `claude` (login interactivo) en la VM.

### 10. Panel en desarrollo (etapa 4)

Deja el panel corriendo en la VM para desarrollo, accesible solo por túnel SSH (Funnel y systemd son de la etapa 6).

1. **`.env` de desarrollo de la API** (no se commitea; `.gitignore` ya lo cubre). Se genera la clave sin mostrarla y el archivo queda con permisos 600:

   ```bash
   cd ~/proyectos/agents-panel
   umask 077
   printf 'PANEL_SECRET_KEY=%s\nPANEL_ORIGIN=http://localhost:4200\nHOST=127.0.0.1\nPORT=3000\n' "$(openssl rand -base64 48)" > apps/api/.env
   ```

   Por qué: la API no arranca sin `PANEL_SECRET_KEY` (≥ 32 bytes; cifra el secreto TOTP) ni `PANEL_ORIGIN` (chequeo de Origin y CORS-less same-origin). Si se pierde o cambia la clave, hay que rehacer el segundo factor de cada usuario (`user:reset-2fa`).

2. **Dependencias:** `npm ci` (el SDK trae su binario de Claude Code para linux-arm64).
3. **Usuario real** (lo hace la persona, porque elige la contraseña y escanea el QR; no se pega nada acá):

   ```bash
   npm run -w @agents-panel/api cli -- user:create <usuario>
   ```

4. **Registrar un proyecto** (la base queda en `~/.local/share/agents-panel/panel.sqlite`, directorio 700):

   ```bash
   npm run -w @agents-panel/api cli -- project:add <nombre> <ruta-del-repo> <rama-base> ["comando de setup"]
   ```

   El comando de setup se ejecuta sin shell dentro del worktree nuevo (por ejemplo `npm ci`). Los worktrees se crean en `~/wt/<proyecto>/<slug>` (`PANEL_WORKTREES_DIR` lo cambia).
   **NovaGent (raíz + fe-ventas + be-ventas)** es un solo proyecto: la raíz es el `repoPath` y el setup arma los dos repos hijos con `scripts/panel-setup.sh` (vive en el repo `ventas`):

   ```bash
   npm run -w @agents-panel/api cli -- project:add novagent ~/proyectos/ventas dev "bash scripts/panel-setup.sh"
   ```

   Qué hace el script dentro de `~/wt/novagent/<slug>` (idempotente): clona fe-ventas y be-ventas desde GitHub con `--reference` a las copias locales (el `origin` queda en GitHub, así `merge-dev` puede pushear y abrir la PR), crea la rama `feature-<slug>` desde `origin/dev` (el slug sale del nombre de la carpeta), copia solo `.env`, `.env.local` y `.env.development` de be-ventas (600, nunca producción), y corre `go mod download` y `npm ci`. Requiere que `~/proyectos/ventas/fe-ventas` y `be-ventas` existan (paso 3) y que el repo `ventas` esté actualizado en la VM (`git pull`). Se verifica creando un work desde el panel y mirando `git -C ~/wt/novagent/<slug>/fe-ventas remote -v` (GitHub) y `branch --show-current` (`feature-<slug>`).
5. **Levantar** (dos terminales o tmux): `npm run dev -w @agents-panel/api` y `npm run start -w @agents-panel/web`.
6. **Entrar desde la PC** con un túnel SSH (el host es el del `~/.ssh/config`, ver `docs/vm-oracle.md`): `ssh -L 4200:127.0.0.1:4200 oracle-vm` y abrir `http://localhost:4200`.

Verificación (2026-10-04, API y web reales con una base y un repo descartables en la carpeta temporal de la sesión; no se tocó la base real): login con contraseña + TOTP por el proxy de `ng serve` (`/api/auth/me` 401 sin sesión, 200 con sesión; logout sin `X-CSRF-Token` 403); crear un work contra un repo de prueba (worktree y rama `feature/e2e-demo`, sesión del SDK, 8 eventos, estado `idle`); SSE por el proxy con `Last-Event-ID`; apagar la API con `kill -9` en medio de un turno → al volver el chat quedó `interrupted`; mandar un mensaje retomó la **misma** sesión del SDK (`sdk_session_id` idéntico) y el agente recordó el contexto anterior.

No cambia costos: usa la suscripción Claude existente y la VM Always Free.

**Pendiente de confirmar a mano en un navegador** (la VM no tiene uno): las tres pantallas de la web (login en dos pasos, lista con formulario, chat en vivo).

### Pendiente (etapas siguientes del plan)


- Tailscale + Funnel (etapa 6).
- Servicio systemd del panel (etapa 6).

## Costos

Regla del repo (`CLAUDE.md`): todo cambio que pueda modificar lo que se paga se avisa y se aprueba antes.

| Fecha | Recurso / cambio | Costo mensual estimado | Aprobado por |
|---|---|---|---|
| 2026-10-02 | Instancia A1 2 OCPU / 12 GB + boot volume 200 GB (dentro de Always Free) | US$0 | Miqueas |
| 2026-10-03 | Etapa 1 (paquetes, swap en el disco existente, Node, Go, gh, Claude Code, Kyro, repos) | US$0: no agrega recursos de Oracle | — |
| 2026-10-03 | Permisos de Claude Code y Remote Control (servicio systemd de usuario) | US$0 (usa la suscripción Claude Pro existente) | — |
| 2026-10-04 | Panel en desarrollo (etapa 4): `.env`, base SQLite local, worktrees en `~/wt`, sesiones del Agent SDK con la suscripción existente | US$0: sin recursos nuevos de Oracle ni planes pagos | — |

## Bitácora

| Fecha | Qué se hizo | Resultado |
|---|---|---|
| 2026-10-02 | VM creada en Oracle, SSH, fail2ban, unattended-upgrades | OK (ver proyecto "VM") |
| 2026-10-03 | `01-base.sh` (primera corrida; antes falló porque faltaba el `scp` de los scripts) | OK: node v24.21.0, npm 11.19.0, go1.27.1, gh 2.102.0, Claude Code 2.1.288, Kyro 6.0.2 (`kyro install --agent claude` OK), swap 8G |
| 2026-10-03 | `gh auth login` (navegador + código) | OK: logueado como Maiki02 |
| 2026-10-03 | `claude` → login con suscripción | OK: Claude Code 2.1.288, plan Claude Pro, modo de permisos por defecto "auto" |
| 2026-10-03 | `02-novagent.sh` (1ª corrida) | NovaGent y fe-ventas OK. be-ventas parecía trabado: era el clon completo de ~590 MB sin barra de progreso (la salida va al log). Se agregó `--filter=blob:none --progress` al script |
| 2026-10-03 | `02-novagent.sh` (continuación) | OK: be-ventas clonado completo (~590 MB), fe/be en `dev`, `go mod download` y `npm ci` OK (primer `npm ci` unos minutos, sin caché). Kyro workspace instalado con adapter `standard` (el de Claude ya estaba global) |
| 2026-10-03 | Copia de `.env`, `.env.local`, `.env.development` de be-ventas (`chmod 600`) y de `git-committer.md` a `~/.claude/agents/` | Hecho por scp desde la PC |
| 2026-10-03 | `03-verify.sh` | `kyro doctor`: 13/13 PASS. `build:client`: OK en 29 s, pico 2,4 GB. `go test`: **FALLA** `internal/core/services`: `go vet` de go1.27.1 marca `employee_service_test.go:531` (condición repetida `len(userRepo.users) != 1 \|\| len(userRepo.users) != 1`). Decisión: fijar Go a 1.25.x como en go.mod; el test igual tiene un bug a corregir en be-ventas |
| 2026-10-03 | `01-base.sh` actualizado (Go fijado a 1.25.x) + `03-verify.sh` | **VERIFY OK**. Go 1.25.14. `kyro doctor` 13/13 PASS, `go test ./...` OK, `build:client` 24,6 s y pico 1,7 GB, 0 swap usado, 15 GB de disco. **Etapa 1 cerrada** |
| 2026-10-03 | `claude remote-control` en `~/proyectos/ventas` (tmux `etapa2`), prompt enviado desde el celular | Funciona, pero pidió permiso para cada comando. Se agregó `04-claude-permisos.sh` |
| 2026-10-03 | Reinicio con `--permission-mode acceptEdits` | Siguió pidiendo permiso. Causa probable: Kyro lee su runtime en `~/.agents` (fuera del proyecto). Se agregó `additionalDirectories` y más comandos al script; el server pasa a `--permission-mode auto` |
| 2026-10-03 | Pidió permiso para `gh` y `git push` | Se agregaron reglas explícitas de push (solo ramas feature y `main`) y de `gh pr`; push directo a `dev` queda bloqueado |
| 2026-10-03 | Etapa 2: work `fix-employee-test-redundant-or` vía Remote Control con permisos nuevos | OK: PR a `dev` en be-ventas abierta, pendiente de revisión del usuario |
| 2026-10-03 | Pasos 7 y 8: clon de agents-panel, `kyro install --init-workspace`, `05-remote-control.sh --install` | OK: servicio `claude-remote-control.service` habilitado, servers `rc-ventas` (same-dir) y `rc-agents-panel` (worktree) corriendo |
| 2026-10-03 | Revisión de servers | `rc-ventas` conectado (retomó `vm-ia-parallel-acorn`). `rc-agents-panel` trabado en `Trust …? [y/N]`. Se respondió `y` con `tmux send-keys` y el script ahora pre-acepta la confianza |
| 2026-10-03 | `rc-agents-panel` tras aceptar la confianza | OK: conectado. Entornos en la web: ventas `env_01Asj9nDeWPMK5r4jqmmNUQW`, agents-panel `env_01CvvXqJ93bAKBscT2UC8aWw` (link directo: `https://claude.ai/code?environment=<id>`) |
| 2026-10-03 | Opus agotaba el límite del plan Pro | `04-claude-permisos.sh` fija `model: sonnet` por defecto. Hay que correrlo y reiniciar los servers |
| 2026-10-04 | Corrida de humo del Agent SDK sobre un repo git de prueba (T3.3 del scope `panel-mvp`) | OK: reutiliza `~/.claude/.credentials.json`, sin `setup-token`. Mensaje del asistente + `result:success`; `curl` negado por la allowlist. Sin cambios de configuración en la VM ni costo |
| 2026-10-04 | Paso 10: `apps/api/.env` de desarrollo (clave generada, 600), recorrido de punta a punta con API y web reales sobre datos descartables | OK: login+TOTP, work en worktree, SSE, reinicio (`interrupted`) y resume con la misma sesión. Usuario real y proyecto real: los crea la persona (`user:create`, `project:add`) |
| 2026-10-03 | `panel-setup.sh` en el repo `ventas` (setup de worktrees multi-repo para el panel) y receta de `project:add novagent` en el paso 10 | Escrito y subido, **sin correr todavía en la VM** (falta `git pull` en `~/proyectos/ventas` y probar con un work). Sin costo |
