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

Cuando el repo esté en GitHub, alcanza con clonarlo en la VM (`~/agent-panel`).

### 1. Base: `scripts/vm/01-base.sh`

```bash
bash ~/01-base.sh
```

| Qué | Cómo | Por qué |
|---|---|---|
| Paquetes base | `apt`: git, tmux, build-essential, curl, jq, unzip, xz-utils, ripgrep, sqlite3, time | Herramientas de trabajo y de los scripts |
| Swap 8 GB | `/swapfile` en `/etc/fstab`, `vm.swappiness=10` en `/etc/sysctl.d/99-agent-panel.conf` | Colchón para picos de RAM en builds de Angular |
| Node 24 LTS | Binario oficial en `/opt/node`, links en `/usr/local/bin` | Angular 21 y el panel. Versión fija, sin depender del apt de Ubuntu |
| npm global sin sudo | `npm config set prefix ~/.npm-global` | Instalar CLIs (Kyro) sin root |
| Go 1.25.x | Binario oficial en `/usr/local/go`, serie fijada en `GO_SERIES` | Misma serie que `go.mod` de be-ventas. Con go1.27, `go vet` (que corre dentro de `go test`) falla en código que en la PC pasa |
| GitHub CLI | Repo apt oficial de `cli.github.com` | PRs, checks y credenciales de git |
| Claude Code | Instalador nativo `claude.ai/install.sh` → `~/.local/bin/claude` | El agente |
| Kyro 6 | `npm i -g kyro-ai@latest` + `kyro install --agent claude` | Flujo de trabajo; en v6 las skills `kyro-*` van a `~/.claude/skills/` |
| PATH | Bloque `# >>> agent-panel >>>` en `~/.profile` y `~/.bashrc` | `~/.local/bin`, `~/.npm-global/bin`, `/usr/local/go/bin`, `~/go/bin` |
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

### Pendiente (etapas siguientes del plan)


- Tailscale + Funnel (etapa 6).
- Servicio systemd del panel (etapa 6).

## Costos

Regla del repo (`CLAUDE.md`): todo cambio que pueda modificar lo que se paga se avisa y se aprueba antes.

| Fecha | Recurso / cambio | Costo mensual estimado | Aprobado por |
|---|---|---|---|
| 2026-10-02 | Instancia A1 2 OCPU / 12 GB + boot volume 200 GB (dentro de Always Free) | US$0 | Miqueas |
| 2026-10-03 | Etapa 1 (paquetes, swap en el disco existente, Node, Go, gh, Claude Code, Kyro, repos) | US$0: no agrega recursos de Oracle | — |

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
