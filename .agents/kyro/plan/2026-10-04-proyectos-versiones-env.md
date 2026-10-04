---
docType: plan
date: 2026-10-04
slug: proyectos-versiones-env
title: Proyectos, Versiones y .env desde la web
maturedFrom: mature
agents: []
---

# Proyectos, Versiones y .env desde la web

## Core thesis

El panel tiene que poder sumar y operar proyectos **solo desde la web**: elegir el proyecto como primer paso, agregar uno nuevo pegando su repo de GitHub (el panel lo clona en la VM), cargar sus `.env` de desarrollo de forma segura sin traerlos de la PC y actualizar Kyro (global de la VM) con un botón. Hoy todo eso exige SSH y comandos a mano, y eso choca con el objetivo del panel: trabajar desde cualquier navegador, incluso el celular.

## Problem / Motivation

- **Causa:** el registro de proyectos existe solo por CLI (`project:add <nombre> <ruta> <rama> [setup]`) y exige que el repo ya esté clonado en la VM. Los `.env` se copian a mano por SSH/`scp` y cada `panel-setup.sh` los copia desde la copia principal. Kyro se actualiza con comandos sueltos por SSH.
- **Consecuencia:** sumar `expedientes-ai` (el proyecto "Judiciar") o cambiar un `.env` obliga a estar en la PC con SSH. La pantalla inicial mezcla los chats de todos los proyectos y no hay un lugar donde ver qué versión de Kyro corre en la VM.
- **Por qué ahora:** la etapa 4 (Panel MVP) ya funciona en la VM (`docs/plan.md`) y `expedientes-ai` es el segundo proyecto real. Sumarlo a mano repetiría el problema con cada proyecto nuevo.

## Current-state evidence

| Hecho | Fuente |
|---|---|
| La base es SQLite (`node:sqlite`) en `~/.local/share/agents-panel/panel.sqlite` (dir 0700), configurable con `PANEL_DATA_DIR` | `docs/plan.md` (Arquitectura), `docs/vm-setup.md` paso 10 |
| Tabla `projects(id, name UNIQUE, repo_path, base_branch, setup_command, created_at)`; hoy hay un registro: `novagent`, `/home/ubuntu/proyectos/ventas`, `main`, `bash scripts/panel-setup.sh` | `apps/api/src/db/migrations.ts`, consulta a la base en la VM |
| `ProjectRepository.add` valida nombre kebab-case, que la ruta sea repo git y que exista la rama base; no clona | `apps/api/src/projects/repo.ts` |
| La API de proyectos solo tiene `GET /api/projects` | `apps/api/src/projects/routes.ts` |
| `createWorktree` crea `<worktreesDir>/<proyecto>/<slug>` en `feature/<slug>` y corre `setup_command` con `execFile` (sin shell, `splitCommand`), con rollback si falla | `apps/api/src/worktrees/create.ts` |
| `panel-setup.sh` de `ventas` clona fe/be desde GitHub y copia `.env`, `.env.local`, `.env.development` de `be-ventas` de la copia principal | `~/proyectos/ventas/scripts/panel-setup.sh` |
| En `ventas`, `/fe-ventas/` y `/be-ventas/` están en `.gitignore` (son repos hijos) | `~/proyectos/ventas/.gitignore` |
| La web: `/` = lista de chats de todos los proyectos (con el formulario de chat nuevo), `/chats/:id`, `/login` | `apps/web/src/app/app.routes.ts`, `chats/chat-list.page.ts` |
| `GET /api/chats` ya acepta querystring (filtros) | `apps/api/src/chats/routes.ts` |
| TOTP: `checkTotp(secret, code, now)` devuelve el contador usado (permite evitar repetir un código) | `apps/api/src/auth/totp.ts` |
| Kyro: CLI global en `~/.npm-global/bin/kyro`, versión 6.1.0 instalada = 6.1.0 publicada; runtime global en `~/.agents/kyro/current`; skills `kyro-*` enlazadas a `~/.claude/skills` por `scripts/vm/06-kyro-skills.sh` | `kyro --version`, `npm view kyro-ai version`, `docs/vm-setup.md` paso 11 |
| Scripts de VM existentes: `01-base.sh` … `06-kyro-skills.sh` | `scripts/vm/` |
| `Maiki02/expedientes-ai`: privado, rama `main`, un solo repo con `backend/` (Python 3.12, `uv`: `pyproject.toml`, `uv.lock`, `.python-version`, `.env.example`) y `frontend/` (solo docs por ahora); trae `.agents/` y `.claude/` | GitHub API (lectura) |
| Claves de `backend/.env.example`: `ENV`, `EXPEDIENTES_DATA_ROOT` (fuera del repo), `STORAGE_BACKEND`, `REPOSITORY_BACKEND`, `DEV_TOKEN_SECRET`, `DEV_USER_ID` | GitHub API (solo nombres) |
| La VM no tiene `uv`; tiene Python 3.14.4 | `which uv`, `python3 --version` |
| Agents Panel ya está clonado en `~/proyectos/agents-panel` (rama `main`) pero no registrado como proyecto | `ls ~/proyectos`, base |

Hipótesis a verificar en la ejecución (no son decisiones):

- H1: `kyro update` (desde la raíz de cada proyecto con Kyro) más `npm i -g kyro-ai@latest` es la secuencia correcta de actualización en 6.x. Fuente: stub de la skill ("use `kyro update` for upgrades"). Se confirma corriéndolo a mano una vez antes de escribir el script.
- H2: `kyro install --init-workspace --yes` con el CLI global equivale a lo que hizo `npx kyro-ai@latest install --init-workspace --yes` en el paso 7 de `vm-setup.md`.

## Who it's for

- **Usuario principal:** Miqueas, el único operador. Entra al panel desde la PC o el celular. Tiene que poder: (1) elegir en qué proyecto trabajar, (2) sumar un proyecto nuevo sin SSH, (3) cargar o rotar los `.env` de desarrollo sin la PC, (4) saber si Kyro está al día y actualizarlo sin romper sesiones en curso.
- **Secundario:** los agentes que corren en los worktrees. Necesitan arrancar con el repo listo (dependencias y `.env` en su lugar) y sin poder filtrar ni commitear los secretos.

## What success looks like

1. Al entrar, `/` muestra **Proyectos** (NovaGent, Agents Panel, expedientes-ai). Al elegir uno se ve su página: chat nuevo con ese proyecto ya elegido y solo sus chats. *Falso éxito:* aparecen chats de otro proyecto (se detecta con un test de filtro).
2. Desde **Agregar proyecto** se pega `Maiki02/expedientes-ai`. El panel lo clona en `~/proyectos/expedientes-ai` y lo deja `listo`, con rama base `main` y setup `uv sync --project backend`. *Falso éxito:* queda registrado pero sin clonar, o el `origin` no es GitHub (se comprueba con `git remote get-url origin`).
3. Registrar Agents Panel desde la web (carpeta existente con el mismo `origin`) lo **adopta sin volver a clonar**.
4. Se sube `backend/.env` para expedientes-ai. La API nunca devuelve su contenido. Un worktree nuevo lo tiene en `backend/.env` con permisos 600, y `git status` del worktree no lo muestra. *Falso éxito:* el valor aparece en la base en claro, en logs o en `chat_events` (se busca un valor centinela).
5. **Versiones** muestra la versión instalada y la última publicada de Kyro. "Actualizar" corre el script, refresca las skills y registra el resultado. Con una sesión corriendo, el botón se niega (409).

## Product laws / invariants

| Ley | Falla que evita |
|---|---|
| L1. Ninguna ruta nueva sin sesión. El guard deny-by-default y su test cubren todas | Exponer clonado, `.env` o actualización a internet (la URL es pública) |
| L2. Todo comando externo va por `execFile` con argv. Lo que escribe el usuario es solo un argumento validado, nunca va a un shell | Inyección de comandos desde la web |
| L3. Un `.env` nunca vuelve al navegador. La API devuelve solo ruta, nombres de claves y fecha | Fuga de secretos por la UI o por la red |
| L4. En reposo, los `.env` se guardan cifrados (AES-256-GCM, clave derivada con HKDF de `PANEL_SECRET_KEY`). Nunca van a logs ni a eventos | Fuga por backup de la base o por logs |
| L5. Solo se aceptan `.env` de desarrollo: nombre `.env` o `.env.<sufijo>` (`.env.local`, `.env.development`, `.env.test`…), nunca un nombre con `prod`, nunca plantillas (`example`, `sample`, `ejemplo`, `template`) | Llevar credenciales de producción a la VM (regla de `CLAUDE.md`) |
| L6. Un `.env` solo se escribe en una ruta que git **ignora** (`git check-ignore`), tanto al subirlo como al escribirlo en cada worktree | Que el agente lo commitee y lo pushee a GitHub |
| L7. Subir, reemplazar o borrar un `.env` y actualizar Kyro piden de nuevo un código TOTP (un código usado no se acepta dos veces) | Que una sesión robada o abierta cambie secretos o el runtime |
| L8. Kyro no se actualiza con sesiones corriendo, y mientras se actualiza no arrancan sesiones nuevas | Agentes a mitad de tarea con el runtime cambiado debajo |
| L9. Un proyecto solo pasa a `listo` si el clon terminó, `origin` es el repo pedido y la rama base existe. Si algo falla queda en `error` con el motivo, sin carpeta a medio clonar | Worktrees creados sobre clones rotos |
| L10. Solo se clonan repos de GitHub (`owner/repo`) a los que llega el `gh` autenticado de la VM | Clonar URLs arbitrarias (otros hosts, rutas locales, `file://`) |

## Observable success and failure guarantees

| Situación | Comportamiento |
|---|---|
| Sin proyectos | `/` muestra "Todavía no hay proyectos" y el botón Agregar proyecto |
| Proyecto `clonando` | La tarjeta muestra el estado y no deja crear chats. La página se actualiza al terminar (polling) |
| Clon falla (repo inexistente, sin permiso, sin espacio) | Estado `error` con el mensaje de `gh` recortado. La carpeta destino se borra si la creó el panel. Se puede reintentar o descartar |
| Carpeta destino existe con otro `origin` | 409: "la carpeta ya existe con otro repo". No se toca nada |
| Repo sin `.agents/kyro/` | Se registra igual, con aviso "proyecto sin Kyro" (no se inicializa Kyro) |
| URL inválida | 400 antes de ejecutar nada |
| `.env` con nombre o ruta inválida, no ignorado por git, más de 64 KB o líneas que no son `CLAVE=valor` (se admiten comentarios y líneas vacías) | 400 con el motivo. No se guarda nada |
| TOTP incorrecto o repetido | 401, cuenta para el límite de intentos existente |
| Worktree nuevo: la carpeta de un `.env` no existe después del setup | Falla la creación con "falta la carpeta X para `.env`" y rollback (fail-closed: el agente no arranca sin sus `.env`) |
| Aplicar a worktrees activos | Resultado por worktree (escrito / omitido con motivo). Uno que falla no frena a los demás |
| `PANEL_SECRET_KEY` cambió y no se puede descifrar | El archivo figura como "ilegible, volvé a subirlo". No se escribe nada en worktrees |
| Actualizar Kyro con sesiones activas | 409 con la cantidad de sesiones |
| Script de actualización falla | Se registra error con la salida recortada. La versión que se muestra es la que realmente quedó (`kyro --version`) |
| `npm view` sin red | Se muestra la versión instalada y "última: desconocida". El botón sigue disponible |

## Outcome-based scope

### In

1. **Navegación por proyecto:** `/` = Proyectos; `/projects/:id` = página del proyecto (chat nuevo con el proyecto fijo + chats filtrados + sección Configuración con setup y `.env`); `/versions` = Versiones; menú con Proyectos y, debajo, Versiones. `/chats/:id` no cambia.
2. **Agregar proyecto desde la web:**
   - Entrada: `owner/repo` o `https://github.com/owner/repo(.git)`, nombre interno kebab-case (sugerido a partir del repo), nombre visible, rama base (por defecto, la rama default de GitHub) y comando de setup (sugerido).
   - Pasos: clona en segundo plano en `PANEL_PROJECTS_DIR/<nombre>` (por defecto `~/proyectos`), o adopta la carpeta si ya existe con el mismo `origin`. Después inicializa Kyro si el repo lo usa.
3. **Setup por convención:** al registrar, si el repo trae `scripts/panel-setup.sh` se sugiere `bash scripts/panel-setup.sh`; si no, el campo queda vacío. El valor guardado es explícito y se puede editar después desde Configuración.
4. **`.env` por proyecto:**
   - Uno o varios archivos por proyecto, cada uno identificado por su ruta relativa (`.env`, `.env.local`, `.env.development`, `backend/.env`, `be-ventas/.env.local`…).
   - Acciones: subir y reemplazar (archivo o texto pegado), ver solo los metadatos y borrar.
   - Se escriben en cada worktree nuevo **después** del setup. Al subir se puede elegir aplicarlos también a los worktrees activos del proyecto.
5. **Versiones:** versión de Kyro instalada y última publicada, botón Actualizar (TOTP + sin sesiones activas) que corre `scripts/vm/08-kyro-update.sh`, e historial de actualizaciones.
6. **VM:** `scripts/vm/07-uv.sh` instala `uv` (sin costo) para expedientes-ai; `08-kyro-update.sh` es idempotente y también se puede correr por SSH.
7. **Alta de los tres proyectos desde la web:** nombre visible de NovaGent; adopción de Agents Panel (setup `npm ci`); clon de expedientes-ai (setup `uv sync --project backend`, `.env` en `backend/.env`).
8. **Docs** actualizados en el mismo cambio: `plan.md`, `vm-setup.md`, `panel-desarrollo.md`, `CLAUDE.md`.

### Explicitly out

- Editar un `.env` en línea o verlo: va contra L3. Para cambiarlo se sube de nuevo.
- Borrar proyectos o su carpeta desde la web: es destructivo y no hace falta para el objetivo. Queda como follow-up.
- Repos fuera de GitHub o URLs SSH: L10.
- Instalar toolchains (Go, `uv`, Python) desde la web: van por los scripts de `scripts/vm/` (regla de oro de la VM).
- Actualizar otras herramientas desde Versiones (Claude Code, Node, `gh`): en v1 solo Kyro. El diseño de la pantalla deja lugar para sumarlas.
- Passkeys y re-autenticación por passkey.
- Quitar la copia de `.env` de `panel-setup.sh` de `ventas`: es otro repo, queda como follow-up (hoy no molesta: el panel escribe después y gana).

## Closed decisions with rationale

| # | Decisión | Por qué | Costo aceptado | Consecuencia |
|---|---|---|---|---|
| D1 | El clon lo dispara el usuario desde la web, nunca un agente ni una tarea previa | Pedido explícito del usuario | El primer alta de expedientes-ai espera a que esté esta funcionalidad | No se clona nada durante la implementación; se prueba con un repo descartable |
| D2 | Clonar con `gh repo clone owner/repo <dir>` (`execFile`), solo GitHub | `gh` ya está autenticado en la VM y llega a los repos privados; `origin` queda en GitHub, como necesita `merge-dev` | No admite GitLab ni URLs SSH | La validación se reduce a `owner` `^[A-Za-z0-9-]{1,39}$` y `repo` `^[A-Za-z0-9._-]{1,100}$` (sin empezar con `.`) |
| D3 | El clon corre en segundo plano y el proyecto tiene estado `clonando` / `listo` / `error` | Un clon grande (be-ventas ~590 MB) supera un timeout HTTP razonable | Hace falta polling o SSE en la tarjeta | Se agrega la columna `status` (+ `status_detail`) a `projects`. Los proyectos existentes migran como `listo` |
| D4 | Adoptar una carpeta existente si `origin` coincide | Agents Panel y NovaGent ya están clonados; volver a clonar es inútil | Hay que comparar URLs normalizadas (https/ssh, con o sin `.git`) | Alta idempotente: registrar dos veces el mismo repo da "ya existe", no un clon duplicado |
| D5 | El setup se detecta por convención al registrar y se guarda explícito (editable) | El usuario preguntó si todos necesitan `setup.sh`: no. La mayoría alcanza con un comando o nada; `panel-setup.sh` solo para multi-repo (regla actual de `CLAUDE.md`) | Si un repo suma `panel-setup.sh` después, hay que editar el setup a mano | Siempre está a la vista qué se ejecuta. `createWorktree` no cambia su contrato |
| D6 | Los `.env` se guardan en SQLite cifrados (AES-256-GCM, HKDF de `PANEL_SECRET_KEY`, `info="env-files-v1"`) | Sirven para cualquier proyecto sin depender de la copia principal ni de cada script; la base y sus backups no tienen secretos en claro | Rotar `PANEL_SECRET_KEY` deja los `.env` ilegibles y hay que volver a subirlos | Tabla nueva `project_env_files(project_id, rel_path, ciphertext, iv, tag, key_names, updated_at, UNIQUE(project_id, rel_path))` |
| D7 | Nombres admitidos: basename `^\.env(\.[A-Za-z0-9_-]+)*$`, sin `prod` (sin distinguir mayúsculas) y sin `example|sample|ejemplo|template` | El usuario aclaró que los nombres varían (`.env`, `.env.local`, `.env.development`…); la regla de `CLAUDE.md` prohíbe producción en la VM | Un `.env.staging` se acepta (no es producción) | Validación en un solo módulo con tests de tabla |
| D8 | El `.env` se escribe en el worktree **después** del setup | Los repos hijos de NovaGent (`be-ventas/`) los crea el setup; escribir antes rompería el `git clone` | Un setup que necesite el `.env` no lo tiene. Hoy ninguno lo necesita, y `panel-setup.sh` de ventas igual copia el suyo | Si la carpeta destino no existe después del setup, falla con rollback (L9) |
| D9 | Re-autenticación TOTP para `.env` y para actualizar Kyro | Son las acciones con más impacto. La URL es pública | Hay que tipear un código más | Se reutiliza `checkTotp` + contador, con el límite de intentos de `auth/attempts.ts` |
| D10 | Actualizar Kyro = script idempotente versionado (`08-kyro-update.sh`) invocado por el panel. Cada corrida se guarda en una tabla `maintenance_runs` | Cumple la regla de oro: el procedimiento está en el runbook y se puede rehacer a mano | Las corridas desde el panel no suman línea a la bitácora de `vm-setup.md` | Se ajusta `CLAUDE.md`: las actualizaciones de Kyro hechas desde el panel quedan en `maintenance_runs`; la bitácora registra la creación del script y los cambios de procedimiento |
| D11 | Kyro se inicializa al registrar solo si el repo trae `.agents/kyro/` | No meter archivos de Kyro en repos que no lo usan | Un repo sin Kyro no tiene `/kyro-*` hasta inicializarlo a mano | Aviso visible en la tarjeta |
| D12 | Nombre interno kebab-case (rutas, worktrees) + nombre visible libre ("NovaGent", "Agents Panel", "Judiciar") | El nombre ya se usa en rutas (`~/wt/<proyecto>/…`) y no puede cambiar. El usuario quiere ver nombres de producto | Una columna más | `display_name` (nullable; si falta se muestra `name`) |

## Constraints and tradeoffs

- **Costo:** US$0. `uv`, el clon y los `.env` no agregan recursos de Oracle. El disco (200 GB, hoy ~15 GB usados) alcanza para un repo más.
- **Seguridad:** la URL es pública (Funnel). Aplican L1–L10 y lo que ya existe: CSRF, `SameSite=Strict`, límite de intentos y nunca `bypassPermissions`.
- **Stack:** TypeScript strict, Fastify, `node:sqlite`, Angular standalone + signals, migraciones numeradas en `migrations.ts`. Scripts en bash con `set -euo pipefail` y LF.
- **Regla de oro de la VM:** cada script nuevo va documentado en `vm-setup.md` con su línea en la bitácora.
- **Proceso del panel:** corre como `ubuntu` y sin root, así que `uv` y npm global se instalan en el home (`~/.local/bin`, `~/.npm-global`).
- **Límite de body:** el upload de `.env` va como JSON (texto, ≤ 64 KB), sin multipart. Así se evita sumar una dependencia.

## Risks, failure modes and degradation

| Riesgo | Disparador | Impacto | Prevención / contención | Señal |
|---|---|---|---|---|
| Secreto en logs | Logger de Fastify serializa el body | Fuga de `.env` | Redacción del campo `content` en el logger + test con valor centinela | Test de logs falla |
| El agente lee el `.env` del worktree | Lectura normal del agente | El valor pasa por la API de Anthropic | Solo dev (L5). Es el mismo riesgo que hoy con la copia del script. Se acepta | — |
| Actualización de Kyro rompe el runtime | Release nueva con cambios incompatibles | Sesiones nuevas sin skills | L8, `kyro doctor` al final del script; error visible y versión real mostrada | Corrida en `error` en Versiones |
| Clon gigante llena el disco | Repo enorme | La VM queda sin espacio | Chequeo de espacio libre antes de clonar (umbral 10 GB). El clon fallido se borra | Estado `error` "sin espacio" |
| Carrera entre clon y creación de chat | Chat sobre un proyecto `clonando` | Worktree sobre un repo incompleto | `POST /api/chats` rechaza proyectos que no están `listo` | 409 |
| Reinicio del panel durante un clon | Corte o restart | Proyecto colgado en `clonando` | Al arrancar, los `clonando` pasan a `error` ("interrumpido") y se pueden reintentar | Estado visible |
| Repo con hooks o setup malicioso | Repo de terceros | Ejecución de código en la VM | Solo repos a los que llega tu `gh`; el setup sugerido se muestra y se confirma antes de guardarlo | — |

## Execution blueprint

**WS1. Modelo y migración** (sin dependencias)
- Migración nueva: `projects` + `display_name`, `repo_url`, `status`, `status_detail` (los existentes pasan a `listo`); tablas `project_env_files` y `maintenance_runs`. Tipos en `packages/shared`.
- *Gate:* `db.test.ts` migra una base con datos del esquema actual sin perder `novagent`.

**WS2. Alta de proyectos (API)** (depende de WS1)
- Parser y validador de `owner/repo`/URL (D2).
- Servicio de alta:
  - adopta la carpeta si coincide el `origin` (D4); si no, clona en segundo plano (D3) con chequeo de disco;
  - verifica `origin` y rama base, e inicializa Kyro según D11;
  - sugiere el setup (D5) y recupera los `clonando` al arrancar.
- Rutas:
  - `POST /api/projects` (alta);
  - `GET /api/projects` y `GET /api/projects/:id` (con estado);
  - `PATCH /api/projects/:id` (nombre visible, rama base, setup);
  - `POST /api/projects/:id/retry`.
- `POST /api/chats` rechaza proyectos que no están `listo`. `project:add` del CLI reutiliza el mismo servicio.
- *Gate:* tests con un repo git local como "remoto" falso (inyectando el comando de clon). Cubren URL inválida, adopción, `origin` distinto y fallo de clon con limpieza. `guard.test.ts` cubre las rutas nuevas.

**WS3. `.env` (API)** (depende de WS1)
- Módulo de cifrado (HKDF + AES-256-GCM) y validador de ruta y nombre (D7, L6, tamaño, formato `CLAVE=valor`).
- Paso TOTP de re-autenticación (D9).
- Rutas:
  - `GET /api/projects/:id/env` (solo metadatos);
  - `PUT /api/projects/:id/env` (body `{ path, content, totp, applyToActive }`);
  - `DELETE /api/projects/:id/env` (con `totp`).
- Escritura en worktrees: `createWorktree` (o quien lo llama) escribe los `.env` después del setup, con 0600 y `check-ignore`, y hace rollback si falla. `applyToActive` devuelve un resultado por worktree.
- Redacción en el logger.
- *Gate:* tests con un valor centinela que no aparece en la respuesta, los logs, `chat_events` ni la base en claro. También: rechazo de `.env.production`, `.env.example`, `../.env` y archivos no ignorados; TOTP repetido rechazado; worktree con `backend/.env` 600 y `git status` limpio.

**WS4. Versiones (VM + API)** (depende de WS1)
- Verificar H1 a mano y documentar.
- `scripts/vm/08-kyro-update.sh`, idempotente:
  1. `npm i -g kyro-ai@latest`;
  2. `kyro update` en cada raíz de proyecto con Kyro que recibe por argumento;
  3. `06-kyro-skills.sh`;
  4. `kyro doctor`.
- Rutas:
  - `GET /api/versions` (instalada y última, con timeout);
  - `POST /api/versions/kyro/update` (TOTP, L8, bloqueo de sesiones nuevas mientras corre);
  - `GET /api/maintenance-runs`.
- *Gate:* tests con el script reemplazado por un fake: 409 con sesión activa, bloqueo de sesiones durante la corrida y registro del resultado. Una segunda corrida real del script en la VM no cambia nada.

**WS5. Web** (depende de WS2–WS4)
- Rutas:
  - `/` ProjectsPage (tarjetas con estado y polling mientras está `clonando`);
  - formulario Agregar proyecto;
  - `/projects/:id` (formulario de chat nuevo con el proyecto fijo, chats filtrados y Configuración: setup y `.env` con diálogo TOTP);
  - `/versions`.
- Menú lateral o superior con Proyectos y, debajo, Versiones. Los textos siguen en español.
- *Gate:* specs de los formularios: validación de URL y nombres de `.env`, y que el contenido del `.env` no queda en el estado después de enviarlo. Build de la web OK y recorrido manual en el navegador por el túnel SSH (`panel-desarrollo.md`).

**WS6. VM y docs** (`07-uv.sh` puede ir en paralelo desde el inicio; el resto, al final)
- `scripts/vm/07-uv.sh` (instala `uv` en `~/.local/bin`, idempotente). Paso nuevo en `vm-setup.md` + bitácora + tabla Costos (US$0).
- Paso de `08-kyro-update.sh` en `vm-setup.md`.
- `plan.md`: el registro de proyectos pasa a hacerse desde la web y reemplaza la idea de `.panel/project.yaml`; se suman `.env` y Versiones.
- `panel-desarrollo.md`: alta desde la web.
- `CLAUDE.md`:
  - sección "Proyectos registrados": convención de setup y que los `.env` los pone el panel;
  - ajuste de la regla de la bitácora (D10).

**WS7. Alta real** (después de WS1–WS6, **la hace el usuario desde la web**)
- NovaGent: nombre visible. Agents Panel: adopción con `npm ci`. expedientes-ai: clon con `uv sync --project backend` y subida de `backend/.env`.
- *Gate:* un work chico en expedientes-ai crea su worktree con `.env` y dependencias, y el agente arranca.

## Acceptance and validation matrix

| Resultado / ley | Escenario | Evidencia | Método |
|---|---|---|---|
| Éxito 1 | Elegir proyecto muestra solo sus chats | Spec + test de `GET /api/chats?projectId=` | Vitest (api + web), navegador |
| Éxito 2, L9, L10 | Alta por `owner/repo` → `listo`; repo inválido → `error` y carpeta borrada | Tests de alta con remoto falso | Vitest |
| Éxito 3 | Carpeta existente con el mismo `origin` → adoptada, sin clon | Test de adopción; el comando de clon no se llama | Vitest |
| Éxito 4, L3, L4, L6 | `.env` subido → worktree con 600 e ignorado; centinela ausente de respuesta, logs, eventos y base en claro | Tests de `.env` | Vitest + `stat`/`git status` en la VM |
| L5, D7 | `.env.local` y `.env.development` OK; `.env.production`, `.env.example` y `../x/.env` rechazados | Test de tabla | Vitest |
| L7 | TOTP faltante, incorrecto o repetido → 401 | Tests | Vitest |
| Éxito 5, L8 | Update con sesión activa → 409; sin sesiones → corrida registrada y versión real | Tests con script fake + corrida real | Vitest + VM |
| L1 | Rutas nuevas devuelven 401 sin sesión | `guard.test.ts` | Vitest |
| L2 | No hay `exec`/`shell: true` en código nuevo | Revisión + grep en el review | Review |
| D8 | Setup que no crea la carpeta del `.env` → creación falla y hace rollback | Test de worktree | Vitest |
| Regla de oro | `07-uv.sh` y `08-kyro-update.sh` documentados; segunda corrida idempotente | `vm-setup.md` + bitácora | Corrida doble en la VM |
| WS7 | Work real en expedientes-ai arranca con `.env` y dependencias | Chat en el panel | Manual por el usuario |

## Forge handoff

- **Scope propuesto:** `proyectos-y-versiones`.
- **Objetivo:** que agregar y operar proyectos (alta por GitHub, setup, `.env` de desarrollo y actualización de Kyro) se haga completo desde la web, con Proyectos como pantalla inicial.
- **Requisitos candidatos:** R1 navegación por proyecto · R2 alta por GitHub con clon en segundo plano y adopción · R3 setup por convención editable · R4 `.env` cifrados, solo escritura, solo dev, solo rutas ignoradas, aplicados a worktrees · R5 re-autenticación TOTP · R6 Versiones con actualización de Kyro segura · R7 `uv` en la VM · R8 docs y regla de bitácora.
- **Orden:** WS1 → (WS2, WS3, WS4 en ese orden; comparten la migración) → WS5 → WS6 → WS7. `07-uv.sh` puede ir en cualquier momento.
- **Non-goals:** los de "Explicitly out".
- **Dependencias externas:** `gh` autenticado en la VM (ya está), red a GitHub y npm.
- **Follow-ups no bloqueantes:** borrar proyectos desde la web; quitar la copia de `.env` de `panel-setup.sh` en `ventas`; actualizar Claude Code desde Versiones; passkey como re-autenticación.

## Quality gate

| Criterio | Puntaje |
|---|---|
| Thesis and causality | 14/15 |
| Grounding and evidence | 14/15 (H1 y H2 quedan explícitas como hipótesis a verificar en WS4/WS2) |
| Clarity and no ambiguity | 14/15 |
| Observable outcomes | 14/15 |
| Invariants and failures | 10/10 |
| Decisions and tradeoffs | 10/10 |
| Scope coherence | 9/10 (WS7 depende de una acción manual del usuario) |
| Executable handoff | 9/10 |
| **Total** | **94/100** |

Fuentes revisadas: `CLAUDE.md`, `docs/plan.md`, `docs/vm-setup.md`, `docs/panel-desarrollo.md`, `apps/api/src/{projects,worktrees,db,auth,chats,cli}`, `apps/web/src/app/{app.routes.ts,chats}`, `~/proyectos/ventas/scripts/panel-setup.sh` y `.gitignore`, base de la VM (`projects`), `kyro --version`, `npm view kyro-ai version`, GitHub API de `Maiki02/expedientes-ai` (estructura y nombres de claves de `.env.example`, sin valores). No quedan contradicciones materiales: el pedido de que el clon sea solo desde la web (D1) y los nombres variables de `.env` (D7) están incorporados.
