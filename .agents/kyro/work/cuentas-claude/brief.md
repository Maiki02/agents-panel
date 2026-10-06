# Selector de cuenta de Claude en el panel

## Objetivo

Que el panel pueda usar cualquiera de las cuentas de Claude Code logueadas en la VM ("Miqueas Gentile" en `~/.claude`, "Miqueas - Bimtrazer" en `~/.claude2`) y que cambiar de una a otra sea un clic desde la web, para seguir trabajando cuando una se queda sin cupo.

## Problema

- El Agent SDK lanza el proceso de Claude Code con el entorno del panel: siempre usa `~/.claude` (o el `CLAUDE_CONFIG_DIR` que herede la API, por accidente).
- No hay forma de registrar otra cuenta ni de elegirla. El work de tokens que viene necesita saber con qué cuenta corrió cada sesión.

## Regla nueva

- **Cuentas:** tabla `claude_accounts` (nombre, directorio de config, alta). Una migración crea la cuenta por defecto (`~/.claude`, directorio nulo) como activa. Hay siempre exactamente una cuenta activa, global para todo el panel.
- **Alta:** desde la web (página **Cuentas**), con nombre y directorio absoluto dentro del home, que exista y tenga login (`.credentials.json`). `~/.claude` no se da de alta: es la cuenta por defecto. Se puede renombrar cualquier cuenta y borrar las que no son la por defecto ni la activa.
- **Identidad visible:** cada cuenta muestra el email y la organización que lee de su `.claude.json` (`oauthAccount`), si tiene login y si su `projects/` está enlazado a `~/.claude/projects` (`11-claude-cuentas.sh`); sin enlace, una sesión empezada con otra cuenta no se puede retomar y se avisa.
- **Uso:** cada turno nuevo corre con la cuenta activa en ese momento: el SDK recibe `env` con `CLAUDE_CONFIG_DIR` de la cuenta; para la cuenta por defecto la variable se quita (si se pusiera `~/.claude`, Claude Code buscaría `.claude.json` adentro). Un turno que ya corre termina con su cuenta.
- **Registro:** `agent_sessions.account_id` guarda la cuenta de cada sesión y el evento `session_started` lleva el nombre de la cuenta (se ve en el Timeline).
- **Selector:** un desplegable en el encabezado de la web con las cuentas; elegir una la deja activa (`PUT /api/accounts/active`, con sesión y CSRF).

## Fuera de alcance

- Mostrar tokens o cupo por cuenta (work aparte, que usa `account_id`).
- Cambiar de cuenta solo cuando el piloto se queda sin cupo.
- Hacer el login de una cuenta desde la web (se hace en la VM con `CLAUDE_CONFIG_DIR=<dir> claude`).
