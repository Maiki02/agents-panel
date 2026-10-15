import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { SecondFactorRepository, generateTotpCode, generateTotpSecret } from '../src/auth/totp.js';
import { UserRepository } from '../src/auth/users.js';
import {
  GitTokenRejectedError,
  HttpGitProviderApi,
  type GitProviderApi,
} from '../src/git-accounts/provider-api.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { PASSWORD, TEST_ENV, makeApp, makeGitRepo, mutatingHeaders } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
});

const TOKEN = 'glpat-S3NT1NEL_TOKEN_9f2c';
const PERIOD_MS = 30_000;

async function setup() {
  const state = { t: 1_700_000_000_000 };
  const calls: { provider: string; host: string }[] = [];
  const api: GitProviderApi = {
    fetchUsername(provider, host, token) {
      calls.push({ provider, host });
      if (token.startsWith('bad')) return Promise.reject(new GitTokenRejectedError('rechazado'));
      return Promise.resolve(`user-of-${token.slice(-4)}`);
    },
  };
  const made = makeApp({}, () => state.t, { gitProviderApi: api });
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
  const post = (payload: Record<string, unknown>) =>
    server.inject({ method: 'POST', url: '/api/git-accounts', headers, payload });
  const patch = (id: number, payload: Record<string, unknown>) =>
    server.inject({ method: 'PATCH', url: `/api/git-accounts/${String(id)}`, headers, payload });
  const del = (id: number) =>
    server.inject({ method: 'DELETE', url: `/api/git-accounts/${String(id)}`, headers });
  const list = () => server.inject({ url: '/api/git-accounts', headers });
  const gitlab = (extra: Record<string, unknown> = {}) => ({
    provider: 'gitlab',
    name: 'work',
    host: 'GitLab.Example.com',
    token: TOKEN,
    totp: totp(),
    ...extra,
  });
  return { made, server, calls, post, patch, del, list, totp, gitlab, headers };
}

describe('HttpGitProviderApi', () => {
  const reply = (status: number, body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

  it('asks GitHub and GitLab with the right URL and credentials', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fake = ((url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, headers: init.headers });
      return reply(200, { login: 'gh-user', username: 'gl-user' });
    }) as unknown as typeof fetch;
    const api = new HttpGitProviderApi(fake, 1000);
    expect(await api.fetchUsername('github', 'github.com', 't1')).toBe('gh-user');
    expect(await api.fetchUsername('gitlab', 'gl.example.com', 't2')).toBe('gl-user');
    expect(seen[0]?.url).toBe('https://api.github.com/user');
    expect(seen[0]?.headers['Authorization']).toBe('Bearer t1');
    expect(seen[1]?.url).toBe('https://gl.example.com/api/v4/user');
    expect(seen[1]?.headers['PRIVATE-TOKEN']).toBe('t2');
  });

  it('maps 401 to a rejected token and other failures to plain errors', async () => {
    const status = (code: number) => new HttpGitProviderApi(() => reply(code, {}), 1000);
    await expect(status(401).fetchUsername('gitlab', 'gl.example.com', 't')).rejects.toBeInstanceOf(
      GitTokenRejectedError,
    );
    await expect(status(500).fetchUsername('gitlab', 'gl.example.com', 't')).rejects.toThrow(/500/);
    const down = new HttpGitProviderApi(() => Promise.reject(new Error('x')), 1000);
    await expect(down.fetchUsername('github', 'github.com', 't')).rejects.toThrow(/No se pudo/);
  });
});

describe('git account routes', () => {
  it('creates an account, normalizes the host, stores the provider username and never returns the token', async () => {
    const { post, list, gitlab } = await setup();
    const res = await post(gitlab({ host: 'https://GitLab.Example.com/' }));
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      provider: 'gitlab',
      name: 'work',
      host: 'gitlab.example.com',
      username: 'user-of-9f2c',
    });
    const listed = await list();
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain('S3NT1NEL');
    expect(listed.body).not.toContain('ciphertext');
    expect(Object.keys(listed.json<object[]>()[0] ?? {}).sort()).toEqual([
      'createdAt',
      'host',
      'id',
      'name',
      'provider',
      'updatedAt',
      'username',
    ]);
  });

  it('keeps the token encrypted in the database', async () => {
    const { post, gitlab, made } = await setup();
    expect((await post(gitlab())).statusCode).toBe(201);
    const row = made.db.prepare('SELECT * FROM git_accounts').get() as {
      ciphertext: Uint8Array;
    };
    expect(Buffer.from(row.ciphertext).toString('utf8')).not.toContain('S3NT1NEL');
    expect(JSON.stringify(made.db.prepare('SELECT * FROM git_accounts').all())).not.toContain(
      'S3NT1NEL',
    );
  });

  it('github is always github.com', async () => {
    const { post, totp, calls } = await setup();
    const ok = await post({ provider: 'github', name: 'gh', token: TOKEN, totp: totp() });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ host: 'github.com' });
    expect(calls).toEqual([{ provider: 'github', host: 'github.com' }]);
    const other = await post({
      provider: 'github',
      name: 'gh2',
      host: 'gitlab.com',
      token: TOKEN,
      totp: totp(),
    });
    expect(other.statusCode).toBe(400);
  });

  it('rejects bad hosts, a token the provider refuses and a repeated name', async () => {
    const { post, gitlab, calls } = await setup();
    for (const host of [
      'http://gitlab.example.com',
      'gitlab.example.com:8443',
      'gitlab.example.com/sub',
      'https://user@gitlab.example.com',
      'localhost',
    ]) {
      const res = await post(gitlab({ host, name: 'h' }));
      expect(res.statusCode, host).toBe(400);
    }
    expect(calls).toEqual([]);

    const bad = await post(gitlab({ token: 'bad-token' }));
    expect(bad.statusCode).toBe(400);

    expect((await post(gitlab())).statusCode).toBe(201);
    const dup = await post(gitlab());
    expect(dup.statusCode).toBe(409);
  });

  it('requires TOTP to create and to replace a token, but not to rename', async () => {
    const { post, patch, gitlab, totp } = await setup();
    expect((await post(gitlab({ totp: undefined }))).statusCode).toBe(401);

    const created = (await post(gitlab())).json<{ id: number }>();
    expect((await patch(created.id, { token: 'new-token-1234' })).statusCode).toBe(401);
    const replaced = await patch(created.id, { token: 'new-token-1234', totp: totp() });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json()).toMatchObject({ username: 'user-of-1234' });
    const refused = await patch(created.id, { token: 'bad-1', totp: totp() });
    expect(refused.statusCode).toBe(400);

    const renamed = await patch(created.id, { name: 'renamed' });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ name: 'renamed' });
    expect((await patch(999, { name: 'x' })).statusCode).toBe(404);
  });

  it('requires a session and, for writes, CSRF', async () => {
    const { server, headers } = await setup();
    expect((await server.inject({ url: '/api/git-accounts' })).statusCode).toBe(401);
    expect(
      [401, 403].includes(
        (await server.inject({ method: 'POST', url: '/api/git-accounts', payload: {} })).statusCode,
      ),
    ).toBe(true);
    const noCsrf = { cookie: headers['cookie'], origin: headers['origin'] };
    for (const [method, url] of [
      ['POST', '/api/git-accounts'],
      ['PATCH', '/api/git-accounts/1'],
      ['DELETE', '/api/git-accounts/1'],
    ] as const) {
      const res = await server.inject({ method, url, headers: noCsrf, payload: {} });
      expect(res.statusCode, method).toBe(403);
    }
  });

  it('deletes an unused account and answers 409 when a project uses it', async () => {
    const { post, del, gitlab, made, list } = await setup();
    const a = (await post(gitlab())).json<{ id: number }>();
    const project = await new ProjectRepository(made.db).add({
      name: 'demo',
      repoPath: makeGitRepo(),
      baseBranch: 'main',
    });
    made.db
      .prepare('UPDATE projects SET git_account_id = ?, git_provider = ? WHERE id = ?')
      .run(a.id, 'gitlab', project.id);
    expect((await del(a.id)).statusCode).toBe(409);
    expect((await list()).json<object[]>().length).toBe(1);

    made.db.prepare('UPDATE projects SET git_account_id = NULL').run();
    expect((await del(a.id)).statusCode).toBe(200);
    expect((await del(a.id)).statusCode).toBe(404);
  });
});
