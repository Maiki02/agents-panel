import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectPermissions } from '@agents-panel/shared';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { SecondFactorRepository, generateTotpCode, generateTotpSecret } from '../src/auth/totp.js';
import { UserRepository } from '../src/auth/users.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { PASSWORD, TEST_ENV, makeApp, makeGitRepo, mutatingHeaders } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
});

const PERIOD_MS = 30_000;

async function setup(files: Record<string, string> = {}) {
  const state = { t: 1_700_000_000_000 };
  const made = makeApp({}, () => state.t);
  app = made.app;
  await app.ready();
  const server = app;

  const repoPath = makeGitRepo();
  for (const [name, content] of Object.entries(files)) writeFileSync(join(repoPath, name), content);
  const projects = new ProjectRepository(made.db);
  const project = await projects.add({ name: 'demo', repoPath, baseBranch: 'main' });

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
  const url = `/api/projects/${String(project.id)}/permissions`;
  return {
    server,
    projects,
    project,
    headers,
    totp,
    url,
    get: () => server.inject({ url, headers }),
    put: (payload: Record<string, unknown>) =>
      server.inject({ method: 'PUT', url, headers, payload }),
  };
}

describe('project permissions', () => {
  it('returns the base, the fixed denied commands and nothing extra by default', async () => {
    const { get } = await setup();
    const body = (await get()).json<ProjectPermissions>();
    expect(body.commands).toEqual([]);
    expect(body.hosts).toEqual([]);
    expect(body.base).toEqual(expect.arrayContaining(['git', 'gh', 'npm', 'go', 'kyro', 'ls']));
    expect(body.fixedDenied).toEqual(
      expect.arrayContaining([
        'oci',
        'tailscale',
        'terraform',
        'sudo',
        'ssh',
        'wget',
        'env',
        'bash',
      ]),
    );
    expect(body.curlBaseHosts).toEqual(['localhost', '127.0.0.1']);
    expect(body.suggestions).toEqual([]);
  });

  it('saves validated commands and hosts with a valid TOTP', async () => {
    const { get, put, totp, projects, project } = await setup();
    const res = await put({
      commands: ['uv', 'pytest'],
      hosts: ['API.example.com'],
      totp: totp(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<ProjectPermissions>()).toMatchObject({
      commands: ['uv', 'pytest'],
      hosts: ['api.example.com'],
    });
    expect(projects.getBashExtras(project.id)).toEqual({
      commands: ['uv', 'pytest'],
      hosts: ['api.example.com'],
    });
    expect((await get()).json<ProjectPermissions>().commands).toEqual(['uv', 'pytest']);
  });

  it('rejects PUT without TOTP, with a wrong one or a reused one, and stores nothing', async () => {
    const { put, totp, projects, project } = await setup();
    const valid = totp();
    expect((await put({ commands: ['uv'], hosts: [] })).statusCode).toBe(401);
    expect((await put({ commands: ['uv'], hosts: [], totp: '000000' })).statusCode).toBe(401);
    expect((await put({ commands: ['uv'], hosts: [], totp: valid })).statusCode).toBe(200);
    expect((await put({ commands: ['make'], hosts: [], totp: valid })).statusCode).toBe(401);
    expect(projects.getBashExtras(project.id)).toEqual({ commands: ['uv'], hosts: [] });
  });

  it.each([
    [{ commands: ['sudo'], hosts: [] }],
    [{ commands: ['oci'], hosts: [] }],
    [{ commands: ['ssh'], hosts: [] }],
    [{ commands: ['env'], hosts: [] }],
    [{ commands: ['xargs'], hosts: [] }],
    [{ commands: ['git'], hosts: [] }],
    [{ commands: ['/usr/bin/uv'], hosts: [] }],
    [{ commands: ['uv run'], hosts: [] }],
    [{ commands: ['a;b'], hosts: [] }],
    [{ commands: [], hosts: ['http://example.com'] }],
    [{ commands: [], hosts: ['exa mple.com'] }],
    [{ commands: ['uv'], hosts: ['bad_host.com'] }],
  ])('answers 400 and saves nothing for %j', async (payload) => {
    const { put, totp, projects, project } = await setup();
    await put({ commands: ['make'], hosts: [], totp: totp() });
    const res = await put({ ...payload, totp: totp() });
    expect(res.statusCode).toBe(400);
    expect(projects.getBashExtras(project.id)).toEqual({ commands: ['make'], hosts: [] });
  });

  it('suggests commands from the lockfiles without applying them', async () => {
    const { get, projects, project, put, totp } = await setup({
      'uv.lock': '',
      Makefile: '',
      'Cargo.toml': '',
    });
    const body = (await get()).json<ProjectPermissions>();
    expect(body.suggestions).toEqual([
      { file: 'uv.lock', commands: ['uv', 'python', 'pytest'] },
      { file: 'Makefile', commands: ['make'] },
      { file: 'Cargo.toml', commands: ['cargo'] },
    ]);
    expect(body.commands).toEqual([]);
    expect(projects.getBashExtras(project.id).commands).toEqual([]);

    await put({ commands: ['uv', 'make'], hosts: [], totp: totp() });
    const after = (await get()).json<ProjectPermissions>();
    expect(after.suggestions).toEqual([
      { file: 'uv.lock', commands: ['python', 'pytest'] },
      { file: 'Cargo.toml', commands: ['cargo'] },
    ]);
  });

  it('suggests uv for pyproject.toml alone', async () => {
    const { get } = await setup({ 'pyproject.toml': '' });
    expect((await get()).json<ProjectPermissions>().suggestions[0]).toMatchObject({
      file: 'pyproject.toml',
    });
  });

  it('answers 404 for an unknown project', async () => {
    const { server, headers, totp } = await setup();
    expect(
      (await server.inject({ url: '/api/projects/999/permissions', headers })).statusCode,
    ).toBe(404);
    const res = await server.inject({
      method: 'PUT',
      url: '/api/projects/999/permissions',
      headers,
      payload: { commands: [], hosts: [], totp: totp() },
    });
    expect(res.statusCode).toBe(404);
  });

  it('answers 401 without a session and 403 to a PUT without CSRF', async () => {
    const { server, url, headers } = await setup();
    const origin = { origin: 'http://localhost:4200' };
    expect((await server.inject({ url, headers: origin })).statusCode).toBe(401);
    expect(
      (await server.inject({ method: 'PUT', url, headers: origin, payload: {} })).statusCode,
    ).toBe(401);
    const noCsrf = { cookie: headers['cookie'] ?? '', ...origin };
    const res = await server.inject({
      method: 'PUT',
      url,
      headers: noCsrf,
      payload: { commands: [], hosts: [], totp: '123456' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('keeps the route non-public', async () => {
    const { server } = await setup();
    const routes = server.registeredRoutes.filter((r) => r.url === '/api/projects/:id/permissions');
    expect(routes.length).toBeGreaterThanOrEqual(2);
    expect(routes.every((r) => !r.public)).toBe(true);
  });
});
