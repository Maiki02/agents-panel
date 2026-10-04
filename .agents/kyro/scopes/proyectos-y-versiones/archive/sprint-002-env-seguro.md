---
title: 'proyectos-y-versiones — Sprint 2: .env cifrados y escritura en worktrees'
date: '2026-10-04'
scope: 'proyectos-y-versiones'
sprint: 2
slug: 'env-seguro'
outcome: 'shipped'
type: 'sprint-archive'
---

# Sprint 2: .env cifrados y escritura en worktrees

> Closed: 2026-10-04
> Outcome: shipped

## Objective

Que la API guarde los .env de desarrollo de cada proyecto cifrados y validados, los suba, reemplace y borre solo con sesión y un TOTP nuevo, y los escriba con permisos 600 en cada worktree nuevo (y a pedido en los activos) sin que el contenido aparezca nunca en respuestas, logs, eventos ni en la base en claro.

## Definition of Done

- Todas las tareas done con evidencia y verdict pass
- npm run typecheck (raíz, 3 workspaces) en verde
- cd apps/api && npx eslint src test && npx vitest run en verde
- kyro doctor --artifacts --kyro-scope proyectos-y-versiones sin errores
- Prueba de centinela: el valor no aparece en respuestas, logs, chat_events ni en la base
- Ninguna ruta nueva sin sesión; allowlist pública sin cambios; sin exec ni shell en código nuevo
- Sin cambios en la VM ni en costos (US$0)

## Phases

### P1 — Validación y cifrado de .env

> Tener las piezas puras y testeadas (validador de ruta y contenido, cifrado y repositorio) antes de exponer rutas.

#### T1.1: Validador único de ruta y contenido de .env con tests de tabla

**Status**: done

**Description**: Crear apps/api/src/env-files/validate.ts con validateEnvPath(relPath) y parseEnvContent(content). validateEnvPath: ruta relativa con separador '/', sin ser absoluta, sin '..', sin '.', sin segmentos vacíos, sin '\\' ni NUL, sin segmento '.git', largo máximo 200; basename que cumpla ^\.env(\.[A-Za-z0-9_-]+)*$, que no contenga 'prod' (sin distinguir mayúsculas) y que no tenga como sufijo una plantilla (example, sample, ejemplo, template, sin distinguir mayúsculas). Devuelve la ruta normalizada. parseEnvContent: hasta 64 KB medidos en bytes UTF-8, sin NUL, finales LF o CRLF; cada línea es vacía, comentario (#) o CLAVE=valor con CLAVE ^[A-Za-z_][A-Za-z0-9_]*$ y prefijo 'export ' opcional; devuelve los nombres de clave únicos en orden de aparición. Un error lanza EnvFileError (subclase de ProjectError, así las rutas lo mapean a 400) con un motivo en español que cita el número de línea, nunca el texto de la línea ni el valor.

**Evidence**:
- Summary: Nuevo apps/api/src/env-files/validate.ts: EnvFileError (subclase de ProjectError → 400), validateEnvPath (relativa, sin .. . segmentos vacíos \ NUL .git, máx 200, basename ^\.env(\.[A-Za-z0-9_-]+)*$, sin 'prod', sin sufijo plantilla) y parseEnvContent (≤65536 bytes UTF-8, sin NUL, LF/CRLF, comentarios, vacías, 'export ' opcional, claves únicas en orden; errores citan 'Línea N' sin texto). Tests de tabla en test/env-validate.test.ts.
- Validation: npx vitest run test/env-validate.test.ts: 42 passed
- Validation: npx eslint apps/api: exit 0 (prettier --check limpio)
- Validation: npm run typecheck -w apps/api: ok
- Validation: npm test -w apps/api: 254/254 en la primera corrida; después falla de forma intermitente un test previo de project-service (carrera ajena a T1.1, registrada como deuda)
- Files changed: `apps/api/src/env-files/validate.ts`, `apps/api/test/env-validate.test.ts`
- Notes: Test con valor centinela comprueba que error.message no incluye el contenido. Valores multilínea entre comillas se rechazan con la línea que falla, según el contexto de la tarea.

**Verdict**: pass

---
#### T1.2: Cifrado AES-256-GCM y repositorio project_env_files

**Status**: done

**Description**: Agregar a apps/api/src/auth/crypto.ts un par encryptParts/decryptParts que devuelva y reciba { ciphertext, iv, tag } como Buffer y acepte AAD. Crear apps/api/src/env-files/repo.ts (EnvFileRepository) sobre la tabla project_env_files ya migrada: clave deriveKey(secretKey, 'env-files-v1'); AAD = '<projectId>:<relPath>' para que un cifrado no pueda moverse a otra fila; upsert(projectId, relPath, content, keyNames) que devuelve si creó o reemplazó; list(projectId) solo con metadatos { path, keyNames, updatedAt, readable }; remove(projectId, relPath); readAll(projectId) que devuelve { path, content } o { path, unreadable: true } si falla el descifrado (clave rotada o datos alterados). 'readable' en list se calcula intentando descifrar, sin devolver el texto. Tipos EnvFileInfo y EnvApplyResult en packages/shared.

**Evidence**:
- Summary: crypto.ts suma encryptParts/decryptParts (AES-256-GCM, {ciphertext, iv, tag} Buffer, AAD opcional). Nuevo env-files/repo.ts: EnvFileRepository con clave deriveKey(secret,'env-files-v1') (info efectivo agents-panel:env-files-v1), AAD '<projectId>:<relPath>', upsert (ON CONFLICT → 'created'|'replaced', key_names JSON), list solo metadatos con readable por intento de descifrado, remove, readAll con {path, unreadable:true} si falla. Tipos EnvFileInfo y EnvApplyResult en packages/shared.
- Validation: npx vitest run test/env-repo.test.ts: 8 passed (reemplazo con una fila y updated_at nuevo, centinela ausente en JSON.stringify(list), otra clave → readable=false/unreadable, byte alterado y rel_path/project_id cambiados → ilegible, filas y archivos de la base (db+wal) sin centinela)
- Validation: npm run typecheck --workspaces (shared, api, web): ok tras build de shared
- Validation: npx eslint apps/api packages/shared: exit 0
- Validation: npm test -w apps/api: 262/262 passed
- Files changed: `apps/api/src/auth/crypto.ts`, `apps/api/src/env-files/repo.ts`, `packages/shared/src/index.ts`, `apps/api/test/env-repo.test.ts`
- Notes: Los tests usan TEST_ENV y centinelas falsos; no se leyó ningún .env real. EnvApplyResult = {chatId, worktreePath, status: written|skipped, reason} para R17.

**Verdict**: pass

---
### P2 — Re-autenticación TOTP, rutas y redacción

> Exponer GET, PUT y DELETE de .env con sesión y TOTP nuevo, sin que el contenido llegue a respuestas ni logs.

#### T2.1: Paso de re-autenticación TOTP reutilizable

**Status**: done

**Description**: Crear apps/api/src/auth/reauth.ts con un verificador que recibe la sesión (request.session) y el código: si falta, no es de 6 dígitos, el usuario está bloqueado, el código es incorrecto o ya se usó (consumeTotp quema el time step) responde 401 { error: 'invalid_totp' }; cada fallo llama users.registerFailure con MAX_FAILED_ATTEMPTS y LOCK_MS y se audita en login_attempts con step 'reauth'; un éxito llama clearFailures y se audita. No acepta códigos de recuperación. Exportar el verificador para que lo usen las rutas de .env ahora y la actualización de Kyro en el sprint 3.

**Evidence**:
- Summary: Nuevo auth/reauth.ts: ReauthVerifier.verify(request, reply, code) lee request.session; sin código, no-6-dígitos, usuario bloqueado, incorrecto o ya usado (consumeTotp quema el time step, compartido con el login) → 401 {error:'invalid_totp'}. Cada fallo (salvo estando bloqueado, igual que el login) llama registerFailure(MAX_FAILED_ATTEMPTS, LOCK_MS); éxito → clearFailures. Todo intento se audita en login_attempts con step 'reauth' y motivo (missing_code|bad_format|bad_code|locked), sin el código. No acepta códigos de recuperación. AttemptStep suma 'reauth' (sin migración). Exporta INVALID_TOTP.
- Validation: npx vitest run test/reauth.test.ts: 11 passed (faltante/vacío/no-string/mal formado/largo/incorrecto → 401 invalid_totp y contador +1; mismo código dos veces → 401; recovery code → 401; 5 fallos → bloqueo y código válido 401 hasta que vence; login_attempts sin el código)
- Validation: npx eslint apps/api: exit 0
- Validation: npm run typecheck -w apps/api: ok
- Validation: npm test -w apps/api: 272/273; la única falla es el test previo de project-service recoverInterrupted (carrera ajena, debt-5), que se arregla en la tarea emergente E1
- Files changed: `apps/api/src/auth/reauth.ts`, `apps/api/src/auth/attempts.ts`, `apps/api/test/reauth.test.ts`

**Verdict**: pass

---
#### T2.2: Rutas GET, PUT y DELETE /api/projects/:id/env

**Status**: done

**Description**: Crear apps/api/src/env-files/routes.ts y registrarlo en app.ts. GET /api/projects/:id/env devuelve la lista de metadatos. PUT /api/projects/:id/env con body { path, content, totp, applyToActive? }: valida claves (onlyKeys), forma, TOTP (T2.1), proyecto existente y 'ready', ruta (T1.1), contenido (T1.1) y que git ignora la ruta en el clon del proyecto (git -C <repoPath> check-ignore -q -- <path> por execFile; 0 = ignorado, 1 = no ignorado → 400, otro código → 400 con motivo genérico); recién entonces guarda (T1.2) y responde 201 si creó o 200 si reemplazó con { file, applied? }. DELETE /api/projects/:id/env con body { path, totp } borra la fila (404 si no existe). Mover onlyKeys a un helper compartido (apps/api/src/http/only-keys.ts) y reutilizarlo desde projects/routes.ts. El PUT tiene bodyLimit propio (256 KB) porque el global es 64 KB y el JSON escapa el contenido; el límite real de 64 KB lo impone parseEnvContent. Aplicar AUTH_RATE_LIMIT a PUT y DELETE. Ampliar la allowlist de rutas que mutan en cli.test.ts y la cobertura de guard.test.ts.

**Evidence**:
- Summary: Nuevo env-files/routes.ts (registrado en app.ts como plugin para que aplique el rate limit): GET /api/projects/:id/env (metadatos, 404 si no existe), PUT {path, content, totp, applyToActive?} con bodyLimit 256 KB y AUTH_RATE_LIMIT: onlyKeys → schema → TOTP (ReauthVerifier) → proyecto existente (404) y ready (409) → validateEnvPath → parseEnvContent → git -C repo check-ignore -q -- path por execFile (1 → 400, otro → 400 genérico) → upsert; 201 creado / 200 reemplazado con {file}. DELETE {path, totp} con TOTP, 404 si no hay fila. onlyKeys movido a http/only-keys.ts y reutilizado en projects/routes.ts (respond e idParams exportados). applyToActive aceptado sin efecto (T3.3).
- Validation: npx vitest run test/env-routes.test.ts test/guard.test.ts test/cli.test.ts: 32 passed (201/200/GET solo metadatos sin centinela; 400 para .env.production, .env.example, ../.env, /abs/.env, a/../.env, config/.env no ignorado, >64 KB, NUL, línea inválida y campo extra con tabla vacía; 401 invalid_totp sin/incorrecto/repetido en PUT y DELETE sin cambios, TOTP antes que la ruta; 409 no ready; 404 proyecto inexistente y DELETE de ruta inexistente; 401 sin sesión)
- Validation: guard.test.ts: rutas nuevas no públicas, allowlist pública exacta = /api/health + /api/auth/login + /api/auth/totp; cli.test.ts con /api/projects/:id/env (PUT y DELETE) en la allowlist de rutas que mutan
- Validation: grep -nE 'exec\(|shell: ?true' en código nuevo: solo RegExp.exec en validate.ts; ningún child_process exec ni shell:true (se usa execFile con '--')
- Validation: npx eslint apps/api: exit 0; prettier --check limpio; npm run typecheck --workspaces: ok
- Validation: npm test -w apps/api: 290/291; la única falla es el test previo recoverInterrupted (debt-5 / tarea emergente E1)
- Files changed: `apps/api/src/env-files/routes.ts`, `apps/api/src/http/only-keys.ts`, `apps/api/src/projects/routes.ts`, `apps/api/src/app.ts`, `apps/api/test/env-routes.test.ts`, `apps/api/test/guard.test.ts`, `apps/api/test/cli.test.ts`

**Verdict**: pass

---
#### T2.3: Redacción en el logger y prueba de centinela de punta a punta

**Status**: done

**Description**: Configurar la redacción del logger de Fastify (redact de req.body.content, body.content y content con censura fija) en un solo lugar que usen main.ts y los tests (por ejemplo una constante LOGGER_OPTIONS exportada desde app.ts). Agregar un test de punta a punta con una base SQLite en archivo y el logger en nivel trace escribiendo a un stream en memoria: sube un .env con un valor centinela (válido), lo reemplaza, provoca un 400 por línea inválida que contiene el centinela, un 401 por TOTP y un error de check-ignore, crea un chat que escribe el .env en su worktree (cuando T3.2 exista) y verifica que el centinela no aparece en ningún cuerpo de respuesta, en la salida del logger, en chat_events ni en los bytes del archivo de la base (incluido el -wal si existe).

**Evidence**:
- Summary: app.ts exporta LOGGER_OPTIONS (level info, redact req.body.content / body.content / content con censura fija '[redacted]'); main.ts pasa { logger: LOGGER_OPTIONS } (antes logger: true; nivel de producción sin cambios). Nuevo test/env-sentinel.test.ts de punta a punta: SQLite en archivo, logger con LOGGER_OPTIONS en nivel trace a un stream en memoria y un hook que loguea el body completo (peor caso); sube un .env con centinela (201), lo reemplaza (200), 400 por línea inválida con el centinela, 401 por TOTP, 400 por ruta no ignorada, 400 por check-ignore fallido (clon sin .git), GET, crea un chat que escribe el .env en su worktree (verificado) y lee sus eventos.
- Validation: npx vitest run test/env-sentinel.test.ts: 1 passed — centinela ausente en todas las respuestas, en la salida trace del logger (que sí contiene '[redacted]'), en chat_events y en los bytes de panel.sqlite y sus -wal/-shm
- Validation: npm run typecheck --workspaces: ok; npx eslint apps/api: exit 0
- Validation: npm test -w apps/api: 303/303 passed
- Files changed: `apps/api/src/app.ts`, `apps/api/src/main.ts`, `apps/api/test/env-sentinel.test.ts`

**Verdict**: pass

---
### P3 — Escritura de .env en worktrees

> Que cada worktree nuevo arranque con sus .env (600, ignorados, después del setup) y que se puedan aplicar a los activos.

#### T3.1: Escritor seguro de .env en un worktree

**Status**: done

**Description**: Crear apps/api/src/env-files/write.ts con writeEnvFiles(worktreePath, files). Para cada archivo: revalida la ruta con validateEnvPath; exige que la carpeta destino exista (si no, falla con 'falta la carpeta <dir> para <path>'); resuelve realpath de la carpeta y exige que quede dentro del realpath del worktree (sin escaparse por symlinks); exige que git ignore la ruta en ese worktree (git -C <worktree> check-ignore -q -- <path>); escribe en un archivo temporal de la misma carpeta con modo 0600 (flag wx) y lo renombra sobre el destino, así un symlink existente en el destino se reemplaza y no se sigue; deja el modo en 600. Si algún archivo viene ilegible, falla sin escribir ninguno ('el .env <path> está ilegible, volvé a subirlo'). Todos los chequeos se hacen antes de escribir el primer archivo, así un fallo no deja escrituras a medias en la validación.

**Evidence**:
- Summary: Nuevo env-files/write.ts: writeEnvFiles(worktreePath, files) rechaza toda la lista si hay un ilegible ('el .env <path> está ilegible, volvé a subirlo'); por archivo revalida con validateEnvPath, exige carpeta existente ('falta la carpeta <dir> para <path>'), realpath de la carpeta dentro del realpath del worktree y git check-ignore en el worktree (execFile con '--'); todos los chequeos antes de la primera escritura. Escribe a temp en la misma carpeta (0600, flag wx), chmod 600 y rename sobre el destino (un symlink se reemplaza, no se sigue). assertGitIgnored queda exportado acá y routes.ts lo reutiliza (se quitó el duplicado).
- Validation: npx vitest run test/env-write.test.ts: 8 passed sobre worktrees reales (makeGitRepo + git worktree add): backend/.env 600 y git status --porcelain vacío; carpeta faltante → mensaje exacto y nada escrito; carpeta symlink fuera → error y nada fuera; destino symlink → archivo regular 600 y blanco intacto; ruta no ignorada → error y nada escrito; ilegible → error y nada escrito; ../.env rechazada
- Validation: npx vitest run test/env-routes.test.ts: 18 passed tras mover assertGitIgnored
- Validation: npx eslint apps/api: exit 0; typecheck api ok
- Validation: npm test -w apps/api: 299/299 passed
- Files changed: `apps/api/src/env-files/write.ts`, `apps/api/test/env-write.test.ts`, `apps/api/src/env-files/routes.ts`

**Verdict**: pass

---
#### T3.2: Escribir los .env al crear el worktree de un chat, con rollback

**Status**: done

**Description**: En ChatService.create, después de createWorktree (que ya corrió el setup) y antes de crear el chat, leer los .env del proyecto (readAll) y escribirlos con writeEnvFiles. Si falla, removeWorktree (worktree y rama) y ChatError 422 con el motivo; no queda chat, evento ni rama. Registrar en los eventos bufferizados solo { step: 'env', paths: [...] }, nunca contenido. Sin .env registrados, el flujo queda como hoy. No cambia el contrato de createWorktree. Pasar EnvFileRepository por ChatServiceDeps desde app.ts.

**Evidence**:
- Summary: ChatService.create: tras createWorktree (setup incluido) y antes de crear el chat, writeEnv lee envFiles.readAll y llama writeEnvFiles; EnvFileError → ChatError 422 y el catch existente hace removeWorktree (worktree + rama), sin chat ni eventos. Evento bufferizado worktree_output { step: 'env', paths } sin contenido. Sin .env el flujo no cambia. EnvFileRepository llega por ChatServiceDeps.envFiles desde app.ts (una sola instancia compartida con las rutas). createWorktree sin cambios.
- Validation: npx vitest run test/chats.test.ts: 14 passed; nuevos: setup 'mkdir backend' → backend/.env 600, git status --porcelain vacío, evento {step:'env', paths:['.env','backend/.env']} y chat_events sin centinela; sin setup → 422 'falta la carpeta backend para backend/.env' sin chat, worktree ni rama feature/no-backend; .env cifrado con otra clave → 422 'el .env .env está ilegible, volvé a subirlo' con rollback completo y 0 eventos; tests previos (sin .env) en verde
- Validation: npx eslint apps/api: exit 0; npm run typecheck --workspaces: ok
- Validation: npm test -w apps/api: 301/302; la única falla es el test previo recoverInterrupted (debt-5 / tarea emergente E1)
- Files changed: `apps/api/src/chats/service.ts`, `apps/api/src/app.ts`, `apps/api/test/chats.test.ts`

**Verdict**: pass

---
#### T3.3: Aplicar un .env subido a los worktrees activos (applyToActive)

**Status**: done

**Description**: Cuando el PUT trae applyToActive: true, después de guardar, escribir ese archivo en cada worktree activo del proyecto y devolver applied: [{ chatId, worktreePath, status: 'written' | 'skipped', reason? }]. Worktree activo = chat del proyecto cuyo worktreePath todavía existe en disco; los que no existen no se listan. Cada worktree se procesa por separado con writeEnvFiles y un fallo (carpeta faltante, no ignorado, symlink) queda como 'skipped' con su motivo sin frenar a los demás. El guardado ya está hecho aunque todos fallen.

**Evidence**:
- Summary: Nuevo env-files/apply.ts: applyEnvFileToWorktrees(chats, file) recorre los chats del proyecto cuyo worktree existe en disco (los demás no se listan) y llama writeEnvFiles por separado; EnvFileError → skipped con su motivo, otro error → skipped con motivo genérico, sin frenar a los demás. PUT con applyToActive: true, después de guardar, devuelve { file, applied: EnvApplyResult[] }; sin applyToActive (o false) responde { file } y no toca worktrees. EnvFileRouteDeps suma chats (ChatRepository); app.ts lo pasa (cableado necesario fuera de la lista de archivos).
- Validation: npx vitest run test/env-routes.test.ts: 20 passed; nuevos: dos chats activos (uno sin backend/) → written (backend/.env 600 con el contenido) y skipped 'falta la carpeta backend para backend/.env'; chat con worktree borrado no aparece en applied; reemplazo con applyToActive deja el contenido nuevo; sin applyToActive o false no escribe en el worktree ni devuelve applied; la respuesta no contiene el centinela
- Validation: npx eslint apps/api: exit 0; npm run typecheck --workspaces: ok
- Validation: npm test -w apps/api: 304/305; la única falla es el test previo recoverInterrupted (debt-5 / tarea emergente E1)
- Files changed: `apps/api/src/env-files/apply.ts`, `apps/api/src/env-files/routes.ts`, `apps/api/src/app.ts`, `apps/api/test/env-routes.test.ts`

**Verdict**: pass

---
### P4 — Docs y deuda chica

> Dejar documentado lo que hace el sprint y pagar la deuda que queda al lado del código tocado.

#### T4.1: Docs: .env en plan.md, panel-desarrollo.md, estados.md y CLAUDE.md

**Status**: done

**Description**: docs/plan.md: sección de .env (cifrado AES-256-GCM con HKDF y info 'agents-panel:env-files-v1', validaciones de nombre, ruta y contenido, check-ignore, re-autenticación TOTP, escritura después del setup con 600 y fail-closed, ilegibles al rotar PANEL_SECRET_KEY, applyToActive). docs/panel-desarrollo.md: cómo subir, reemplazar, listar y borrar un .env por la API mientras no haya web (con valores falsos, nunca reales). docs/estados.md: el nuevo motivo de fallo al crear un worktree ('falta la carpeta X para .env' o .env ilegible). CLAUDE.md, sección 'Proyectos registrados': los .env de desarrollo los pone el panel en cada worktree; panel-setup.sh puede seguir copiando el suyo (el panel escribe después y gana). No tocar la regla de bitácora (R24, sprint 3).

**Evidence**:
- Summary: docs/plan.md: nueva sección '.env de desarrollo por proyecto' (tabla project_env_files, AES-256-GCM con HKDF info agents-panel:env-files-v1 y AAD projectId:ruta, solo metadatos hacia afuera y LOGGER_OPTIONS con redacción, validaciones de ruta/nombre/contenido y check-ignore, re-auth TOTP con 401 invalid_totp y step reauth, escritura 600 después del setup con fail-closed 422 y rollback, ilegibles al rotar PANEL_SECRET_KEY, applyToActive). docs/panel-desarrollo.md: cómo subir/reemplazar (PUT con ejemplo de valores falsos), listar, borrar y los códigos 200/201/400/401/404/409/422. docs/estados.md: el paso instalando_dependencias incluye la escritura de .env y sus motivos de fallo (422 con rollback, sin chat). CLAUDE.md 'Proyectos registrados': una viñeta sobre los .env que pone el panel (panel-setup.sh puede copiar el suyo; el panel escribe después y gana). Sin cambios en la VM.
- Validation: Contraste con apps/api/src/env-files/routes.ts y test/env-routes.test.ts: rutas GET/PUT/DELETE /api/projects/:id/env, campos path/content/totp/applyToActive, 201/200, 400, 401 invalid_totp, 404, 409, DELETE {ok:true}; 422 y mensajes con test/chats.test.ts y write.ts
- Validation: grep -iE 'sk-|ghp_|gho_|AKIA|PRIVATE KEY|password=|secret=|token=|api_key=' sobre las líneas agregadas: sin coincidencias (el ejemplo usa API_KEY=valor-de-prueba y totp 123456)
- Validation: git diff CLAUDE.md: solo +1 línea en 'Proyectos registrados'; la regla de bitácora sin cambios
- Files changed: `docs/plan.md`, `docs/panel-desarrollo.md`, `docs/estados.md`, `CLAUDE.md`

**Verdict**: pass

---
#### T4.2: Pagar debt-1 y debt-2: campos extra en chats y mensaje de duplicado

**Status**: done

**Description**: debt-1: usar el helper onlyKeys (T2.2) en las rutas de chats que tienen body (POST /api/chats y POST /api/chats/:id/messages) para que un campo extra dé 400 en vez de descartarse. debt-2: el mensaje de proyecto duplicado pasa a español ('El proyecto ya existe: <nombre>' o equivalente con 'ya existe'). Ajustar los tests de chats y de proyectos.

**Evidence**:
- Summary: debt-1: chats/routes.ts usa onlyKeys (http/only-keys.ts) en POST /api/chats y POST /api/chats/:id/messages (schemas extraídos a createBody/messageBody); un campo extra da 400 'Unknown field: …' antes de crear nada. debt-2: el duplicado de proyecto pasa a 'El proyecto ya existe: <nombre>' en repo.ts (insertGithub y add) y service.ts.
- Validation: npx vitest run test/chats.test.ts test/projects.test.ts test/project-service.test.ts test/cli.test.ts: 73 passed; nuevos: POST /api/chats con worktreePath extra → 400 'Unknown field: worktreePath', sin chat ni worktree; messages con campo extra → 400; segundo POST /api/projects del mismo repo → 409 con /ya existe/
- Validation: npx eslint apps/api: exit 0; typecheck api ok
- Validation: npm test -w apps/api: 306/306 passed
- Files changed: `apps/api/src/chats/routes.ts`, `apps/api/src/projects/repo.ts`, `apps/api/src/projects/service.ts`, `apps/api/test/chats.test.ts`, `apps/api/test/projects.test.ts`

**Verdict**: pass

---

## Unfinished work

_None — every task is done with a passing verdict._

## Learnings

- Un test que crea en paralelo una carpeta que también crea un job en segundo plano es inestable; esperar una señal del fake (cloner llamado) en vez de competir
- Las rutas con rate limit por ruta tienen que registrarse dentro de app.register para cargar después de @fastify/rate-limit; se verificó con 429 en el pedido 11

## Resolved Debt

- **debt-1**: Rutas de chats: additionalProperties:false descarta campos extra en vez de rechazarlos (ajv removeAdditional de Fastify)
- **debt-2**: R4: el mensaje de duplicado está en inglés ('Project already exists'), la especificación pide 'ya existe'
- **debt-5**: Test flaky project-service 'recoverInterrupted…': el clon en segundo plano hace mkdir(dest) antes que el mkdirSync del test (EEXIST ~40%). Fix: mkdirSync(..., { recursive: true }) en test/project-service.test.ts:315

## Recommendations for Sprint 3

- Sprint 3: reutilizar ReauthVerifier para la actualización de Kyro y resolver debt-3/debt-4 junto al alta
- Sprint 4 (web): distinguir 401 invalid_totp de sesión vencida y mostrar applied por worktree
