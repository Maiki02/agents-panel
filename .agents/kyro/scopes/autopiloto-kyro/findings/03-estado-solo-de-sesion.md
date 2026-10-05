# Solo existe el estado de sesión; no hay estado de trabajo ni Timeline

- **Severidad:** media.
- **Archivos:** `apps/api/src/db/migrations.ts` (`chats.status` con 5 valores, sin `worktree_state`), `apps/web/src/app/chats/status.ts` (etiquetas "En curso", "En espera"…), `apps/web/src/app/chats/chat-sidebar.ts`, `docs/estados.md`.
- **Comportamiento visible:** la sidebar muestra "En espera" aunque el trabajo esté en QA o esperando una aprobación; no se sabe qué sprint ni qué tarea corre.
- **Recomendación:** tabla `worktree_state` + eventos de transición, lector de `kyro context-pack --json` / `kyro work status --json` después de cada turno, y mapeo a una etiqueta por ítem (proyecto, trabajo, sesión) con tono por quién actúa.
- **Validación:** fixtures de los JSON reales de Kyro y specs de la función que elige la etiqueta.
