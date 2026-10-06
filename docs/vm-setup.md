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
| Kyro 6 | `npm i -g kyro-ai@latest` | Flujo de trabajo. Solo instala el CLI: el runtime y las skills se instalan por workspace (pasos 3 y 7) y se enlazan a Claude Code con el paso 11 |
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

Después de este paso, correr el paso 11 (si no, Claude Code no ve las skills de Kyro).

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

### 11. Skills de Kyro visibles para Claude Code: `scripts/vm/06-kyro-skills.sh`

```bash
bash ~/proyectos/agents-panel/scripts/vm/06-kyro-skills.sh
```

Kyro 6.1 solo ofrece los adapters `standard`, `opencode` y `codex` (ya no existe `--agent claude`). El adapter `standard` deja las skills `kyro-*` en `~/.agents/skills/`, y Claude Code solo lee `~/.claude/skills/` y `<proyecto>/.claude/skills/`. Sin este paso, ningún `/kyro-*` aparece en la VM (ni en Remote Control).

- Crea un symlink por skill: `~/.claude/skills/kyro-* → ~/.agents/skills/kyro-*`. Así se actualizan solas cuando Kyro se reinstala y valen para todos los proyectos.
- Idempotente. No pisa una copia real (no symlink) que ya exista: avisa y la deja.
- Hay que repetirlo si Kyro agrega skills nuevas. `02-novagent.sh` lo corre solo.
- **Verificar:** `ls -l ~/.claude/skills | grep kyro-` (8 enlaces) y, en una sesión nueva de Claude Code, que `/kyro-work`, `/kyro-forge`, etc. aparezcan en la lista de skills. Las sesiones y los servers `rc-*` que ya estaban corriendo hay que reiniciarlos (`05-remote-control.sh --stop` y de nuevo sin flags).
- Los repos con `.claude/skills/kyro-*` propias de una instalación vieja (hoy `ventas`: le faltan `kyro-work` y `kyro-scope-retire`, y tiene `merge-dev`) usan esa copia en vez de la global. Si molesta, borrar esas carpetas del repo en un cambio aparte.

### 12. uv (gestor de Python): `scripts/vm/07-uv.sh`

```bash
bash ~/proyectos/agents-panel/scripts/vm/07-uv.sh
```

Algunos proyectos (hoy `expedientes-ai`, con setup `uv sync --project backend`) necesitan `uv`; el setup de un worktree corre sin shell y con el PATH del panel, así que `uv` tiene que estar instalado en la VM.

- Usa el instalador oficial (`https://astral.sh/uv/install.sh`), que baja el binario de `releases.astral.sh` y verifica su checksum. Lo deja en `~/.local/bin` (`uv` y `uvx`) con `UV_NO_MODIFY_PATH=1`: no toca `.bashrc` ni `.profile` (`~/.local/bin` ya está en el PATH por el `.bashrc` de la VM).
- Sin privilegios de root y sin salir del home. Costo US$0 (sin recursos de Oracle).
- Idempotente: si `~/.local/bin/uv` ya existe, solo corre `uv self update` (sin cambios si ya es la última versión).
- **Verificar:** `uv --version` (en una sesión nueva) y `ls -l ~/.local/bin/uv ~/.local/bin/uvx`. Una segunda corrida del script termina con `You're already on version … (the latest version)`.

### 13. Alta de proyectos desde la web: hallazgos de `gh` y `kyro` (verificación, sin cambios en la VM)

Verificado el 2026-10-04 con `gh` 2.102.0 y Kyro 6.1.0, siempre dentro de una carpeta temporal y con argv (sin shell), como lo hace el panel. Sirve de referencia para el alta por GitHub (`ProjectService`).

- **Clonar:** `gh repo clone <owner/repo> <directorio>`. Con un repo válido sale con código 0, escribe `Cloning into '<dir>'...` en stderr y el origin queda `https://github.com/<owner>/<repo>.git` (protocolo https, el configurado en `gh`); se queda en la rama por defecto del remoto. Probado con un repo público ajeno (`octocat/Hello-World`); ningún repo del usuario se clonó para la prueba.
- **Errores:** con un `owner/repo` inexistente sale con código 1 y stderr `GraphQL: Could not resolve to a Repository with the name '<owner>/<repo>'. (repository)`; no crea la carpeta. Con el destino ya existente y no vacío sale con código 1 (`fatal: destination path '<dir>' already exists and is not an empty directory.` y `failed to run git: exit status 128`). El panel usa stderr como detalle del error.
- **Kyro en un repo con `.agents/kyro/`:** `kyro install --scope workspace --init-workspace --yes` (CLI global, cwd en el repo) sale con código 0 y crea `.agents/kyro/local.json` (ignorado por git: el árbol queda limpio). Una segunda corrida también sale con 0 y solo cambia `installedAt` dentro de `local.json`. Equivale al `npx --yes kyro-ai@latest install --init-workspace --yes` del paso 7.
- **Ojo:** ese comando no es local al proyecto: también refresca el runtime global (`~/.agents/kyro/current`) y las skills (`~/.agents/skills/*`), aunque la versión sea la misma. Es lo mismo que hace una actualización de Kyro, así que no rompe nada, pero instalar en un proyecto toca lo global de toda la VM.
- **Un repo sin Kyro:** el mismo comando en un repo sin `.agents/kyro/` crea `.agents/kyro/.gitignore`, `project.json`, `local.json` (ignorado) y `scopes/` (verificado el 2026-10-05 en una carpeta temporal; `git status` muestra `.agents/` sin seguimiento). Es lo que commitea el botón **Inicializar Kyro** del panel en la rama `chore/kyro-init`.
- **Skills:** son globales de la VM (`~/.agents/skills`), no se copian por proyecto. Claude Code solo lee `~/.claude/skills`, así que después de cada `kyro install` desde el panel (alta de un proyecto con Kyro e Inicializar Kyro) se corre `bash scripts/vm/06-kyro-skills.sh` (idempotente, best effort). A mano: el mismo comando.
- **Validar:** `kyro doctor` (13 checks `PASS` y código 0 en un clon recién inicializado).

### 14. Actualizar Kyro: `scripts/vm/08-kyro-update.sh`

```bash
bash ~/proyectos/agents-panel/scripts/vm/08-kyro-update.sh ~/proyectos/agents-panel ~/proyectos/ventas
```

Kyro es global de la VM (CLI en `~/.npm-global/bin/kyro`, runtime en `~/.agents/kyro/current`, skills en `~/.agents/skills`), pero cada proyecto con Kyro tiene además su workspace (`.agents/kyro/`). Este script es lo que corre el botón Actualizar de la pantalla Versiones, y también se puede correr a mano.

- **H1 verificada (Kyro 6.1.0, 2026-10-04):** `kyro update --help` dice que verifica el registro, actualiza el paquete global si está atrás y refresca el runtime y el workspace del directorio actual; `--check` y `--dry-run` no cambian nada, `--yes` evita la pregunta. Por eso la secuencia es `npm i -g kyro-ai@latest` y después `kyro update --yes` con el cwd en cada raíz. Con `--yes` no pidió nada interactivo en ninguna de las dos raíces, así que no hace falta el plan B (`kyro install --scope workspace --init-workspace --yes`).
- **Qué hace, en orden:** (1) valida todas las raíces recibidas (cada una tiene que ser un directorio con `.agents/kyro/`; si no, sale con error antes de tocar nada); (2) `npm i -g kyro-ai@latest`; (3) `kyro update --yes` en cada raíz; (4) `06-kyro-skills.sh`; (5) `kyro doctor`. Sin argumentos solo hace lo global, las skills y el doctor.
- **Raíces sucias (2026-10-05):** antes de `kyro update` en cada raíz, el script mira `git status --porcelain -- . ':(exclude).agents/kyro'`. Si hay algo (versionado o no), no corre `kyro update` ahí, lo avisa en la salida y emite `KYRO_SKIPPED=<raíz>` justo antes de `KYRO_VERSION`; la actualización global corre siempre y el script sale con 0. Un `git status` que falla no saltea nada.
- La última línea es `KYRO_VERSION=<x.y.z>` (salida de `kyro --version`): la versión que realmente quedó. No imprime secretos ni lee `.env`.
- Idempotente: con Kyro al día, `npm` responde `changed 1 package`, `kyro update` dice `is the latest release` y los symlinks quedan iguales.
- Sin costo (US$0): no toca recursos de Oracle ni planes pagos.
- **Verificar:** exit 0, 13 checks `PASS` de `kyro doctor`, última línea `KYRO_VERSION=…`, y `ls -l ~/.claude/skills | grep kyro-` igual antes y después. Las corridas desde el panel quedan en `maintenance_runs`, no en la bitácora (ver `CLAUDE.md`).
- Las sesiones que ya estaban abiertas siguen con el runtime anterior: el panel no actualiza mientras haya sesiones corriendo.

### 15. Tailscale + Funnel: `scripts/vm/09-tailscale-funnel.sh`

```bash
bash ~/proyectos/agents-panel/scripts/vm/09-tailscale-funnel.sh      # 1ª vez: instala y pide el login
sudo tailscale up                                                    # manual, una sola vez, con tu cuenta
bash ~/proyectos/agents-panel/scripts/vm/09-tailscale-funnel.sh      # 2ª vez: publica la web con Funnel
```

Publica la web del panel en una URL `https://<vm>.<tailnet>.ts.net` para entrar desde el celular y la PC sin túnel SSH y para que Web Push (que exige HTTPS) funcione en el Android. Se adelantó de la etapa 6 por el sprint 5 de `autopiloto-kyro`.

- **Qué hace, en orden:** (1) instala Tailscale desde su repositorio oficial de apt (`pkgs.tailscale.com/stable/ubuntu/<codename>`, con su clave en `/usr/share/keyrings`) si falta; (2) `systemctl enable --now tailscaled`; (3) si el nodo no tiene sesión, avisa que falta `sudo tailscale up`, imprime `FUNNEL_URL=` vacío y sale con 0; (4) con sesión, `sudo tailscale funnel --bg 4200`: Funnel en 443 hacia `http://127.0.0.1:4200` (la web con `ng serve`; el proxy de la web reenvía `/api` a la API). Acepta otro puerto como argumento.
- **Idempotente:** con todo hecho solo escribe `ya publicado`; la última línea es `FUNNEL_URL=<url>`. `--bg` deja la configuración guardada en `tailscaled`, así que sobrevive a reinicios de la VM.
- **Sin secretos:** el login es interactivo (link + cuenta); no se usan authkeys. El script y este doc no llevan ninguno.
- **Requisitos en la cuenta de Tailscale (una sola vez, a mano):** habilitar HTTPS en el tailnet y el atributo `funnel` del nodo en las ACL. Si falta, `tailscale funnel` imprime el link para habilitarlo.
- **Qué hay que ajustar en el panel para que atienda por ese nombre:**
  - API (`apps/api/.env`): `PANEL_EXTRA_ORIGINS=https://<vm>.<tailnet>.ts.net` suma esa URL a las que se aceptan como `Origin` en las escrituras; `PANEL_ORIGIN` sigue siendo `http://localhost:4200` y el túnel SSH sigue funcionando. Reiniciar la API.
  - Web (`apps/web/angular.json`): el dev server acepta solo hosts `*.ts.net` (y `localhost`) con `allowedHosts: [".ts.net"]`. Reiniciar `ng serve`.
  - Las cookies de sesión ya son `Secure`, `HttpOnly` y `SameSite=Strict`: con HTTPS de Funnel no hace falta cambiar nada.
- **Riesgo:** la URL es pública. El login (Argon2id + passkey o TOTP) es la única puerta y toda ruta de la API exige sesión (test de rutas sin sesión en `apps/api/test`), pero mientras el panel corra con `ng serve` (el servicio systemd y el build de producción son de la etapa 6) Funnel publica el servidor de desarrollo. Antes de prender Funnel: confirmar que las únicas rutas públicas son `GET /api/health` y los dos pasos del login (`public: true` en `apps/api/src`).
- Sin costo (US$0): plan gratis de Tailscale (Personal), sin recursos de Oracle. Aprobado por Miqueas el 2026-10-05.
- **Verificar:** `tailscale funnel status` muestra solo `https://<vm>.<tailnet>.ts.net` → `proxy http://127.0.0.1:4200`; desde un dispositivo fuera de la VM esa URL muestra el login y el login con TOTP funciona; correr el script dos veces seguidas no cambia nada.
- **Si el navegador da `DNS_PROBE_FINISHED_NXDOMAIN` (2026-10-05):** el nombre solo lo resolvía la VM (por Tailscale) y el DNS público no tenía registro, ni siquiera el servidor autoritativo de `ts.net`; apagar y volver a prender Funnel no lo arregló. Lo resolvió pedir el certificado una vez a mano: `cd /tmp && sudo tailscale cert <vm>.<tailnet>.ts.net && sudo rm -f /tmp/<vm>.<tailnet>.ts.net.*` (el `.crt` y el `.key` que deja no se usan: Funnel maneja su certificado dentro de `tailscaled`, por eso se borran). El registro público apareció a los pocos minutos. Se comprueba con `dig +short @8.8.8.8 <vm>.<tailnet>.ts.net`.
- Estado (2026-10-05): **corrido en la VM**. Tailscale 1.102.4 (arm64, Ubuntu `resolute`), login hecho por la persona, HTTPS Certificates y Funnel habilitados en el admin de Tailscale. La segunda corrida respondió `ya publicado` sin cambios. Falta la prueba del login con TOTP desde un dispositivo fuera de la VM.

### Pendiente (etapas siguientes del plan)


- Servicio systemd del panel (etapa 6).

## Costos

Regla del repo (`CLAUDE.md`): todo cambio que pueda modificar lo que se paga se avisa y se aprueba antes.

| Fecha | Recurso / cambio | Costo mensual estimado | Aprobado por |
|---|---|---|---|
| 2026-10-02 | Instancia A1 2 OCPU / 12 GB + boot volume 200 GB (dentro de Always Free) | US$0 | Miqueas |
| 2026-10-03 | Etapa 1 (paquetes, swap en el disco existente, Node, Go, gh, Claude Code, Kyro, repos) | US$0: no agrega recursos de Oracle | — |
| 2026-10-03 | Permisos de Claude Code y Remote Control (servicio systemd de usuario) | US$0 (usa la suscripción Claude Pro existente) | — |
| 2026-10-04 | Skills de Kyro enlazadas a `~/.claude/skills` (symlinks locales) | US$0: sin recursos de Oracle | — |
| 2026-10-04 | uv instalado en `~/.local/bin` con el instalador oficial (`07-uv.sh`) | US$0: sin recursos de Oracle ni planes pagos | — |
| 2026-10-04 | Panel en desarrollo (etapa 4): `.env`, base SQLite local, worktrees en `~/wt`, sesiones del Agent SDK con la suscripción existente | US$0: sin recursos nuevos de Oracle ni planes pagos | — |
| 2026-10-04 | Actualización de Kyro con `08-kyro-update.sh` (paquete npm global, runtime y symlinks locales) | US$0: sin recursos de Oracle ni planes pagos | — |
| 2026-10-05 | Tailscale (repositorio oficial) y Funnel en 443 hacia la web del panel (`09-tailscale-funnel.sh`, paso 15) | US$0: plan gratis de Tailscale (Personal), sin recursos de Oracle | Miqueas, 2026-10-05 (adelantado de la etapa 6) |

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
| 2026-10-04 | Las skills `kyro-*` no aparecían en la VM: `kyro install` (6.1.0, adapter `standard`) las deja en `~/.agents/skills/`, que Claude Code no lee. Se agregó `06-kyro-skills.sh` (symlinks a `~/.claude/skills/`) y se corrigió el doc (ya no existe `--agent claude`) | OK: 8 symlinks creados, segunda corrida idempotente, las skills aparecen en la lista de la sesión. Sin costo |
| 2026-10-04 | Paso 10: `apps/api/.env` de desarrollo (clave generada, 600), recorrido de punta a punta con API y web reales sobre datos descartables | OK: login+TOTP, work en worktree, SSE, reinicio (`interrupted`) y resume con la misma sesión. Usuario real y proyecto real: los crea la persona (`user:create`, `project:add`) |
| 2026-10-03 | `panel-setup.sh` en el repo `ventas` (setup de worktrees multi-repo para el panel) y receta de `project:add novagent` en el paso 10 | Escrito y subido, **sin correr todavía en la VM** (falta `git pull` en `~/proyectos/ventas` y probar con un work). Sin costo |
| 2026-10-03 | Regla en `CLAUDE.md`: cuándo un repo lleva `scripts/panel-setup.sh` | Solo documentación. Sin cambios en la VM ni costo |
| 2026-10-04 | Scope `proyectos-y-versiones`: verificación de `gh repo clone` y de `kyro install --init-workspace` sobre carpetas temporales (paso 13) | OK: sin cambios de configuración en la VM; `kyro install` refrescó el runtime y las skills globales (misma versión 6.1.0). Sin costo |
| 2026-10-04 | Paso 12: `bash scripts/vm/07-uv.sh` dos veces | OK: 1ª corrida instaló uv 0.12.23 (aarch64) en `~/.local/bin` (`uv`, `uvx`; `.bashrc`/`.profile` intactos); 2ª corrida `You're already on version v0.12.23 (the latest version)`, mismos sha256 de los binarios. Sin costo |
| 2026-10-04 | Paso 14: `bash scripts/vm/08-kyro-update.sh ~/proyectos/agents-panel ~/proyectos/ventas` (1ª corrida; la raíz de NovaGent es `ventas`) | OK: exit 0, `kyro update --yes` sin preguntas en las dos raíces (6.1.0 ya era la última), `kyro doctor` 13/13 PASS, `KYRO_VERSION=6.1.0`. Raíz inexistente o sin `.agents/kyro/`: falla con mensaje claro antes de tocar nada. Sin costo |
| 2026-10-04 | Paso 14: misma corrida, 2ª vez seguida | OK: exit 0, `kyro doctor` 13/13 PASS, `KYRO_VERSION=6.1.0`; los 8 symlinks de skills quedaron idénticos (mismo hash del listado). Sin costo |
| 2026-10-05 | El panel corre `scripts/vm/06-kyro-skills.sh` después de cada `kyro install` (alta con Kyro e Inicializar Kyro); `kyro install --init-workspace` verificado en una carpeta temporal sin Kyro | OK: crea `.agents/kyro/{.gitignore,project.json,local.json,scopes}`; sin cambios de configuración en la VM (el script es el del paso 6, idempotente). Sin costo |
| 2026-10-05 | `08-kyro-update.sh` cambia de procedimiento: saltea las raíces con cambios locales fuera de `.agents/kyro/` y emite `KYRO_SKIPPED=<raíz>`. Probado con stubs de `npm` y `kyro` y repos temporales (test automático); no se corrió contra el Kyro real | OK en el test: raíz limpia y raíz con cambios solo en `.agents/kyro/` se actualizan, raíz sucia se saltea, global siempre corre. Sin costo |
| 2026-10-05 | `/tmp` sin inodos (45.752 carpetas `panel-*` de tests en 1.048.576 inodos): el Bash de Claude Code dejó de responder. Se borraron a mano `panel-*`, `go-build*` y `e2e-*` del usuario (`find /tmp -maxdepth 1 -user ubuntu … -exec rm -rf {} +`). Script global `~/.agents/scripts/clean-test-tmp.sh` (con `--dry-run`, solo carpetas de más de 30 min) y su índice `~/.agents/scripts/README.md`; regla de permiso de Claude Code solo para ese script en `~/.claude/settings.json` (backup `settings.json.bak.*`). Se quitaron de `~` las copias viejas de `01`–`04` (las vigentes están en `scripts/vm/`) | OK: inodos de `/tmp` de 100% a 2% (13.597 usados); `--dry-run` da 0 carpetas. Causa de fondo (los tests no limpian sus `mkdtemp`) pendiente como deuda del scope `autopiloto-kyro`. Sin costo |
| 2026-10-05 | Paso 15: se escribió `scripts/vm/09-tailscale-funnel.sh` (instala Tailscale desde el repo oficial, habilita `tailscaled`, publica la web con `tailscale funnel --bg 4200`), `PANEL_EXTRA_ORIGINS` en la API y `allowedHosts: [".ts.net"]` en el dev server | Probado con stubs (`apps/api/test/funnel.test.ts`): 2ª corrida sin cambios, sin login no publica nada. **Sin correr todavía en la VM**: falta el login manual (`sudo tailscale up`) y la verificación desde un dispositivo externo. Sin costo |
| 2026-10-05 | Paso 15 corrido: `09-tailscale-funnel.sh` instaló Tailscale 1.102.4, `sudo tailscale up` (login manual), HTTPS Certificates y Funnel habilitados en el admin; segunda corrida `ya publicado`. Se agregaron al `apps/api/.env` (600) `PANEL_EXTRA_ORIGINS` con la URL de Funnel y las claves VAPID generadas con `push:vapid-keys` (sin valores en este doc), y se reinició el panel con `dev-panel.sh` | OK desde la VM: la URL de Funnel sirve la web (200), `/push-sw.js` 200, `/api/health` 200, rutas con sesión dan 401, login con `Origin` de Funnel pasa el chequeo y con un `Origin` ajeno da 403; `funnel status` muestra solo el puerto 4200. Pendiente: login con TOTP desde un dispositivo externo. Sin costo |
| 2026-10-05 | Paso 15: el navegador daba `DNS_PROBE_FINISHED_NXDOMAIN` (sin registro DNS público). Se apagó y prendió Funnel (`tailscale funnel --https=443 off` + `09-tailscale-funnel.sh`) sin efecto y después se pidió el certificado con `sudo tailscale cert` (archivos borrados) | OK: el DNS público resolvió a los pocos minutos; con `curl --resolve` hacia las IPs de Funnel la web da 200 con certificado válido, `/api/health` 200, rutas con sesión 401. Sin costo |
