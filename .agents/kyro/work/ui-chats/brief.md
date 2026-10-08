# Chats como cards, Nuevo chat en modal, stepper verde al mergear y pestañas con scroll

## Objetivo

Que la sección Chats de un proyecto sea una grilla de cards (una por chat, es decir, por worktree) en la que se entiende de un vistazo qué es cada trabajo, que crear un chat sea un modal, que el stepper muestre la PR mergeada en verde y que las pestañas no rompan el ancho en el celular.

## Pedido del usuario

1. ¿Estamos usando la card de worktree?
2. Corrijamos la sección de "Chats". Que no tenga TITULO. Que el título sea el nombre corto ("min-w-0 break-words text-sm font-medium").
3. Work o Scope debe ser un chip.
4. Cuando la PR ya está mergeada (porque el estado del chat es mergeada), en el timeline el chip debe aparecer verde: "Idea › Plan › Ejecución › QA › Cierre › Merge › PR".
5. Habíamos dicho que por default, cuando ingresábamos, era como si presionábamos "Nuevo chat". Lo que quiero ajustar es que: los chats sean cards, una debajo de otra o una al lado de otra y bajando. Al presionar el botón de "Nuevo chat", se abre un modal para poder escribir el prompt, seleccionar el tipo y enviar el nuevo worktree que se creará.
6. Ajustemos todos los lugares donde hay tabs `<app-tabs>`. En mobile, se sale del 100% de ancho cuando hay muchas opciones. Agreguemos un scroll horizontal pero con el scroll oculto para que no moleste visualmente para los casos donde hay muchas tabs.

## Respuesta a la pregunta 1

No. `docs/plan.md` («Worktrees activos») pide una tarjeta por scope o work, pero en la web no existe ese componente: la lista de chats es una columna de links (`chat-sidebar.ts`) y la única tarjeta de worktree es la de cada repo en la pestaña Git (`git/repo-card.ts`). Este Work la crea.

## Decisiones del usuario (AskUserQuestion)

- Al abrir un chat, el chat ocupa todo el ancho, con un botón «Chats» para volver a la grilla (también en el celular). Ya no hay lista lateral ni panel deslizable.
- Al entrar a un proyecto o a la pestaña Chats siempre se ve la grilla: ya no se abre el último chat ni el formulario de Nuevo chat.

## Alcance

- Card de chat: título = nombre corto (slug) con `min-w-0 break-words text-sm font-medium`, el tipo (Scope, Work, Idea, Directo) como chip, un único badge de estado y la rama como metadato. La card entera es el link al chat.
- Grilla responsive: una columna en el celular, más columnas a medida que hay ancho. Los filtros actuales se mantienen arriba.
- Botón «Nuevo chat» que abre un `app-modal` con el formulario actual (tipo, nombre corto, pedido, piloto, modelos). Crear navega al chat nuevo.
- Cabecera del chat: el título también es el nombre corto.
- Stepper: con el estado `mergeada` todos los pasos, PR incluido, en verde.
- `app-tabs`: scroll horizontal con la barra oculta y pestañas que no se parten, en todos sus usos.
- Docs: `docs/plan.md` e `docs/identidad-visual.md` describen la grilla, la card, el modal y las pestañas.

## Fuera de alcance

- Cambios en la API (el título que guarda la base no cambia; la web deja de mostrarlo).
- Acciones dentro de la card (pausar, cancelar, reanudar) de «Worktrees activos».
