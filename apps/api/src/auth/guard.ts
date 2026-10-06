import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Session, SessionService } from './sessions.js';
import { SESSION_COOKIE } from './sessions.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Explicit opt-out of the session guard. Only login steps and health may set this. */
    public?: boolean;
  }
  interface FastifyRequest {
    session: Session | null;
  }
  interface FastifyInstance {
    registeredRoutes: RegisteredRoute[];
  }
}

export interface RegisteredRoute {
  method: string;
  url: string;
  public: boolean;
}

/**
 * Deny-by-default: every request, including unknown paths, needs a valid session
 * unless the matched route sets config.public = true.
 */
export function registerGuard(
  app: FastifyInstance,
  sessions: SessionService,
  /** Requests answered by the compiled web (static files), which need no session. */
  isWebRequest: (request: FastifyRequest) => boolean = () => false,
): void {
  app.decorate('registeredRoutes', []);
  app.decorateRequest('session', null);

  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const isPublic = (route.config as { public?: boolean } | undefined)?.public === true;
    for (const method of methods) {
      app.registeredRoutes.push({ method, url: route.url, public: isPublic });
    }
  });

  app.addHook('onRequest', async (request, reply) => {
    // Parse by hand: this hook is registered before @fastify/cookie finishes loading.
    const cookies = app.parseCookie(request.headers.cookie ?? '');
    request.session = sessions.validate(cookies[SESSION_COOKIE]) ?? null;
    if (request.routeOptions.config.public === true) return;
    // The web files are public (as with ng serve); only a request no route matched can be one.
    if (request.is404 && isWebRequest(request)) return;
    if (!request.session) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });
}
