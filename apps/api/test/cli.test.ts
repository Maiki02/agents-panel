import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MFA_COOKIE } from '../src/auth/challenge.js';
import { generateTotpCode } from '../src/auth/totp.js';
import { UserRepository } from '../src/auth/users.js';
import { CliError, runCli, type CliIo } from '../src/cli/commands.js';
import { ORIGIN, PASSWORD, TEST_ENV, cookieHeader, makeApp } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
});

/** Scripted I/O: answers are consumed in order; the TOTP answer is computed from the printed URI. */
function scriptedIo(answers: string[], now: () => number) {
  const lines: string[] = [];
  let secret = '';
  const io: CliIo = {
    prompt: (question) => {
      if (question.startsWith('Enter the 6-digit')) {
        return Promise.resolve(generateTotpCode(secret, now()));
      }
      const next = answers.shift();
      if (next === undefined) throw new Error(`no scripted answer for: ${question}`);
      return Promise.resolve(next);
    },
    print: (line) => {
      lines.push(line);
      const match = /secret=([A-Z2-7]+)/.exec(line);
      if (match?.[1]) secret = match[1];
    },
    qr: () => undefined,
  };
  return { io, lines, secret: () => secret };
}

const TIMINGS = { idleTtlSeconds: 1800, absoluteTtlSeconds: 43200 };
const SECRET = Buffer.from(TEST_ENV.PANEL_SECRET_KEY);

describe('CLI', () => {
  it('user:create produces a user that can complete the full web login', async () => {
    const state = { t: 1_700_000_000_000 };
    const made = makeApp({}, () => state.t);
    app = made.app;
    await app.ready();
    const script = scriptedIo([PASSWORD, PASSWORD], () => state.t);
    await runCli(['user:create', 'carol'], script.io, {
      db: made.db,
      secretKey: SECRET,
      sessionTimings: TIMINGS,
      now: () => state.t,
    });
    const codes = script.lines.filter((l) => /^ {2}[0-9a-f]{5}-[0-9a-f]{5}$/.test(l));
    expect(codes).toHaveLength(10);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ORIGIN },
      payload: { username: 'carol', password: PASSWORD },
    });
    const mfa = cookieHeader(login.headers['set-cookie'], MFA_COOKIE);
    state.t += 30_000;
    const totp = await app.inject({
      method: 'POST',
      url: '/api/auth/totp',
      headers: { origin: ORIGIN, cookie: mfa },
      payload: { code: generateTotpCode(script.secret(), state.t) },
    });
    expect(totp.statusCode).toBe(200);
  });

  it('does not create the user when the confirmation code is wrong', async () => {
    const made = makeApp();
    app = made.app;
    const io: CliIo = {
      prompt: (q) => Promise.resolve(q.startsWith('Enter') ? '000000' : PASSWORD),
      print: () => undefined,
      qr: () => undefined,
    };
    await expect(
      runCli(['user:create', 'dave'], io, {
        db: made.db,
        secretKey: SECRET,
        sessionTimings: TIMINGS,
      }),
    ).rejects.toBeInstanceOf(CliError);
    expect(new UserRepository(made.db).findByUsername('dave')).toBeUndefined();
    expect(made.db.prepare('SELECT COUNT(*) AS n FROM user_totp').get()).toEqual({ n: 0 });
  });

  it('rejects short passwords and mismatched repeats', async () => {
    const made = makeApp();
    app = made.app;
    const deps = { db: made.db, secretKey: SECRET, sessionTimings: TIMINGS };
    const short = scriptedIo(['too-short'], Date.now);
    await expect(runCli(['user:create', 'erin'], short.io, deps)).rejects.toBeInstanceOf(CliError);
    const mismatch = scriptedIo([PASSWORD, `${PASSWORD}x`], Date.now);
    await expect(runCli(['user:create', 'erin'], mismatch.io, deps)).rejects.toBeInstanceOf(
      CliError,
    );
  });

  it('user:unlock clears the lock from failed logins', async () => {
    const made = makeApp();
    app = made.app;
    await app.ready();
    const users = new UserRepository(made.db);
    const user = await users.create('frank', PASSWORD);
    for (let i = 0; i < 5; i++) users.registerFailure(user.id, Date.now(), 5, 900_000);
    const locked = users.findById(user.id);
    expect(locked && users.isLocked(locked, Date.now())).toBe(true);
    const out = scriptedIo([], Date.now);
    await runCli(['user:unlock', 'frank'], out.io, {
      db: made.db,
      secretKey: SECRET,
      sessionTimings: TIMINGS,
    });
    const after = users.findById(user.id);
    expect(after && users.isLocked(after, Date.now())).toBe(false);
    expect(after?.failedAttempts).toBe(0);
  });
});

describe('no web route manages users', () => {
  it('registers no route that creates or edits users (only auth steps and chat actions mutate)', async () => {
    const made = makeApp();
    app = made.app;
    await app.ready();
    const unsafe = app.registeredRoutes
      .filter((r) => !['GET', 'HEAD', 'OPTIONS'].includes(r.method))
      .map((r) => r.url);
    expect(unsafe.sort()).toEqual([
      '/api/auth/login',
      '/api/auth/logout',
      '/api/auth/totp',
      '/api/chats',
      '/api/chats/:id/cancel',
      '/api/chats/:id/messages',
    ]);
    for (const route of app.registeredRoutes) {
      expect(route.url).not.toMatch(/user|register|signup|password/i);
    }
  });
});
