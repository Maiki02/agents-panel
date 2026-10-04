# 03 — Streaming SSE e historial persistente

- **Severidad:** media.
- **Comportamiento esperado:** cada mensaje del SDK se guarda en `chat_events` (secuencia monótona por chat) y se emite por SSE. Al reconectar, `Last-Event-ID` reproduce desde la base. Al arrancar, los chats que estaban corriendo pasan a `interrumpido`.
- **Recomendación:** emisor en proceso + replay desde SQLite; heartbeat cada 15 s; `EventSource` same-origin usa la cookie de sesión.
- **Docs:** el MVP usa un estado grueso de sesión (corriendo / en espera / error / interrumpido / cancelado). El estado fino de `docs/estados.md` es la etapa 5; hay que dejar documentado el mapeo.
