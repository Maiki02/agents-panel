# La web abre en la lista de chats de todos los proyectos

- **Resumen:** `/` carga `ChatListPage` con el formulario de chat nuevo y los chats de todos los proyectos; no hay pantallas de proyectos, configuración ni versiones. `GET /api/chats` ya acepta querystring.
- **Severidad:** media.
- **Archivos afectados:** `apps/web/src/app/app.routes.ts`, `apps/web/src/app/chats/chat-list.page.ts`, `new-chat.form.ts`, `apps/api/src/chats/routes.ts`.
- **Recomendación:** `/` = Proyectos, `/projects/:id`, `/versions`; chat nuevo con proyecto fijo; diálogo de TOTP para las acciones sensibles.
- **Validación:** specs de formularios y de que el contenido del `.env` no queda en el estado; build y recorrido manual por el túnel SSH.
