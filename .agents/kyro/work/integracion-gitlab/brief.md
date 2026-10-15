# Proyectos de GitLab y cuentas de GitHub/GitLab vinculadas

## Objetivo

Que el panel, además de proyectos de GitHub, acepte proyectos de **GitLab** (gitlab.com y GitLab privados accesibles por HTTPS), y que en la sección **Cuentas** se puedan vincular **varias cuentas de GitHub y de GitLab** con un token de acceso personal. Cada proyecto usa la cuenta vinculada que le corresponde para clonar, traer cambios, pushear y abrir PRs / Merge Requests, con la misma paridad que hoy tiene GitHub.

## Problema

- Hoy todo lo que sale a un proveedor de git usa el único login global de `gh` de la VM (`gh auth login` + `gh auth setup-git`, cuenta Maiki02). No hay forma de usar otra cuenta de GitHub ni ninguna de GitLab.
- El alta de proyectos (`parseGithubRepo`, `repo-input.ts`) solo acepta `https://github.com/...`; el clon usa `gh repo clone`.
- El piloto y `WorktreeOps` abren, buscan y siguen PRs solo con `gh` (`github-cli.ts`, `pr-lookup.ts`, `pr-watcher.ts`); `prStateOf` solo acepta URLs de `github.com`.
- La página **Cuentas** solo maneja cuentas de Claude.

## Decisiones del usuario (2026-10-15)

- El pedido se refiere a **GitLab** (gitlab.com y GitLab privados/self-hosted), además de GitHub.
- Las cuentas se vinculan **pegando un token de acceso personal en la web**, con segundo factor (TOTP), y el panel lo guarda **cifrado** (AES-256-GCM, como los `.env`). No se hace login en la VM.
- **Paridad completa** para GitLab: clonar, traer cambios, pushear, abrir Merge Requests, que el piloto los siga hasta mergeados y los botones de la web.
- Los GitLab privados **se alcanzan por HTTPS** desde la VM: no hace falta red extra ni cambia el costo (US$0).

## Regla nueva

- **Cuentas de git:** tabla nueva (proveedor `github` | `gitlab`, nombre, host —`github.com`, `gitlab.com` o el host del GitLab privado, solo `https`—, usuario que informa el proveedor, token cifrado, alta). Al vincular, el panel valida el token contra la API del proveedor (`GET /user`) y guarda el usuario que devuelve; el token nunca vuelve a la web ni a logs, ni viaja en argv.
- **Cuenta principal de GitHub:** el login global de `gh` de la VM sigue siendo la cuenta por defecto. Los proyectos existentes no cambian: sin cuenta vinculada usan el `gh` global como hoy.
- **Proyecto ↔ cuenta:** cada proyecto guarda su proveedor y, opcionalmente, la cuenta vinculada. Un proyecto de GitLab necesita una cuenta de GitLab de su mismo host. Se elige al darlo de alta y se puede cambiar en Configuración.
- **Alta:** **Proyectos → Nuevo proyecto** acepta la URL completa de GitHub o de GitLab (incluye subgrupos `https://host/grupo/sub/repo` y `/-/tree/<rama>`). El host tiene que coincidir con el de una cuenta vinculada (o ser `github.com`).
- **Operaciones:** clonar, fetch, pull y push del panel usan las credenciales de la cuenta del proyecto sin escribirlas en disco ni en la URL del remoto (credencial por entorno del proceso). Abrir, buscar y seguir PRs/MRs pasa por una abstracción de proveedor: GitHub sigue con `gh` (con el token de la cuenta si la hay) y GitLab usa su API REST v4.
- **Seguridad:** rutas con sesión y CSRF; vincular, cambiar o ver estado del token exige TOTP como los `.env`. Borrar una cuenta usada por un proyecto se rechaza.

## Fuera de alcance

- Hacer el login OAuth de GitHub/GitLab desde la web (solo token personal).
- GitLab detrás de VPN o red privada (necesitaría red extra en la VM y se planifica aparte).
- Instalar `glab` u otra herramienta nueva en la VM.
- Bitbucket u otros proveedores.
- Migrar la cuenta global de `gh` a una cuenta vinculada.
