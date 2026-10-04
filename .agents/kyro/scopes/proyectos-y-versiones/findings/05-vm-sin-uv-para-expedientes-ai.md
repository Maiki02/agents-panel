# expedientes-ai necesita uv y la VM no lo tiene

- **Resumen:** `Maiki02/expedientes-ai` (privado, `main`) tiene `backend/` en Python 3.12 con `uv` (`pyproject.toml`, `uv.lock`, `.python-version`) y `backend/.env.example`. La VM tiene Python 3.14.4 y no tiene `uv`.
- **Severidad:** media.
- **Archivos afectados:** `scripts/vm/07-uv.sh` (nuevo), `docs/vm-setup.md` (paso, bitácora, Costos).
- **Recomendación:** instalar `uv` en `~/.local/bin` con un script idempotente; setup del proyecto `uv sync --project backend`.
- **Validación:** `uv --version` y segunda corrida sin cambios; costo US$0.
