# El piloto y los permisos bloquean menos

El piloto reconoce el QA aunque el agente siga la skill leyendo su SKILL.md, y el chequeo de Bash deja de confundir texto entre comillas con pipes, separadores o redirecciones.

## Problema

- **Cierre sin QA falso (chat 3, `operaciones-worktree`):** el prompt del cierre dice «Read ~/.agents/skills/kyro-qa/SKILL.md first and follow it». El agente lo leyó y corrió QA (APPROVED WITH NOTES, reporte escrito), pero `usedSkill` solo acepta la herramienta `Skill` con `kyro-qa`, y el piloto frenó con `qa_sin_correr`.
- **Comillas en Bash:** `checkBash` parte el comando por `|`, `;`, `&` y busca `<`/`>` sin mirar las comillas. `git grep -E "a|b"` se rechaza («Bash command not allowed: b») y `git commit -m "… <noreply@anthropic.com>"` se rechaza como redirección.

## Regla nueva

- `usedSkill(events, s)` cuenta la herramienta `Skill` con `s` y también un `Read` de `…/skills/<s>/SKILL.md`, que es como los prompts del piloto mandan usar las skills.
- `checkBash` enmascara el texto entre comillas simples y dobles antes de buscar separadores, pipes y redirecciones; cada etapa se sigue validando con su texto original. La sustitución de comandos (`$(…)`, backticks) se sigue rechazando en cualquier lugar, también entre comillas dobles, donde bash la ejecuta. Una comilla sin cerrar se rechaza.

## Fuera de alcance

- Habilitar `du`, `df` o `free` en la base (se agregan por proyecto en Permisos).
