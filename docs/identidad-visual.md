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
