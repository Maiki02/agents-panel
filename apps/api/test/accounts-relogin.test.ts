import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ClaudeAccount } from '@agents-panel/shared';
import type { ReloginProcess, ReloginSpawner } from '../src/accounts/relogin.js';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { SecondFactorRepository, generateTotpCode, generateTotpSecret } from '../src/auth/totp.js';
import { UserRepository } from '../src/auth/users.js';
import { PASSWORD, TEST_ENV, makeApp, mutatingHeaders } from './helpers.js';

const dirs: string[] = [];
let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PERIOD_MS = 30_000;
const LINK = 'https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz';
const CODE = 'AbCd1234-efGh5678#state9';

/** The login process of the tests: it says what the real one would and obeys the test. */
class FakeProcess implements ReloginProcess {
  killed = false;
  written: string[] = [];
  /** Reacts to what the panel types (for example: write the credentials and exit 0). */
  onWrite: ((text: string) => void) | undefined;
  private readonly outputs: ((text: string) => void)[] = [];
  private readonly exits: ((code: number | null) => void)[] = [];
  onOutput(listener: (text: string) => void): void {
    this.outputs.push(listener);
  }
  onExit(listener: (code: number | null) => void): void {
    this.exits.push(listener);
  }
  write(text: string): void {
    this.written.push(text);
    this.onWrite?.(text);
  }
  kill(): void {
    this.killed = true;
    this.exit(null);
  }
  emit(text: string): void {
    for (const listener of this.outputs) listener(text);
  }
  exit(code: number | null): void {
    for (const listener of this.exits) listener(code);
  }
}

async function boot(options: { banner?: string | null; startMs?: number; finishMs?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'panel-relogin-'));
  dirs.push(home);
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', '.credentials.json'), '{"old":true}');
  mkdirSync(join(home, '.claude2'));
  writeFileSync(join(home, '.claude2', '.credentials.json'), '{"old":true}');

  const spawned: { env: Record<string, string>; proc: FakeProcess }[] = [];
  const banner =
    options.banner === undefined
      ? `\u001b[1mOpening browser\u001b[0m\nVisit https://example.com/help\nIf it did not open, use:\n${LINK}\nPaste code here > `
      : options.banner;
  const spawner: ReloginSpawner = (env) => {
    const proc = new FakeProcess();
    spawned.push({ env, proc });
    if (banner !== null) {
      setTimeout(() => {
        proc.emit(banner);
      }, 0);
    }
    return proc;
  };

  const state = { t: 1_700_000_000_000 };
  const made = makeApp({}, () => state.t, {
    accountsHome: home,
    reloginSpawner: spawner,
    reloginTimings: { startMs: options.startMs ?? 2000, finishMs: options.finishMs ?? 2000 },
  });
  app = made.app;
  await made.app.ready();
  const user = await new UserRepository(made.db).create('alice', PASSWORD);
  const secret = generateTotpSecret();
  new SecondFactorRepository(made.db, Buffer.from(TEST_ENV.PANEL_SECRET_KEY)).setTotpSecret(
    user.id,
    secret,
  );
  const { token, csrfToken } = new SessionService(
    made.db,
    { idleTtlSeconds: 1800, absoluteTtlSeconds: 43200 },
    () => state.t,
  ).create(user.id);
  const headers = mutatingHeaders(`${SESSION_COOKIE}=${token}`, csrfToken);
  const totp = () => {
    state.t += PERIOD_MS;
    return generateTotpCode(secret, state.t);
  };
  const server = made.app;
  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
    server.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  /** `null` sends no TOTP at all. */
  const start = (id: number, code: string | null = totp()) =>
    call('POST', `/api/accounts/${String(id)}/relogin`, code === null ? {} : { totp: code });
  const submit = (id: number, code: string) =>
    call('POST', `/api/accounts/${String(id)}/relogin/code`, { code });
  // Account 2 is the second login (~/.claude2).
  const added = await call('POST', '/api/accounts', {
    name: 'segunda',
    configDir: join(home, '.claude2'),
  });
  const second = added.json<ClaudeAccount>();
  return { home, spawned, call, start, submit, second, headers, totp };
}

describe('POST /api/accounts/:id/relogin', () => {
  it('needs a fresh TOTP and launches nothing without it', async () => {
    const { start, spawned } = await boot();
    expect((await start(1, null)).statusCode).toBe(400);
    expect((await start(1, '000000')).statusCode).toBe(401);
    expect(spawned).toHaveLength(0);
  });

  it('answers 401 without a session', async () => {
    const { spawned } = await boot();
    const res = await app?.inject({
      method: 'POST',
      url: '/api/accounts/1/relogin',
      headers: { origin: 'http://localhost:4200' },
      payload: { totp: '123456' },
    });
    expect(res?.statusCode).toBe(401);
    expect(spawned).toHaveLength(0);
  });

  it('returns the Claude link (ANSI stripped, other links ignored) and keeps the flow open', async () => {
    const { start, spawned } = await boot();
    const res = await start(1);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: LINK });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.proc.killed).toBe(false);
  });

  it('runs with the CLAUDE_CONFIG_DIR of the account, none for the main one, and no panel secrets', async () => {
    const { start, spawned, second, home } = await boot();
    await start(1);
    await start(second.id);
    expect(spawned[0]?.env['CLAUDE_CONFIG_DIR']).toBeUndefined();
    expect(spawned[1]?.env['CLAUDE_CONFIG_DIR']).toBe(join(home, '.claude2'));
    for (const { env } of spawned) {
      expect(
        Object.keys(env).every((key) =>
          /^(PATH|HOME|LANG|LC_ALL|TMPDIR|NO_COLOR|TERM|CLAUDE_CONFIG_DIR)$/.test(key),
        ),
      ).toBe(true);
      expect(JSON.stringify(env)).not.toContain(TEST_ENV.PANEL_SECRET_KEY);
    }
  });

  it('refuses a second flow for the same account with 409', async () => {
    const { start, spawned } = await boot();
    expect((await start(1)).statusCode).toBe(200);
    const again = await start(1);
    expect(again.statusCode).toBe(409);
    expect(spawned).toHaveLength(1);
  });

  it('answers 404 for an account that does not exist', async () => {
    const { start, spawned } = await boot();
    expect((await start(999)).statusCode).toBe(404);
    expect(spawned).toHaveLength(0);
  });

  it('answers 502 and stops the process when no link comes in time', async () => {
    const { start, spawned } = await boot({ banner: null, startMs: 50 });
    const res = await start(1);
    expect(res.statusCode).toBe(502);
    expect(spawned[0]?.proc.killed).toBe(true);
    // The flow is gone: a new start launches again.
    expect((await start(1)).statusCode).toBe(502);
    expect(spawned).toHaveLength(2);
  });

  it('does not hand out a link that is not from Claude or Anthropic', async () => {
    const { start, spawned } = await boot({
      banner: 'Open https://evil.example.com/steal then wait',
      startMs: 50,
    });
    expect((await start(1)).statusCode).toBe(502);
    expect(spawned[0]?.proc.killed).toBe(true);
  });

  it('answers 502 when the process ends before giving a link', async () => {
    const { start, spawned } = await boot({ banner: null });
    const pending = start(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    spawned[0]?.proc.exit(1);
    expect((await pending).statusCode).toBe(502);
  });
});

describe('POST /api/accounts/:id/relogin/code', () => {
  /** The process accepts the code: it rewrites the credentials and exits 0. */
  function accepting(home: string, spawned: { proc: FakeProcess }[], dir = '.claude') {
    const proc = spawned[spawned.length - 1]?.proc;
    if (!proc) throw new Error('no process');
    proc.onWrite = () => {
      writeFileSync(join(home, dir, '.credentials.json'), '{"new":true}');
      setTimeout(() => {
        proc.exit(0);
      }, 5);
    };
    return proc;
  }

  it('types the code, waits for Claude and returns the account', async () => {
    const { start, submit, spawned, home } = await boot();
    await start(1);
    const proc = accepting(home, spawned);
    const res = await submit(1, `  ${CODE}  `);
    expect(res.statusCode).toBe(200);
    expect(res.json<ClaudeAccount>()).toMatchObject({ id: 1, loggedIn: true });
    expect(proc.written).toEqual([`${CODE}\n`]);
    // The flow is over: the same account can start another one.
    expect((await start(1)).statusCode).toBe(200);
  });

  it('works for a second account (its own directory)', async () => {
    const { start, submit, spawned, home, second } = await boot();
    await start(second.id);
    accepting(home, spawned, '.claude2');
    const res = await submit(second.id, CODE);
    expect(res.statusCode).toBe(200);
    expect(res.json<ClaudeAccount>()).toMatchObject({ id: second.id, loggedIn: true });
  });

  it('answers 404 without a flow and 409 before the link is out', async () => {
    const { submit, start, spawned } = await boot({ banner: null, startMs: 300 });
    expect((await submit(1, CODE)).statusCode).toBe(404);
    const pending = start(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await submit(1, CODE)).statusCode).toBe(409);
    spawned[0]?.proc.emit(LINK);
    expect((await pending).statusCode).toBe(200);
  });

  it('refuses a code with a strange format and keeps the flow to try again', async () => {
    const { start, submit, spawned, home } = await boot();
    await start(1);
    const proc = spawned[0]?.proc;
    expect((await submit(1, 'short')).statusCode).toBe(400);
    expect((await submit(1, 'has spaces inside the code')).statusCode).toBe(400);
    expect((await submit(1, 'semi;colon&&rm -rf /')).statusCode).toBe(400);
    expect(proc?.written).toEqual([]);
    accepting(home, spawned);
    expect((await submit(1, CODE)).statusCode).toBe(200);
  });

  it('answers 400 when Claude rejects the code, without echoing it, and ends the flow', async () => {
    const { start, submit, spawned } = await boot();
    await start(1);
    const proc = spawned[0]?.proc;
    if (!proc) throw new Error('no process');
    proc.onWrite = () => {
      setTimeout(() => {
        proc.exit(1);
      }, 5);
    };
    const res = await submit(1, CODE);
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(CODE);
    expect((await start(1)).statusCode).toBe(200);
  });

  it('does not count a login that left the old credentials untouched', async () => {
    const { start, submit, spawned, home } = await boot();
    await start(1);
    const file = join(home, '.claude', '.credentials.json');
    utimesSync(file, new Date(2000, 0, 1), new Date(2000, 0, 1));
    const proc = spawned[0]?.proc;
    if (!proc) throw new Error('no process');
    proc.onWrite = () => {
      setTimeout(() => {
        proc.exit(0);
      }, 5);
    };
    expect(statSync(file).mtimeMs).toBeLessThan(Date.now() - 86_400_000);
    const res = await submit(1, CODE);
    expect(res.statusCode).toBe(400);
  });

  it('answers 502 when Claude does not confirm in time, and stops the process', async () => {
    const { start, submit, spawned } = await boot({ finishMs: 50 });
    await start(1);
    const res = await submit(1, CODE);
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain(CODE);
    expect(spawned[0]?.proc.killed).toBe(true);
  });
});

describe('DELETE /api/accounts/:id/relogin', () => {
  it('cancels the flow and stops the process; it is safe when there is none', async () => {
    const { start, call, spawned } = await boot();
    expect((await call('DELETE', '/api/accounts/1/relogin')).statusCode).toBe(204);
    await start(1);
    expect((await call('DELETE', '/api/accounts/1/relogin')).statusCode).toBe(204);
    expect(spawned[0]?.proc.killed).toBe(true);
    expect((await start(1)).statusCode).toBe(200);
  });
});

describe('closing the server', () => {
  it('stops the login processes that are still open', async () => {
    const { start, spawned } = await boot();
    await start(1);
    await app?.close();
    app = undefined;
    expect(spawned[0]?.proc.killed).toBe(true);
  });
});
