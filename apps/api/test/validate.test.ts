import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import { loadConfig } from '../src/config.js';
import { ProjectRepository } from '../src/projects/repo.js';
import {
  VALIDATE_OUTPUT_LIMIT,
  runValidation,
  trimOutput,
  validationEventPayload,
} from '../src/worktrees/validate.js';
import { PASSWORD, TEST_ENV, makeApp, makeGitRepo, mutatingHeaders } from './helpers.js';

const node = (code: string) => `node -e "${code}"`;

describe('runValidation', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'validate-'));

  it('skips a project without validate_command', async () => {
    expect(await runValidation({ validateCommand: null }, cwd)).toEqual({ status: 'skipped' });
    expect(await runValidation({ validateCommand: '   ' }, cwd)).toEqual({ status: 'skipped' });
  });

  it('passes with exit 0, runs in the worktree and without a shell', async () => {
    writeFileSync(join(cwd, 'marca.txt'), 'x');
    const ok = await runValidation(
      {
        validateCommand: node(
          "console.log(require('fs').existsSync('marca.txt'), process.argv.length)",
        ),
      },
      cwd,
    );
    expect(ok).toMatchObject({ status: 'passed', output: 'true 1' });
    // No shell: the && is just an argument of node, not a second command.
    const noShell = await runValidation(
      { validateCommand: `${node('console.log(1)')} && echo hacked` },
      cwd,
    );
    expect(noShell).toMatchObject({ status: 'passed' });
    expect(noShell.status === 'passed' ? noShell.output : '').not.toContain('hacked');
  });

  it('fails with the exit code and the tail of the output', async () => {
    const result = await runValidation(
      { validateCommand: node("console.error('roto'); process.exit(3)") },
      cwd,
    );
    expect(result).toMatchObject({ status: 'failed', exitCode: 3, output: 'roto' });
  });

  it('stops a command that exceeds the timeout', async () => {
    const result = await runValidation(
      { validateCommand: node('setTimeout(() => {}, 60000)') },
      cwd,
      200,
    );
    expect(result.status).toBe('timeout');
  });

  it('reports an unclosed quote and a missing program as failed, never throws', async () => {
    expect(await runValidation({ validateCommand: 'node "abc' }, cwd)).toMatchObject({
      status: 'failed',
    });
    expect(await runValidation({ validateCommand: 'no-existe-este-programa' }, cwd)).toMatchObject({
      status: 'failed',
    });
  });

  it('keeps only the end of a long output in the event payload', async () => {
    expect(trimOutput('a'.repeat(VALIDATE_OUTPUT_LIMIT + 50)).length).toBe(
      VALIDATE_OUTPUT_LIMIT + 1,
    );
    const result = await runValidation(
      { validateCommand: node(`console.log('x'.repeat(${String(VALIDATE_OUTPUT_LIMIT * 2)}))`) },
      cwd,
    );
    const payload = validationEventPayload(result);
    expect(String(payload['output']).length).toBeLessThanOrEqual(VALIDATE_OUTPUT_LIMIT + 1);
    expect(validationEventPayload({ status: 'skipped' })).toEqual({ status: 'skipped' });
  });
});

describe('validate_command of a project', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function boot() {
    const made = makeApp();
    app = made.app;
    await made.app.ready();
    const user = await new UserRepository(made.db).create('alice', PASSWORD);
    const { token, csrfToken } = new SessionService(made.db, {
      idleTtlSeconds: 1800,
      absoluteTtlSeconds: 43200,
    }).create(user.id);
    const headers = mutatingHeaders(`${SESSION_COOKIE}=${token}`, csrfToken);
    const project = await new ProjectRepository(made.db).add({
      name: 'demo',
      repoPath: makeGitRepo(),
      baseBranch: 'main',
    });
    const url = `/api/projects/${String(project.id)}`;
    return { app: made.app, headers, url };
  }

  it('is null by default, set and cleared by PATCH and shown by GET', async () => {
    const { app: a, headers, url } = await boot();
    expect((await a.inject({ url, headers })).json()).toMatchObject({ validateCommand: null });
    const set = await a.inject({
      method: 'PATCH',
      url,
      headers,
      payload: { validateCommand: 'npm run build' },
    });
    expect(set.json()).toMatchObject({ validateCommand: 'npm run build' });
    expect((await a.inject({ url, headers })).json()).toMatchObject({
      validateCommand: 'npm run build',
    });
    const cleared = await a.inject({
      method: 'PATCH',
      url,
      headers,
      payload: { validateCommand: null },
    });
    expect(cleared.json()).toMatchObject({ validateCommand: null });
  });

  it('refuses a command over 500 characters and one with an unclosed quote', async () => {
    const { app: a, headers, url } = await boot();
    const long = await a.inject({
      method: 'PATCH',
      url,
      headers,
      payload: { validateCommand: 'x'.repeat(501) },
    });
    expect(long.statusCode).toBe(400);
    const quote = await a.inject({
      method: 'PATCH',
      url,
      headers,
      payload: { validateCommand: 'npm run "build' },
    });
    expect(quote.statusCode).toBe(400);
  });

  it('the timeout is configurable and defaults to 15 minutes', () => {
    expect(loadConfig(TEST_ENV).pilotValidateTimeoutMs).toBe(15 * 60 * 1000);
    expect(
      loadConfig({ ...TEST_ENV, PILOT_VALIDATE_TIMEOUT_MINUTES: '2' }).pilotValidateTimeoutMs,
    ).toBe(120_000);
  });
});
