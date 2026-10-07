Verdict: APPROVED WITH NOTES

# QA — operaciones-worktree, sprint 4 `docs-y-cierre`

## Alcance auditado
Cambios sin commitear del sprint: `CLAUDE.md`, `docs/plan.md`, `docs/estados.md`, `docs/panel-desarrollo.md` (más estado Kyro). Sprint solo de documentación; el código de los sprints 1 a 3 ya tiene su QA.

## Verificación
- `npm run typecheck`: sin errores (shared, api, web).
- `npm test`: api 72 archivos / 1197 tests OK; web 32 archivos / 304 tests OK.
- `kyro analyze`: sin hallazgos. Deuda abierta: 0. Pendientes de review: 0.
- Contraste docs ↔ código: las rutas citadas (`git/pr`, `git/diff`, `git/discard`, `work/delete-preview`, `steps`), `PARITY_CATALOG` (con `parity-catalog.test.ts`), `QUOTA_RESET_MARGIN_MS` (`pilot/autopilot.ts`), `provider_usage`, `project_repos` y `usageTone` existen y coinciden con lo descrito (D18 a D28).
- `CLAUDE.md`: la sección «Operaciones sobre un trabajo» recoge actor, 409, límites de push/rebase/clon base/ignorados y medición por `account_id`; consistente con `docs/plan.md`.
- `docs/estados.md`: `sin_cupo_de_uso` actualizado a `resetsAt + 60 s` con fallback a 15 min; coincide con el código.
- Seguridad: los docs no incluyen secretos, solo describen dónde viven.

## Notas (no bloqueantes)
1. El recorrido manual en `ventas` y la PR real en `agents-panel` (paso 7 de `panel-desarrollo.md`) quedan para el usuario, como lo declara el doc; el agente no los puede hacer. Deben hacerse antes de completar el scope.
2. Backup de SQLite, topes configurables y limpieza automática (etapa 6) siguen pendientes y están documentados como tales.

## Decisión
Documentación fiel a lo implementado, sin hallazgos críticos ni altos. Sin bloqueos.
