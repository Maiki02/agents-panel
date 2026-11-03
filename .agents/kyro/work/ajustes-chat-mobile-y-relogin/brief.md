# Ajustes del chat en mobile, etiquetas de la card, info de tarea, modelos y relogueo de Claude

Cinco ajustes del panel: navegación mobile dentro de un chat, etiqueta de planificación en la card, tooltip con el título de la tarea en ejecución, orden vertical de los modelos pensante y ejecutor, y relogueo de una cuenta de Claude desde la web.

## Pedido

1. Dentro de un chat, en mobile se quitan las tabs de Chat y Configuración y se pone una flecha para volver atrás. En desktop la UI se mantiene porque no interfiere.
2. En la card del chat se clasifica el «Planificando»: si es general, «Planificando»; si es del scope, «Planificando scope»; si es de un sprint, «Planificando sprint X».
3. Cuando se ejecuta una tarea (por ejemplo la T3.1) se agrega un icono de info; al pasar el mouse (hover) muestra un tooltip con el título de la tarea.
4. En la configuración de modelos, el modelo pensante y su input van primero y debajo, en otra línea, el modelo ejecutor y su input (hoy comparten la fila).
5. Poder reloguear una cuenta de Claude desde el panel cuando se cerró su sesión. Decisión del usuario: flujo con código en la web. En Cuentas, un botón «Reloguear» corre el login de Claude en la VM con el `CLAUDE_CONFIG_DIR` de la cuenta, muestra el link de autorización, el usuario lo abre, pega el código en el panel y el flujo se cierra.

## Criterios

- Mobile: dentro de un chat no se ven las tabs Chat y Configuración y hay una flecha atrás que vuelve a la lista de chats del proyecto. Desktop queda igual.
- La etiqueta de «Planificando» en la card distingue general, scope y sprint X, a partir de señales verificables de Kyro (no del texto del agente); `docs/estados.md` refleja la clasificación.
- Con una tarea en ejecución (T3.1, W2…) el panel muestra un icono de info con tooltip del título de la tarea; si Kyro no entrega título, no se muestra el icono y no se inventa nada.
- En los formularios de modelos (configuración del proyecto y nuevo chat) el pensante va arriba y el ejecutor abajo, en líneas separadas.
- Relogueo: la ruta pide sesión, CSRF y TOTP; el estado del flujo vive en memoria (un solo flujo a la vez por cuenta, con timeout); nunca se devuelve, loguea ni persiste el código ni las credenciales; no se tocan `.credentials.json` ni `.claude.json` fuera de lo que hace el propio `claude`; la cuenta sin login ofrece el botón. Se documenta en `docs/panel-desarrollo.md` y `docs/plan.md`.
- Tests de API y web actualizados; build y tests del repo en verde.
