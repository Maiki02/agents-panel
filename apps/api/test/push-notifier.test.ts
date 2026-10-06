import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  WORKTREE_STATE_INFO,
  WORKTREE_STATE_IDS,
  type WorktreeStateId,
} from '@agents-panel/shared';
import { UserRepository } from '../src/auth/users.js';
import { ChatEventBus } from '../src/chats/events.js';
import { ChatRepository } from '../src/chats/repo.js';
import { PushNotifier } from '../src/push/notifier.js';
import { PushSubscriptionRepository } from '../src/push/repo.js';
import type { PushSendResult, PushSender, PushTarget } from '../src/push/sender.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { WorktreeStateRepository } from '../src/worktrees/state-repo.js';
import { PASSWORD, makeApp, makeKyroRepo } from './helpers.js';

const VAPID = {
  PUSH_VAPID_PUBLIC_KEY: 'fake-public-key',
  PUSH_VAPID_PRIVATE_KEY: 'fake-private-key',
  PUSH_VAPID_SUBJECT: 'mailto:test@example.com',
};

class FakeSender implements PushSender {
  readonly sent: { target: PushTarget; payload: Record<string, string> }[] = [];
  next: PushSendResult = { ok: true };
  send(target: PushTarget, payload: string): Promise<PushSendResult> {
    this.sent.push({ target, payload: JSON.parse(payload) as Record<string, string> });
    return Promise.resolve(this.next);
  }
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

async function boot(overrides: Record<string, string> = VAPID) {
  const sender = new FakeSender();
  const bus = new ChatEventBus();
  const made = makeApp(overrides, undefined, { pushSender: sender, bus });
  app = made.app;
  await made.app.ready();
  const users = new UserRepository(made.db);
  const alice = await users.create('alice', PASSWORD);
  const bob = await users.create('bob', PASSWORD);
  const subs = new PushSubscriptionRepository(made.db);
  const base = { p256dh: 'a', auth: 'b', userAgent: null };
  subs.upsert(alice.id, { ...base, endpoint: 'https://p.example.com/alice', name: 'PC' });
  subs.upsert(bob.id, { ...base, endpoint: 'https://p.example.com/bob', name: 'Android' });
  const project = await new ProjectRepository(made.db).add({
    name: 'demo',
    repoPath: makeKyroRepo(),
    baseBranch: 'main',
  });
  const chats = new ChatRepository(made.db);
  const chat = chats.create({
    projectId: project.id,
    kind: 'scope',
    slug: 'mi-scope',
    title: 'Mi scope',
    worktreePath: '/tmp/wt/mi-scope',
    branch: 'feature/mi-scope',
    status: 'idle',
  });
  const states = new WorktreeStateRepository(made.db, chats, bus);
  const go = async (
    state: WorktreeStateId,
    actor: 'user' | 'pilot' | 'agent' | 'system',
    reason?: string,
  ) => {
    states.transition(chat.id, { state, actor, reason: reason ?? null });
    await flush();
  };
  return { sender, subs, chat, project, go, bus };
}

describe('PushNotifier', () => {
  it('a block with a reason notifies every subscription with reason and chat url', async () => {
    const { sender, go, chat, project } = await boot();
    await go('escribiendo_codigo', 'pilot');
    expect(sender.sent).toEqual([]);
    await go('bloqueado', 'pilot', 'El sprint llegó al tope de sesiones');
    expect(sender.sent.map((s) => s.target.endpoint).sort()).toEqual([
      'https://p.example.com/alice',
      'https://p.example.com/bob',
    ]);
    expect(sender.sent[0]?.payload).toEqual({
      title: 'demo · Mi scope',
      body: 'Bloqueado: El sprint llegó al tope de sesiones',
      url: `/projects/${String(project.id)}/chats/${String(chat.id)}`,
      tag: `chat-${String(chat.id)}`,
    });
  });

  it('a ready PR notifies', async () => {
    const { sender, go } = await boot();
    await go('pr_lista', 'pilot', 'La PR está lista para revisar');
    expect(sender.sent).toHaveLength(2);
    expect(sender.sent[0]?.payload['body']).toBe(
      'PR lista para revisar: La PR está lista para revisar',
    );
  });

  it('states where the agent works send nothing, and a repeated state does not resend', async () => {
    const { sender, go } = await boot();
    for (const state of ['planificando', 'escribiendo_codigo', 'qa', 'cerrando_sprint'] as const) {
      await go(state, 'pilot');
    }
    expect(sender.sent).toEqual([]);
    await go('esperando_respuesta', 'agent');
    expect(sender.sent).toHaveLength(2);
    await go('esperando_respuesta', 'agent');
    await go('esperando_respuesta', 'agent', 'otra vez');
    expect(sender.sent).toHaveLength(2);
  });

  it('a pause only notifies when the pilot caused it', async () => {
    const { sender, go } = await boot();
    await go('pausado', 'user');
    expect(sender.sent).toEqual([]);
    await go('qa', 'pilot');
    await go('pausado', 'pilot', 'Pausó el piloto');
    expect(sender.sent).toHaveLength(2);
  });

  it('does not notify the wait for the usage quota', () => {
    expect(PushNotifier.notifies('sin_cupo_de_uso', 'pilot')).toBe(false);
  });

  it('a failing send (500) changes no state; a 410 deletes the subscription', async () => {
    const { sender, subs, go } = await boot();
    sender.next = { ok: false, statusCode: 500 };
    await go('bloqueado', 'pilot', 'x');
    expect(subs.listAll()).toHaveLength(2);
    await go('qa', 'pilot');
    sender.next = { ok: false, statusCode: 410 };
    await go('interrumpido', 'system');
    expect(subs.listAll()).toEqual([]);
  });

  it('a sender that throws never breaks the transition', async () => {
    const { sender, go, chat } = await boot();
    sender.send = () => Promise.reject(new Error('boom'));
    await expect(go('bloqueado', 'pilot', 'x')).resolves.toBeUndefined();
    expect(chat.id).toBeGreaterThan(0);
  });

  it('sends nothing when push is disabled', async () => {
    const { sender, go } = await boot({});
    await go('bloqueado', 'pilot', 'x');
    expect(sender.sent).toEqual([]);
  });
});

describe('who acts', () => {
  it('classifies every state in shared, with the user states amber for web and push', () => {
    for (const id of WORKTREE_STATE_IDS) expect(WORKTREE_STATE_INFO[id].label, id).not.toBe('');
    expect(WORKTREE_STATE_INFO.bloqueado.who).toBe('user');
    expect(WORKTREE_STATE_INFO.escribiendo_codigo.who).toBe('working');
    expect(WORKTREE_STATE_INFO.pr_lista.who).toBe('ok');
  });
});
