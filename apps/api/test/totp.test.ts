import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SecondFactorRepository, generateTotpCode, generateTotpSecret } from '../src/auth/totp.js';
import { UserRepository } from '../src/auth/users.js';
import { MFA_COOKIE } from '../src/auth/challenge.js';
import { ORIGIN, TEST_ENV, PASSWORD, cookieHeader, makeApp } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
});

async function setup(startMs = 1_700_000_000_000) {
  const state = { t: startMs };
  const made = makeApp({}, () => state.t);
  app = made.app;
  await app.ready();
  const server = app;
  const user = await new UserRepository(made.db).create('alice', PASSWORD);
  const factor = new SecondFactorRepository(
    made.db,
    Buffer.from(TEST_ENV.PANEL_SECRET_KEY),
    () => state.t,
  );
  const secret = generateTotpSecret();
  factor.setTotpSecret(user.id, secret);
  const recovery = factor.regenerateRecoveryCodes(user.id);

  async function passwordStep() {
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ORIGIN },
      payload: { username: 'alice', password: PASSWORD },
    });
    return cookieHeader(res.headers['set-cookie'], MFA_COOKIE);
  }
  const submit = (code: string, cookie?: string) =>
    server.inject({
      method: 'POST',
      url: '/api/auth/totp',
      payload: { code },
      headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    });
  return { state, db: made.db, server, secret, recovery, passwordStep, submit };
}

describe('two-step login', () => {
  it('password + TOTP yields a session usable on /api/auth/me', async () => {
    const { state, server, secret, passwordStep, submit } = await setup();
    const mfa = await passwordStep();
    const res = await submit(generateTotpCode(secret, state.t), mfa);
    expect(res.statusCode).toBe(200);
    const session = cookieHeader(res.headers['set-cookie'], '__Host-panel_session');
    const header = String(res.headers['set-cookie']);
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) {
      expect(header).toContain(attr);
    }
    const me = await server.inject({ url: '/api/auth/me', headers: { cookie: session } });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ user: { username: string } }>().user.username).toBe('alice');
  });

  it('rejects the same code twice in the same time step', async () => {
    const { state, secret, passwordStep, submit } = await setup();
    const code = generateTotpCode(secret, state.t);
    expect((await submit(code, await passwordStep())).statusCode).toBe(200);
    expect((await submit(code, await passwordStep())).statusCode).toBe(401);
  });

  it('rejects a wrong code and counts it toward the lock', async () => {
    const { db, secret, state, passwordStep, submit } = await setup();
    const mfa = await passwordStep();
    for (let i = 0; i < 5; i++) expect((await submit('000000', mfa)).statusCode).toBe(401);
    const valid = await submit(generateTotpCode(secret, state.t), mfa);
    expect(valid.statusCode).toBe(401);
    expect(db.prepare('SELECT locked_until FROM users').get()?.['locked_until']).not.toBeNull();
  });

  it('accepts a recovery code exactly once', async () => {
    const { recovery, passwordStep, submit } = await setup();
    const code = recovery[0] ?? '';
    expect((await submit(code, await passwordStep())).statusCode).toBe(200);
    expect((await submit(code, await passwordStep())).statusCode).toBe(401);
  });

  it('stores neither the TOTP secret in base32 nor recovery codes in plaintext', async () => {
    const { db, secret, recovery } = await setup();
    const dump = JSON.stringify([
      db.prepare('SELECT * FROM user_totp').all(),
      db.prepare('SELECT * FROM recovery_codes').all(),
    ]);
    expect(dump).not.toContain(secret);
    for (const code of recovery) expect(dump).not.toContain(code);
  });

  it('answers 401 without a challenge cookie, with a forged one, or an expired one', async () => {
    const { state, secret, passwordStep, submit } = await setup();
    const code = generateTotpCode(secret, state.t);
    expect((await submit(code)).statusCode).toBe(401);
    expect((await submit(code, `${MFA_COOKIE}=forged.value`)).statusCode).toBe(401);
    const mfa = await passwordStep();
    state.t += 5 * 60 * 1000 + 1;
    expect((await submit(generateTotpCode(secret, state.t), mfa)).statusCode).toBe(401);
  });
});
