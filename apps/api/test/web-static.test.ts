import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import { makeApp } from './helpers.js';

function makeWeb(withIndex = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'panel-web-'));
  if (withIndex) writeFileSync(join(dir, 'index.html'), '<html>spa</html>');
  writeFileSync(join(dir, 'main-ABCD1234.js'), 'console.log(1)');
  writeFileSync(join(dir, 'favicon.ico'), 'ico');
  mkdirSync(join(dir, 'assets'));
  return dir;
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(webDir: string | undefined): Promise<FastifyInstance> {
  app = makeApp(webDir === undefined ? {} : { PANEL_WEB_DIR: webDir }).app;
  await app.ready();
  return app;
}

describe('web static', () => {
  it('serves index.html for / and for client routes, without a session', async () => {
    const a = await start(makeWeb());
    for (const url of ['/', '/projects/x', '/chats/3/timeline']) {
      const res = await a.inject({ url });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('<html>spa</html>');
      expect(res.headers['cache-control']).toBe('no-cache');
    }
  });

  it('serves hashed files with long cache and the others without it', async () => {
    const a = await start(makeWeb());
    const hashed = await a.inject({ url: '/main-ABCD1234.js' });
    expect(hashed.statusCode).toBe(200);
    expect(hashed.body).toBe('console.log(1)');
    expect(hashed.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const plain = await a.inject({ url: '/favicon.ico' });
    expect(plain.body).toBe('ico');
    expect(plain.headers['cache-control']).toBe('no-cache');
  });

  it('sends the security headers on the static files', async () => {
    const a = await start(makeWeb());
    const res = await a.inject({ url: '/main-ABCD1234.js' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
    // Scripts stay 'self' only; only styles may be inline (Angular component styles).
    expect(String(res.headers['content-security-policy'])).toContain(
      "style-src 'self' 'unsafe-inline'",
    );
    expect(String(res.headers['content-security-policy'])).not.toContain('script-src');
  });

  it('answers 401 without a session and 404 with one for an unknown /api path, never index.html', async () => {
    const a = await start(makeWeb());
    const anon = await a.inject({ url: '/api/no-existe' });
    expect(anon.statusCode).toBe(401);
    expect(anon.body).not.toContain('spa');
    expect((await a.inject({ url: '/api' })).statusCode).toBe(401);
  });

  it('answers 404 JSON, not index.html, for an unknown /api path with a session', async () => {
    const made = makeApp({ PANEL_WEB_DIR: makeWeb() });
    app = made.app;
    await app.ready();
    const user = await new UserRepository(made.db).create('alice', 'correct horse battery staple');
    const { token } = new SessionService(made.db, {
      idleTtlSeconds: 1800,
      absoluteTtlSeconds: 43200,
    }).create(user.id);
    const res = await app.inject({
      url: '/api/no-existe',
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('spa');
  });

  it('does not grow the public allowlist and does not let paths escape the folder', async () => {
    const a = await start(makeWeb());
    const publicRoutes = a.registeredRoutes.filter((r) => r.public).map((r) => r.url);
    expect([...new Set(publicRoutes)].sort()).toEqual([
      '/api/auth/login',
      '/api/auth/totp',
      '/api/health',
    ]);
    const escape = await a.inject({ url: '/..%2f..%2fetc/passwd' });
    expect(escape.body).toBe('<html>spa</html>');
    expect((await a.inject({ url: '/%E0%A4%A' })).statusCode).toBe(400);
  });

  it('starts and serves health without PANEL_WEB_DIR or with a folder without a build', async () => {
    for (const dir of [undefined, makeWeb(false)]) {
      const a = await start(dir);
      expect((await a.inject({ url: '/api/health' })).statusCode).toBe(200);
      expect((await a.inject({ url: '/' })).statusCode).toBe(401);
      await a.close();
      app = undefined;
    }
  });
});
