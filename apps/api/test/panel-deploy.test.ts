import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MaintenanceRun, PanelDeployInfo } from '@agents-panel/shared';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { SecondFactorRepository, generateTotpCode, generateTotpSecret } from '../src/auth/totp.js';
import { UserRepository } from '../src/auth/users.js';
import { ChatRepository } from '../src/chats/repo.js';
import { NOT_UNDER_SYSTEMD } from '../src/maintenance/deployer.js';
import type { ScriptRunner } from '../src/maintenance/updater.js';
import type { Exec } from '../src/maintenance/versions.js';
import { AutopilotRunRepository } from '../src/pilot/runs-repo.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { FakeRunner } from './fake-runner.js';
import { PASSWORD, TEST_ENV, makeApp, makeKyroRepo, mutatingHeaders } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const PERIOD_MS = 30_000;
const DEPLOY_URL = '/api/versions/panel/deploy';
const DONE = 'build ok\nDEPLOY_FROM=aaa1111\nDEPLOY_TO=bbb2222\nDEPLOY_RESTART=yes\n';

async function setup(
  options: {
    systemd?: boolean;
    script?: ScriptRunner;
    agent?: FakeRunner;
    behind?: string;
  } = {},
) {
  const state = { t: 1_700_000_000_000 };
  const gitCalls: string[][] = [];
  const exec: Exec = (file, args) => {
    if (file === 'kyro') return Promise.resolve('6.1.0\n');
    if (file === 'npm') return Promise.resolve('6.1.0\n');
    gitCalls.push(args);
    if (args.includes('rev-parse')) return Promise.resolve('aaa1111\n');
    if (args.includes('rev-list')) return Promise.resolve(`${options.behind ?? '3'}\n`);
    return Promise.resolve('');
  };
  const script = vi.fn<ScriptRunner>(
    options.script ?? (() => Promise.resolve({ exitCode: 0, output: DONE })),
  );
  const restart = vi.fn();
  const made = makeApp(options.systemd === false ? {} : { INVOCATION_ID: 'abc' }, () => state.t, {
    panelDeploy: { runner: script, exec, restart },
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
  const deploy = (payload: Record<string, unknown>) =>
    server.inject({ method: 'POST', url: DEPLOY_URL, headers, payload });
  const panel = async () =>
    (await server.inject({ url: '/api/versions', headers })).json<{ panel: PanelDeployInfo }>()
      .panel;
  const runs = async () =>
    (await server.inject({ url: '/api/maintenance-runs', headers })).json<MaintenanceRun[]>();
  const waitFinished = () =>
    vi.waitFor(async () => {
      expect((await runs()).every((run) => run.status !== 'running')).toBe(true);
    });
  return { db: made.db, deploy, panel, runs, totp, script, restart, waitFinished, gitCalls };
}

describe('GET /api/versions (panel)', () => {
  it('reports the running commit and how many commits of origin/main are not deployed', async () => {
    const { panel, gitCalls } = await setup();
    expect(await panel()).toEqual({
      commit: 'aaa1111',
      behind: 3,
      deployRunning: false,
      unavailableReason: null,
    });
    expect(gitCalls).toContainEqual(expect.arrayContaining(['fetch', 'origin', 'main']));
    expect(gitCalls).toContainEqual(expect.arrayContaining(['rev-list', 'aaa1111..origin/main']));
    // The fetch is cached: a second read does not fetch again.
    const fetches = gitCalls.filter((args) => args.includes('fetch')).length;
    await panel();
    expect(gitCalls.filter((args) => args.includes('fetch'))).toHaveLength(fetches);
  });

  it('says why the deploy is unavailable outside systemd', async () => {
    const { panel } = await setup({ systemd: false });
    expect((await panel()).unavailableReason).toBe(NOT_UNDER_SYSTEMD);
  });
});

describe('POST /api/versions/panel/deploy', () => {
  it('needs a valid TOTP code and runs nothing without it', async () => {
    const { deploy, script } = await setup();
    expect((await deploy({ code: '000000' })).statusCode).toBe(401);
    expect((await deploy({})).statusCode).toBe(401);
    expect(script).not.toHaveBeenCalled();
  });

  it('runs the script, keeps the run with both commits and restarts when asked to', async () => {
    const { deploy, totp, runs, script, restart, waitFinished } = await setup();
    const res = await deploy({ code: totp() });
    expect(res.statusCode).toBe(202);
    await waitFinished();
    expect(script).toHaveBeenCalledTimes(1);
    expect(script.mock.calls[0]?.[0][0]).toMatch(/scripts\/vm\/12-panel-deploy\.sh$/);
    // The running commit goes to the script: a pull without a restart still gets deployed.
    expect(script.mock.calls[0]?.[0].at(-1)).toBe('aaa1111');
    const [run] = await runs();
    expect(run).toMatchObject({
      kind: 'panel-deploy',
      fromVersion: 'aaa1111',
      toVersion: 'bbb2222',
      status: 'ok',
    });
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('does not restart when main was already up to date', async () => {
    const { deploy, totp, restart, waitFinished, panel } = await setup({
      script: () =>
        Promise.resolve({
          exitCode: 0,
          output: 'DEPLOY_FROM=aaa1111\nDEPLOY_TO=aaa1111\nDEPLOY_RESTART=no\n',
        }),
    });
    expect((await deploy({ code: totp() })).statusCode).toBe(202);
    await waitFinished();
    expect(restart).not.toHaveBeenCalled();
    expect((await panel()).deployRunning).toBe(false);
  });

  it('keeps a failed deploy as an error with its output and does not restart', async () => {
    const { deploy, totp, runs, restart, waitFinished } = await setup({
      script: () => Promise.resolve({ exitCode: 1, output: 'ERROR: el build falló\n' }),
    });
    expect((await deploy({ code: totp() })).statusCode).toBe(202);
    await waitFinished();
    const [run] = await runs();
    expect(run).toMatchObject({ status: 'error', output: 'ERROR: el build falló\n' });
    expect(restart).not.toHaveBeenCalled();
  });

  it('is refused outside systemd', async () => {
    const { deploy, totp, script } = await setup({ systemd: false });
    const res = await deploy({ code: totp() });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: NOT_UNDER_SYSTEMD });
    expect(script).not.toHaveBeenCalled();
  });

  it('is refused while a pilot takes a work to its PR', async () => {
    const { db, deploy, totp, script } = await setup();
    const project = await new ProjectRepository(db).add({
      name: 'demo',
      repoPath: makeKyroRepo(),
      baseBranch: 'main',
    });
    const chat = new ChatRepository(db).create({
      projectId: project.id,
      kind: 'work',
      slug: 'w',
      title: 'w',
      worktreePath: '/tmp/wt/w',
      branch: 'feature/w',
      status: 'idle',
    });
    const pilots = new AutopilotRunRepository(db);
    pilots.create(chat.id);
    pilots.setPhase(chat.id, 'merge');
    const res = await deploy({ code: totp() });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toContain('PR');
    expect(script).not.toHaveBeenCalled();
  });

  it('is refused while another deploy runs', async () => {
    let release: (value: { exitCode: number; output: string }) => void = () => undefined;
    const { deploy, totp, panel, waitFinished } = await setup({
      script: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    expect((await deploy({ code: totp() })).statusCode).toBe(202);
    expect((await panel()).deployRunning).toBe(true);
    const again = await deploy({ code: totp() });
    expect(again.statusCode).toBe(409);
    release({ exitCode: 0, output: 'DEPLOY_RESTART=no\n' });
    await waitFinished();
  });
});
