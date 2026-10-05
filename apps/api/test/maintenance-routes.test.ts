import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Chat, MaintenanceRun } from '@agents-panel/shared';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { SecondFactorRepository, generateTotpCode, generateTotpSecret } from '../src/auth/totp.js';
import { UserRepository } from '../src/auth/users.js';
import { openDatabase } from '../src/db/index.js';
import { MaintenanceRunRepository } from '../src/maintenance/runs.js';
import type { ScriptResult, ScriptRunner } from '../src/maintenance/updater.js';
import { KyroVersions, type Exec } from '../src/maintenance/versions.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { FakeRunner } from './fake-runner.js';
import { ORIGIN, PASSWORD, TEST_ENV, makeApp, makeKyroRepo, mutatingHeaders } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
});

const PERIOD_MS = 30_000;
const UPDATE_URL = '/api/versions/kyro/update';

async function setup(
  options: { latest?: string | null; script?: ScriptRunner; agent?: FakeRunner } = {},
) {
  const state = { t: 1_700_000_000_000 };
  const exec: Exec = (file) => {
    if (file === 'kyro') return Promise.resolve('6.1.0\n');
    return options.latest === null
      ? Promise.reject(new Error('ENOTFOUND'))
      : Promise.resolve(`${options.latest ?? '6.2.0'}\n`);
  };
  const script = vi.fn<ScriptRunner>(
    options.script ?? (() => Promise.resolve({ exitCode: 0, output: 'ok' })),
  );
  const made = makeApp({}, () => state.t, {
    kyroVersions: new KyroVersions(exec),
    kyroScriptRunner: script,
    ...(options.agent ? { runner: options.agent } : {}),
  });
  app = made.app;
  await app.ready();
  const server = app;

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
  const update = (payload: Record<string, unknown>) =>
    server.inject({ method: 'POST', url: UPDATE_URL, headers, payload });
  const versions = () => server.inject({ url: '/api/versions', headers });
  const runs = () => server.inject({ url: '/api/maintenance-runs?kind=kyro-update', headers });
  const rows = () => made.db.prepare('SELECT * FROM maintenance_runs').all();
  const waitFinished = () =>
    vi.waitFor(async () => {
      const list = (await runs()).json<MaintenanceRun[]>();
      expect(list.every((run) => run.status !== 'running')).toBe(true);
    });
  return {
    state,
    server,
    db: made.db,
    headers,
    totp,
    update,
    versions,
    runs,
    rows,
    script,
    waitFinished,
  };
}

describe('GET /api/versions', () => {
  it('returns the installed and the latest version', async () => {
    const { versions } = await setup();
    const res = await versions();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      kyro: { installed: '6.1.0', latest: '6.2.0', updateRunning: false },
    });
  });

  it('returns latest null without network, and the update is still accepted', async () => {
    const { versions, update, totp, waitFinished } = await setup({ latest: null });
    expect((await versions()).json()).toEqual({
      kyro: { installed: '6.1.0', latest: null, updateRunning: false },
    });
    const res = await update({ code: totp() });
    expect(res.statusCode).toBe(202);
    await waitFinished();
  });
});

describe('POST /api/versions/kyro/update', () => {
  it('answers 202 with the run id; the run is listed first with its versions and output', async () => {
    const { update, totp, runs, script, waitFinished } = await setup({
      script: () => Promise.resolve({ exitCode: 0, output: 'listo\nKYRO_VERSION=6.1.0\n' }),
    });
    const res = await update({ code: totp() });
    expect(res.statusCode).toBe(202);
    const { runId } = res.json<{ runId: number }>();
    await waitFinished();
    const list = (await runs()).json<MaintenanceRun[]>();
    expect(list[0]).toMatchObject({
      id: runId,
      kind: 'kyro-update',
      status: 'ok',
      fromVersion: '6.1.0',
      toVersion: '6.1.0',
    });
    expect(list[0]?.output).toContain('listo');
    expect(script).toHaveBeenCalledTimes(1);
  });

  it('records a failing script as an error run', async () => {
    const { update, totp, runs, waitFinished } = await setup({
      script: () => Promise.resolve({ exitCode: 1, output: 'npm ERR!' }),
    });
    expect((await update({ code: totp() })).statusCode).toBe(202);
    await waitFinished();
    expect((await runs()).json<MaintenanceRun[]>()[0]).toMatchObject({
      status: 'error',
      output: 'npm ERR!',
    });
  });

  it.each([
    ['no code', {}],
    ['a wrong code', { code: '000000' }],
    ['a malformed code', { code: 'abc' }],
  ])('answers 401 invalid_totp with %s and runs nothing', async (_label, payload) => {
    const { update, rows, script } = await setup();
    const res = await update(payload);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_totp' });
    expect(rows()).toEqual([]);
    expect(script).not.toHaveBeenCalled();
  });

  it('rejects a code that was already used', async () => {
    const { update, totp, rows, script, waitFinished } = await setup();
    const code = totp();
    expect((await update({ code })).statusCode).toBe(202);
    await waitFinished();
    const again = await update({ code });
    expect(again.statusCode).toBe(401);
    expect(again.json()).toEqual({ error: 'invalid_totp' });
    expect(rows()).toHaveLength(1);
    expect(script).toHaveBeenCalledTimes(1);
  });

  it('refuses unknown fields', async () => {
    const { update, totp, rows } = await setup();
    const res = await update({ code: totp(), script: '/bin/evil' });
    expect(res.statusCode).toBe(400);
    expect(rows()).toEqual([]);
  });

  it('answers 409 with the running count when a session is running, creating nothing', async () => {
    const agent = new FakeRunner();
    let release: () => void = () => undefined;
    agent.gate = new Promise((resolve) => {
      release = resolve;
    });
    const { server, db, headers, update, totp, rows, script } = await setup({ agent });
    const project = await new ProjectRepository(db).add({
      name: 'demo',
      repoPath: makeKyroRepo(),
      baseBranch: 'main',
    });
    const chat = await server.inject({
      method: 'POST',
      url: '/api/chats',
      headers,
      payload: { projectId: project.id, kind: 'work', slug: 'busy', prompt: 'x' },
    });
    expect(chat.statusCode).toBe(201);

    const res = await update({ code: totp() });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ running: 1 });
    expect(rows()).toEqual([]);
    expect(script).not.toHaveBeenCalled();

    release();
    await vi.waitFor(async () => {
      const got = await server.inject({
        url: `/api/chats/${String(chat.json<Chat>().id)}`,
        headers,
      });
      expect(got.json<Chat>().status).not.toBe('running');
    });
  });

  it('blocks chats and a second update while running, then frees everything', async () => {
    let finish: (r: ScriptResult) => void = () => undefined;
    const { server, db, headers, update, totp, rows, versions, waitFinished } = await setup({
      script: () =>
        new Promise<ScriptResult>((resolve) => {
          finish = resolve;
        }),
    });
    const project = await new ProjectRepository(db).add({
      name: 'demo',
      repoPath: makeKyroRepo(),
      baseBranch: 'main',
    });
    expect((await update({ code: totp() })).statusCode).toBe(202);
    expect((await versions()).json()).toMatchObject({ kyro: { updateRunning: true } });

    const second = await update({ code: totp() });
    expect(second.statusCode).toBe(409);
    expect(rows()).toHaveLength(1);
    const chat = await server.inject({
      method: 'POST',
      url: '/api/chats',
      headers,
      payload: { projectId: project.id, kind: 'work', slug: 'late', prompt: 'x' },
    });
    expect(chat.statusCode).toBe(409);

    finish({ exitCode: 0, output: 'ok' });
    await waitFinished();
    expect((await versions()).json()).toMatchObject({ kyro: { updateRunning: false } });
  });
});

describe('maintenance routes without a session', () => {
  it('answer 401 and stay out of the public allowlist', async () => {
    await setup();
    if (!app) throw new Error('app not built');
    const server = app;
    const targets = [
      { method: 'GET', url: '/api/versions' },
      { method: 'POST', url: UPDATE_URL },
      { method: 'GET', url: '/api/maintenance-runs' },
    ] as const;
    for (const target of targets) {
      const res = await server.inject({ ...target, headers: { origin: ORIGIN } });
      expect(res.statusCode, `${target.method} ${target.url}`).toBe(401);
    }
    const seen = server.registeredRoutes.filter(
      (r) => r.url.startsWith('/api/versions') || r.url === '/api/maintenance-runs',
    );
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.every((r) => !r.public)).toBe(true);
  });
});

describe('startup recovery', () => {
  it('turns a run left running into an error "interrumpido" and allows a new one', async () => {
    const db = openDatabase(':memory:');
    const stuck = new MaintenanceRunRepository(db).create('6.0.2');
    const made = makeApp({}, undefined, {
      db,
      kyroScriptRunner: () => Promise.resolve({ exitCode: 0, output: 'ok' }),
    });
    app = made.app;
    await app.ready();
    expect(new MaintenanceRunRepository(db).findById(stuck.id)).toMatchObject({
      status: 'error',
      output: 'interrumpido',
    });
  });
});
