# Refactor de la UI: menú hamburguesa, layout a pantalla completa y chat con scroll propio

## Objetivo

Que el panel se use cómodo en desktop y en el celular: navegación en un menú lateral con íconos, el título del proyecto en el centro del encabezado, textos en blanco o grises, el layout ocupando toda la pantalla y el chat con su propio scroll, sin que cada novedad de la IA arrastre la página entera al final.

## Problema

- La navegación (Proyectos, Versiones, Cuentas, Notificaciones) son links de texto sueltos en el encabezado; en mobile no entran y no se nota cuál está seleccionada.
- Dentro de un proyecto hay una flecha "← Proyectos" y un menú lateral propio (Chats / Configuración) que come ancho.
- Muchos textos (links, nombre del proyecto, URL del repo, insignias) salen en azul.
- `main` tiene ancho máximo y ninguna altura: toda la página scrollea. En el chat, cada evento nuevo hace `scrollIntoView` y lleva la página al final aunque el usuario esté leyendo arriba.

## Pedido del usuario

1. En el encabezado: un menú hamburguesa y el título del proyecto en el medio.
2. El sidebar del menú hamburguesa se abre con una animación de desplazamiento.
3. Las opciones del menú son las navegaciones Proyectos, Versiones, Cuentas y Notificaciones; se tiene que notar que son opciones y cuál está seleccionada.
4. Cada opción tiene su ícono de Google Material (instalarlo si no existe).
5. Los textos no van en azul: todo blanco o escala de grises. Solo botones y cosas puntuales llevan el color primario.
6. Dentro de un proyecto se quita la flecha para volver a Proyectos (esa información está en el sidebar).
7. El layout abarca el 100% de la pantalla, y se define cómo se ve en mobile (sidebar, sección de chats y caja de escribir).
8. La sección del chat con las novedades de la IA tiene un alto máximo y scroll propio; la página no scrollea entera.

## Decisiones del usuario

- **Mobile:** el chat ocupa toda la pantalla con la caja de escribir fija abajo; la lista de chats se abre con un botón "Chats" arriba del chat, como panel deslizable.
- **Menú del proyecto:** la columna lateral "Chats / Configuración" se reemplaza por dos pestañas bajo el título del proyecto.

## Regla nueva

- **Íconos:** Google Material Symbols (variante Outlined), instalados como dependencia npm y servidos por el propio panel (sin CDN). El componente `app-icon` los usa para todos los íconos.
- **Shell:** encabezado de altura fija con botón hamburguesa a la izquierda, título centrado (nombre del proyecto dentro de un proyecto; si no, el nombre de la sección) y, a la derecha en desktop, el selector de cuenta. Debajo, `main` ocupa el resto del alto (`100dvh`) y todo el ancho.
- **Sidebar (drawer):** panel que entra desde la izquierda con transición de desplazamiento, sobre un fondo que lo cierra con un clic; se cierra con Esc, con la X y al navegar. Lista las cuatro opciones con su ícono; la activa se distingue por fondo, peso y una marca del color primario. Proyectos queda activa también dentro de un proyecto. Al pie: cuenta de Claude (en mobile), usuario y Salir.
- **Colores de texto:** los links usan el color de texto (`--ui-link` pasa a la escala de grises) y la insignia `accent` lleva texto neutro; el color primario queda para botones, foco, la marca de la opción activa, el paso actual y bordes puntuales.
- **Chat:** la página del chat ocupa el alto disponible: cabecera arriba (con alto máximo y scroll propio si crece), las novedades en el medio con `overflow-y: auto` y la caja de escribir fija abajo. El auto-scroll mueve solo el contenedor del chat y solo si el usuario ya estaba cerca del final; al abrir un chat arranca al final.

## Fuera de alcance

- Cambios en la API.
- Rediseñar las páginas internas (Versiones, Cuentas, Notificaciones, Configuración) más allá del color de los textos y del nuevo layout.
- Un tema claro/oscuro elegible desde la web.
