import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import { ChatRepository } from '../src/chats/repo.js';
import { KyroPendingCache } from '../src/projects/kyro-pending-cache.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { PASSWORD, makeApp, makeGitRepo, makeKyroRepo, mutatingHeaders } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
});

async function login() {
  const made = makeApp();
  const server = made.app;
  app = server;
  await server.ready();
  const user = await new UserRepository(made.db).create('alice', PASSWORD);
  const { token, csrfToken } = new SessionService(
    made.db,
    { idleTtlSeconds: 1800, absoluteTtlSeconds: 43200 },
    () => Date.now(),
  ).create(user.id);
  const cookie = `${SESSION_COOKIE}=${token}`;
  return { made, server, cookie, post: mutatingHeaders(cookie, csrfToken) };
}

describe('response compression', () => {
  it('compresses a large JSON response when the client accepts gzip', async () => {
    const { made, server, cookie } = await login();
    const repo = new ProjectRepository(made.db);
    for (let i = 0; i < 25; i += 1) {
      await repo.add({ name: `project-${String(i)}`, repoPath: makeGitRepo(), baseBranch: 'main' });
    }
    const plain = await server.inject({
      url: '/api/projects',
      headers: { cookie, 'accept-encoding': 'identity' },
    });
    expect(plain.headers['content-encoding']).toBeUndefined();
    const zipped = await server.inject({
      url: '/api/projects',
      headers: { cookie, 'accept-encoding': 'gzip' },
    });
    expect(zipped.headers['content-encoding']).toBe('gzip');
    expect(zipped.rawPayload.length).toBeLessThan(plain.rawPayload.length / 2);
    expect(gunzipSync(zipped.rawPayload).toString()).toBe(plain.body);
    console.log(
      `/api/projects 25 items: ${String(plain.rawPayload.length)} B -> ${String(zipped.rawPayload.length)} B gzip`,
    );
  });

  it('compresses the files of the compiled web served by the API', async () => {
    const webDir = mkdtempSync(join(tmpdir(), 'panel-web-'));
    writeFileSync(join(webDir, 'index.html'), `<html>${'<p>panel</p>'.repeat(300)}</html>`);
    writeFileSync(join(webDir, 'main-ABCDEFGH.js'), `console.log("x");\n`.repeat(400));
    const made = makeApp({ PANEL_WEB_DIR: webDir });
    app = made.app;
    await made.app.ready();
    for (const url of ['/', '/main-ABCDEFGH.js']) {
      const res = await made.app.inject({ url, headers: { 'accept-encoding': 'br, gzip' } });
      expect(res.statusCode).toBe(200);
      expect(['br', 'gzip']).toContain(res.headers['content-encoding']);
    }
  });

  it('leaves small responses alone (under 1 KB)', async () => {
    const { server } = await login();
    const res = await server.inject({
      url: '/api/health',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('sends the SSE stream uncompressed and keeps delivering events', async () => {
    const { made, server, cookie } = await login();
    const project = await new ProjectRepository(made.db).add({
      name: 'p',
      repoPath: makeGitRepo(),
      baseBranch: 'main',
    });
    const chat = new ChatRepository(made.db).create({
      projectId: project.id,
      kind: 'work',
      slug: 'sse',
      title: 'SSE',
      worktreePath: '/tmp/wt/sse',
      branch: 'feature/sse',
      status: 'idle',
    });
    await server.listen({ port: 0, host: '127.0.0.1' });
    const address = server.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const headers = await new Promise<{ encoding: unknown; type: unknown; body: string }>(
      (resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            path: `/api/chats/${String(chat.id)}/stream`,
            headers: { cookie, 'accept-encoding': 'gzip, br' },
          },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
              body += chunk;
              if (body.includes('retry: 3000')) {
                resolve({
                  encoding: res.headers['content-encoding'],
                  type: res.headers['content-type'],
                  body,
                });
                req.destroy();
              }
            });
          },
        );
        req.on('error', (error) => {
          if ((error as { code?: string }).code !== 'ECONNRESET') reject(error);
        });
        req.end();
      },
    );
    expect(headers.type).toContain('text/event-stream');
    expect(headers.encoding).toBeUndefined();
    expect(headers.body).toContain('retry: 3000');
  });
});

describe('GET /api/projects cache', () => {
  it('keeps kyroPendingCommit for a few seconds and a project action invalidates it', async () => {
    const { made, server, cookie, post } = await login();
    const repo = makeKyroRepo();
    const file = join(repo, '.agents', 'kyro', 'project.json');
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
    writeFileSync(file, '{"v":1}\n');
    git('add', '.');
    git('commit', '-q', '-m', 'kyro');
    const project = await new ProjectRepository(made.db).add({
      name: 'k',
      repoPath: repo,
      baseBranch: 'main',
    });
    const pending = async () =>
      (await server.inject({ url: '/api/projects', headers: { cookie } })).json<
        { kyroPendingCommit?: boolean }[]
      >()[0]?.kyroPendingCommit;
    expect(await pending()).toBe(false);

    writeFileSync(file, '{"v":2}\n'); // what `kyro update` leaves behind
    expect(await pending()).toBe(false); // inside the window: no git status, the cached value

    // The pull itself fails (no origin) but it is a project action: the cache is dropped.
    await server.inject({
      method: 'POST',
      url: `/api/projects/${String(project.id)}/pull`,
      headers: post,
    });
    expect(await pending()).toBe(true);
  });
});

describe('KyroPendingCache', () => {
  it('does not run git again inside the window and runs it again after an invalidation', async () => {
    let t = 0;
    const compute = vi.fn(() => Promise.resolve(true));
    const cache = new KyroPendingCache({ compute, ttlMs: 5_000, now: () => t });
    expect(await cache.get('/a')).toBe(true);
    expect(await cache.get('/a')).toBe(true);
    expect(compute).toHaveBeenCalledTimes(1);
    cache.invalidate('/a');
    await cache.get('/a');
    expect(compute).toHaveBeenCalledTimes(2);
    t = 6_000;
    await cache.get('/a');
    expect(compute).toHaveBeenCalledTimes(3);
  });

  it('shares concurrent reads and caps the wait for a slow git', async () => {
    const compute = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          setTimeout(() => {
            resolve(true);
          }, 300);
        }),
    );
    const cache = new KyroPendingCache({ compute, timeoutMs: 20 });
    expect(await Promise.all([cache.get('/a'), cache.get('/a')])).toEqual([false, false]);
    expect(compute).toHaveBeenCalledTimes(1);
  });
});
