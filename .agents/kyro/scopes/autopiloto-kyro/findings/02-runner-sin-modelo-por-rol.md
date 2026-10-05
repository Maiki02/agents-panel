# El runner no pasa `model` ni registra rol y modelo

- **Severidad:** media.
- **Archivos:** `apps/api/src/agent/sdk-runner.ts` (`query()` sin `model`), `apps/api/src/agent/runner.ts` (`RunParams` sin modelo), `apps/api/src/chats/service.ts`, `packages/shared/src/index.ts`.
- **Comportamiento visible:** todas las sesiones usan el modelo por defecto de la VM; nada indica con qué modelo corrió cada paso.
- **Recomendación:** `RunParams.model`, configuración por proveedor con modelo pensante y ejecutor (default Opus 5.5 / Sonnet 5.5) y override por chat; cada evento de sesión guarda rol y modelo. El SDK acepta `model?: string` (`sdk.d.ts`).
- **Validación:** tests de que cada paso usa el modelo de su rol.
