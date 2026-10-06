Verdict: APPROVED WITH NOTES

# Code Review Result

## Verdict

APPROVED WITH NOTES

## Summary

Segunda pasada del QA del sprint 6 (docs-ventas-cierre), después de corregir el hallazgo mayor de la primera (candado de instancia tras un reinicio sucio, tarea E2). El sprint cumple lo que prometía y todo lo verificable está en verde: typecheck, eslint, prettier, 1048 tests de la API, 255 de la web, el build, `kyro analyze` sin hallazgos y `kyro doctor --artifacts` sin errores. Quedan notas que no bloquean, y la corrida real del piloto con el servicio sigue sin hacerse (diferida por el usuario, registrada como deuda).

## Scope Reviewed

Lo de la primera pasada (ver «Historial») más `apps/api/src/instance-lock.ts` y su test con `boot_id` y `apps/web/src/app/notifications/push-sw.spec.ts` (E2), releídos completos.

## Findings

### Critical Issues

No critical issues found.

### Major Issues

No major issues found. El hallazgo mayor de la primera pasada está corregido: el lock guarda pid y `boot_id`, un lock de otro arranque se recupera aunque su pid esté vivo (test), y el formato viejo o un sistema sin `boot_id` conservan el comportamiento anterior.

### Minor Issues

1. Un lock escrito por la versión anterior (solo pid) no tiene `boot_id`: hasta el primer reinicio del servicio con el build nuevo, un reinicio sucio de la VM podría volver a toparse con un pid reutilizado. Se cierra solo con el próximo `--restart`.
2. Entre crear el archivo del lock y escribir el pid hay una ventana de microsegundos en la que otro proceso lo lee vacío y lo toma por huérfano; solo importa si dos APIs arrancan en el mismo instante, algo que el servicio y `tsx watch` no hacen.
3. `10-panel-service.sh --restart` corre `npm ci` con el servicio todavía en marcha (hoy no hay imports dinámicos que fallen).
4. `HASHED_FILE` trata como inmutable cualquier archivo con `-` y 8 o más caracteres alfanuméricos antes de la extensión; hoy no hay ninguno sin hash en `public/`.
5. `style-src 'unsafe-inline'` es una concesión consciente y documentada (scripts solo `'self'`).

## Architecture Alignment

Alineado (sin cambios respecto de la primera pasada): la web estática va por el not-found handler sin sumar rutas públicas, `rm` sigue el patrón de validación por argumento (sec-1) y los trabajos de una sola vez usan `app_flags`.

## Security Review

Sin hallazgos críticos ni mayores. `checkRm`, el service worker (`/\host` y caracteres de control), la allowlist pública de tres rutas, el límite de 10 suscripciones y la ausencia de `bypassPermissions` quedaron revisados en la primera pasada. El cambio del lock no toca nada de seguridad.

## Code Quality Review

Claro y consistente; el cambio de E2 es chico y está comentado con su porqué.

## Functional Review

Las 12 tareas (11 del plan y E2, más E1) tienen evidencia y review `pass`. T5.1 cambió de definición por decisión del usuario y su deuda está registrada.

## Testing Review

El lock tiene tests para los cuatro casos (otro boot, mismo boot, formato viejo, sin `boot_id`). El spec del service worker ya no depende del directorio de trabajo. Lo que no tiene prueba real es la corrida del piloto con el servicio (deuda).

## Performance and Scalability Review

Sin problemas nuevos.

## Reliability Review

El servicio ya no puede quedar sin arrancar por un lock de un arranque anterior. Ver los menores 1 y 2.

## Developer Experience Review

Sin cambios: `panel-desarrollo.md` explica cómo desarrollar sin chocar con el servicio y deja la guía de la corrida real.

## Core Plan Review

`sprint.json`: 12 tareas con evidencia y `pass`, `kyro analyze` limpio, `kyro doctor --artifacts` sin errores. Deuda abierta o diferida, con nota de que no se probó: `debt-1`, `debt-10`, `debt-12`, `debt-13`, `debt-14` y `debt-15`. El handoff coincide con el estado real.

## Required Fixes

No required fixes.

## Recommended Improvements

Los menores de arriba; ninguno bloquea el cierre.

## Final Decision

Approved with notes. El sprint puede cerrarse. La deuda de la corrida real queda abierta y se acepta explícitamente al completar el scope.

---

# Historial: primera pasada (CHANGES REQUIRED)


### Informe de la primera pasada

### Verdict

CHANGES REQUIRED

### Summary

El sprint 6 entrega lo que prometía: servicio systemd con la web compilada, `rm` validado, prompt del primer turno de un Work, deuda menor del sprint 5, el paso de versión de ventas (PR #1) y las docs. Typecheck, eslint, prettier, 1045 tests de la API y 255 de la web y el build pasan, y `kyro analyze` y `kyro doctor` están limpios. Hay **un hallazgo mayor** de confiabilidad en el candado de instancia única, que ahora decide si el servicio de producción arranca, y se corrige antes de cerrar.

### Scope Reviewed

`apps/api/src/{web-static,instance-lock,main,app,config}.ts`, `auth/{guard,security}.ts`, `agent/permissions.ts` (`checkRm`), `pilot/{policy,prompts,routes}.ts`, `chats/service.ts`, `projects/repo.ts`, `push/{repo,routes}.ts`, `db/{flags,migrations}.ts`, `apps/web/public/push-sw.js`, `apps/web/angular.json`, `scripts/vm/{10-panel-service.sh,agents-panel.service,09-tailscale-funnel.sh}`, sus tests, `docs/*` y `CLAUDE.md`, y `sprint.json` del scope (tareas, deuda, handoff). No pude verificar en la VM la idempotencia de `10-panel-service.sh` (la corrió la persona y no vi su salida) ni la corrida real del piloto (diferida por el usuario, ver deuda).

### Findings

### Critical Issues

No critical issues found.

### Major Issues

1. **El candado de instancia solo mira si el pid está vivo (`instance-lock.ts`).** Tras un reinicio sucio de la VM (corte de energía, `kill -9` del host) `panel.lock` queda con el pid del servicio anterior. Después del arranque los pids se reutilizan: si ese número lo tiene otro proceso vivo, `acquireInstanceLock` lo da por dueño, la API sale con error y systemd la reinicia cada 5 s con `Restart=on-failure` **sin recuperarse nunca** (el pid ajeno sigue vivo). Un servicio de producción que no arranca solo después de un reinicio es bloqueante. Corrección: guardar junto al pid el `boot_id` de Linux (`/proc/sys/kernel/random/boot_id`) y tratar como huérfano un lock de otro arranque; test con un lock de otro `boot_id` cuyo pid está vivo.

### Minor Issues

1. `apps/web/src/app/notifications/push-sw.spec.ts` lee `public/push-sw.js` con `process.cwd()`: falla si vitest se corre desde la raíz del repo. Usar `import.meta.dirname`.
2. `10-panel-service.sh --restart` corre `npm ci` con el servicio todavía en marcha: borra `node_modules` bajo un proceso vivo (los módulos ya cargados siguen, pero un `import()` tardío fallaría). Hoy no hay imports dinámicos; documentarlo o parar el servicio antes si aparecen.
3. La regla de cache largo (`HASHED_FILE`) trata como inmutable cualquier archivo con `-` más 8 o más caracteres alfanuméricos antes de la extensión, incluso uno sin hash (por ejemplo un `logo-background.svg` de `public/`). Hoy no hay ninguno.
4. `style-src 'unsafe-inline'` es una concesión consciente (Angular inyecta estilos de componentes); está documentada y los scripts siguen solo `'self'`.

### Architecture Alignment

Alineado. La web estática va por el not-found handler y no suma rutas públicas (la allowlist sigue en tres, con test). `rm` sigue el patrón de los comandos de lectura (validación previa por argumento, convención sec-1) y aplica incluso si un proyecto lo agrega como extra. Los trabajos de una sola vez usan una tabla `app_flags` (migración 18) en vez de recorrer eventos en cada arranque.

### Security Review

Sin hallazgos críticos. Revisé `checkRm`: `..`, symlinks (padre resuelto y último componente sin seguir), barra final sobre symlink, `.git` y anidados, `cd` previo, envoltorios, globs, `~`, variables, comillas y opciones; solo queda la ventana entre validar y ejecutar (documentada). El service worker ya rechaza `/\host` y caracteres de control. Los archivos estáticos son públicos y no exponen datos; no hay `bypassPermissions`; `.env.example` solo con valores falsos; el límite de 10 suscripciones push se evalúa sin `await` entre contar e insertar.

### Code Quality Review

Código claro, comentarios que explican el porqué, sin duplicación relevante. Se corrigió además el formato de 11 archivos del sprint y los tests viejos que daban por hecho que `rm` siempre se denegaba.

### Functional Review

Cada criterio de aceptación de las 11 tareas tiene evidencia. T5.1 cambió de definición por decisión del usuario (corrida real diferida) y su deuda está registrada (`debt-1`, `debt-10`, `debt-12` a `debt-15`).

### Testing Review

Buena cobertura nueva: stubs para los scripts de la VM, un worktree real con symlinks para `rm`, el service worker cargado en un contexto simulado y la red de `web-push` inyectada. Falta el test del `boot_id` (ver hallazgo mayor). Lo que no tiene prueba real es la corrida del piloto con el servicio, y está en la deuda.

### Performance and Scalability Review

Mejora: el ref de `kyro-init` ya no lanza dos `git` por proyecto en cada lectura y el respaldo de `question_cancelled` no recorre eventos en cada arranque. Sin problemas nuevos.

### Reliability Review

El hallazgo mayor (candado tras un reinicio sucio). El resto: lock huérfano por pid muerto recuperado, `Restart=on-failure`, migración 18 idempotente.

### Developer Experience Review

`panel-desarrollo.md` explica cómo desarrollar sin chocar con el servicio y la guía de la corrida real quedó escrita.

### Core Plan Review

`sprint.json`: 11 de 11 tareas con evidencia y review `pass` (E1 re-evidenciada al enlazarla con el escenario S48), `kyro analyze` sin hallazgos y `kyro doctor --artifacts` sin errores. Deuda: `debt-1` y `debt-10` diferidas, `debt-12` a `debt-15` abiertas, todas con nota de que no se probó; resueltas `debt-5`, `debt-9` y `debt-11`. El handoff coincide con el estado real.

### Required Fixes

1. Hallazgo mayor: el candado de instancia guarda y compara el `boot_id` además del pid, con test.

### Recommended Improvements

Los cuatro menores de arriba (el primero es de una línea).

### Final Decision

Changes required. El sprint está bien salvo el candado de instancia, que puede dejar al servicio sin arrancar tras un reinicio sucio. Corregirlo y repetir QA.
