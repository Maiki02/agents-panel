import { timingSafeEqual } from 'node:crypto';
import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const MAX_BODY_BYTES = 64 * 1024;
export const CSRF_HEADER = 'x-csrf-token';

/** Security headers: CSP default-src 'self' (style-src also allows inline styles), HSTS, frame-ancestors 'none', nosniff. */
export function registerHeaders(app: FastifyInstance): void {
  void app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        // Angular injects the component styles as <style> at runtime; scripts stay 'self' only.
        styleSrc: ["'self'", "'unsafe-inline'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    strictTransportSecurity: { maxAge: 63_072_000, includeSubDomains: true },
    xContentTypeOptions: true,
    xFrameOptions: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
  });
}

/**
 * State-changing requests must come from our own origin. Covers login CSRF, where no
 * session exists yet. Browsers always send Origin (or Sec-Fetch-Site) on these methods.
 */
export function registerOriginCheck(
  app: FastifyInstance,
  allowedOrigins: string | readonly string[],
): void {
  const allowed = typeof allowedOrigins === 'string' ? [allowedOrigins] : allowedOrigins;
  app.addHook('onRequest', async (request, reply) => {
    if (!UNSAFE_METHODS.has(request.method)) return;
    const origin = request.headers.origin;
    const sameOrigin =
      origin !== undefined
        ? allowed.includes(origin)
        : request.headers['sec-fetch-site'] === 'same-origin';
    if (!sameOrigin) return reply.code(403).send({ error: 'forbidden_origin' });
  });
}

/** Authenticated state-changing requests must echo the session's CSRF token. Must run after the guard. */
export function registerCsrfCheck(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!UNSAFE_METHODS.has(request.method)) return;
    if (request.routeOptions.config.public === true) return;
    const session = request.session;
    if (!session) return; // the guard already answered 401
    const sent = request.headers[CSRF_HEADER];
    const expected = Buffer.from(session.csrfToken);
    const actual = Buffer.from(typeof sent === 'string' ? sent : '');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return reply.code(403).send({ error: 'invalid_csrf_token' });
    }
  });
}
