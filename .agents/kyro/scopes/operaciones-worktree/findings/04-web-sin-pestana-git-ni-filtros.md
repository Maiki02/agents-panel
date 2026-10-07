# 04 · Web: sin pestaña Git, sin filtros, sin diff ni borrado

- **Severidad:** media
- **Archivos:** `apps/web/src/app/chats/chat.page.ts` (pestañas `chat` y `timeline`), `apps/web/src/app/chats/chat-sidebar.ts`, `apps/web/src/app/ui/tabs.ts`, `apps/api/src/chats/routes.ts`, `apps/api/src/worktrees/create.ts` (`removeWorktree`)

## Resumen

No hay rutas de diff, descartar cambios ni borrar un trabajo (`removeWorktree` existe pero solo se usa para limpiar un alta fallida). La vista del trabajo no tiene pestaña Git y la sidebar no tiene los filtros Activos · Te toca · Terminados · Todos (D18).

## Comportamiento visible

Revisar o deshacer lo que dejó el agente exige SSH.

## Recomendación

Rutas `GET /api/chats/:id/git/diff` (sin ignorados, recorte por archivo), `POST …/git/discard` (rechaza ignorados), `DELETE /api/chats/:id` (rechaza con sesión corriendo, avisa commits sin pushear, remotas solo si se marca), todas con sesión y CSRF. Web: pestaña Git con estado por repo y botones del catálogo, deshabilitados con su motivo mientras el agente o el piloto corren; confirmaciones `danger` según `docs/identidad-visual.md`.

## Validación

Specs de componentes, build de la web y recorrido manual en un worktree de ventas.
