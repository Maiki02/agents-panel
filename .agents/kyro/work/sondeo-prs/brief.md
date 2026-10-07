# Sondeo de PRs: mergeada al mergear en GitHub

Cuando las PRs de un trabajo se mergean en GitHub, el panel lo detecta solo y el trabajo pasa a `mergeada`, sin que nadie toque nada en el panel.

## Problema

Hoy el último estado de un trabajo es `pr_lista` (o `terminado` si no pasó por la fase de merge). El run del piloto queda `finished` con la PR abierta y el panel no vuelve a consultar GitHub: mergear la PR no cambia el estado. Casos reales: chats 2, 3 y 5 con sus PRs ya mergeadas siguen en `pr_lista` / `terminado`.

## Regla nueva

- Un vigilante de PRs (`PrWatcher`) revisa cada `PILOT_PR_POLL_MINUTES` minutos (5 por defecto; 0 lo apaga) los trabajos en `pr_lista` o `terminado`. Las URLs salen de `PrLookup` (las de `autopilot_runs.pr_urls` o, sin ellas, las PR de la rama en GitHub).
- El estado de cada PR sale de `gh pr view <url> --json state` (señal verificable, nunca texto del agente).
  - Alguna `OPEN`: no cambia nada.
  - Todas `MERGED`: el trabajo pasa a `mergeada` (actor `pilot`), con las URLs en `data.prUrls` y el detalle.
  - Ninguna abierta y alguna `CLOSED` sin mergear: pasa a `revisar` (actor `pilot`) con las PR cerradas en el detalle.
  - Sin PRs o con un error de `gh`: no cambia nada (se loguea; se reintenta en la próxima vuelta).
- Se saltea un trabajo cuyo chat está corriendo (`running`) y no se superponen dos vueltas sobre el mismo chat.
- Al abrir el chat (`GET /api/chats/:id/pr`) se fuerza la revisión de ese trabajo, así el cambio se ve sin esperar la vuelta.
- Los tests nunca llaman a GitHub: el estado de las PR es inyectable y el sondeo periódico está apagado en los tests.
- `docs/estados.md` documenta las señales de `mergeada` y `revisar` desde el sondeo y la variable nueva queda en `.env.example` y en los docs.

## Fuera de alcance

- Limpieza automática después de `mergeada` (`limpiando`, `archivado`).
- Webhooks de GitHub.
- Estados `pr_checks_fallidos` y `pr_cambios_pedidos`.
