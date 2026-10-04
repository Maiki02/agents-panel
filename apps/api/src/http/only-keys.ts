import type { preValidationHookHandler } from 'fastify';

/**
 * Fastify's default ajv silently strips unknown properties even with `additionalProperties: false`.
 * Routes that must refuse them (for instance a folder path) check the keys before validation.
 */
export function onlyKeys(allowed: readonly string[]): preValidationHookHandler {
  return (request, reply, done) => {
    const body = request.body;
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
      const extra = Object.keys(body).filter((key) => !allowed.includes(key));
      if (extra.length > 0) {
        void reply.code(400).send({ error: `Unknown field: ${extra[0] ?? ''}` });
        return;
      }
    }
    done();
  };
}
