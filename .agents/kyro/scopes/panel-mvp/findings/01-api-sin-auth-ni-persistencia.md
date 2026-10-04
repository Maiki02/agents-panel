# 01 — La API no tiene auth, sesiones ni persistencia

- **Severidad:** alta (la URL va a ser pública vía Tailscale Funnel).
- **Archivos:** `apps/api/src/app.ts`, `apps/api/src/main.ts`, `apps/api/package.json`.
- **Hoy:** Fastify con una sola ruta pública `GET /api/health`. Sin SQLite, sin cookies, sin tests.
- **Comportamiento esperado:** login con contraseña (Argon2id) + 2FA obligatorio, sesión por cookie `HttpOnly`/`Secure`/`SameSite=Strict`, CSRF, límite de intentos, y guard global deny-by-default (ninguna ruta sin sesión salvo el login y health).
- **Recomendación:** `node:sqlite` (verificado en la VM: Node 24.21, SQLite 3.53.4, sin build nativo) con migraciones numeradas; `@node-rs/argon2` (prebuild arm64); `otpauth` para TOTP; `@fastify/rate-limit` y `@fastify/helmet`. El guard se implementa como hook `onRequest` con allowlist explícita por ruta.
- **Validación:** vitest + `app.inject()`; un test recorre todas las rutas registradas y exige 401 sin sesión.
