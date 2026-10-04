import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { LoginAudit } from '../src/auth/attempts.js';
import { ReauthVerifier } from '../src/auth/reauth.js';
import { MAX_FAILED_ATTEMPTS } from '../src/auth/routes.js';
import { SecondFactorRepository, generateTotpCode, generateTotpSecret } from '../src/auth/totp.js';
import { UserRepository } from '../src/auth/users.js';
import { openDatabase } from '../src/db/index.js';
import { PASSWORD, TEST_ENV } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
});

const PERIOD_MS = 30_000;

async function setup(startMs = 1_700_000_000_000) {
  const state = { t: startMs };
  const now = () => state.t;
  const db = openDatabase(':memory:');
  const users = new UserRepository(db);
  const user = await users.create('alice', PASSWORD);
  const secondFactor = new SecondFactorRepository(db, Buffer.from(TEST_ENV.PANEL_SECRET_KEY), now);
  const secret = generateTotpSecret();
  secondFactor.setTotpSecret(user.id, secret);
  const recovery = secondFactor.regenerateRecoveryCodes(user.id);
  const verifier = new ReauthVerifier({ users, secondFactor, audit: new LoginAudit(db, now), now });

  const server = Fastify();
  app = server;
  server.decorateRequest('session', null);
  server.addHook('onRequest', (request, _reply, done) => {
    request.session = { id: 1, userId: user.id, csrfToken: 'csrf' };
    done();
  });
  server.post<{ Body: { totp?: unknown } | undefined }>('/act', (request, reply) => {
    if (!verifier.verify(request, reply, request.body?.totp)) return reply;
    return { ok: true };
  });
  await server.ready();

  const act = (totp?: unknown) =>
    server.inject({
      method: 'POST',
      url: '/act',
      payload: totp === undefined ? {} : { totp },
    });
  const code = () => generateTotpCode(secret, state.t);
  const attempts = () =>
    db.prepare('SELECT username, success, reason, step FROM login_attempts ORDER BY id').all() as {
      username: string;
      success: number;
      reason: string | null;
      step: string;
    }[];
  const failedCount = () => users.findById(user.id)?.failedAttempts;
  return { state, act, code, recovery, attempts, failedCount, db };
}

describe('ReauthVerifier', () => {
  it('accepts a fresh TOTP, clears failures and audits the success', async () => {
    const { act, code, attempts, failedCount } = await setup();
    await act('000000');
    expect(failedCount()).toBe(1);

    const res = await act(code());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(failedCount()).toBe(0);
    expect(attempts().at(-1)).toEqual({
      username: 'alice',
      success: 1,
      reason: null,
      step: 'reauth',
    });
  });

  it.each([
    ['missing', undefined, 'missing_code'],
    ['empty', '', 'missing_code'],
    ['not a string', 123456, 'missing_code'],
    ['malformed', '12345a', 'bad_format'],
    ['too long', '1234567', 'bad_format'],
    ['wrong', '000000', 'bad_code'],
  ])(
    'rejects a %s code with 401 invalid_totp and counts the failure',
    async (_label, totp, reason) => {
      const { act, attempts, failedCount } = await setup();
      const res = await act(totp);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'invalid_totp' });
      expect(failedCount()).toBe(1);
      expect(attempts()).toEqual([{ username: 'alice', success: 0, reason, step: 'reauth' }]);
    },
  );

  it('rejects the same code twice in the same time step', async () => {
    const { act, code, attempts } = await setup();
    const used = code();
    expect((await act(used)).statusCode).toBe(200);
    const again = await act(used);
    expect(again.statusCode).toBe(401);
    expect(again.json()).toEqual({ error: 'invalid_totp' });
    expect(attempts().at(-1)?.reason).toBe('bad_code');
  });

  it('does not accept recovery codes', async () => {
    const { act, recovery, attempts } = await setup();
    const res = await act(recovery[0]);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_totp' });
    expect(attempts()[0]?.reason).toBe('bad_format');
  });

  it('locks the user on the fifth failure; a valid code is refused while locked', async () => {
    const { state, act, code, attempts } = await setup();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await act('000000');

    const locked = await act(code());
    expect(locked.statusCode).toBe(401);
    expect(locked.json()).toEqual({ error: 'invalid_totp' });
    expect(attempts().at(-1)?.reason).toBe('locked');

    state.t += 16 * 60 * 1000 + PERIOD_MS;
    expect((await act(code())).statusCode).toBe(200);
  });

  it('never stores the code in login_attempts', async () => {
    const { act, code, db } = await setup();
    const valid = code();
    await act('987654');
    await act(valid);
    // Every text column (`at` is a timestamp and could contain the digits by chance).
    const dump = JSON.stringify(
      db.prepare('SELECT username, ip, reason, user_agent, step FROM login_attempts').all(),
    );
    expect(dump).not.toContain('987654');
    expect(dump).not.toContain(valid);
  });
});
