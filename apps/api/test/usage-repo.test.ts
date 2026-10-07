import { describe, expect, it } from 'vitest';
import { AgentManager, type RunAccount } from '../src/agent/manager.js';
import { ChatEventBus } from '../src/chats/events.js';
import { ChatRepository } from '../src/chats/repo.js';
import { AgentSessionRepository } from '../src/chats/sessions-repo.js';
import { openDatabase } from '../src/db/index.js';
import { migrations, runMigrations } from '../src/db/migrations.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { UsageRepository, observationFromRateLimitEvent } from '../src/usage/repo.js';
import { FakeRunner } from './fake-runner.js';
import { makeGitRepo } from './helpers.js';

function rateLimit(info: Record<string, unknown>) {
  return { type: 'rate_limit_event', payload: { type: 'rate_limit_event', rate_limit_info: info } };
}

async function setup(failingUsage = false) {
  const db = openDatabase(':memory:');
  db.prepare(
    "INSERT INTO claude_accounts (name, config_dir, active, created_at) VALUES ('Segunda', '/tmp/c2', 0, 1)",
  ).run();
  const project = await new ProjectRepository(db).add({
    name: 'demo',
    repoPath: makeGitRepo(),
    baseBranch: 'main',
  });
  const chats = new ChatRepository(db);
  const runner = new FakeRunner();
  const usage = new UsageRepository(db, () => 5_000);
  if (failingUsage) {
    usage.upsert = () => {
      throw new Error('disk full');
    };
  }
  let account: RunAccount = { id: 1, name: 'Cuenta principal', configDir: null };
  const manager = new AgentManager(
    chats,
    runner,
    new ChatEventBus(),
    undefined,
    undefined,
    new AgentSessionRepository(db),
    undefined,
    undefined,
    () => account,
    usage,
  );
  const chat = chats.create({
    projectId: project.id,
    kind: 'work',
    slug: 'a',
    title: 'a',
    worktreePath: '/tmp/wt/a',
    branch: 'feature/a',
    status: 'idle',
  });
  return {
    db,
    chats,
    runner,
    usage,
    manager,
    chat,
    useAccount: (next: RunAccount) => {
      account = next;
    },
  };
}

describe('provider_usage migration', () => {
  it('runs over a database with data without losing anything', () => {
    const db = openDatabase(':memory:');
    const before = db.prepare('SELECT COUNT(*) AS n FROM claude_accounts').get();
    const list = migrations.filter((m) => m.version <= 20);
    const fresh = openDatabase(':memory:');
    fresh.exec('DROP TABLE provider_usage');
    fresh.exec('DELETE FROM schema_migrations WHERE version = 21');
    expect(list.length).toBeGreaterThan(0);
    expect(runMigrations(fresh)).toEqual([21]);
    expect(fresh.prepare('SELECT COUNT(*) AS n FROM claude_accounts').get()).toEqual(before);
    expect(runMigrations(fresh)).toEqual([]);
  });
});

describe('UsageRepository', () => {
  it('replaces the previous observation of the same window', async () => {
    const { usage } = await setup();
    usage.upsert(1, {
      window: 'five_hour',
      utilization: 40,
      status: 'allowed',
      resetsAt: 1000,
      source: 'event',
    });
    usage.upsert(1, {
      window: 'five_hour',
      utilization: 75,
      status: 'allowed_warning',
      resetsAt: 2000,
      source: 'event',
    });
    expect(usage.listByAccount(1)).toEqual([
      {
        window: 'five_hour',
        utilization: 75,
        status: 'allowed_warning',
        resetsAt: 2000,
        source: 'event',
        observedAt: 5_000,
      },
    ]);
  });

  it('does not mix accounts', async () => {
    const { usage } = await setup();
    const base = { status: 'allowed', resetsAt: null, source: 'event' } as const;
    usage.upsert(1, { ...base, window: 'five_hour', utilization: 10 });
    usage.upsert(2, { ...base, window: 'five_hour', utilization: 90 });
    expect(usage.listByAccount(1)[0]?.utilization).toBe(10);
    expect(usage.listByAccount(2)[0]?.utilization).toBe(90);
  });

  it('parses an SDK event: resetsAt in seconds becomes milliseconds, no utilization is null', () => {
    expect(
      observationFromRateLimitEvent(
        rateLimit({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1700000000 }).payload,
      ),
    ).toEqual({
      window: 'five_hour',
      utilization: null,
      status: 'allowed',
      resetsAt: 1700000000000,
      source: 'event',
    });
    expect(observationFromRateLimitEvent({ rate_limit_info: { status: 'allowed' } })).toBeNull();
    expect(observationFromRateLimitEvent(null)).toBeNull();
  });
});

describe('AgentManager usage capture', () => {
  it('saves each rate_limit_event under the account of the session', async () => {
    const { runner, usage, manager, chat, useAccount, chats } = await setup();
    runner.script = () => [
      rateLimit({
        status: 'allowed_warning',
        rateLimitType: 'five_hour',
        utilization: 72,
        resetsAt: 1700000000,
      }),
      { type: 'result:success', payload: {} },
    ];
    manager.start(chat.id, 'one');
    await manager.waitForIdle(chat.id);
    expect(usage.listByAccount(1)).toMatchObject([
      {
        window: 'five_hour',
        utilization: 72,
        status: 'allowed_warning',
        resetsAt: 1700000000000,
        source: 'event',
      },
    ]);
    expect(usage.listByAccount(2)).toEqual([]);

    useAccount({ id: 2, name: 'Segunda', configDir: '/tmp/c2' });
    runner.script = () => [
      rateLimit({ status: 'allowed', rateLimitType: 'five_hour', utilization: 5 }),
      { type: 'result:success', payload: {} },
    ];
    manager.start(chat.id, 'two');
    await manager.waitForIdle(chat.id);
    expect(usage.listByAccount(1)[0]?.utilization).toBe(72);
    expect(usage.listByAccount(2)[0]?.utilization).toBe(5);
    expect(chats.findById(chat.id)?.status).toBe('idle');
  });

  it('a failing save does not stop the turn', async () => {
    const { runner, manager, chat, chats } = await setup(true);
    runner.script = () => [
      rateLimit({ status: 'allowed', rateLimitType: 'five_hour', utilization: 10 }),
      { type: 'assistant', payload: { text: 'still here' } },
      { type: 'result:success', payload: {} },
    ];
    manager.start(chat.id, 'one');
    await manager.waitForIdle(chat.id);
    expect(chats.findById(chat.id)?.status).toBe('idle');
    expect(chats.eventsAfter(chat.id).map((e) => e.type)).toContain('result:success');
  });
});
