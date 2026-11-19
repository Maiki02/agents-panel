# Piloto: menos tokens, sin tareas de prueba manual y un mensaje lo reanuda

El piloto gasta demasiados tokens, se traba en tareas que piden probar algo desplegado y, cuando frena, el mensaje de la persona no lo hace seguir: hay que ir a la card del piloto y apretar Reanudar.

## Problema

- **Tokens.** Cada paso abre una sesión nueva del SDK (`freshSession`), pero la sesión de ejecución corre todo el sprint hasta `qa_or_close`: el contexto crece tarea tras tarea y cada turno lo vuelve a mandar entero. Además las sesiones cargan `settingSources: ['project', 'user']`, que suma los conectores MCP de claude.ai (Gmail, Drive, Figma, etc.) y plugins que el piloto no usa. Hoy el panel no mide cuántos tokens gasta cada sesión, así que no se puede ver dónde se va el consumo.
- **Tareas de prueba manual.** El planificador mete en el sprint tareas del tipo «probar en el panel desplegado». El agente no puede hacerlas (no despliega ni usa la URL pública) y bloquea la tarea; el piloto frena.
- **Reanudar.** Con el piloto frenado, un mensaje en el chat (por ejemplo «marcá la tarea como deuda y seguí») va al agente, pero el run sigue `stopped` y la card sigue diciendo «Piloto frenado» hasta apretar Reanudar.

## Decisiones (del usuario, 2026-11-19)

1. **Medir tokens y costo por sesión.** Cada sesión del panel guarda input, output, caché (lectura y escritura) y costo en dólares del mensaje `result` del SDK. La web los muestra por sesión y el total del trabajo.
2. **Sesiones del piloto sin MCP ni plugins que no usa.** Las sesiones del piloto arrancan sin servidores MCP (ni los conectores de claude.ai) ni plugins. Siguen cargando la config del proyecto (`CLAUDE.md`, `.claude/settings.json`) y pueden leer las skills de Kyro. Los chats manuales no cambian.
3. **Una sesión limpia por tarea.** La sesión de ejecución termina cuando la tarea que Kyro rutea queda revisada (o bloqueada), y la siguiente tarea arranca en una sesión nueva con su `context-pack`. La política pasa a v5.
4. **Las pruebas manuales no van al sprint.** Al planificar, el agente no crea tareas cuya única forma de validarse es probar algo desplegado o en la URL pública. Las anota en `.agents/kyro/manual-checks/<scope-o-work>.md`, una por línea. Si al ejecutar una tarea el agente encuentra que una parte solo se valida desplegada, la valida con lo que puede correr localmente, anota el resto en ese archivo y cierra la tarea en vez de bloquearla. El panel lee ese archivo y lo suma a la descripción de la PR como checklist «Verificación manual» (`- [ ] …`).
5. **Un mensaje reanuda el piloto si frenó.** Si el run está `stopped` y la persona manda un mensaje en el chat, el mensaje va al agente como hoy y, cuando ese turno termina bien, el piloto se reanuda solo (igual que Reanudar, incluido el `kyro work unblock` de un work bloqueado), sin pasar por la card. Si el run está `paused` (lo pausó la persona) u `off`, el mensaje no lo reanuda. Si el turno termina con error o la persona lo cancela, tampoco. El Timeline lo anota con actor `user`.

## Decisiones del agente (sin preguntar)

Registradas acá y no con `kyro adr`, porque `kyro adr add` escribe el `sprint.json` de un scope de Forge y un Work no puede tocar el estado de Forge.

- **A1. Señal verificable para las pruebas manuales.** Las verificaciones manuales viven en un archivo del worktree (`.agents/kyro/manual-checks/<scope-o-work>.md`), igual que el informe de QA, y no en el texto del agente: el estado se deduce de señales verificables (CLAUDE.md). Alternativa descartada: pedirle al agente que las escriba en su informe final y parsearlo.
- **A2. Una sola subida de política.** W3 y W4 cambian la política; W4 depende de W3 para que ambos cambios salgan en la misma v5. Alternativa descartada: v5 y v6 en el mismo work.
- **A3. La medición vale para toda sesión.** Medir tokens no cambia el comportamiento, así que se guarda también para los chats manuales; recortar MCP y plugins, en cambio, solo aplica al piloto. Alternativa descartada: medir solo las sesiones del piloto.
- **A4. Reanudar después del turno, no antes.** El piloto se reanuda cuando el turno del mensaje termina bien, para que el agente ya haya hecho lo pedido (por ejemplo, marcar la deuda) cuando el piloto vuelve a leer Kyro. Alternativa descartada: reanudar al recibir el mensaje y pasarlo como nota del próximo prompt del piloto.

## Fuera de alcance

- Cambiar los modelos por rol, el esfuerzo (`effort`) o el tope de sesiones por sprint.
- Cambiar los chats manuales (sin piloto), salvo la medición de tokens, que vale para toda sesión.
- Borrar el botón Reanudar: sigue existiendo para el caso sin mensaje.

## Cómo se verifica

- Tests de Vitest de API y web, `npm run typecheck`, `npm run lint` y `npm run format:check` del repo.
- `docs/plan.md` y `docs/estados.md` reflejan la política v5, la medición de tokens, el archivo de verificaciones manuales y la reanudación por mensaje.
