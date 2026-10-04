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
- Los links usan `--ui-link`, nunca el azul por defecto del navegador.
- Un componente nuevo se arma con las clases de Tailwind que salen de los tokens o con las variables `--ui-*`; si falta un valor, se agrega al token y se documenta acá.
- Los componentes compartidos viven en `apps/web/src/app/ui/` y se usan en toda la web:
  - `Modal` (`<app-modal heading="…" (closed)="…">`): único contenedor de diálogos, con cruz, Esc, click en el fondo y foco atrapado. El pedido de código TOTP es `TotpModal` (`app/shared/`), construido sobre él.
  - `Tabs` (`<app-tabs [tabs] [active] (selected)>`): solo la tira de pestañas; la página decide qué mostrar según la activa (que puede ir en la URL).
  - `Button` (`<button appButton variant="primary|secondary|danger|icon">`): botón nativo con la identidad.
  - `Badge` (`<app-badge tone="neutral|accent|ok|warn|danger">`): insignia de estado.
  - `Icon` (`<app-icon name="refresh|close|plus" [spin]>`): SVG en línea que sigue el color del texto. Para sumar un icono se agrega su trazo a `ICON_PATHS`.

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
- **Con secreto o cambio global** (`.env`, actualizar Kyro): `TotpModal`.
- **Largas** (pull, push, setup, clonado): el botón se deshabilita y muestra el `Icon` girando. El resultado aparece en línea al terminar; si toca varios repos o worktrees, va como tabla por elemento (escrito / omitido con motivo).
- Una acción que no se puede hacer ahora (por ejemplo, con un agente corriendo) se muestra deshabilitada y con el motivo en el tooltip, en vez de esconderla.

### Listas y vacíos

- Toda lista vacía tiene un `hint` que dice qué hacer y, si existe, el botón para hacerlo.
- Las fechas son relativas («hace 2 min») y llevan la fecha completa en `title`.
- Las listas que pueden crecer tienen filtros rápidos arriba (por ejemplo, Activos · Te toca · Terminados · Todos), no paginación.
- Lo que te espera se marca también fuera de la pantalla: un contador en el ítem del proyecto o de la sección.

### Celular

- Se diseña primero para el ancho de un teléfono: margen lateral de 16 px y sin scroll horizontal.
- La sidebar pasa a un panel desplegable con su botón en el header.
- Los objetivos táctiles miden al menos 40 px de alto, incluidos los botones de icono.
