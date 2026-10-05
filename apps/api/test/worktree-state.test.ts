import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ChatEvent, WorktreeState, WorktreeTransition } from '@agents-panel/shared';
import { AgentManager } from '../src/agent/manager.js';
import { QuestionRepository } from '../src/chats/questions-repo.js';
import { AgentSessionRepository } from '../src/chats/sessions-repo.js';
import type { KyroReadResult } from '../src/kyro/reader.js';
import { parseScopeState, type KyroScopeState } from '../src/kyro/state.js';
import { WorktreeStateTracker, type KyroStateReader } from '../src/worktrees/state-tracker.js';
import { FakeRunner } from './fake-runner.js';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import { ChatEventBus } from '../src/chats/events.js';
import { ChatRepository } from '../src/chats/repo.js';
import { openDatabase } from '../src/db/index.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { InvalidStateError, WorktreeStateRepository } from '../src/worktrees/state-repo.js';
import { PASSWORD, makeApp, makeGitRepo } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup() {
  const db = openDatabase(':memory:');
  const project = await new ProjectRepository(db).add({
    name: 'demo',
    repoPath: makeGitRepo(),
    baseBranch: 'main',
  });
  const chats = new ChatRepository(db);
  const bus = new ChatEventBus();
  let clock = 1000;
  const repo = new WorktreeStateRepository(db, chats, bus, () => (clock += 10));
  const newChat = (slug: string, kind: 'scope' | 'work' | 'direct' = 'scope') =>
    chats.create({
      projectId: project.id,
      kind,
      slug,
      title: slug,
      worktreePath: `/tmp/wt/${slug}`,
      branch: `feature/${slug}`,
      status: 'idle',
    });
  return { db, chats, bus, repo, newChat };
}

describe('WorktreeStateRepository', () => {
  it('writes state and transition together and publishes state_changed', async () => {
    const { chats, bus, repo, newChat } = await setup();
    const chat = newChat('a');
    const seen: ChatEvent[] = [];
    bus.subscribe(chat.id, (e) => seen.push(e));

    const first = repo.transition(chat.id, {
      state: 'planificando',
      actor: 'pilot',
      reason: 'arranca el plan',
      role: 'thinker',
      model: 'claude-opus-5-5',
      data: { nextAction: 'plan_sprint' },
    });
    expect(first.changed).toBe(true);
    expect(first.state).toMatchObject({
      state: 'planificando',
      actor: 'pilot',
      role: 'thinker',
      previousState: null,
    });
    repo.transition(chat.id, {
      state: 'escribiendo_codigo',
      actor: 'agent',
      taskDone: 0,
      taskTotal: 3,
    });

    expect(repo.timeline(chat.id)).toMatchObject([
      {
        fromState: null,
        toState: 'planificando',
        actor: 'pilot',
        data: { nextAction: 'plan_sprint' },
      },
      { fromState: 'planificando', toState: 'escribiendo_codigo', actor: 'agent' },
    ]);
    expect(repo.get(chat.id)).toMatchObject({
      state: 'escribiendo_codigo',
      previousState: 'planificando',
      taskTotal: 3,
    });
    const published = chats.eventsAfter(chat.id).filter((e) => e.type === 'state_changed');
    expect(published.map((e) => e.payload)).toEqual([
      { from: null, to: 'planificando', reason: 'arranca el plan', actor: 'pilot' },
      { from: 'planificando', to: 'escribiendo_codigo', reason: null, actor: 'agent' },
    ]);
    expect(seen.map((e) => e.type)).toEqual(['state_changed', 'state_changed']);
  });

  it('updates the row without a new transition when the state repeats', async () => {
    const { repo, newChat, chats } = await setup();
    const chat = newChat('a');
    const first = repo.transition(chat.id, {
      state: 'probando',
      actor: 'agent',
      detail: 'vitest',
      taskDone: 1,
      taskTotal: 4,
    });
    const again = repo.transition(chat.id, {
      state: 'probando',
      actor: 'agent',
      detail: 'eslint',
      taskDone: 2,
      taskTotal: 4,
    });
    expect(again.changed).toBe(false);
    expect(again.state).toMatchObject({ detail: 'eslint', taskDone: 2, since: first.state.since });
    expect(repo.timeline(chat.id)).toHaveLength(1);
    expect(chats.eventsAfter(chat.id).filter((e) => e.type === 'state_changed')).toHaveLength(1);
  });

  it('rejects unknown states, actors and block reasons without writing anything', async () => {
    const { repo, newChat, db } = await setup();
    const chat = newChat('a');
    expect(() => repo.transition(chat.id, { state: 'inventado' as never, actor: 'pilot' })).toThrow(
      InvalidStateError,
    );
    expect(() => repo.transition(chat.id, { state: 'qa', actor: undefined as never })).toThrow(
      InvalidStateError,
    );
    expect(() =>
      repo.transition(chat.id, { state: 'bloqueado', actor: 'pilot', blockedReason: 'x' as never }),
    ).toThrow(InvalidStateError);
    expect(db.prepare('SELECT count(*) AS n FROM worktree_state').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM worktree_transitions').get()).toEqual({ n: 0 });
  });

  it('rolls back both tables when the transition cannot be stored', async () => {
    const { repo, db } = await setup();
    expect(() => repo.transition(999, { state: 'qa', actor: 'pilot' })).toThrow(/FOREIGN KEY/);
    expect(db.prepare('SELECT count(*) AS n FROM worktree_state').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM worktree_transitions').get()).toEqual({ n: 0 });
  });

  it('deletes state and transitions with the chat', async () => {
    const { repo, chats, newChat, db } = await setup();
    const chat = newChat('a');
    repo.transition(chat.id, { state: 'planificando', actor: 'pilot' });
    repo.transition(chat.id, { state: 'qa', actor: 'pilot' });
    chats.delete(chat.id);
    expect(db.prepare('SELECT count(*) AS n FROM worktree_state').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM worktree_transitions').get()).toEqual({ n: 0 });
  });

  it('the database refuses a transition without an actor', async () => {
    const { db, newChat } = await setup();
    const chat = newChat('a');
    expect(() =>
      db
        .prepare(
          "INSERT INTO worktree_transitions (chat_id, to_state, actor, created_at) VALUES (?, 'qa', NULL, 1)",
        )
        .run(chat.id),
    ).toThrow(/NOT NULL/);
    expect(() =>
      db
        .prepare(
          "INSERT INTO worktree_transitions (chat_id, to_state, actor, created_at) VALUES (?, 'qa', 'robot', 1)",
        )
        .run(chat.id),
    ).toThrow(/CHECK/);
  });
});

describe('state and timeline routes', () => {
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
    const project = await new ProjectRepository(made.db).add({
      name: 'demo',
      repoPath: makeGitRepo(),
      baseBranch: 'main',
    });
    const chats = new ChatRepository(made.db);
    const create = (slug: string, kind: 'scope' | 'direct') =>
      chats.create({
        projectId: project.id,
        kind,
        slug,
        title: slug,
        worktreePath: `/tmp/wt/${slug}`,
        branch: `feature/${slug}`,
        status: 'idle',
      });
    const repo = new WorktreeStateRepository(made.db, chats, new ChatEventBus());
    return { ...made, headers, create, repo };
  }

  it('returns the state and the transitions in order', async () => {
    const { app: a, headers, create, repo } = await boot();
    const chat = create('s', 'scope');
    const url = (path: string) => `/api/chats/${String(chat.id)}/${path}`;
    expect((await a.inject({ url: url('state'), headers })).json()).toBeNull();
    expect((await a.inject({ url: url('timeline'), headers })).json()).toEqual([]);

    repo.transition(chat.id, { state: 'planificando', actor: 'pilot' });
    repo.transition(chat.id, { state: 'esperando_aprobacion_plan', actor: 'system' });

    const state = (await a.inject({ url: url('state'), headers })).json<WorktreeState>();
    expect(state).toMatchObject({
      state: 'esperando_aprobacion_plan',
      previousState: 'planificando',
    });
    const timeline = (await a.inject({ url: url('timeline'), headers })).json<
      WorktreeTransition[]
    >();
    expect(timeline.map((t) => [t.fromState, t.toState, t.actor])).toEqual([
      [null, 'planificando', 'pilot'],
      ['planificando', 'esperando_aprobacion_plan', 'system'],
    ]);
  });

  it('answers 404 for a direct chat and for a missing one', async () => {
    const { app: a, headers, create } = await boot();
    const direct = create('d', 'direct');
    for (const path of ['state', 'timeline']) {
      expect(
        (await a.inject({ url: `/api/chats/${String(direct.id)}/${path}`, headers })).statusCode,
      ).toBe(404);
      expect((await a.inject({ url: `/api/chats/999/${path}`, headers })).statusCode).toBe(404);
    }
  });

  it('answers 401 without a session', async () => {
    const { app: a } = await boot();
    for (const path of ['state', 'timeline']) {
      const res = await a.inject({
        url: `/api/chats/1/${path}`,
        headers: { origin: 'http://localhost:4200' },
      });
      expect(res.statusCode, path).toBe(401);
    }
  });
});

describe('WorktreeStateTracker', () => {
  const fixtureDir = join(import.meta.dirname, 'fixtures', 'kyro');
  const load = (name: string): unknown => JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'));
  const scopeFrom = (name: string) =>
    parseScopeState(
      load(`context-pack.${name}.json`),
      load(`status-full.${name}.json`),
      load(`sprint.${name}.json`),
    );

  /** A reader that answers with fixtures (or fails) and never runs Kyro. */
  function fakeReader(result: KyroReadResult<KyroScopeState>): KyroStateReader {
    return {
      readScope: () => Promise.resolve(result),
      readWork: () => Promise.resolve({ ok: false, error: { kind: 'no_target', message: 'n/a' } }),
    };
  }

  async function wire(reader: KyroStateReader, kind: 'scope' | 'work' | 'direct' = 'scope') {
    const base = await setup();
    const states = new WorktreeStateRepository(base.db, base.chats, base.bus);
    const tracker = new WorktreeStateTracker(states, reader);
    const runner = new FakeRunner();
    const questions = new QuestionRepository(base.db);
    const sessions = new AgentSessionRepository(base.db);
    const manager = new AgentManager(
      base.chats,
      runner,
      base.bus,
      undefined,
      questions,
      sessions,
      tracker,
    );
    const userId = Number(
      base.db
        .prepare("INSERT INTO users (username, password_hash, created_at) VALUES ('ana', 'x', 1)")
        .run().lastInsertRowid,
    );
    const chat = base.newChat('t', kind);
    return { ...base, states, tracker, runner, manager, questions, userId, chat };
  }

  it('leaves escribiendo_codigo with task progress, actor, role and model after a turn', async () => {
    const reader = fakeReader({ ok: true, state: scopeFrom('execute_task') });
    const { states, manager, chat, tracker } = await wire(reader);
    tracker.created(chat);
    manager.start(chat.id, 'go', { role: 'thinker' });
    await manager.waitForIdle(chat.id);

    expect(states.get(chat.id)).toMatchObject({
      state: 'escribiendo_codigo',
      phase: 'ejecucion',
      taskDone: 0,
      taskTotal: 2,
      sprintCurrent: 1,
      sprintTotal: 2,
      actor: 'agent',
      role: 'thinker',
      model: 'claude-opus-5-5',
    });
    expect(states.timeline(chat.id).map((t) => [t.toState, t.actor])).toEqual([
      ['creando_worktree', 'system'],
      ['instalando_dependencias', 'system'],
      ['planificando', 'agent'],
      ['escribiendo_codigo', 'agent'],
    ]);
    expect(states.timeline(chat.id).at(-1)).toMatchObject({
      role: 'thinker',
      model: 'claude-opus-5-5',
      data: { nextAction: 'execute_task', waitingOn: 'user' },
    });
  });

  it('goes to esperando_respuesta on a question and back when the user answers', async () => {
    const reader = fakeReader({ ok: true, state: scopeFrom('execute_task') });
    const { states, manager, runner, questions, userId, chat, tracker, chats } = await wire(reader);
    tracker.created(chat);
    // Hold the turn open on a question the way the SDK does through canUseTool.
    runner.script = async (params) => {
      void params.canUseTool('AskUserQuestion', {
        questions: [
          {
            question: '¿Cuál?',
            header: 'Opción',
            multiSelect: false,
            options: [
              { label: 'A', description: 'a' },
              { label: 'B', description: 'b' },
            ],
          },
        ],
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return [{ type: 'result:success', payload: {} }];
    };
    manager.start(chat.id, 'go');
    for (let i = 0; i < 100 && questions.listByChat(chat.id).length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(states.get(chat.id)?.state).toBe('esperando_respuesta');
    const asked = questions.listByChat(chat.id)[0];
    if (!asked) throw new Error('no question');
    manager.answerQuestion(asked.id, { '¿Cuál?': { selected: ['A'], text: null } }, userId);
    expect(states.get(chat.id)?.state).toBe('planificando');
    const lastTwo = states.timeline(chat.id).slice(-2);
    expect(lastTwo.map((t) => [t.toState, t.actor])).toEqual([
      ['esperando_respuesta', 'agent'],
      ['planificando', 'user'],
    ]);
    await manager.waitForIdle(chat.id);
    expect(chats.findById(chat.id)?.status).toBe('idle');
  });

  it('leaves error with the detail when Kyro cannot be read, and the chat stays usable', async () => {
    const reader = fakeReader({ ok: false, error: { kind: 'cli_failed', message: 'kyro: boom' } });
    const { states, manager, chats, chat, tracker } = await wire(reader);
    tracker.created(chat);
    manager.start(chat.id, 'go');
    await manager.waitForIdle(chat.id);
    expect(states.get(chat.id)).toMatchObject({
      state: 'error',
      detail: 'kyro: boom',
      actor: 'system',
    });
    expect(chats.findById(chat.id)?.status).toBe('idle');
    manager.start(chat.id, 'again');
    await manager.waitForIdle(chat.id);
    expect(chats.findById(chat.id)?.status).toBe('idle');
  });

  it('does not let a throwing reader break the turn', async () => {
    const reader: KyroStateReader = {
      readScope: () => Promise.reject(new Error('unexpected')),
      readWork: () => Promise.reject(new Error('unexpected')),
    };
    const { manager, chats, chat } = await wire(reader);
    manager.start(chat.id, 'go');
    await manager.waitForIdle(chat.id);
    expect(chats.findById(chat.id)?.status).toBe('idle');
  });

  it('marks running works as interrumpido at startup and gives direct chats no state', async () => {
    const reader = fakeReader({ ok: true, state: scopeFrom('execute_task') });
    const { states, chats, tracker, chat, newChat } = await wire(reader);
    const direct = newChat('d', 'direct');
    tracker.created(chat);
    chats.setStatus(chat.id, 'running');
    chats.setStatus(direct.id, 'running');
    tracker.markInterrupted(chats.listRunning());
    expect(states.get(chat.id)?.state).toBe('interrumpido');
    expect(states.timeline(chat.id).at(-1)).toMatchObject({
      actor: 'system',
      toState: 'interrumpido',
    });
    expect(states.get(direct.id)).toBeUndefined();
    tracker.created(direct);
    expect(states.get(direct.id)).toBeUndefined();
  });

  it('a direct chat turn creates no state', async () => {
    const reader = fakeReader({ ok: true, state: scopeFrom('execute_task') });
    const { states, manager, chat } = await wire(reader, 'direct');
    manager.start(chat.id, 'go');
    await manager.waitForIdle(chat.id);
    expect(states.get(chat.id)).toBeUndefined();
  });

  it('resuming after interrumpido returns to the previous state with the user as actor', async () => {
    const reader = fakeReader({ ok: true, state: scopeFrom('execute_task') });
    const { states, manager, chat, tracker, chats } = await wire(reader);
    tracker.created(chat);
    manager.start(chat.id, 'go');
    await manager.waitForIdle(chat.id);
    chats.setStatus(chat.id, 'running');
    tracker.markInterrupted(chats.listRunning());
    chats.setStatus(chat.id, 'interrupted');
    manager.start(chat.id, 'continue');
    await manager.waitForIdle(chat.id);
    const kinds = states.timeline(chat.id).map((t) => [t.toState, t.actor]);
    expect(kinds).toContainEqual(['interrumpido', 'system']);
    expect(kinds).toContainEqual(['escribiendo_codigo', 'user']);
  });

  it('resuming after a restart that cancelled a question never goes back to waiting for it', async () => {
    const reader = fakeReader({ ok: true, state: scopeFrom('execute_task') });
    const { states, manager, chat, tracker, chats } = await wire(reader);
    tracker.created(chat);
    manager.start(chat.id, 'go');
    await manager.waitForIdle(chat.id);
    const before = states.get(chat.id)?.state;
    tracker.questionAsked(chat);
    expect(states.get(chat.id)?.state).toBe('esperando_respuesta');
    chats.setStatus(chat.id, 'running');
    tracker.markInterrupted(chats.listRunning());
    chats.setStatus(chat.id, 'interrupted');
    tracker.turnStarted(chat, { role: 'executor', model: 'm' });
    expect(states.get(chat.id)?.state).toBe(before);
    expect(states.get(chat.id)?.state).not.toBe('esperando_respuesta');
    expect(states.timeline(chat.id).at(-1)).toMatchObject({ actor: 'user' });
  });

  it('falls back to planificando when the state before the question is unknown', async () => {
    const reader = fakeReader({ ok: true, state: scopeFrom('execute_task') });
    const { states, tracker, chat } = await wire(reader);
    states.transition(chat.id, { state: 'esperando_respuesta', actor: 'agent' });
    states.transition(chat.id, { state: 'interrumpido', actor: 'system' });
    tracker.turnStarted(chat, { role: 'executor', model: 'm' });
    expect(states.get(chat.id)?.state).toBe('planificando');
  });
});
