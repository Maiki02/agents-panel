Verdict: APPROVED WITH NOTES

# QA del sprint 4 (idea-cierre-merge) de autopiloto-kyro

## Alcance auditado
16 tareas (T1.1 a T6.2): base del piloto, chat Idea y aprobación, cierre por el panel, push, secretos, merge genérico y merge-dev, web mínima, docs y verificación.

## Verificado
- typecheck, lint, format:check, build en verde; API 965 tests y web 187 tests; /tmp igual antes y después.
- Sin `bypassPermissions` en `apps/api/src`; todo comando externo nuevo (git, gh, kyro, validate_command) por `execFile` con argv; `pushArgs` solo acepta nombres de rama simples; el test con repos reales y remoto bare comprueba que el push nunca toca la base y que el pull es `--no-rebase`.
- Sin rutas públicas nuevas; `POST /api/chats/:id/idea` y `accept_debt` exigen sesión y CSRF (tests 401/403).
- Los secretos nunca aparecen en la salida de `scanSecrets` ni en el detalle del freno (tests).
- Migraciones 13 a 16 conservan filas e ids (tests sobre bases con scope, work y direct).
- `kyro doctor --artifacts` no se queja de `.agents/kyro/qa/`.

## Hallazgos

### E1 (major): `accept_debt` ejecuta efectos irreversibles antes de comprobar que existe el run del piloto
`apps/api/src/pilot/accept-debt.ts`: tras `kyro scope complete --accept-open-debt`, el commit y el push, llama a `runs.setPhase(chatId, 'merge')`, que lanza `AutopilotTransitionError` si el chat no tiene run (un scope manual que llegó a `esperando_aprobacion_cierre` por el tracker, sin piloto). Resultado: el scope queda completado, commiteado y pusheado, la API responde error y el trabajo no pasa a la fase de merge ni queda marcado. Corrección: comprobar `runs.get(chatId)` antes de tocar Kyro (409 «el trabajo no tiene piloto») o crear el run, y agregar un test.

### Notas (no bloquean)
- N1: el análisis de Kyro deja 4 escenarios sin cobertura de tareas (S6, S20, S22, S23) y T6.1 sin `scenario_refs` (MEDIUM, ya en `kyro analyze`).
- N2: `scanWorktreeSecrets` revisa el diff completo de la rama contra la base; un documento que cite un token de ejemplo con formato real puede dar falso positivo. Aceptable por ser un freno visible y resoluble con `resume`.
- N3: la fase de merge usa el commit de «cambios pendientes» con `git add -A` solo tras un escaneo limpio; los archivos ignorados por git no se escanean ni se agregan, como corresponde.
- N4: el estado de la web para un scope/work se relee solo con eventos `state_changed`; si el stream cae, la tarjeta se actualiza al reconectar o al recargar.

## Firma
- Arquitectura: alineada (módulos pequeños, dependencias inyectables, política versionada).
- Seguridad: sin hallazgos bloqueantes salvo E1 (consistencia, no explotación).
- Planificación: `sprint.json`, tareas y docs sincronizados con el código.

## Re-QA (misma sesión)
E1 corregido con la tarea emergente E1: `accept_debt` comprueba el run antes de completar (409 sin efectos) y tiene test; API 966 tests en verde, lint y typecheck limpios. El hallazgo queda cerrado.

## Decisión
APPROVED WITH NOTES: solo quedan las notas N1 a N4, no bloqueantes.
