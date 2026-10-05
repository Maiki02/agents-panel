# AskUserQuestion está denegado y no tiene camino de respuesta

- **Severidad:** alta (bloquea el objetivo de preguntar desde la web).
- **Archivos:** `apps/api/src/agent/permissions.ts` (`SAFE_TOOLS` no la incluye), `apps/api/src/agent/sdk-runner.ts` (`createPreToolUseHook` deniega con `decide()` antes de que corra `canUseTool`), `apps/api/src/agent/runner.ts` (`PermissionDecision` no tiene `updatedInput`), `apps/api/src/agent/manager.ts` (`canUseTool` es síncrono).
- **Comportamiento visible:** hoy el agente no puede preguntar nada; la herramienta queda denegada y se registra `permission_denied`.
- **Recomendación:** `canUseTool` y el hook pasan a ser asíncronos; `AskUserQuestion` se deja pasar por el hook y `canUseTool` espera la respuesta guardada en `pending_questions`, que se devuelve como `updatedInput` (hipótesis H1; alternativa: denegar con "el usuario respondió: …"). Tipos del SDK 0.3.289: `AskUserQuestionInput/Output` en `sdk-tools.d.ts`, `updatedInput` en `sdk.d.ts`.
- **Validación:** runner falso que pide una pregunta, respuesta por la API, el runner recibe la respuesta; spike real en la VM.
