# Chat en mobile y tablet (menor a 1024px)

## Pedido

Hay que corregir algunas cosas del chat en mobile y tablet (menor a 1024px).

1. Ambas pantallas deben comportarse igual. Lo que hay en mobile, hay que estirarlo hasta tablet.
2. La flecha hacia atrás, el app-work-info-panel y el botón de cancelar podrían estar en la misma fila. Lo que nos permite más contenido en la pantalla.
3. Falta el `<app-autopilot-bar>`. En pantallas chicas no se está visualizando. En vez de hacer el punto dos, podríamos colocarlo entre la flecha atrás y el botón de "Cancelar". Definilo vos cuál es la mejor opción.

## Situación actual

- El panel de información (`app-work-info-panel`) pasa a columna desde `lg` (1024px); por debajo es un `<details>` plegado arriba del chat.
- La fila de navegación del chat (`chat.page.ts`) usa `md` (768px): flecha atrás solo por debajo de `md`, botón «Chats» desde `md`. Las pestañas del proyecto se ocultan en la ruta del chat solo por debajo de `md` (`hideProjectTabs` con `WIDE_QUERY` de `shell/media.ts`). Entre 768 y 1023px (tablet) el chat se ve distinto que en mobile.
- `app-autopilot-bar` está dentro de la parte plegada del panel: por debajo de `lg` no se ve salvo que se despliegue.

## Decisión (punto 2 vs. punto 3)

Se elige el **punto 3**: por debajo de `lg` la fila de la flecha queda `[flecha atrás] [app-autopilot-bar] [Cancelar]`, y el panel de información sigue siendo el pliegue de ancho completo arriba.

Por qué:
- Resuelve el problema real (la barra del piloto no se ve) sin sumar alto: ocupa la fila que hoy solo tiene la flecha y, a veces, Cancelar.
- Meter el pliegue (slug, badge, proyecto · rama y tarea actual) entre la flecha y Cancelar en 360px dejaría ~200px y truncaría el slug y la tarea; además dejaría la barra del piloto todavía escondida o en otra fila nueva.
- La barra ya es compacta (`flex-wrap`), tiene sentido junto a Cancelar (las dos son acciones sobre la corrida) y se oculta sola en chats sin piloto (directo, idea): ahí la fila queda como hoy.

## Resultado esperado

- Por debajo de 1024px mobile y tablet se ven igual: flecha atrás (no el botón «Chats»), pestañas del proyecto ocultas en la ruta del chat, pliegue del panel arriba.
- Por debajo de 1024px la barra del piloto está siempre visible en la fila de la flecha, entre la flecha y Cancelar, y no se repite dentro del pliegue.
- Desde 1024px nada cambia: botón «Chats», pestañas visibles y la barra del piloto en la columna del panel.

## Fuera de alcance

- Cambios en la lógica del piloto o en la API.
- El layout de escritorio (≥ 1024px).
