import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { IdeaDocument } from '@agents-panel/shared';
import { AgentManager } from '../src/agent/manager.js';
import type { RunParams } from '../src/agent/runner.js';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import { ChatEventBus } from '../src/chats/events.js';
import { isIdeaPath, readIdeaDocument, scanIdeaDocuments } from '../src/chats/idea.js';
import { QuestionRepository } from '../src/chats/questions-repo.js';
import { ChatRepository } from '../src/chats/repo.js';
import { AgentSessionRepository } from '../src/chats/sessions-repo.js';
import { openDatabase } from '../src/db/index.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { WorktreeStateRepository } from '../src/worktrees/state-repo.js';
import { WorktreeStateTracker } from '../src/worktrees/state-tracker.js';
import { FakeRunner } from './fake-runner.js';
import { PASSWORD, makeApp, makeGitRepo } from './helpers.js';

const write = (repo: string, rel: string, text = '# idea\n') => {
  const file = join(repo, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
};

describe('scanIdeaDocuments', () => {
  it('finds new .md files under .agents/kyro/<docType>/ and ignores Kyro state and config', async () => {
    const repo = makeGitRepo();
    write(repo, '.agents/kyro/plan/2026-10-05-panel.md');
    write(repo, '.agents/kyro/scopes/x/sprint.md');
    write(repo, '.agents/kyro/work/w/work.md');
    write(repo, '.agents/kyro/trace/x/e.md');
    write(repo, '.agents/kyro/qa/x/sprint-1.md');
    write(repo, '.agents/kyro/project.json', '{}');
    write(repo, '.agents/kyro/plan/notas.txt', 'x');
    write(repo, 'docs/otro.md');
    expect(await scanIdeaDocuments(repo)).toEqual(['.agents/kyro/plan/2026-10-05-panel.md']);
  });

  it('returns every candidate when there are several and nothing when there are none', async () => {
    const repo = makeGitRepo();
    expect(await scanIdeaDocuments(repo)).toEqual([]);
    write(repo, '.agents/kyro/plan/a.md');
    write(repo, '.agents/kyro/idea/b.md');
    expect(await scanIdeaDocuments(repo)).toEqual([
      '.agents/kyro/idea/b.md',
      '.agents/kyro/plan/a.md',
    ]);
  });

  it('also sees a document the branch committed against the base', async () => {
    const repo = makeGitRepo();
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
    git('checkout', '-q', '-b', 'feature/x');
    write(repo, '.agents/kyro/plan/a.md');
    git('add', '.');
    git('commit', '-q', '-m', 'idea');
    expect(await scanIdeaDocuments(repo)).toEqual([]);
    expect(await scanIdeaDocuments(repo, 'main')).toEqual(['.agents/kyro/plan/a.md']);
  });

  it('isIdeaPath only accepts .md files inside a docType folder', () => {
    expect(isIdeaPath('.agents/kyro/plan/a.md')).toBe(true);
    expect(isIdeaPath('.agents/kyro/plan/sub/a.md')).toBe(true);
    expect(isIdeaPath('.agents/kyro/a.md')).toBe(false);
    expect(isIdeaPath('.agents/kyro/scopes/a.md')).toBe(false);
    expect(isIdeaPath('.agents/kyro/plan/../../../etc/x.md')).toBe(false);
    expect(isIdeaPath('.agents/kyro/plan/a.txt')).toBe(false);
  });
});

describe('readIdeaDocument', () => {
  it('reads a regular file and refuses a symlink that leaves the worktree', async () => {
    const repo = makeGitRepo();
    write(repo, '.agents/kyro/plan/a.md', 'hola');
    expect(await readIdeaDocument(repo, '.agents/kyro/plan/a.md')).toEqual({
      ok: true,
      content: 'hola',
      truncated: false,
    });
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    write(outside, 'secret.md', 'secreto');
    symlinkSync(join(outside, 'secret.md'), join(repo, '.agents/kyro/plan/link.md'));
    expect(await readIdeaDocument(repo, '.agents/kyro/plan/link.md')).toEqual({ ok: false });
    symlinkSync(outside, join(repo, '.agents/kyro/linked'));
    expect(await readIdeaDocument(repo, '.agents/kyro/linked/secret.md')).toEqual({ ok: false });
    expect(await readIdeaDocument(repo, '.agents/kyro/plan/falta.md')).toEqual({ ok: false });
  });
});

describe('state of an idea chat after each turn', () => {
  async function wire(script: (params: RunParams) => void) {
    const db = openDatabase(':memory:');
    const repo = makeGitRepo();
    const project = await new ProjectRepository(db).add({
      name: 'demo',
      repoPath: repo,
      baseBranch: 'main',
    });
    const chats = new ChatRepository(db);
    const bus = new ChatEventBus();
    const states = new WorktreeStateRepository(db, chats, bus);
    const questions = new QuestionRepository(db);
    const tracker = new WorktreeStateTracker(
      states,
      {
        readScope: () => Promise.reject(new Error('not read')),
        readWork: () => Promise.reject(new Error('not read')),
      },
      { scan: (chat) => scanIdeaDocuments(chat.worktreePath) },
      questions,
    );
    const runner = new FakeRunner();
    runner.script = (params) => {
      script(params);
      return [
        { type: 'system:init', payload: {}, sessionId: 's1' },
        { type: 'result:success', payload: {} },
      ];
    };
    const manager = new AgentManager(
      chats,
      runner,
      bus,
      undefined,
      questions,
      new AgentSessionRepository(db),
      tracker,
    );
    const chat = chats.create({
      projectId: project.id,
      kind: 'idea',
      slug: 'i',
      title: 'i',
      worktreePath: repo,
      branch: 'feature/i',
      status: 'idle',
    });
    tracker.created(chat);
    const turn = async () => {
      manager.start(chat.id, 'go', { role: 'thinker' });
      await manager.waitForIdle(chat.id);
    };
    return { chat, states, questions, tracker, turn, repo };
  }

  it('one new document leaves esperando_aprobacion_plan with its path', async () => {
    const t = await wire((p) => {
      write(p.cwd, '.agents/kyro/plan/a.md');
    });
    await t.turn();
    expect(t.states.get(t.chat.id)).toMatchObject({
      state: 'esperando_aprobacion_plan',
      detail: '.agents/kyro/plan/a.md',
    });
    expect(t.states.timeline(t.chat.id).at(-1)).toMatchObject({
      toState: 'esperando_aprobacion_plan',
      data: { path: '.agents/kyro/plan/a.md' },
    });
  });

  it('no document stays in madurando_idea', async () => {
    const t = await wire(() => undefined);
    await t.turn();
    expect(t.states.get(t.chat.id)?.state).toBe('madurando_idea');
  });

  it('two documents block the work with a clear reason', async () => {
    const t = await wire((p) => {
      write(p.cwd, '.agents/kyro/plan/a.md');
      write(p.cwd, '.agents/kyro/idea/b.md');
    });
    await t.turn();
    const state = t.states.get(t.chat.id);
    expect(state).toMatchObject({ state: 'bloqueado', blockedReason: 'otro' });
    expect(state?.detail).toContain('2 documentos de idea');
  });

  it('a pending question does not pass to esperando_aprobacion_plan', async () => {
    let ask: () => void = () => undefined;
    const t = await wire((p) => {
      write(p.cwd, '.agents/kyro/plan/a.md');
      ask();
    });
    ask = () => {
      t.tracker.questionAsked(t.chat);
    };
    await t.turn();
    expect(t.states.get(t.chat.id)?.state).toBe('esperando_respuesta');
  });

  it('a new message after the plan was written goes back to madurando_idea with the user as actor', async () => {
    const t = await wire((p) => {
      write(p.cwd, '.agents/kyro/plan/a.md');
    });
    await t.turn();
    expect(t.states.get(t.chat.id)?.state).toBe('esperando_aprobacion_plan');
    await t.turn();
    const transitions = t.states.timeline(t.chat.id).map((x) => [x.toState, x.actor]);
    expect(transitions).toContainEqual(['madurando_idea', 'user']);
  });
});

describe('GET /api/chats/:id/idea', () => {
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
    const { token } = new SessionService(made.db, {
      idleTtlSeconds: 1800,
      absoluteTtlSeconds: 43200,
    }).create(user.id);
    const headers = { cookie: `${SESSION_COOKIE}=${token}` };
    const repo = makeGitRepo();
    const project = await new ProjectRepository(made.db).add({
      name: 'demo',
      repoPath: repo,
      baseBranch: 'main',
    });
    const chats = new ChatRepository(made.db);
    const create = (kind: 'idea' | 'work') =>
      chats.create({
        projectId: project.id,
        kind,
        slug: kind,
        title: kind,
        worktreePath: repo,
        branch: `feature/${kind}`,
        status: 'idle',
      });
    return { app: made.app, headers, repo, create };
  }

  it('returns the path, the state and the content of the document', async () => {
    const { app: a, headers, repo, create } = await boot();
    const chat = create('idea');
    write(repo, '.agents/kyro/plan/a.md', '# Mi idea\n');
    const res = await a.inject({ url: `/api/chats/${String(chat.id)}/idea`, headers });
    expect(res.statusCode).toBe(200);
    expect(res.json<IdeaDocument>()).toEqual({
      state: null,
      path: '.agents/kyro/plan/a.md',
      documents: ['.agents/kyro/plan/a.md'],
      content: '# Mi idea\n',
      truncated: false,
    });
  });

  it('does not read a document that is a symlink to outside', async () => {
    const { app: a, headers, repo, create } = await boot();
    const chat = create('idea');
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    write(outside, 'secret.md', 'secreto');
    mkdirSync(join(repo, '.agents/kyro/plan'), { recursive: true });
    symlinkSync(join(outside, 'secret.md'), join(repo, '.agents/kyro/plan/a.md'));
    const body = (
      await a.inject({ url: `/api/chats/${String(chat.id)}/idea`, headers })
    ).json<IdeaDocument>();
    expect(body.content).toBeNull();
  });

  it('answers 401 without a session and 404 for a chat that is not an idea', async () => {
    const { app: a, headers, create } = await boot();
    const work = create('work');
    expect(
      (
        await a.inject({
          url: `/api/chats/${String(work.id)}/idea`,
          headers: { origin: 'http://localhost:4200' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await a.inject({ url: `/api/chats/${String(work.id)}/idea`, headers })).statusCode,
    ).toBe(404);
  });
});
