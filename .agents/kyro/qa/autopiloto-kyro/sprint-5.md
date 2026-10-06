Verdict: APPROVED WITH NOTES

# QA del sprint 5 (web-piloto-push) de autopiloto-kyro

## Resultado del re-QA (05/10/2026)
El primer QA dio **CHANGES REQUIRED** por un hallazgo Major de seguridad (SSRF a ciegas por el endpoint de la suscripción push). Se corrigió con la tarea emergente E3 (`isPushServiceEndpoint`: solo `fcm.googleapis.com`, `*.push.services.mozilla.com`, `*.notify.windows.com`, `web.push.apple.com` y `*.push.apple.com`, puerto 443 y sin credenciales; el resto da 400 y no guarda nada). El re-QA verificó:
- La corrección: 3 tests nuevos (aceptados de FCM, Mozilla, Windows y Apple; rechazados `127.0.0.1`, `localhost`, `169.254.169.254`, un host ajeno, `fcm.googleapis.com.evil.example`, host con credenciales, puerto 8443 y `http`; 400 sin guardar). Las dos suscripciones reales (Android y Windows, ambas de FCM) siguen siendo válidas.
- Sin regresión: typecheck, lint, format:check y build en verde; API 1014 tests y web 239 tests; `/tmp` sin carpetas `panel-*`; sin `bypassPermissions`; `public: true` solo en `/api/health` y los dos pasos del login. (`format:check` marcó un formato de `push/routes.ts` y se corrigió; no cambió la lógica.)
- `kyro analyze`: CRITICAL=0, HIGH=0.

No quedan hallazgos Critical ni Major. Los hallazgos menores 2 a 8 quedaron como deuda baja (debt-11, target 6) y los riesgos aceptados siguen documentados (Funnel publica `ng serve` hasta el sprint 6; debt-10).

## Decisión del re-QA
Approved with notes. El sprint se puede cerrar.

---

## Informe del primer QA (CHANGES REQUIRED), conservado como historial

## Resumen
Auditoría independiente de las 14 tareas (T1.1 a T5.2, más las emergentes E1 y E2). La funcionalidad cumple lo pedido y la prueba real con el usuario lo confirma (avisos por push a la PC y al Android con Chrome cerrado, piloto de punta a punta hasta una PR). Hay **un hallazgo de seguridad Major** que bloquea la aprobación: el endpoint de una suscripción push solo se valida como `https`, así que un usuario logueado hace que el servidor mande una petición a cualquier URL https (SSRF a ciegas con el código de estado de vuelta).

## Alcance auditado
`apps/api/src/push/*` (sender, repo, service, routes, notifier), `pilot/routes.ts` (acción `on`), `pilot/autopilot.ts` (reanudar plan/init cortado), `projects/repo.ts`, `projects/kyro-branch.ts` y su ruta de push, `chats/questions-repo.ts`, `app.ts`, `config.ts`, migración 17, `scripts/vm/09-tailscale-funnel.sh`, `apps/web/public/push-sw.js`, `manifest.webmanifest`, la web nueva (chat.page, stepper, Timeline, barra del piloto, nuevo chat, modelos, notificaciones, repositorio), `sprint.json` (handoff, deuda, tareas) y los docs.

## Verificado
- typecheck, lint, format:check, build en verde; API 1011 tests, web 239 tests; `/tmp` sin carpetas `panel-*`.
- Sin `bypassPermissions` en `apps/api/src`; `public: true` solo en `/api/health` y los dos pasos del login.
- Rutas nuevas (`/api/push/*`, acción `on`, `/kyro-init/push`) exigen sesión y CSRF (tests 401/403); cada usuario solo ve y toca sus suscripciones.
- Las claves VAPID salen solo del `.env` (no versionado, modo 600); `GET /api/push/config` no expone la privada; `.env.example` solo con valores falsos.
- El service worker solo abre rutas internas (`panelPath`); el push de la rama de Kyro usa `pushArgs` (nombre de rama simple, sin force).
- Sin colores literales en los componentes nuevos; el manifest y el `theme-color` llevan el azul de la marca documentado.
- Prueba real: H3 confirmada con el usuario; el piloto llegó a la PR #2 sin intervención después de reanudarlo.

## Hallazgos

### Críticos
Ninguno.

### Major
1. **SSRF a ciegas por el endpoint de la suscripción** (`apps/api/src/push/routes.ts`, `isHttps`; `apps/api/src/push/sender.ts`). El alta acepta cualquier URL `https` y `web-push` hace un POST a ese endpoint cada vez que hay un aviso o se toca Probar. Un usuario logueado puede apuntarlo a un servicio https interno o ajeno, y `POST /api/push/subscriptions/:id/test` devuelve el `statusCode` que contestó: sirve para sondear. El contenido del POST no lo controla el atacante y exige sesión con segundo factor, por eso no es Critical, pero la URL del panel es pública y es una puerta innecesaria. **Corrección:** aceptar solo endpoints de los servicios de push de los navegadores (`fcm.googleapis.com`, `*.push.services.mozilla.com`, `*.notify.windows.com`, `web.push.apple.com` y `*.push.apple.com`) con host exacto o sufijo, rechazar con 400 y un mensaje claro cualquier otro, y test del rechazo (incluido `https://127.0.0.1`, `https://localhost` y un host ajeno).

### Minor
2. `pendingKyroInit` (`projects/repo.ts`) corre dos `execFileSync` de git, síncronos, por cada lectura de un proyecto sin Kyro (lista de proyectos, sidebar). Con pocos proyectos es tolerable; conviene cachear o leer el ref desde el sistema de archivos.
3. El respaldo de `question_cancelled` al arrancar (`app.ts`) recorre los eventos de cada chat con preguntas canceladas en cada arranque: crece con el historial. Aceptable hoy.
4. `PushSubscriptionRepository.upsert` reasigna un endpoint que era de otro usuario al que lo da de alta (mismo navegador). Es razonable, pero queda anotado: el endpoint es una URL secreta.
5. No hay tope de suscripciones por usuario.
6. `sender.ts` y `push-sw.js` no tienen test automático (la lógica pura sí); el sender se probó en real con los dispositivos.
7. E1 y E2 quedaron sin referencia de escenario (`kyro analyze` A003, MEDIUM); S20 sin cobertura de tarea (A002).
8. Texto de la ruta `on`: un piloto `finished` responde «ya está encendido», que no es exacto (dice «ya terminó»).

### Riesgos aceptados y documentados (no bloquean)
- **Funnel publica el servidor de desarrollo (`ng serve`).** Decisión explícita del usuario, anotada como riesgo en el paso 15 de `docs/vm-setup.md`; el build de producción y el servicio systemd son del sprint 6.
- **debt-10:** que una suscripción vencida (404 o 410) se borre sola no se probó en real; está cubierto por tests y queda con target 6.

## Revisión por dimensión
- **Arquitectura:** alineada. La clasificación «quién actúa» pasó a `packages/shared` y la comparten web y notificador; el push es un módulo propio con sender inyectable; el piloto sigue decidiendo solo por señales verificables.
- **Seguridad:** ver el hallazgo 1; el resto sin hallazgos.
- **Calidad de código:** lógica pura con specs en la web; sin duplicación relevante.
- **Funcional:** cumple los criterios de las 14 tareas y la prueba real.
- **Testing:** suficiente en la API y en la lógica de la web; las pantallas no tienen tests de componente (patrón del repo).
- **Rendimiento:** ver el menor 2.
- **Confiabilidad:** el reinicio con preguntas pendientes y con un plan cortado quedó resuelto (E2); un fallo de envío push nunca frena al piloto.
- **Planificación:** `sprint.json` coherente (14 tareas con pass, deuda registrada: debt-1 diferida, debt-5, debt-9 y debt-10 abiertas, debt-8 resuelta); handoff en `qa_or_close`; docs actualizados (`estados`, `plan`, `panel-desarrollo`, `identidad-visual`, `vm-setup`, `CLAUDE.md`).

## Correcciones requeridas
1. Restringir los endpoints de suscripción push a los servicios de push de los navegadores, con test (hallazgo 1).

## Mejoras recomendadas
Hallazgos 2 a 8, como deuda o en el sprint 6.

## Decisión final
Changes required. La funcionalidad es correcta y está probada en real, pero el hallazgo de seguridad 1 debe corregirse antes de aprobar; después hace falta un nuevo QA.
