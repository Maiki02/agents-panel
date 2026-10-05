import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE, SessionService, hashToken } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import { ORIGIN, makeApp } from './helpers.js';

let app: FastifyInstance | undefined;
function server(): FastifyInstance {
  if (!app) throw new Error('app not built');
  return app;
}
afterEach(async () => {
  await app?.close();
});

const PASSWORD = 'correct horse battery staple';

describe('deny-by-default guard', () => {
  it('returns 401 without a cookie for every registered non-public route', async () => {
    const made = makeApp();
    app = made.app;
    await app.ready();
    const routes = app.registeredRoutes.filter((r) => !r.public && r.method !== 'HEAD');
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      const res = await app.inject({
        method: route.method as 'GET',
        url: route.url.replace(/:[A-Za-z]+/g, '1'),
        headers: { origin: ORIGIN },
      });
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(401);
    }
  });

  it('registers the project routes and keeps them non-public', async () => {
    app = makeApp().app;
    await app.ready();
    const routes = app.registeredRoutes.filter((r) => r.url.startsWith('/api/projects'));
    const seen = routes.map((r) => `${r.method} ${r.url}`);
    for (const expected of [
      'GET /api/projects',
      'POST /api/projects',
      'GET /api/projects/:id',
      'PATCH /api/projects/:id',
      'POST /api/projects/:id/retry',
      'GET /api/projects/:id/env',
      'PUT /api/projects/:id/env',
      'DELETE /api/projects/:id/env',
    ]) {
      expect(seen).toContain(expected);
    }
    expect(routes.every((r) => !r.public)).toBe(true);
  });

  it('registers the chat question routes and keeps them non-public', async () => {
    app = makeApp().app;
    await app.ready();
    const seen = app.registeredRoutes
      .filter((r) => r.url.includes('/questions'))
      .map((r) => ({ route: `${r.method} ${r.url}`, public: r.public }));
    expect(seen).toEqual(
      expect.arrayContaining([
        { route: 'GET /api/chats/:id/questions', public: false },
        { route: 'POST /api/chats/:id/questions/:qid/answer', public: false },
      ]),
    );
    expect(seen.every((r) => !r.public)).toBe(true);
  });

  it('only health is public for now, and unknown paths are rejected too', async () => {
    app = makeApp().app;
    await app.ready();
    const publicRoutes = app.registeredRoutes.filter((r) => r.public).map((r) => r.url);
    // GET /api/health also registers HEAD, hence the Set.
    expect([...new Set(publicRoutes)].sort()).toEqual([
      '/api/auth/login',
      '/api/auth/totp',
      '/api/health',
    ]);
    // The allowlist stays closed: nothing from the projects API is public.
    expect(publicRoutes.filter((url) => url.startsWith('/api/projects'))).toEqual([]);
    expect((await app.inject({ url: '/api/health' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/nope' })).statusCode).toBe(401);
  });
});

describe('sessions', () => {
  async function setup(now: () => number) {
    const made = makeApp({}, now);
    app = made.app;
    await app.ready();
    const users = new UserRepository(made.db);
    const user = await users.create('alice', PASSWORD);
    const sessions = new SessionService(
      made.db,
      { idleTtlSeconds: 1800, absoluteTtlSeconds: 43200 },
      now,
    );
    return { db: made.db, user, sessions };
  }

  it('stores only the SHA-256 of the token, never the token', async () => {
    const { db, user, sessions } = await setup(() => 1_000);
    const { token } = sessions.create(user.id);
    const rows = db.prepare('SELECT token_hash FROM sessions').all();
    expect(rows).toEqual([{ token_hash: hashToken(token) }]);
    expect(JSON.stringify(db.prepare('SELECT * FROM sessions').all())).not.toContain(token);
  });

  it('accepts a valid cookie on /api/auth/me', async () => {
    const { user, sessions } = await setup(() => 1_000);
    const { token, csrfToken } = sessions.create(user.id);
    const res = await server().inject({
      url: '/api/auth/me',
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: { id: user.id, username: 'alice' }, csrfToken });
  });

  it('expires by inactivity and deletes the row', async () => {
    let t = 1_000;
    const { db, user, sessions } = await setup(() => t);
    const { token } = sessions.create(user.id);
    t += 1801 * 1000;
    const res = await server().inject({
      url: '/api/auth/me',
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });

  it('expires at the absolute lifetime even if kept active', async () => {
    let t = 1_000;
    const { db, user, sessions } = await setup(() => t);
    const { token } = sessions.create(user.id);
    const headers = { cookie: `${SESSION_COOKIE}=${token}` };
    for (let i = 0; i < 40; i++) {
      t += 1700 * 1000;
      const res = await server().inject({ url: '/api/auth/me', headers });
      if (t - 1_000 > 43200 * 1000) {
        expect(res.statusCode).toBe(401);
        break;
      }
      expect(res.statusCode).toBe(200);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });

  it('logout invalidates the session and clears the cookie', async () => {
    const { db, user, sessions } = await setup(() => 1_000);
    const { token, csrfToken } = sessions.create(user.id);
    const headers = { cookie: `${SESSION_COOKIE}=${token}` };
    const res = await server().inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { ...headers, origin: ORIGIN, 'x-csrf-token': csrfToken },
    });
    expect(res.statusCode).toBe(200);
    const cleared = String(res.headers['set-cookie']);
    expect(cleared).toContain(`${SESSION_COOKIE}=;`);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    expect((await server().inject({ url: '/api/auth/me', headers })).statusCode).toBe(401);
  });
});

describe('cookie attributes', () => {
  it('sets HttpOnly, Secure, SameSite=Strict, Path=/ and the __Host- prefix on logout/clear', async () => {
    const made = makeApp();
    app = made.app;
    await app.ready();
    const user = await new UserRepository(made.db).create('bob', PASSWORD);
    const { token, csrfToken } = new SessionService(made.db, {
      idleTtlSeconds: 1800,
      absoluteTtlSeconds: 43200,
    }).create(user.id);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: `${SESSION_COOKIE}=${token}`, origin: ORIGIN, 'x-csrf-token': csrfToken },
    });
    const header = String(res.headers['set-cookie']);
    expect(header.startsWith('__Host-panel_session=')).toBe(true);
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) {
      expect(header).toContain(attr);
    }
    expect(header).not.toContain('Domain');
  });
});
