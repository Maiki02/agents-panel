---
title: 'proyectos-y-versiones — Sprint 5: Identidad visual, modales y layout de proyecto'
date: '2026-10-04'
scope: 'proyectos-y-versiones'
sprint: 5
slug: 'ui-identidad-layout'
outcome: 'shipped'
type: 'sprint-archive'
---

# Sprint 5: Identidad visual, modales y layout de proyecto

> Closed: 2026-10-04
> Outcome: shipped

## Objective

Que la web siga una identidad visual única y documentada (Tailwind, tokens, Inter) y que Proyectos, Versiones y la página del proyecto (layout con sidebar de chats y configuración en tabs) usen modales y componentes consistentes.

## Definition of Done

- Todas las tareas con evidencia y verdict pass
- La identidad visual está en tokens y documentada en docs/identidad-visual.md
- Typecheck, lint, format:check, tests y build en verde
- Deudas debt-7, debt-8 y debt-9 reubicadas al Sprint 6

## Phases

### P1 — Fundamentos de la identidad visual

> Sistema de diseño único (tokens, Inter, Tailwind) y componentes base reutilizables, documentados.

#### T1.1: Arreglar el nav duplicado y renombrar a 'Panel de agentes'

**Status**: done

**Description**: app.ts renderiza dos veces el bloque <nav class="menu"> (parche aplicado dos veces en el Sprint 4). Dejar uno solo y cambiar el título visible del header y el <title> de index.html de 'agents-panel' a 'Panel de agentes'.

**Evidence**:
- Summary: Eliminado el bloque <nav class=menu> duplicado de app.ts (parche aplicado dos veces en el Sprint 4); título del header y <title> de index.html pasan a 'Panel de agentes'.
- Validation: grep '<nav class="menu"' app.ts = 1
- Validation: web typecheck, lint, prettier y build en verde
- Files changed: `apps/web/src/app/app.ts`, `apps/web/src/index.html`

**Verdict**: pass

---
#### T1.2: Tailwind v4, Inter autoalojada y tokens de diseño en un solo lugar

**Status**: done

**Description**: Instalar tailwindcss y @tailwindcss/postcss con .postcssrc.json (Angular 22 lo soporta) y @fontsource-variable/inter. Crear apps/web/src/styles/tokens.css (@theme: colores semánticos con modo claro y oscuro, familia de letra, escala de tamaños, radios, sombras, espaciado), base.css (reset, body, links sin azul por defecto, foco visible) y dejar styles.css solo como índice de imports. Inter para todo el proyecto. Documentar en docs/identidad-visual.md cómo cambiar colores/tipografías/tamaños y qué clases usar, y enlazarlo desde CLAUDE.md (tabla de documentación).

**Evidence**:
- Summary: Tailwind v4 (@tailwindcss/postcss + .postcssrc.json) e Inter autoalojada (@fontsource-variable/inter). Tokens en styles/tokens.css en tres capas (paleta --palette-*, semánticos --ui-* con tema claro/oscuro y data-theme, @theme inline para las utilidades). base.css con links en --ui-link y foco visible; styles.css solo imports; los estilos viejos pasan a legacy.css ya sobre tokens. docs/identidad-visual.md creado y enlazado desde CLAUDE.md.
- Validation: Prueba de token: cambiar --palette-brand-600 y compilar deja el nuevo valor en el CSS del bundle; al revertir vuelve el original
- Validation: grep de hex/rgb fuera de tokens.css en apps/web/src = 0
- Validation: El CSS del bundle no contiene URLs externas; los woff2 de Inter salen en dist/web/browser/media
- Validation: npm run lint, format:check, typecheck, vitest web 66/66 y build en verde
- Files changed: `apps/web/package.json`, `apps/web/.postcssrc.json`, `apps/web/src/styles.css`, `apps/web/src/styles/tokens.css`, `apps/web/src/styles/base.css`, `apps/web/src/styles/legacy.css`, `docs/identidad-visual.md`, `CLAUDE.md`
- Notes: No se miró en navegador: el color de links y la tipografía se verifican por CSS compilado, no visualmente. Las utilidades de Tailwind (bg-surface, etc.) se usarán desde T1.3.

**Verdict**: pass

---
#### T1.3: Componentes base: Modal, Tabs, Button, Badge, Icon

**Status**: done

**Description**: Crear apps/web/src/app/ui/ con: Modal (role=dialog, aria-modal, cruz para cerrar, Esc, click en el fondo, foco que entra y vuelve), Tabs, Button (variantes primaria, secundaria, peligro, icono), Badge de estado e Icon (refresh, cerrar, más; SVG en línea). Todos con las clases y tokens de T1.2. Lógica de teclado y selección de pestaña en funciones puras con spec.

**Evidence**:
- Summary: Componentes base en app/ui: Modal (role=dialog, aria-modal, cruz, Esc, click en el fondo, foco que entra, se atrapa con Tab y vuelve al cerrar), Tabs (solo la tira; la página decide qué mostrar), Button (directiva [appButton] con variantes primary/secondary/danger/icon), Badge (tonos) e Icon (refresh, close, plus; SVG en línea). Lógica pura en modal-logic.ts y tabs-logic.ts. Solo clases y tokens del tema.
- Validation: vitest web 74/74: Esc, cruz/fondo vs. click dentro, ciclo de foco, resolveTab con fallback a la primera, moveTab, y variantes sin colores literales
- Validation: npm run lint, typecheck y build de web en verde
- Files changed: `apps/web/src/app/ui/modal.ts`, `apps/web/src/app/ui/modal-logic.ts`, `apps/web/src/app/ui/modal.spec.ts`, `apps/web/src/app/ui/tabs.ts`, `apps/web/src/app/ui/tabs-logic.ts`, `apps/web/src/app/ui/tabs.spec.ts`, `apps/web/src/app/ui/button.ts`, `apps/web/src/app/ui/badge.ts`, `apps/web/src/app/ui/icon.ts`
- Notes: Los componentes todavía no se usan en pantallas (T1.4 y siguientes). Foco, trampa de Tab y Esc no se probaron en un navegador: solo la lógica pura tiene test.

**Verdict**: pass

---
#### T1.4: Migrar las pantallas existentes a la identidad y borrar el CSS viejo

**Status**: done

**Description**: Pasar login, lista y detalle de chat, Proyectos, Versiones y el header a los tokens y componentes de T1.2/T1.3, y eliminar de styles.css las clases antiguas (.bar, .card, .badge, .chat-row…) que ya no se usen. Sin cambios de comportamiento.

**Evidence**:
- Summary: Pantallas migradas a la identidad: header con utilidades de Tailwind, todos los <button> con la directiva appButton (variantes primary/secondary/danger), insignias con app-badge (tonos por estado vía statusTone y projectStatusTone/Label), styles.css reducido a imports, legacy.css borrado y reemplazado por styles/components.css (primitivas compartidas con @apply sobre tokens). Sin cambios de comportamiento.
- Validation: styles.css = 6 líneas de @import; sin reglas de componentes ni colores
- Validation: grep de hex/rgb fuera de tokens.css en apps/web/src = 0
- Validation: El CSS del bundle incluye las utilidades usadas (bg-accent, rounded-card, border-border, text-muted, bg-overlay) y Inter Variable
- Validation: npm run lint, typecheck, vitest web 74/74 y build en verde
- Files changed: `apps/web/src/styles.css`, `apps/web/src/styles/components.css`, `apps/web/src/styles/tokens.css`, `apps/web/src/app/app.ts`, `apps/web/src/app/auth/login.page.ts`, `apps/web/src/app/chats/chat.page.ts`, `apps/web/src/app/chats/chat-list.page.ts`, `apps/web/src/app/chats/new-chat.form.ts`, `apps/web/src/app/chats/status.ts`, `apps/web/src/app/projects/projects.page.ts`, `apps/web/src/app/projects/project.page.ts`, `apps/web/src/app/projects/project-label.ts`, `apps/web/src/app/versions/versions.page.ts`, `docs/identidad-visual.md`
- Notes: No se revisó visualmente en un navegador: la migración se valida por compilación y por el CSS generado; puede haber diferencias de espaciado respecto del diseño anterior que solo se ven corriendo la web.

**Verdict**: pass

---
### P2 — Modales y alta por URL completa

> Todo pedido de código TOTP y el alta de proyectos pasan por modales; el repo se identifica por su URL completa.

#### T2.1: Pedido de código TOTP en un modal

**Status**: done

**Description**: Reemplazar el uso en línea de TotpDialog por un modal (sobre Modal) con el input de 6 dígitos, el botón Enviar y la cruz para cerrar. Se usa en subir un .env, borrar un .env y actualizar Kyro (Versiones). El código se vacía al enviar, al cerrar y al fallar; un error (401 invalid_totp) se muestra dentro del modal sin sacar de la página.

**Evidence**:
- Summary: TotpModal (sobre Modal) reemplaza a TotpDialog: input de 6 dígitos con foco automático, botón Enviar y cruz; el código se vacía al enviar y al cerrar. Lo usan subir .env, borrar .env y actualizar Kyro. Un 401 invalid_totp (isInvalidTotp) se muestra dentro del modal, que sigue abierto; en subir .env se conserva el borrador para reintentar solo con el código. Otros errores (400, 409 de Versiones…) se muestran y el contenido de .env se descarta como antes.
- Validation: vitest web 78/78: sanitizeCode, isCompleteCode, takeCode (vacía al enviar) e isInvalidTotp
- Validation: npm run lint, typecheck y build en verde
- Files changed: `apps/web/src/app/shared/totp-modal.ts`, `apps/web/src/app/shared/totp-code.ts`, `apps/web/src/app/shared/totp-code.spec.ts`, `apps/web/src/app/shared/api-error.spec.ts`, `apps/web/src/app/chats/chats.service.ts`, `apps/web/src/app/ui/modal.ts`, `apps/web/src/app/projects/env-files.section.ts`, `apps/web/src/app/versions/versions.page.ts`
- Notes: Que el modal quede abierto tras un invalid_totp y que el foco caiga en el input se verifica por código y compilación; no se probó en un navegador. docs/plan.md todavía nombra TotpDialog: se corrige en T4.1.

**Verdict**: pass

---
#### T2.2: API: la URL de GitHub trae usuario, repo y rama

**Status**: done

**Description**: parseGithubRepo acepta https://github.com/usuario/repo con /tree/<rama> opcional (también .git y barra final) y devuelve owner, repo y branch; ProjectService.add usa branch como rama base cuando no se pasa baseBranch. La validación de owner/repo no cambia (R3) y owner/repo suelto sigue aceptado por la API como referencia; la web exigirá la URL.

**Evidence**:
- Summary: parseGithubRepo acepta https://github.com/o/r[/tree/<rama>] (también .git, barra final, ramas con barra y %2F) y devuelve branch (null si no se nombró; solo se lee de la forma URL). La rama se valida estricta (sin '..', '-' inicial, '.lock', caracteres de control o ~^:?*[\, vacíos). ProjectService.add usa branch como rama base y un baseBranch explícito gana; si la rama no existe en el clon el proyecto queda en error. owner/repo suelto sigue aceptado; normalizeOrigin no cambia. panel-desarrollo.md actualizado.
- Validation: api vitest 371/371 (github.test: ramas válidas e inválidas, sin rama; project-service.test: rama de la URL, baseBranch explícito gana, rama inexistente = error)
- Validation: tsc y eslint de api en verde
- Files changed: `apps/api/src/projects/github.ts`, `apps/api/src/projects/service.ts`, `apps/api/test/github.test.ts`, `apps/api/test/project-service.test.ts`, `docs/panel-desarrollo.md`

**Verdict**: pass

---
#### T2.3: Botón 'Nuevo proyecto' con el formulario en un modal y URL completa

**Status**: done

**Description**: En Proyectos, un botón 'Nuevo proyecto' abre un modal con el formulario de alta (hoy en línea). El campo pide la URL completa de GitHub (repo-input solo acepta https://github.com/usuario/repo[/tree/rama]) y muestra la rama y el repo detectados. Cierra con la cruz y al agregar con éxito. 409 y 400 se muestran dentro del modal y conservan lo escrito.

**Evidence**:
- Summary: Botón 'Nuevo proyecto' (con icono +) en Proyectos que abre un modal con el formulario de alta; ya no hay formulario en línea. repo-input solo acepta la URL completa https://github.com/usuario/repo[/tree/rama] (con .git, barra final, ramas con barra y %2F) y devuelve owner, repo, slug y branch; el modal muestra 'Repo: … · Rama: …' detectados. Se cierra con la cruz, Esc, fondo y tras agregar; un 400/409 se muestra dentro del modal y conserva lo escrito.
- Validation: vitest web 88/88: repo-input acepta URL con y sin .git, barra final y /tree/rama; rechaza owner/repo suelto, file://, git@, ssh, http, otros hosts, puerto, credenciales, query/fragmento, /blob, ramas inválidas
- Validation: npm run lint, typecheck, format y build en verde
- Files changed: `apps/web/src/app/projects/repo-input.ts`, `apps/web/src/app/projects/repo-input.spec.ts`, `apps/web/src/app/projects/add-project.form.ts`, `apps/web/src/app/projects/projects.page.ts`
- Notes: El 409 dentro del modal se verifica por código (el catch deja el modal abierto con lo escrito), no en un navegador.

**Verdict**: pass

---
### P3 — Pantallas: Proyectos, Versiones y layout del proyecto

> Tarjetas con estado a la derecha, Versiones con icono de refresh y el proyecto como layout con sidebar Chats / Configuración.

#### T3.1: Tarjetas de Proyectos: estado a la derecha y URL completa

**Status**: done

**Description**: La tarjeta muestra nombre visible, la URL completa de GitHub como link (usuario/repo y rama base) y el estado (Clonando/Listo/Error) alineado a la derecha del todo. Mantiene Reintentar, el aviso de proyecto sin Kyro, el setup sugerido y el refresco mientras clona.

**Evidence**:
- Summary: Tarjeta de proyecto: cabecera en fila con nombre visible y URL completa de GitHub como link (con 'rama <base>'; ruta local sin link si se agregó por CLI) a la izquierda y el badge de estado a la derecha del todo (flex justify-between, shrink-0, min-w-0 + break-all para pantallas angostas). Reintentar, aviso sin Kyro, setup sugerido y refresco mientras clona intactos.
- Validation: vitest web 90/90 (repoDisplay: URL como link con rama; ruta local sin link y rama vacía oculta)
- Validation: npm run lint, typecheck, format y build en verde
- Files changed: `apps/web/src/app/projects/projects.page.ts`, `apps/web/src/app/projects/project-label.ts`, `apps/web/src/app/projects/project-label.spec.ts`
- Notes: La alineación a la derecha y el comportamiento en pantalla angosta salen de las clases (flex/justify-between/shrink-0/min-w-0); no se vieron en un navegador.

**Verdict**: pass

---
#### T3.2: Versiones: Kyro con un icono de refresh en lugar del botón

**Status**: done

**Description**: En la tarjeta de Kyro el botón 'Actualizar' pasa a un botón de solo icono (refresh) con aria-label y tooltip 'Actualizar Kyro'. Sigue abriendo el modal TOTP, se deshabilita y gira mientras hay una actualización en curso. Si quedan otras acciones en Versiones, también usan iconos.

**Evidence**:
- Summary: La tarjeta de Kyro ya no tiene botón de texto: un botón de solo icono (variante icon, app-icon refresh) con aria-label y title 'Actualizar Kyro', a la derecha de la tarjeta. Abre el modal TOTP, se deshabilita y el icono gira (animate-spin, nuevo input spin de Icon) mientras updateRunning. No quedan otras acciones en Versiones.
- Validation: grep: no queda el texto 'Actualizar' como botón en versions.page.ts; el aria-label es 'Actualizar Kyro'
- Validation: El CSS del bundle incluye animate-spin
- Validation: npm run lint, typecheck, vitest web 90/90 y build en verde
- Files changed: `apps/web/src/app/versions/versions.page.ts`, `apps/web/src/app/ui/icon.ts`
- Notes: No se vio en un navegador; accesibilidad por aria-label/title y comportamiento por código.

**Verdict**: pass

---
#### T3.3: Layout de /projects/:id: sidebar, rutas hijas y chat seleccionado recordado

**Status**: done

**Description**: ProjectLayout (/projects/:id) con sidebar fija 'Chats' y 'Configuración' y un router-outlet. Rutas hijas: chats/new (por defecto), chats/:chatId y settings/:tab. Al entrar en /projects/:id sin hijo, redirige al último chat abierto de ese proyecto o, si no hay, a Nuevo chat. El último chat se recuerda por proyecto en localStorage (con try/catch; la app funciona sin él) y se mantiene al navegar a otras pantallas y volver. /chats/:id sigue funcionando y redirige a su proyecto.

**Evidence**:
- Summary: ProjectLayout en /projects/:id con riel lateral 'Chats' / 'Configuración' y router-outlet; ProjectContext compartido con las rutas hijas. Rutas: '' y 'chats' redirigen (guard con UrlTree) al último chat guardado o a chats/new; chats/new (NewChatPage), chats/:chatId (ChatPage reactivo al parámetro, con descarte de respuestas viejas al cambiar de chat), settings -> settings/general y settings/:tab (SettingsPage; las tabs llegan en T3.6). El layout guarda la selección en cada NavigationEnd (chats/:id la guarda, chats/new la olvida) con LastChatStore (localStorage con try/catch). /chats/:id redirige a /projects/:projectId/chats/:id. NewChatForm navega a la ruta nueva; ProjectPage eliminada.
- Validation: vitest web 104/104: last-chat (guarda/devuelve por proyecto, olvida con null, ignora ids inválidos, no falla sin storage ni con storage que lanza, selectionFromUrl y chatsPath)
- Validation: npm run lint, typecheck, format y build en verde
- Files changed: `apps/web/src/app/app.routes.ts`, `apps/web/src/app/projects/project-layout.ts`, `apps/web/src/app/projects/project-context.ts`, `apps/web/src/app/projects/last-chat.ts`, `apps/web/src/app/projects/last-chat.store.ts`, `apps/web/src/app/projects/last-chat.spec.ts`, `apps/web/src/app/projects/settings.page.ts`, `apps/web/src/app/chats/chats-section.ts`, `apps/web/src/app/chats/new-chat.page.ts`, `apps/web/src/app/chats/chat-redirect.page.ts`, `apps/web/src/app/chats/chat.page.ts`, `apps/web/src/app/chats/new-chat.form.ts`
- Notes: El ruteo (redirecciones por guard, chat recordado al volver, /chats/:id -> proyecto, cambio de chat sin recargar) no se ejecutó en un navegador ni con TestBed: solo la lógica pura tiene test; el resto se verifica por compilación y revisión.

**Verdict**: pass

---
#### T3.4: Sidebar de chats al estilo de las IA actuales

**Status**: done

**Description**: En la sidebar de Chats: arriba un botón 'Nuevo chat' (lleva a chats/new) y debajo la lista de chats del proyecto con título, rama/worktree que lo identifica y estado (badge). El elegido queda resaltado. La lista se refresca al crear un chat y cada pocos segundos mientras haya alguno corriendo. Usa ChatsService.list(projectId).

**Evidence**:
- Summary: ChatSidebar (columna izquierda de la sección Chats, estilo de las IA actuales): arriba el botón 'Nuevo chat' (a chats/new, con icono +) y debajo los chats del proyecto con título, 'work|scope · rama' y badge de estado; el activo queda resaltado (routerLinkActive). Usa ChatsService.list(projectId) (la API filtra). Se recarga tras cada NavigationEnd (un chat creado aparece y queda seleccionado) y cada 4 s solo mientras haya uno corriendo (hasRunning). ChatsSection arma la grilla lista | conversación; ChatList anterior eliminada.
- Validation: vitest web 107/107: hasRunning, chatSubtitle (rama/worktree) y statusTone
- Validation: npm run lint, typecheck, format y build en verde
- Files changed: `apps/web/src/app/chats/chat-sidebar.ts`, `apps/web/src/app/chats/chats-section.ts`, `apps/web/src/app/chats/status.ts`, `apps/web/src/app/chats/status.spec.ts`
- Notes: No se vio ni se ejecutó en un navegador: el resaltado, la recarga tras crear un chat y el polling se verifican por código y compilación.

**Verdict**: pass

---
#### T3.5: Nuevo chat y chat dentro del layout

**Status**: done

**Description**: chats/new muestra el formulario de nuevo chat (proyecto fijo, deshabilitado con el motivo si no está listo) y al crear navega a chats/:chatId dentro del layout. chats/:chatId muestra el chat existente (ChatPage reutilizado) sin selector de proyecto ni cambios de comportamiento del streaming.

**Evidence**:
- Summary: Nuevo chat y chat dentro del layout: chats/new muestra NewChatForm con el proyecto fijo (sin selector), deshabilitado con el motivo si cloning/error, y al crear navega a /projects/:p/chats/:chatId dentro del layout (hecho en T3.3); ChatPage reutilizado sin selector de proyecto ni cambios del streaming, reactivo al cambio de chat. En esta tarea: ProjectLayout relee el proyecto cada 3 s mientras está 'cloning' (el formulario se desbloquea sin recargar; se corta al pasar a otro estado y al salir) y el contenedor principal pasa a 80rem para que quepan riel, lista y conversación.
- Validation: npm run lint, typecheck, format y build en verde
- Validation: vitest web 107/107 (sin cambios de lógica pura)
- Files changed: `apps/web/src/app/projects/project-layout.ts`, `apps/web/src/app/chats/new-chat.form.ts`, `apps/web/src/app/chats/chat.page.ts`, `apps/web/src/styles/base.css`
- Notes: Sin test de DOM ni navegador: crear un chat y verlo abrirse en el layout, el formulario deshabilitado y el streaming en vivo se verifican por código y compilación; el streaming no se tocó.

**Verdict**: pass

---
#### T3.6: Configuración del proyecto en tabs: General y Environment

**Status**: done

**Description**: settings/:tab con Tabs: 'General' (nombre visible, rama base, comando de setup) y 'Environment' (archivos .env con el modal TOTP). La tab activa va en la URL. El código deja lugar para sumar tabs sin tocar las existentes.

**Evidence**:
- Summary: Configuración en tabs: SettingsPage (settings/:tab) con el componente Tabs; General (ProjectGeneralSettings: nombre visible, rama base, setup, PATCH como antes) y Environment (EnvFilesSection con el modal TOTP). Se ve una tab por vez y la activa va en la URL (/projects/:id/settings/general|environment); una tab desconocida se reemplaza por General. Las tabs son una lista declarativa en settings-tabs.ts: sumar una es agregar la entrada y un @case, sin tocar las existentes.
- Validation: vitest web 109/109 (settings-tabs.spec: General primera, ids únicos, path de la tab y fallback a General)
- Validation: npm run lint, typecheck, format y build en verde
- Files changed: `apps/web/src/app/projects/settings.page.ts`, `apps/web/src/app/projects/settings-tabs.ts`, `apps/web/src/app/projects/settings-tabs.spec.ts`, `apps/web/src/app/projects/project-settings.ts`
- Notes: Navegar entre tabs, la tab en la URL y guardar/subir .env no se probaron en un navegador; General y Environment reutilizan sin cambios la lógica de Sprint 4 (PATCH y .env con TOTP).

**Verdict**: pass

---
### P4 — Docs y verificación

> Docs al día con la nueva web e identidad, y verificación automática completa.

#### T4.1: Docs al día con el nuevo layout, modales e identidad

**Status**: done

**Description**: Actualizar plan.md (pantallas web: layout del proyecto con sidebar, modales, tabs, alta por URL completa), panel-desarrollo.md (cómo se usa cada pantalla) y verificar que docs/identidad-visual.md y CLAUDE.md reflejan lo implementado.

**Evidence**:
- Summary: Docs al día (plan.md, panel-desarrollo.md, identidad-visual.md, CLAUDE.md) con el layout con sidebar, modales TOTP, Nuevo proyecto con URL completa, pestañas y Versiones con icono. Renovada tras vincular el escenario S53.
- Validation: npm run format:check limpio
- Validation: grep: sin TotpDialog ni 'Agregar proyecto' en docs/ y CLAUDE.md
- Validation: Rutas y campos documentados coinciden con app.routes.ts y los servicios
- Files changed: `docs/plan.md`, `docs/panel-desarrollo.md`, `docs/identidad-visual.md`, `CLAUDE.md`

**Verdict**: pass

---
#### T4.2: Verificación automática del sprint

**Status**: done

**Description**: Correr typecheck, lint, format:check, tests y build de todo el repo; comprobar con grep que no quedan colores hex fuera de tokens.css, que no hay pedidos a dominios externos para fuentes y que el nav aparece una sola vez. El recorrido visual por el usuario es opcional y se registra aparte si se hace.

**Evidence**:
- Summary: Verificación automática del repo completo tras el Sprint 5 (renovada tras vincular el escenario S50).
- Validation: typecheck sin errores; lint y format:check limpios
- Validation: npm test: api 371/371 y web 109/109; build en verde
- Validation: grep de hex/rgb fuera de tokens.css = 0; sin URLs externas ni Google Fonts; un solo <nav>; título 'Panel de agentes'
- Files changed: `docs`
- Notes: NO probado en un navegador: nada de la web de este sprint se vio renderizado ni con ruteo real (modales: foco/Esc/cruz, último chat recordado, cambio de chat sin recargar, sidebar con polling, tabs en la URL, icono girando, estado a la derecha en pantallas angostas, aspecto de la identidad). Solo la lógica pura tiene tests; el resto está validado por typecheck, lint, build y revisión.

**Verdict**: pass

---

## Unfinished work

_None — every task is done with a passing verdict._

## Learnings

_No learnings recorded._

## Resolved Debt

- **debt-1**: Rutas de chats: additionalProperties:false descarta campos extra en vez de rechazarlos (ajv removeAdditional de Fastify)
- **debt-2**: R4: el mensaje de duplicado está en inglés ('Project already exists'), la especificación pide 'ya existe'
- **debt-3**: Sin índice único en repo_url: dos altas concurrentes del mismo repo con nombres distintos clonarían dos veces
- **debt-4**: kyro install corre por proyecto y toca lo global: serializar si hay altas simultáneas con .agents/kyro/
- **debt-5**: Test flaky project-service 'recoverInterrupted…': el clon en segundo plano hace mkdir(dest) antes que el mkdirSync del test (EEXIST ~40%). Fix: mkdirSync(..., { recursive: true }) en test/project-service.test.ts:315
- **debt-6**: writeEnvFiles con applyToActive sobre un worktree con agente corriendo: entre el realpath de la carpeta y el rename hay una ventana (TOCTOU) en la que el agente podría cambiar una carpeta por un symlink. Evaluar abrir la carpeta con O_DIRECTORY/O_NOFOLLOW o no aplicar a chats running

## Recommendations for Sprint 6

_None recorded._
