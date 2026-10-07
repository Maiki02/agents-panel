# Mejorar los tiempos de carga del panel

## Pedido

> Debemos mejorar los tiempos de carga. Actualmente, al ingresar a proyectos, versiones, notificaciones, etc, hay un leve retraso. Tardan en aparecer las cosas. Hay otro retraso que creo que es mucho más fácil de solucionar: los chats. Al apretar un chat, tarda MUCHO en cargar. Mi propuesta: que solo carguen los últimos 10 mensajes del agente y si quiere más, que scrollee hacia arriba y haga lazy loading.

## Objetivo

Que un chat abra casi al instante mostrando solo lo último (los últimos 10 mensajes del agente) y cargue lo anterior al scrollear hacia arriba, y que Proyectos, Versiones y Notificaciones muestren algo enseguida en vez de esperar a que respondan los comandos lentos.

## Diagnóstico (código actual)

- **Chat** (`apps/web/src/app/chats/chat.page.ts`): `restart()` hace `GET /api/chats/:id` y **después** `GET /api/chats/:id/events?afterSeq=0`, que devuelve hasta 1000 eventos con el payload completo (los resultados de herramientas, como lecturas de archivos enteros, viajan sin recortar; el recorte a 4000 caracteres se hace recién en el navegador en `event-view.ts`). Después el SSE repite desde el último seq. Todo se dibuja de una vez, con `track $index`.
- **Versiones** (`/api/versions`): cada carga lanza `kyro --version` (sin caché), y cada 60 s `npm view kyro-ai version` (hasta 10 s) y `git fetch origin main` (hasta 15 s); la respuesta espera a todos.
- **Proyectos** (`/api/projects`): por cada proyecto con Kyro corre `git` (`kyroPendingCommit`) en cada listado.
- **General**: la API no comprime las respuestas (JSON ni JS); las rutas de la web son lazy sin precarga, así que cada pantalla nueva baja su chunk recién al entrar; las pantallas muestran vacío hasta que llega todo.

## Decisiones tomadas (sin preguntar, por la política del piloto)

1. **«Últimos 10 mensajes del agente»** = los últimos 10 eventos `assistant` con texto visible. La ventana incluye todo lo que hay entre ellos (prompts del usuario, herramientas, resultados, logs), para no dejar la conversación con huecos. Al scrollear arriba se traen los 10 anteriores con la misma regla.
2. **Preguntas abiertas**: si hay una pregunta del agente sin responder más vieja que la ventana, la ventana inicial se extiende hasta incluirla (la tarjeta para contestar nunca queda escondida).
3. **Recorte en el servidor**: las rutas de lectura de eventos para la web recortan los textos grandes (resultado de herramienta, entrada de herramienta, resultado del turno, salida de pasos) al mismo límite que ya usa la web (4000 caracteres + «… (recortado)»). Lo que se ve no cambia; lo que viaja sí. La base guarda todo igual.
4. **Versiones y proyectos**: se responde con el último valor conocido y se refresca en segundo plano (stale-while-revalidate); `kyro --version` se cachea y se invalida al terminar una actualización de Kyro. Nada cambia en lo que se decide con esos datos (los botones siguen validando en el servidor).
5. **Compresión**: gzip/brotli en la API para JSON y archivos de la web, **nunca** en `text/event-stream` (el SSE tiene que seguir fluyendo).
6. **Web**: caché en memoria por servicio para mostrar al instante la última lista (proyectos, chats, versiones, dispositivos) mientras se pide la nueva, y precarga de las rutas lazy.

## Criterios generales

- Abrir un chat largo pide una sola ventana chica y no 1000 eventos; el SSE sigue sin repetir ni perder eventos.
- Scroll hacia arriba carga los anteriores sin saltar la vista; cuando no hay más, se indica.
- Proyectos, Versiones y Notificaciones muestran contenido (cacheado o un esqueleto) sin esperar a `git fetch`/`npm view`.
- Sin dependencias pagas ni cambios en la VM. Sesión, CSRF y reglas de seguridad intactas.
- typecheck, lint, format:check, tests de API y web y build en verde. Docs actualizadas (`docs/plan.md`).

## Fuera de alcance

- Cambiar el esquema de `chat_events` o borrar historia.
- Virtualizar la lista del chat (puede venir después si 10 mensajes por página no alcanza).
