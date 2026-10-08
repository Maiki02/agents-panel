# Chats sin subrayado, modal de Nuevo chat ancho, capacidad al final y Cuentas y Notificaciones como lista + botón

## Objetivo

Que las pantallas de listas sigan una sola estructura (título, botón primario «Nuevo …» a la derecha, la lista y el alta en un modal), como ya hacen Proyectos y Chats, y pulir tres detalles de la web: el subrayado al pasar el mouse por las cards de chat, el ancho del modal de Nuevo chat y la posición del disco y la RAM en Proyectos.

## Pedido del usuario

1. Cuando hacemos hover a los chats, no subrayemos las palabras.
2. El modal de nuevo chat, debe ser más ancho.
3. El disco y la ram que aparece al inicio, coloquemoslo al final.
4. Tenemos que seguir un layout y estructura. Así como listamos los proyectos y tenemos un botón de "Nuevo proyecto" y listamos los chats y tenemos un botón de "Nuevo chat", quiero que listemos las cuentas y tengamos un botón de "Nueva cuenta". Al presionar, se abre el modal de lo necesario para cargar una nueva cuenta
5. Lo mismo con "Notificaciones". Listamos las que hay y un botón de nuevo de "Agregar este dispositivo".

## Diagnóstico

- Subrayado: `styles/base.css` define `a:hover { text-decoration: underline }` fuera de toda capa (`@layer`). En Tailwind v4 las utilidades viven en `@layer utilities` y cualquier regla sin capa les gana, así que el `hover:no-underline` de `chat-card.ts` (y el de `side-nav.ts` y `account-selector.ts`) no tiene efecto. `docs/identidad-visual.md` ya dice que los links que son ítems de menú o tarjetas no se subrayan.
- Modal: `app-modal` tiene dos anchos (`max-w-md` y `wide` = `max-w-3xl`); Nuevo chat usa el angosto.
- Disco y RAM: `<app-capacity-bars />` está arriba de la lista en `projects.page.ts`.
- Cuentas: el alta es una tarjeta «Agregar cuenta» al pie de la página, sin botón ni modal.
- Notificaciones: hay una tarjeta «Este dispositivo» con «Activar en este dispositivo» arriba de la lista.

## Decisiones propias (sin preguntar)

- Subrayado: las reglas de links de `base.css` (`a`, `a:hover`) pasan a `@layer base`, así las utilidades (`hover:no-underline`) ganan en todos lados. El resto de `base.css` no se toca para no mover márgenes de títulos en toda la app.
- Nuevo chat usa el modal ancho (`wide`, `max-w-3xl`), el mismo que Crear PR.
- Notificaciones: «Agregar este dispositivo» abre un modal con el nombre del dispositivo (sugerido por el navegador, editable) y el motivo si este navegador no puede recibir avisos; Activar pide el permiso, suscribe y cierra. Si este dispositivo ya está en la lista, el botón queda deshabilitado con el motivo. Así sigue el mismo patrón que Cuentas y Proyectos.
- Cuentas: el modal «Nueva cuenta» lleva los mismos campos y la misma ayuda que la tarjeta de hoy (nombre, directorio de config y los pasos previos en la VM); el error de la API se muestra dentro del modal sin borrar lo escrito.

## Alcance

- Cards de chat sin subrayado al pasar el mouse (y los demás links que ya piden `hover:no-underline`).
- Modal de Nuevo chat ancho.
- Proyectos: barras de disco y RAM debajo de la lista de proyectos.
- Cuentas: título + botón primario «Nueva cuenta», la lista de cuentas y el alta en un `app-modal`.
- Notificaciones: título + botón primario «Agregar este dispositivo», la lista de dispositivos y el alta en un `app-modal`.
- Docs: `docs/identidad-visual.md` (estructura de las páginas de lista) y `docs/panel-desarrollo.md` (pasos de Cuentas y Notificaciones con los nuevos nombres de botones).

## Fuera de alcance

- Cambios en la API.
- Rediseñar Versiones.
