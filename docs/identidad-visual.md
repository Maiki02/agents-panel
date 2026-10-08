# Identidad visual de la web

Una sola fuente de verdad para colores, tipografía, tamaños, radios y sombras: **`apps/web/src/styles/tokens.css`**. Ningún componente lleva un color, un tamaño de letra ni un radio literal: usa un token. Así se cambia el aspecto de toda la app tocando un archivo, y la identidad se puede replicar en otro proyecto copiando esa carpeta.

## Cómo está armado

| Archivo | Para qué sirve |
|---|---|
| `src/styles.css` | Solo `@import`s: Tailwind, la tipografía, los tokens y la base. No se escribe CSS acá. |
| `src/styles/tokens.css` | Los tokens. Es el único lugar con valores crudos. |
| `src/styles/base.css` | Estilos de elementos (`body`, títulos, links, foco) usando solo tokens. |
| `src/styles/components.css` | Primitivas compartidas entre pantallas (`.card`, campos de formulario, `.error`, `.hint`, mensajes del chat…), escritas con `@apply` de utilidades que leen los tokens. Solo se agrega algo acá si varias pantallas lo repiten. |
| `.postcssrc.json` | Activa Tailwind v4 en el build de Angular. |

`tokens.css` tiene tres capas:

1. **Paleta** (`--palette-*`): los valores crudos (grises, azul de marca, rojo, verde, ámbar). Para cambiar la marca se tocan estos.
2. **Tokens semánticos** (`--ui-*`): qué significa cada color (`--ui-bg`, `--ui-surface`, `--ui-border`, `--ui-text`, `--ui-muted`, `--ui-accent`, `--ui-link`, `--ui-danger`, `--ui-ok`, `--ui-warn`…). Apuntan a la paleta y cambian según el tema.
3. **Tema de Tailwind** (`@theme inline`): expone los semánticos como clases (`bg-surface`, `text-muted`, `border-border`, `text-accent`, `rounded-card`, `shadow-card`, `font-sans`). Las clases siguen al tema sin redefinir nada.

## Qué cambiar para…

- **Un color de la marca:** `--palette-brand-*` en `tokens.css`.
- **Qué color usa un rol** (por ejemplo, los links): el token semántico (`--ui-link`) en el tema claro y en el oscuro.
- **La letra:** `--font-sans` en `@theme inline` y el `@import` de la fuente en `styles.css`. Hoy es **Inter**, autoalojada con `@fontsource-variable/inter`: el build la copia al bundle y la web no pide nada a Google Fonts (la URL del panel es pública).
- **Tamaños de letra, radios y sombras:** `--text-*`, `--radius-*` y `--shadow-*` en `@theme inline`.

## Temas

Claro por defecto, oscuro si el sistema lo pide (`prefers-color-scheme: dark`). Se puede forzar con `data-theme="light"` o `data-theme="dark"` en `<html>`. Los tokens semánticos se redefinen en cada tema; las clases de Tailwind no cambian.

## Reglas

- Nada de hex, `rgb()` ni `px` sueltos para colores o tipografía fuera de `tokens.css`. Se controla con un grep (ver la tarea de verificación del sprint).
- **Los textos van en blanco o en grises** (`text-text`, `text-muted`), nunca en el color primario. El primario (`accent`) queda para cosas puntuales: el fondo del botón primario, el foco, la marca de la opción activa del menú, el paso actual del stepper y bordes (pestaña activa, chat elegido, insignia `accent`).
- Los links usan `--ui-link`, que apunta al color del texto (`--ui-text`) en los dos temas. Un link suelto dentro de una frase lleva la clase `.link` (subrayado gris que se aclara al pasar el mouse); los links que son ítems de menú o tarjetas no se subrayan.
- Un componente nuevo se arma con las clases de Tailwind que salen de los tokens o con las variables `--ui-*`; si falta un valor, se agrega al token y se documenta acá.
- Los componentes compartidos viven en `apps/web/src/app/ui/` y se usan en toda la web:
  - `Modal` (`<app-modal heading="…" (closed)="…">`): único contenedor de diálogos, con cruz, Esc, click en el fondo y foco atrapado. El pedido de código TOTP es `TotpModal` (`app/shared/`), construido sobre él.
  - `Tabs` (`<app-tabs [tabs] [active] (selected)>`): solo la tira de pestañas; la página decide qué mostrar según la activa (que puede ir en la URL). **Con scroll:** si no entran (celular), la tira se desplaza en horizontal sin mostrar la barra (clase `.scrollbar-none`), cada pestaña no se parte (`whitespace-nowrap`, `shrink-0`) y la activa se trae a la vista al cargar y al cambiar.
  - `Button` (`<button appButton variant="primary|secondary|danger|icon">`): botón nativo con la identidad.
  - `Badge` (`<app-badge tone="neutral|accent|ok|warn|danger">`): insignia de estado. En `accent` el primario va solo en el borde; el texto queda en el color del texto.
  - `Icon` (`<app-icon name="menu" [spin]>`): íconos de **Google Material Symbols** (Outlined, peso 400) del paquete `@material-symbols/svg-400`. El build carga los `.svg` como texto (`loader` en `angular.json`) y el componente dibuja su trazo con `fill: currentColor`, así que sigue el color del texto; solo entran al bundle los que se importan. Para sumar uno: importar `@material-symbols/svg-400/outlined/<nombre>.svg` en `ui/icon.ts` y agregarlo a `ICON_SVGS`. No se usa la fuente de íconos (pesa 4 MB) ni el CDN de Google.
  - `Drawer` (`<app-drawer [open] heading="…" (closed)>`): panel lateral que entra desde la izquierda con una transición de desplazamiento (sin animación si el sistema pide menos movimiento), sobre un fondo que lo cierra con un clic; también cierran Esc y la cruz. Atrapa el foco abierto y es `inert` cerrado. Un bloque con el atributo `drawerFooter` queda fijo al pie.

## Estructura de la app (shell)

- **Pantalla completa:** `app-root` mide `100dvh` y es una columna: encabezado de 56 px y `main` con el resto del alto y todo el ancho (sin ancho máximo, margen de 16 px). `main` tiene su propio scroll; el documento no scrollea.
- **Encabezado:** botón hamburguesa (ícono `menu`) a la izquierda, título centrado y, en pantallas anchas (`lg`), el selector de cuenta de Claude a la derecha. El título es el nombre del proyecto dentro de un proyecto; afuera, el nombre de la sección (Proyectos, Versiones, Cuentas, Notificaciones).
- **Menú (sidebar):** un `Drawer` con las secciones Proyectos (`folder`), Versiones (`update`), Cuentas (`account_circle`) y Notificaciones (`notifications`). La opción activa lleva fondo elevado, texto en blanco, semibold, `aria-current` y una barra del primario a la izquierda; las demás van en gris. Proyectos queda activa también dentro de un proyecto. Al pie: el selector de cuenta (en pantallas angostas), el usuario y Salir. Cualquier navegación lo cierra.
- **Proyecto:** sin flecha para volver (eso está en el menú). Debajo del encabezado, pestañas **Chats / Configuración** (con el `Tabs` compartido, que navega por ruta) y el estado del proyecto a la derecha; la sección elegida llena el resto del alto. Entrar al proyecto o a la pestaña Chats lleva siempre a la **grilla de chats** (no se recuerda el último chat).
- **Grilla de chats** (`/projects/:id/chats`): arriba el título «Chats» y el botón primario **Nuevo chat** (ícono `plus`); debajo los filtros rápidos y las tarjetas de chat en una grilla de una columna en el celular, dos desde `sm` y tres desde `xl`. Sin chats (o sin ninguno para el filtro) muestra un `hint` con qué hacer. Mientras algún agente corre se relee cada 4 s; cuando ninguno corre deja de consultar.
- **Tarjeta de chat** (`ChatCard`): toda la tarjeta es el link al chat. Título = nombre corto (slug); arriba a la derecha el único `Badge` de estado; debajo el **chip de tipo** y la rama en `text-muted`.
- **Chip de tipo** (`.kind-chip`): píldora neutra (borde, fondo elevado, sin tono) con Scope, Work, Idea o Directo. El tipo no es un estado, por eso no usa los tonos del `Badge`.
- **Modal de Nuevo chat:** un `Modal` con el formulario completo (tipo, nombre corto, pedido, piloto automático y, en «Opciones: modelos», pensante y ejecutor). Vive en la ruta `chats/new` (la grilla con el modal abierto; los links viejos siguen andando). Crear cierra el modal y abre el chat; Esc, la cruz y el fondo cierran sin crear y conservan lo escrito hasta recargar la página (`NewChatDraft`).
- **Chat abierto** (`/projects/:id/chats/:chatId`): ocupa todo el ancho, también en el celular, con un botón secundario **Chats** (ícono `chats`) arriba que vuelve a la grilla. Ya no hay lista lateral ni panel deslizable de chats.
- **Chat:** columna del alto disponible. Arriba la cabecera (título, estado, stepper, piloto, pestañas, avisos y tarjetas) con alto máximo de `40dvh` y scroll propio si crece; en el medio las novedades (o la Timeline) con `overflow-y: auto`; abajo la caja de escribir, siempre visible. Las novedades siguen al final solo si el usuario ya estaba ahí (a menos de 80 px): si subió a leer, un evento nuevo no lo mueve. Abrir un chat, volver a la pestaña Chat o mandar un mensaje vuelve a seguir el final.

## Criterios de pantallas

Rigen para toda pantalla nueva. Lo que ya existe se ajusta cuando se toca, no en un cambio aparte.

### Tarjetas e ítems de lista

- **Anatomía fija:** título (una línea, se corta con `…` y el texto completo va en `title`), debajo una línea de metadatos en `text-muted` (tipo · rama · URL), y el **estado arriba a la derecha** como un único `Badge`. Las acciones van al pie (tarjeta) o como botones de icono a la derecha (ítem).
- **Un solo destino por tarjeta:** si la tarjeta lleva a otra pantalla, toda la tarjeta es el link. Las acciones secundarias son botones de icono con `aria-label` y tooltip, y no navegan.
- **Como mucho un botón primario** por tarjeta o modal. El resto, secundario o de icono.
- **Un estado por entidad.** Nunca dos badges de estado en la misma tarjeta. Los avisos (sin Kyro, setup sugerido) van como `hint` debajo de los metadatos, no como badge.

### Color de estado según quién actúa

El tono del `Badge` sale de quién tiene que moverse, igual para proyectos, trabajos y sesiones:

| Tono | Cuándo |
|---|---|
| `accent` | El agente o el sistema están trabajando (clonando, planificando, probando) |
| `warn` | **Te toca a vos** (pregunta, aprobación, permiso, bloqueado, interrumpido) |
| `danger` | Error del sistema |
| `ok` | Listo o terminado (proyecto listo, PR lista, mergeado) |
| `neutral` | En cola, en pausa, archivado o cancelado |

Las etiquetas son descriptivas y en español: «Esperando tu respuesta», «Probando · go test», «Cerrando sprint 2/4». Nunca un nombre técnico como «idle». Las etiquetas y los tonos viven en un solo módulo de la web, no en cada pantalla.

### Acciones

- **Destructivas** (borrar, cancelar, descartar): botón `danger` y confirmación en un `Modal` que nombra lo que se borra.
- **Con secreto o cambio global** (`.env`, actualizar Kyro, inicializar Kyro): `TotpModal`.
- **Destructivas que además piden escribir el nombre** (borrar un proyecto): un `Modal` propio con el nombre y el código TOTP; si el servidor rechaza, lista los motivos dentro del modal sin vaciar el nombre.
- **Largas** (pull, push, setup, clonado): el botón se deshabilita y muestra el `Icon` girando. El resultado aparece en línea al terminar; si toca varios repos o worktrees, va como tabla por elemento (escrito / omitido con motivo).
- Una acción que no se puede hacer ahora (por ejemplo, con un agente corriendo) se muestra deshabilitada y con el motivo en el tooltip, en vez de esconderla.

### Trabajo: stepper, pestañas, piloto y Timeline

- **Stepper de fases** (`PhaseStepper`): Idea › Plan › Ejecución › QA › Cierre › Merge › PR como píldoras: hechas en `ok`, la actual rellena con `accent`, las que faltan en `neutral`. Debajo, una línea `text-muted` con sprint n/m, tarea n/m y rol · modelo, solo con los datos que el estado trae (no se inventan números). Un estado que interrumpe (bloqueado, pausado) conserva la fase en que quedó.
- **Pestañas Chat y Timeline** con el `Tabs` compartido; el pedido directo no las tiene.
- **Barra del piloto** (`AutopilotBar`): una tarjeta con el estado de la **corrida** (no del trabajo: el estado del trabajo sigue siendo el único badge de la cabecera) y los botones Encender, Reanudar, Pausar y Apagar. Lo que no aplica va deshabilitado y con su motivo escrito debajo (en el celular no hay tooltip). Apagar es `danger` y pide confirmación en un `Modal`.
- **Timeline** (`Timeline`): una tarjeta por transición, de la más nueva a la más vieja: de → a (el destino como `Badge` con el tono de quién actúa), actor, rol y modelo, motivo, deuda y decisiones. La lista vacía dice qué esperar.
- **Notificaciones:** página propia (opción del menú) porque los dispositivos son del usuario y no de un proyecto. El manifest y el `theme-color` del `index.html` llevan el azul de la marca como valor literal porque ahí no se pueden usar variables CSS: si cambia `--palette-brand-600`, actualizarlos a mano.

### Listas y vacíos

- Toda lista vacía tiene un `hint` que dice qué hacer y, si existe, el botón para hacerlo.
- Las fechas son relativas («hace 2 min») y llevan la fecha completa en `title`.
- Las listas que pueden crecer tienen filtros rápidos arriba (por ejemplo, Activos · Te toca · Terminados · Todos), no paginación.
- Lo que te espera se marca también fuera de la pantalla: un contador en el ítem del proyecto o de la sección.

### Celular

- Se diseña primero para el ancho de un teléfono: margen lateral de 16 px y sin scroll horizontal.
- El menú de la app es siempre el `Drawer` del botón hamburguesa.
- **Chats de un proyecto:** en el celular la grilla es de una columna; el chat abierto ocupa todo el ancho con la caja de escribir fija abajo y el botón **Chats** arriba para volver a la grilla. Las pestañas que no entran se desplazan en horizontal (ver `Tabs`).
- Los objetivos táctiles miden al menos 40 px de alto, incluidos los botones de icono.
