import type { FastifyInstance } from 'fastify';
import type {
  NewPushSubscription,
  PushConfig,
  PushSubscriptionInfo,
  PushTestResult,
} from '@agents-panel/shared';
import { onlyKeys } from '../http/only-keys.js';
import { toInfo, type PushSubscriptionRepository } from './repo.js';
import type { PushService } from './service.js';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

const createBody = {
  type: 'object',
  required: ['endpoint', 'keys'],
  additionalProperties: false,
  properties: {
    endpoint: { type: 'string', minLength: 1, maxLength: 2048 },
    keys: {
      type: 'object',
      required: ['p256dh', 'auth'],
      additionalProperties: false,
      properties: {
        p256dh: { type: 'string', minLength: 1, maxLength: 256 },
        auth: { type: 'string', minLength: 1, maxLength: 128 },
      },
    },
    name: { type: 'string', maxLength: 80 },
  },
} as const;

const renameBody = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: { name: { type: 'string', minLength: 1, maxLength: 80 } },
} as const;

function defaultName(name: string | undefined): string {
  const trimmed = name?.trim() ?? '';
  return trimmed === '' ? 'Este dispositivo' : trimmed;
}

/**
 * Push services of the browsers. The server POSTs to a subscription's endpoint, so accepting any
 * https URL would let a user aim it at an internal or foreign host. Exact host or `.suffix`.
 */
const PUSH_SERVICE_HOSTS = [
  'fcm.googleapis.com',
  '.push.services.mozilla.com',
  '.notify.windows.com',
  'web.push.apple.com',
  '.push.apple.com',
] as const;

/** True for an https URL (default port, no credentials) on one of the browsers' push services. */
export function isPushServiceEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return false;
  if (url.port !== '' && url.port !== '443') return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some((allowed) =>
    allowed.startsWith('.')
      ? host.endsWith(allowed) && host.length > allowed.length
      : host === allowed,
  );
}

/**
 * Web Push subscriptions of the logged-in user. Everything needs a session (and CSRF when it
 * writes) through the global guard; each user only sees and touches their own (another's: 404).
 */
export function registerPushRoutes(
  app: FastifyInstance,
  deps: { push: PushService; subscriptions: PushSubscriptionRepository },
): void {
  const { push, subscriptions } = deps;
  // The global guard guarantees a session: the user is always the one of that session.
  const userOf = (request: { session?: { userId: number } | null }): number => {
    const userId = request.session?.userId;
    if (userId === undefined) throw new Error('Unauthorized');
    return userId;
  };
  const notFound = { error: 'Suscripción no encontrada' };

  app.get('/api/push/config', (): PushConfig => ({
    enabled: push.enabled,
    publicKey: push.enabled ? push.publicKey : null,
  }));

  app.get('/api/push/subscriptions', (request): PushSubscriptionInfo[] =>
    subscriptions.listForUser(userOf(request)).map(toInfo),
  );

  app.post<{ Body: NewPushSubscription }>(
    '/api/push/subscriptions',
    { schema: { body: createBody }, preValidation: onlyKeys(Object.keys(createBody.properties)) },
    async (request, reply): Promise<PushSubscriptionInfo | undefined> => {
      if (!isPushServiceEndpoint(request.body.endpoint)) {
        await reply.code(400).send({
          error: 'El endpoint tiene que ser de un servicio de push de un navegador (https)',
        });
        return undefined;
      }
      const agent = request.headers['user-agent'];
      const saved = subscriptions.upsert(userOf(request), {
        endpoint: request.body.endpoint,
        p256dh: request.body.keys.p256dh,
        auth: request.body.keys.auth,
        name: defaultName(request.body.name),
        userAgent: typeof agent === 'string' ? agent.slice(0, 300) : null,
      });
      return toInfo(saved);
    },
  );

  app.patch<{ Params: { id: number }; Body: { name: string } }>(
    '/api/push/subscriptions/:id',
    {
      schema: { params: idParams, body: renameBody },
      preValidation: onlyKeys(Object.keys(renameBody.properties)),
    },
    async (request, reply): Promise<PushSubscriptionInfo | undefined> => {
      const name = request.body.name.trim();
      if (name === '') {
        await reply.code(400).send({ error: 'El nombre no puede estar vacío' });
        return undefined;
      }
      const renamed = subscriptions.rename(userOf(request), request.params.id, name);
      if (!renamed) {
        await reply.code(404).send(notFound);
        return undefined;
      }
      return toInfo(renamed);
    },
  );

  app.delete<{ Params: { id: number } }>(
    '/api/push/subscriptions/:id',
    { schema: { params: idParams } },
    async (request, reply) => {
      const own = subscriptions.findForUser(userOf(request), request.params.id);
      if (!own) return reply.code(404).send(notFound);
      subscriptions.remove(own.id);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: number } }>(
    '/api/push/subscriptions/:id/test',
    { schema: { params: idParams } },
    async (request, reply): Promise<PushTestResult | undefined> => {
      const own = subscriptions.findForUser(userOf(request), request.params.id);
      if (!own) {
        await reply.code(404).send(notFound);
        return undefined;
      }
      if (!push.enabled) {
        await reply.code(409).send({ error: 'Las notificaciones push no están configuradas' });
        return undefined;
      }
      return push.sendTo(own, {
        title: 'Panel de agentes',
        body: 'Notificación de prueba: si la ves, este dispositivo recibe avisos.',
        url: '/',
      });
    },
  );
}
