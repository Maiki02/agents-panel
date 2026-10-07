# 03 · Indicador de uso: falta todo y tiene que ser por cuenta

- **Severidad:** media
- **Archivos:** `apps/api/src/pilot/autopilot.ts` (`hitUsageLimit`, `QUOTA_RETRY_MS`), `apps/api/src/pilot/runs-repo.ts`, `apps/web/src/app/app.ts` (header)

## Resumen

No hay tabla `provider_usage` ni `GET /api/usage`. El piloto detecta el `rate_limit_event` rechazado y reintenta cada 15 minutos (`sin_cupo_de_uso`). D24 se escribió antes de que el panel tuviera varias cuentas de Claude; `CLAUDE.md` exige ahora que lo que mida uso lo haga **por cuenta** (`account_id`).

## Comportamiento visible

El usuario no ve cuánto cupo queda (5 h, semanal) hasta que el piloto frena.

## Recomendación

`provider_usage` con `account_id`, ventana, utilización, reinicio, fuente y fecha; guardar cada `rate_limit_event` de cualquier sesión (fuente pasiva) y la lectura a pedido del SDK con caché de 60 s (experimental: si falla, degradado al dato pasivo con su antigüedad). El indicador muestra la cuenta activa. El piloto pasa a reintentar en `resetsAt` cuando lo conoce.

## Validación

Tests con fixtures de la respuesta y del evento, degradado si la llamada falla, spec del tono por umbral (ok < 70 %, warn ≥ 70 %, danger ≥ 90 % o rejected).
