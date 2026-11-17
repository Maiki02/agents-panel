import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ClaudeAccount } from '@agents-panel/shared';
import { AccountRepository } from '../src/accounts/repo.js';
import { AccountService } from '../src/accounts/service.js';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import { openDatabase } from '../src/db/index.js';
import { ORIGIN, PASSWORD, makeApp, mutatingHeaders } from './helpers.js';

const dirs: string[] = [];
let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fake home in the legacy layout: ~/.claude logged in, ~/.claude2 logged in and linked, ~/.claude3 not linked. */
function fakeHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'panel-accounts-')));
  dirs.push(home);
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
  writeFileSync(join(home, '.claude', '.credentials.json'), '{"secret":"main"}');
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      oauthAccount: { emailAddress: 'main@example.com', organizationName: 'Main' },
    }),
  );
  mkdirSync(join(home, '.claude2'));
  writeFileSync(join(home, '.claude2', '.credentials.json'), '{"secret":"two"}');
  writeFileSync(
    join(home, '.claude2', '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'two@example.com', organizationName: 'Two' } }),
  );
  symlinkSync(join(home, '.claude', 'projects'), join(home, '.claude2', 'projects'));
  mkdirSync(join(home, '.claude3', 'projects'), { recursive: true });
  writeFileSync(join(home, '.claude3', '.credentials.json'), '{}');
  mkdirSync(join(home, 'no-login'));
  return home;
}

async function boot() {
  const home = fakeHome();
  const made = makeApp({}, undefined, { accountsHome: home });
  app = made.app;
  await made.app.ready();
  const user = await new UserRepository(made.db).create('alice', PASSWORD);
  const { token, csrfToken } = new SessionService(made.db, {
    idleTtlSeconds: 1800,
    absoluteTtlSeconds: 43200,
  }).create(user.id);
  const headers = mutatingHeaders(`${SESSION_COOKIE}=${token}`, csrfToken);
  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
    url: string,
    payload?: object,
  ) => made.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  return { home, db: made.db, app: made.app, headers, call };
}

describe('claude_accounts migration', () => {
  it('creates only the default account, active and without a directory', () => {
    const db = openDatabase(':memory:');
    const accounts = new AccountRepository(db).list();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ configDir: null, active: true });
  });

  it('never leaves zero active accounts when the id does not exist', () => {
    const repo = new AccountRepository(openDatabase(':memory:'));
    expect(() => {
      repo.setActive(999);
    }).toThrow();
    expect(repo.active().configDir).toBeNull();
  });
});

describe('account routes', () => {
  it('lists the default account with its identity and no login data', async () => {
    const { call } = await boot();
    const res = await call('GET', '/api/accounts');
    expect(res.statusCode).toBe(200);
    const [main] = res.json<ClaudeAccount[]>();
    expect(main).toMatchObject({
      configDir: null,
      active: true,
      email: 'main@example.com',
      organization: 'Main',
      loggedIn: true,
      linked: true,
    });
    expect(res.body).not.toContain('secret');
  });

  it('creates the account folder linked to the global ~/.claude and its command', async () => {
    const { home, call } = await boot();
    const res = await call('POST', '/api/accounts', { name: 'Trabajo', slug: 'work' });
    expect(res.statusCode, res.body).toBe(201);
    const dir = join(home, '.claude-work');
    expect(res.json()).toMatchObject({
      configDir: dir,
      command: 'claude-work',
      loggedIn: false,
      linked: true,
      active: false,
    });
    expect(readlinkSync(join(dir, 'projects'))).toBe(join(home, '.claude', 'projects'));
    expect(readlinkSync(join(dir, 'skills'))).toBe(join(home, '.claude', 'skills'));
    expect(existsSync(join(dir, '.credentials.json'))).toBe(false);
    const wrapper = readFileSync(join(home, '.local', 'bin', 'claude-work'), 'utf8');
    expect(wrapper).toContain(`export CLAUDE_CONFIG_DIR="${dir}"`);
    expect(wrapper).toContain(`exec "${join(home, '.local', 'bin', 'claude')}" "$@"`);
    // Without a login it cannot be the active one.
    const id = res.json<ClaudeAccount>().id;
    expect((await call('PUT', '/api/accounts/active', { id })).statusCode).toBe(409);
  });

  it('refuses bad commands, repeated names and repeated folders', async () => {
    const { call } = await boot();
    for (const slug of ['Work', '../x', 'a b', '-x', 'a'.repeat(33)]) {
      const res = await call('POST', '/api/accounts', { name: `n-${slug}`, slug });
      expect(res.statusCode, slug).toBe(400);
    }
    expect((await call('POST', '/api/accounts', { name: 'X', configDir: '/tmp' })).statusCode).toBe(
      400,
    );
    expect((await call('POST', '/api/accounts', { name: 'Dos', slug: 'dos' })).statusCode).toBe(
      201,
    );
    expect((await call('POST', '/api/accounts', { name: 'Dos', slug: 'tres' })).statusCode).toBe(
      409,
    );
    expect((await call('POST', '/api/accounts', { name: 'Otra', slug: 'dos' })).statusCode).toBe(
      409,
    );
  });

  it('keeps exactly one active account and protects the legacy and the active one', async () => {
    const { home, db, call } = await boot();
    const two = (
      await call('POST', '/api/accounts', { name: 'Dos', slug: 'work' })
    ).json<ClaudeAccount>();
    writeFileSync(join(home, '.claude-work', '.credentials.json'), '{"secret":"two"}');
    const switched = await call('PUT', '/api/accounts/active', { id: two.id });
    expect(switched.statusCode).toBe(200);
    const list = (await call('GET', '/api/accounts')).json<ClaudeAccount[]>();
    expect(list.filter((a) => a.active).map((a) => a.id)).toEqual([two.id]);
    expect(new AccountRepository(db).active().id).toBe(two.id);

    expect((await call('DELETE', `/api/accounts/${String(two.id)}`)).statusCode).toBe(409);
    const main = list.find((a) => a.configDir === null);
    expect((await call('PUT', '/api/accounts/active', { id: main?.id })).statusCode).toBe(200);
    expect((await call('DELETE', `/api/accounts/${String(main?.id)}`)).statusCode).toBe(409);
    expect((await call('DELETE', `/api/accounts/${String(two.id)}`)).statusCode).toBe(204);
    expect((await call('PUT', '/api/accounts/active', { id: 999 })).statusCode).toBe(404);
  });

  it('renames an account', async () => {
    const { call } = await boot();
    const [main] = (await call('GET', '/api/accounts')).json<ClaudeAccount[]>();
    const res = await call('PATCH', `/api/accounts/${String(main?.id)}`, {
      name: 'Miqueas Gentile',
    });
    expect(res.json()).toMatchObject({ name: 'Miqueas Gentile' });
  });

  it('needs a session, and CSRF to write', async () => {
    const { app: server, headers } = await boot();
    expect((await server.inject({ method: 'GET', url: '/api/accounts' })).statusCode).toBe(401);
    const res = await server.inject({
      method: 'PUT',
      url: '/api/accounts/active',
      headers: { cookie: headers['cookie'] ?? '', origin: ORIGIN },
      payload: { id: 1 },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('moving an account to its own folder (CLI account:dir)', () => {
  it('points the legacy account to ~/.claude-personal and validates the folder', () => {
    const home = fakeHome();
    const db = openDatabase(':memory:');
    const service = new AccountService(new AccountRepository(db), home, () => Promise.resolve());
    const [legacy] = service.list();
    const id = legacy?.id ?? 0;
    for (const bad of [join(home, '.claude'), join(home, 'missing'), '/etc', 'relative']) {
      expect(() => service.setDir(id, bad), bad).toThrow();
    }
    const personal = join(home, '.claude-personal');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(join(home, '.local', 'bin', 'claude-personal'), '#!/bin/sh\n');
    mkdirSync(personal);
    symlinkSync(join(home, '.claude', 'projects'), join(personal, 'projects'));
    writeFileSync(join(personal, '.credentials.json'), '{}');
    expect(service.setDir(id, personal)).toMatchObject({
      configDir: personal,
      command: 'claude-personal',
      loggedIn: true,
      linked: true,
    });
    expect(service.activeForRun().configDir).toBe(personal);
  });
});
