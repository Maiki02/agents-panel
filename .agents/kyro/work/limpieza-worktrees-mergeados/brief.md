# Borrar solo el worktree de los trabajos mergeados, sin perder la card

Los worktrees de NovaGent y Agents Panel ocupan más de 10 GB en `~/wt` y la mayoría son de trabajos cuya PR ya se mergeó: no se van a volver a usar. Hay que liberar ese espacio sin perder la información de la card (tiempos, rama, estado, Timeline, uso, PR) ni el historial del chat.

## Situación actual

- Una card es una fila de `chats` con sus tablas hijas (`worktree_state`, `worktree_transitions`, `chat_events`, `agent_sessions`, `autopilot_runs`, `panel_steps`). El chat se muestra entero desde `chat_events`: no lee la carpeta del worktree.
- Ya existe **Borrar trabajo** (`WorktreeOps.deleteWork`, D28): apaga el piloto, pasa por `limpiando`, borra las ramas remotas si se pide, borra la carpeta y las ramas locales y deja la card en `archivado` (solo lectura). **No borra la fila**: la card y el chat quedan. Hoy es solo manual (`delete_work` tiene `automatic: null` en `PARITY_CATALOG`).
- `PrWatcher` detecta las PR mergeadas (estado `mergeada`), pero nada reacciona a ese estado: `docs/estados.md` deja la limpieza automática después de `mergeada` para más adelante.

## Decisiones (del usuario, 2026-11-19)

1. **El worktree se borra solo 24 horas después del merge.** No al crear la PR (puede necesitar correcciones) ni en el momento del merge. Pasadas 24 horas desde el merge, el panel corre Borrar trabajo y la card queda en `archivado` con toda su información.
2. **También se borra la rama remota** (GitHub o GitLab) del trabajo y de sus repos hijos: ya está mergeada, no se pierde nada. Nunca la rama base.
3. **Los worktrees que ya existen se limpian solos al desplegar.** Al arrancar, el panel aplica la misma regla a los trabajos existentes: los que tienen la PR mergeada hace más de 24 horas se limpian sin intervención.

## Decisiones del agente (sin preguntar)

Registradas acá y no con `kyro adr`, porque `kyro adr add` escribe el `sprint.json` de un scope de Forge y un Work no puede tocar el estado de Forge.

- **A1. Las 24 horas se cuentan desde el merge real cuando el proveedor lo informa.** `PrWatcher` guarda el momento del merge (`mergedAt` de `gh`, `merged_at` de GitLab; si son varias PR, el último) y, si no lo informa, el momento en que lo detectó. Así los trabajos mergeados hace semanas se limpian en el primer despliegue (decisión 3) y los nuevos esperan 24 horas. Alternativa descartada: contar desde la detección, que haría esperar 24 horas más a todos los existentes.
- **A2. Un limpiador del panel, no del piloto.** Un servicio nuevo de la API recorre los trabajos en `mergeada` al arrancar y después cada cierto tiempo, y llama a `WorktreeOps.deleteWork(chatId, true, 'pilot')`: pasa por el servicio único, el Timeline lo registra y `delete_work` pasa a `automatic: 'pilot'` en `PARITY_CATALOG` (el botón ya existe). Vale para cualquier trabajo con worktree que llegue a `mergeada`, tenga o no piloto.
- **A3. Nunca se pierde trabajo.** Antes de borrar, el limpiador usa `deletePreview`: si algún repo tiene archivos sin commitear o commits que ningún remoto tiene, no borra y pasa el trabajo a `revisar` con el detalle (se resuelve a mano). Si el trabajo está ocupado (agente corriendo, mantenimiento de Kyro, piloto activo: el 409 de siempre), lo saltea y lo reintenta en la próxima vuelta.
- **A4. Configurable.** `PANEL_CLEANUP_AFTER_MERGE_HOURS` (24 por defecto; 0 apaga la limpieza automática) en `.env.example` y en la config.
- **A5. La card avisa.** Una card en `mergeada` muestra cuándo se borra su worktree; una en `archivado` sigue mostrando rama, tiempos, PR, Timeline, uso y chat.

## Fuera de alcance

- Borrar trabajos que no están mergeados (PR abierta o cerrada sin merge, sin PR): siguen con Borrar trabajo a mano.
- Borrar carpetas huérfanas de `~/wt` que no pertenecen a ningún trabajo ni a los transcripts del SDK en `~/.claude/projects` (pesan poco).
- Cambios en la VM.

## Cómo se verifica

- Tests de Vitest de API y web, `npm run typecheck`, `npm run lint` y `npm run format:check` del repo.
- `docs/plan.md`, `docs/estados.md` (`mergeada → limpiando → archivado` automático) y `.env.example` reflejan la limpieza automática.
