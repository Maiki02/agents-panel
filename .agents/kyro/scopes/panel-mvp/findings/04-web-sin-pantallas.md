# 04 — La web es solo un componente raíz

- **Severidad:** baja.
- **Archivos:** `apps/web/src/app/*`, `apps/web/angular.json`.
- **Comportamiento esperado:** login en dos pasos (contraseña → código TOTP o de recuperación), lista de chats, nuevo chat (proyecto, scope/work, slug, pedido) y vista de chat con streaming y caja para continuar.
- **Recomendación:** proxy de desarrollo `/api → 127.0.0.1:3000`, interceptor que agrega `X-CSRF-Token`, guard de rutas basado en un signal de sesión.
- **Validación:** `ng build` + lint + prueba manual de punta a punta por túnel SSH (Funnel es la etapa 6).
