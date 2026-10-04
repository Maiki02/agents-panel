import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { Chat } from '@agents-panel/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { LOGGER_OPTIONS, buildApp } from '../src/app.js';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { SecondFactorRepository, generateTotpCode, generateTotpSecret } from '../src/auth/totp.js';
import { UserRepository } from '../src/auth/users.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { FakeRunner } from './fake-runner.js';
import { PASSWORD, TEST_ENV, makeGitRepo, mutatingHeaders } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
});

const SENTINEL = 'S3NT1NEL_E2E_SECRET_c0ffee42';

/** A repo whose committed .gitignore ignores /.env* (and nothing under config/). */
function ignoredRepo(): string {
  const repo = makeGitRepo();
  writeFileSync(join(repo, '.gitignore'), '/.env*\n');
  execFileSync('git', ['-C', repo, 'add', '.gitignore']);
  execFileSync('git', [
    '-C',
    repo,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '-m',
    'ignore env',
  ]);
  return repo;
}

describe('a .env value never leaks', () => {
  it('stays out of responses, trace logs, chat events and the database files', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'panel-sentinel-'));
    const dbPath = join(dataDir, 'panel.sqlite');
    const db = openDatabase(dbPath);
    const config = loadConfig({
      ...TEST_ENV,
      PANEL_WORKTREES_DIR: mkdtempSync(join(tmpdir(), 'panel-sentinel-wt-')),
      PANEL_PROJECTS_DIR: mkdtempSync(join(tmpdir(), 'panel-sentinel-projects-')),
    });
    const logs: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logs.push(chunk.toString('utf8'));
        callback();
      },
    });
    const state = { t: 1_700_000_000_000 };
    const runner = new FakeRunner();
    app = buildApp(
      { config, db, runner, now: () => state.t },
      { logger: { ...LOGGER_OPTIONS, level: 'trace', stream } },
    );
    // Worst case: something logs the whole request body. The redaction must still hide it.
    app.addHook('preHandler', (request, _reply, done) => {
      request.log.trace({ body: request.body }, 'request body');
      done();
    });
    await app.ready();
    const server = app;

    const projects = new ProjectRepository(db);
    const project = await projects.add({
      name: 'demo',
      repoPath: ignoredRepo(),
      baseBranch: 'main',
    });
    // A second project whose clone lost its .git: check-ignore fails with an unexpected code.
    const broken = await projects.add({
      name: 'broken',
      repoPath: makeGitRepo(),
      baseBranch: 'main',
    });
    rmSync(join(broken.repoPath, '.git'), { recursive: true, force: true });

    const user = await new UserRepository(db).create('alice', PASSWORD);
    const secret = generateTotpSecret();
    new SecondFactorRepository(db, Buffer.from(TEST_ENV.PANEL_SECRET_KEY)).setTotpSecret(
      user.id,
      secret,
    );
    const { token, csrfToken } = new SessionService(
      db,
      { idleTtlSeconds: 1800, absoluteTtlSeconds: 43200 },
      () => state.t,
    ).create(user.id);
    const headers = mutatingHeaders(`${SESSION_COOKIE}=${token}`, csrfToken);
    const totp = () => {
      state.t += 30_000;
      return generateTotpCode(secret, state.t);
    };

    const bodies: string[] = [];
    const call = async (
      method: 'GET' | 'PUT' | 'POST',
      url: string,
      payload?: Record<string, unknown>,
    ) => {
      const res = await server.inject({ method, url, headers, ...(payload ? { payload } : {}) });
      bodies.push(res.body);
      return res;
    };
    const envUrl = (id: number) => `/api/projects/${String(id)}/env`;
    const content = `DB_HOST=localhost\nAPI_KEY=${SENTINEL}\n`;

    expect(
      (await call('PUT', envUrl(project.id), { path: '.env', content, totp: totp() })).statusCode,
    ).toBe(201);
    expect(
      (await call('PUT', envUrl(project.id), { path: '.env', content, totp: totp() })).statusCode,
    ).toBe(200);
    const badLine = await call('PUT', envUrl(project.id), {
      path: '.env.local',
      content: `A=1\n${SENTINEL} oops\n`,
      totp: totp(),
    });
    expect(badLine.statusCode).toBe(400);
    expect(badLine.json()).toEqual({ error: 'Línea 2: se esperaba CLAVE=valor' });
    expect(
      (await call('PUT', envUrl(project.id), { path: '.env', content, totp: '000000' })).statusCode,
    ).toBe(401);
    expect(
      (await call('PUT', envUrl(project.id), { path: 'config/.env', content, totp: totp() }))
        .statusCode,
    ).toBe(400);
    expect(
      (await call('PUT', envUrl(broken.id), { path: '.env', content, totp: totp() })).statusCode,
    ).toBe(400);
    expect((await call('GET', envUrl(project.id))).statusCode).toBe(200);

    const created = await call('POST', '/api/chats', {
      projectId: project.id,
      kind: 'work',
      slug: 'sentinel',
      prompt: 'check the env',
    });
    expect(created.statusCode).toBe(201);
    const chat = created.json<Chat>();
    // The .env did reach the worktree: the sentinel is only absent where it must be.
    expect(readFileSync(join(chat.worktreePath, '.env'), 'utf8')).toBe(content);
    for (let i = 0; i < 200 && runner.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    bodies.push((await call('GET', `/api/chats/${String(chat.id)}/events`)).body);

    for (const body of bodies) expect(body).not.toContain(SENTINEL);

    const logText = logs.join('');
    expect(logText).toContain('[redacted]');
    expect(logText).not.toContain(SENTINEL);

    expect(JSON.stringify(db.prepare('SELECT * FROM chat_events').all())).not.toContain(SENTINEL);

    const dbFiles = readdirSync(dataDir).filter((file) => file.startsWith('panel.sqlite'));
    expect(dbFiles).toContain('panel.sqlite');
    for (const file of dbFiles) {
      expect(readFileSync(join(dataDir, file)).toString('latin1'), file).not.toContain(SENTINEL);
    }
  });
});
