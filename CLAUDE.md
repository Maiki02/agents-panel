# CLAUDE.md — agent-panel

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

Si una decisión cambia, se actualiza el doc correspondiente en el mismo cambio. Los docs se escriben en español; el código (identificadores, comentarios técnicos) en inglés.

## Regla de oro de la VM

**Nada se hace en la VM sin quedar documentado.** Cada cambio en la VM (paquete, servicio, archivo de config, permiso, cuenta) tiene que:

1. Estar en `docs/vm-setup.md`: qué se hizo, comando exacto, por qué y cómo se verifica.
2. Si es automatizable, estar en un script idempotente de `scripts/vm/` (se puede correr dos veces sin romper nada).
3. Sumar una línea a la **bitácora** de `docs/vm-setup.md` con fecha, qué se corrió y el resultado.

El objetivo: poder rehacer la VM desde cero siguiendo solo el runbook.

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
- Commits y push solo cuando el usuario lo pide.

## Flujo de trabajo (Kyro)

- **Kyro Work** para cambios chicos (un fix, un ajuste de doc, una pantalla).
- **Kyro Forge (scope)** para cada etapa grande del plan (Panel MVP, Estados y PRs, Operación).
- Cerrar sprint y scope (retro + archivo) antes de mergear.

## Stack y convenciones de código

- Todo TypeScript, `strict: true`. Node 24 LTS. npm workspaces.
- `apps/api`: Fastify + Claude Agent SDK + SQLite. `apps/web`: Angular (standalone + signals). `packages/shared`: tipos compartidos entre API y web.
- El estado de un worktree se deduce de señales verificables (Kyro, git, `gh`, hooks del SDK), nunca del texto del agente. Si se agrega o cambia un estado, se actualiza `docs/estados.md`.
- Scripts de shell en bash con `set -euo pipefail` y finales de línea LF.

## Seguridad del panel

La URL es pública (Tailscale Funnel), así que el login es la única puerta:

- Argon2id + segundo factor obligatorio (passkey o TOTP). Sin registro público.
- Cookies `HttpOnly`, `Secure`, `SameSite=Strict`; CSRF; límite de intentos.
- Ninguna ruta de la API sin sesión. El agente nunca corre con `bypassPermissions`.
