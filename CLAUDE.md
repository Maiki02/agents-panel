# CLAUDE.md — agents-panel

Reglas generales del repo. Valen para cualquier agente (Claude Code, Cowork) y para cualquier persona que trabaje acá.

## Qué es este repo

Panel web para mandar pedidos a Claude Code y seguir cada scope o work de Kyro de punta a punta (planificación → ejecución → QA → PR a `dev`). Corre en la VM `vm-ia` (Oracle Cloud, Ubuntu, ARM) y se publica con Tailscale Funnel. Es multiproyecto: la v1 arranca con NovaGent.

## Documentación (fuente de verdad)

| Archivo | Qué contiene |
|---|---|
| `docs/plan.md` | Decisiones, arquitectura, etapas y riesgos |
| `docs/estados.md` | Catálogo de estados de un worktree y cómo se detectan |
| `docs/vm-oracle.md` | Cómo se creó la VM en Oracle (cuenta, instancia, red, SSH) |
| `docs/vm-setup.md` | Runbook de la VM: **todo** lo que se instaló o configuró, paso a paso, y la bitácora |
| `docs/panel-desarrollo.md` | Crear cuenta, correr API y web en la VM y entrar desde la PC por túnel SSH |
| `docs/identidad-visual.md` | Tokens de diseño (colores, Inter, tamaños), Tailwind y cómo replicar la identidad de la web |

Si una decisión cambia, se actualiza el doc correspondiente en el mismo cambio. Los docs se escriben en español; el código (identificadores, comentarios técnicos) en inglés.

## Regla de oro de la VM

**Nada se hace en la VM sin quedar documentado.** Cada cambio en la VM (paquete, servicio, archivo de config, permiso, cuenta) tiene que:

1. Estar en `docs/vm-setup.md`: qué se hizo, comando exacto, por qué y cómo se verifica.
2. Si es automatizable, estar en un script idempotente de `scripts/vm/` (se puede correr dos veces sin romper nada).
3. Sumar una línea a la **bitácora** de `docs/vm-setup.md` con fecha, qué se corrió y el resultado.

El objetivo: poder rehacer la VM desde cero siguiendo solo el runbook.

**Excepción: actualizar Kyro desde el panel.** Cada corrida del botón Actualizar de Versiones corre `scripts/vm/08-kyro-update.sh` (ya documentado en el paso 14 de `docs/vm-setup.md`) y queda registrada en la tabla `maintenance_runs` de la base del panel (versión anterior, versión nueva, resultado y salida recortada): esas corridas **no** suman línea a la bitácora. La bitácora sí registra la creación del script, sus cambios de procedimiento y las corridas hechas a mano.

## Regla de costos

**Cualquier cambio en la VM o en la cuenta de Oracle que pueda modificar lo que se paga se avisa al usuario antes de hacerlo**, con el costo estimado y la alternativa gratis si existe. Sin su OK explícito, no se hace.

- Hoy el costo es **US$0**: todo está dentro del cupo Always Free (2 OCPU / 12 GB Ampere, 200 GB de disco). La cuenta es Pay As You Go, así que pasarse del cupo se cobra.
- Ejemplos que requieren aviso: cambiar el shape u OCPU/RAM, agregar discos, volúmenes o backups por encima del cupo, IPs reservadas, balanceadores, más instancias, servicios pagos de Oracle, planes pagos de Tailscale u otro proveedor.
- Todo cambio de costo queda en la tabla **Costos** de `docs/vm-setup.md` (fecha, qué, costo mensual estimado, quién lo aprobó). La alerta de presupuesto (`budget-ia-vm`, US$1) es la red de seguridad, no el control.

## Secretos

- Nunca se commitean `.env`, tokens, claves SSH ni credenciales. Solo `.env.example` con valores falsos.
- En la VM van solo los `.env` de **desarrollo**. Nunca credenciales de producción.
- Los secretos no se pegan en docs ni en la bitácora: se describe dónde están, no qué valen.

## Git

- Rama principal: `main`. Conventional Commits con scope (`feat(api): …`, `docs(vm): …`).
- Nunca `push --force` ni `rebase` de ramas ya pusheadas.
- Para leer el estado usar `git --no-optional-locks` (`status`, `diff`, `log`).
- Commits y push solo cuando el usuario lo pide. Excepción: el piloto del panel commitea al cerrar cada sprint y pushea la rama de su worktree (en cualquier repo del trabajo); nunca `--force`, nunca la rama base y nunca mergea la PR.

## Flujo de trabajo (Kyro)

- **Kyro Work** para cambios chicos (un fix, un ajuste de doc, una pantalla).
- **Kyro Forge (scope)** para cada etapa grande del plan (Panel MVP, Estados y PRs, Operación).
- Cerrar sprint y scope (retro + archivo) antes de mergear.

## Stack y convenciones de código

- Todo TypeScript, `strict: true`. Node 24 LTS. npm workspaces.
- `apps/api`: Fastify + Claude Agent SDK + SQLite. `apps/web`: Angular (standalone + signals). `packages/shared`: tipos compartidos entre API y web.
- El estado de un worktree se deduce de señales verificables (Kyro, git, `gh`, hooks del SDK), nunca del texto del agente. Si se agrega o cambia un estado, se actualiza `docs/estados.md`.
- Scripts de shell en bash con `set -euo pipefail` y finales de línea LF.

## Proyectos registrados en el panel

Los proyectos se dan de alta desde la web (**Proyectos → Nuevo proyecto**, con la URL completa de GitHub); `project:add` del CLI queda para carpetas ya clonadas. El setup de un proyecto (campo de la configuración en la web, o `project:add … ["comando de setup"]`) es opcional y se ejecuta sin shell dentro del worktree nuevo:

- Si no necesita nada, no lleva comando.
- Si alcanza con un comando, se pasa directo (por ejemplo `"npm ci"`).
- Si necesita más de un paso (clonar repos hijos, copiar `.env`, instalar dependencias), el repo lleva `scripts/panel-setup.sh` y se registra con `"bash scripts/panel-setup.sh"`. Tiene que ser idempotente, con `set -euo pipefail`, LF, clonar desde GitHub (no desde la copia local) y copiar solo `.env` de desarrollo. Modelo: `scripts/panel-setup.sh` del repo `ventas`.
- Si el proyecto tiene un comando que valida un cambio antes de abrir la PR (build, tests), se registra como **validate_command** (campo opcional del proyecto: `PATCH /api/projects/:id` con `validateCommand`; el campo está en la web, en Configuración → General). Se ejecuta sin shell en el worktree, con timeout (`PILOT_VALIDATE_TIMEOUT_MINUTES`, 15 por defecto), después de traer la base; si falla, el piloto frena con `build_roto` y no abre la PR. Sin comando, el merge se hace sin validación y el Timeline lo anota. Si el repo trae `.claude/skills/merge-dev/SKILL.md`, el piloto usa esa skill para el merge en vez del merge genérico.
- Los `.env` de desarrollo los pone el panel en cada worktree: se suben cifrados por proyecto (`/api/projects/:id/env`, con TOTP) y se escriben con modo 600 después del setup. Un `panel-setup.sh` puede seguir copiando el suyo; el panel escribe después y su versión gana. Detalle en `docs/plan.md` y `docs/panel-desarrollo.md`.

- Un proyecto sin Kyro (sin `.agents/kyro/` en el repo) solo admite chats de tipo **Pedido directo**; para usar Work o Scope se inicializa desde la web (**Configuración → Repositorio → Inicializar Kyro**), que deja la rama `chore/kyro-init` para revisar, pushear y mergear a la rama base.
- Borrar un proyecto desde la web nunca pierde trabajo: se rechaza si hay algo sin commitear o sin pushear (detalle en `docs/plan.md`).

## Operaciones sobre un trabajo

Valen para cualquier cambio futuro en el panel (detalle en `docs/plan.md`, «Servicio de acciones y paridad manual»):

- Toda acción sobre un trabajo (git, Crear PR, descartar, borrar, pasos del agente) pasa por el servicio único `WorktreeOps` con **actor** (`user`, `pilot`, `agent`); el Timeline lo registra. Cada acción nueva del piloto suma su fila en `PARITY_CATALOG` y su botón en la web; un test falla si falta.
- Las rutas de operaciones piden sesión y CSRF y responden **409** si el agente del trabajo corre, hay mantenimiento de Kyro o el piloto está en `active`, `queued` o `waiting_quota` (para operar a mano se pausa el piloto); un trabajo `archivado` es de solo lectura.
- Ninguna operación fuerza un push, hace rebase, pushea una rama que no sea la del trabajo, commitea o instala en el clon base del proyecto (solo se actualiza con `pull --ff-only`), ni lee o toca archivos ignorados (los `.env`).
- El uso de los proveedores se mide por `account_id` (ver abajo); la API y la web usan el mismo `usageTone`.

## Cuentas de Claude

- La VM tiene más de un login de Claude Code: `~/.claude` es la principal y la fuente de la verdad; las demás (`~/.claude2`, …) enlazan su config con `scripts/vm/11-claude-cuentas.sh` (paso 17 de `docs/vm-setup.md`). Nunca se enlazan ni se copian `.credentials.json` ni `.claude.json`.
- El panel corre cada turno con la cuenta activa (una para todo el panel, se elige en la web): `CLAUDE_CONFIG_DIR` de la cuenta, o la variable quitada para la principal. Toda sesión guarda su `account_id`; lo que mida uso (tokens, cupo) lo hace por cuenta.

## Seguridad del panel

La URL es pública (Tailscale Funnel), así que el login es la única puerta:

- Argon2id + segundo factor obligatorio (passkey o TOTP). Sin registro público.
- Cookies `HttpOnly`, `Secure`, `SameSite=Strict`; CSRF; límite de intentos.
- Ninguna ruta de la API sin sesión (solo `/api/health` y los pasos del login son públicos). El agente nunca corre con `bypassPermissions`.
- Funnel se prende con `scripts/vm/09-tailscale-funnel.sh` (paso 15 de `docs/vm-setup.md`) tras un login manual de Tailscale; la URL de Funnel se declara en `PANEL_EXTRA_ORIGINS`. Funnel publica el puerto 3000, donde el servicio systemd `agents-panel` (`scripts/vm/10-panel-service.sh`, paso 16) sirve la API y la web compilada; `ng serve` y `tsx watch` son solo para desarrollo, con el servicio parado (un candado de instancia única impide dos APIs sobre la misma base).
- Web Push: las claves VAPID (`PUSH_VAPID_*`) son secretos y viven solo en el `.env` del panel; cada ruta de `/api/push` exige sesión y CSRF, y cada usuario solo toca sus dispositivos, y el endpoint de una suscripción solo se acepta si es de un servicio de push de un navegador (FCM, Mozilla, Windows, Apple): el servidor hace un POST a esa URL.
