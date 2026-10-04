import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import { ORIGIN, PASSWORD, makeApp } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
});

async function authed() {
  const made = makeApp();
  app = made.app;
  await app.ready();
  const user = await new UserRepository(made.db).create('alice', PASSWORD);
  const { token, csrfToken } = new SessionService(made.db, {
    idleTtlSeconds: 1800,
    absoluteTtlSeconds: 43200,
  }).create(user.id);
  return { db: made.db, server: app, cookie: `${SESSION_COOKIE}=${token}`, csrfToken };
}

describe('CSRF and origin', () => {
  it('rejects an authenticated POST without or with a wrong X-CSRF-Token, leaving the base intact', async () => {
    const { db, server, cookie } = await authed();
    for (const extra of [{}, { 'x-csrf-token': 'wrong' }]) {
      const res = await server.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie, origin: ORIGIN, ...extra },
      });
      expect(res.statusCode).toBe(403);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 1 });
  });

  it('accepts the right token', async () => {
    const { server, cookie, csrfToken } = await authed();
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, origin: ORIGIN, 'x-csrf-token': csrfToken },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a login POST from a foreign Origin, or with no Origin at all', async () => {
    const { server } = await authed();
    const payload = { username: 'alice', password: PASSWORD };
    const foreign = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'https://evil.example' },
      payload,
    });
    expect(foreign.statusCode).toBe(403);
    const none = await server.inject({ method: 'POST', url: '/api/auth/login', payload });
    expect(none.statusCode).toBe(403);
  });

  it('accepts Sec-Fetch-Site: same-origin when Origin is absent', async () => {
    const { server } = await authed();
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'sec-fetch-site': 'same-origin' },
      payload: { username: 'alice', password: 'wrong password here!!' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects bodies over the size limit', async () => {
    const { server } = await authed();
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ORIGIN },
      payload: { username: 'a', password: 'x'.repeat(70 * 1024) },
    });
    expect(res.statusCode).toBe(413);
  });
});

describe('security headers', () => {
  it('sends CSP, HSTS and nosniff, including on errors', async () => {
    const { server } = await authed();
    for (const url of ['/api/health', '/api/missing']) {
      const res = await server.inject({ url });
      expect(res.headers['content-security-policy']).toContain("default-src 'self'");
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(res.headers['strict-transport-security']).toContain('max-age=');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    }
  });
});
