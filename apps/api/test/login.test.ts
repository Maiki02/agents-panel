import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MFA_COOKIE } from '../src/auth/challenge.js';
import { UserRepository } from '../src/auth/users.js';
import { ORIGIN, makeApp } from './helpers.js';

const PASSWORD = 'correct horse battery staple';
let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
});

async function setup(now?: () => number) {
  const made = makeApp({}, now);
  app = made.app;
  await app.ready();
  await new UserRepository(made.db).create('alice', PASSWORD);
  const server = app;
  const login = (username: string, password: string) =>
    server.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ORIGIN },
      payload: { username, password },
    });
  return { db: made.db, server, login };
}

describe('POST /api/auth/login', () => {
  it('with the right password sets only the MFA challenge, not a session', async () => {
    const { server, login } = await setup();
    const res = await login('alice', PASSWORD);
    expect(res.statusCode).toBe(200);
    const cookies = String(res.headers['set-cookie']);
    expect(cookies).toContain(`${MFA_COOKIE}=`);
    expect(cookies).not.toContain('__Host-panel_session');
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) {
      expect(cookies).toContain(attr);
    }
    expect((await server.inject({ url: '/api/auth/me' })).statusCode).toBe(401);
  });

  it('answers unknown users and wrong passwords identically', async () => {
    const { login } = await setup();
    const unknown = await login('nobody', PASSWORD);
    const wrong = await login('alice', 'wrong password here!!');
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.body).toBe(wrong.body);
  });

  it('locks the account after 5 failures even for the correct password', async () => {
    const { db, login } = await setup();
    for (let i = 0; i < 5; i++) {
      expect((await login('alice', 'wrong password here!!')).statusCode).toBe(401);
    }
    const sixth = await login('alice', PASSWORD);
    expect(sixth.statusCode).toBe(401);
    expect(String(sixth.headers['set-cookie'] ?? '')).not.toContain(MFA_COOKIE);
    const last = db.prepare('SELECT reason FROM login_attempts ORDER BY id DESC LIMIT 1').get();
    expect(last).toEqual({ reason: 'locked' });
  });

  it('unlocks after the lock window passes', async () => {
    let t = 1_000_000;
    const { login } = await setup(() => t);
    for (let i = 0; i < 5; i++) await login('alice', 'wrong password here!!');
    expect((await login('alice', PASSWORD)).statusCode).toBe(401);
    t += 15 * 60 * 1000 + 1;
    expect((await login('alice', PASSWORD)).statusCode).toBe(200);
  });

  it('records every attempt with its outcome', async () => {
    const { db, login } = await setup();
    await login('alice', PASSWORD);
    await login('alice', 'wrong password here!!');
    await login('nobody', PASSWORD);
    const rows = db
      .prepare('SELECT username, success, reason, step, ip FROM login_attempts ORDER BY id')
      .all();
    expect(rows).toEqual([
      { username: 'alice', success: 1, reason: null, step: 'password', ip: '127.0.0.1' },
      { username: 'alice', success: 0, reason: 'bad_password', step: 'password', ip: '127.0.0.1' },
      { username: 'nobody', success: 0, reason: 'unknown_user', step: 'password', ip: '127.0.0.1' },
    ]);
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
  });

  it('returns 429 beyond 10 requests per minute from one IP', async () => {
    const { login } = await setup();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++)
      codes.push((await login('nobody', 'whatever password')).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});
