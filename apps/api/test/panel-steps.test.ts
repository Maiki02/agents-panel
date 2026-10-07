import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChatRepository } from '../src/chats/repo.js';
import { PanelStepRepository } from '../src/chats/steps-repo.js';
import { openDatabase } from '../src/db/index.js';
import type { PilotGh } from '../src/pilot/github-cli.js';
import { runGenericMerge, type MergeDeps, type MergeInput } from '../src/pilot/merge.js';
import {
  runMergePhase,
  type MergePhaseDeps,
  type MergePhaseInput,
} from '../src/pilot/merge-phase.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { makeGitRepo } from './helpers.js';

async function setup() {
  const db = openDatabase(':memory:');
  const project = await new ProjectRepository(db).add({
    name: 'demo',
    repoPath: makeGitRepo(),
    baseBranch: 'main',
  });
  const chats = new ChatRepository(db);
  const chat = chats.create({
    projectId: project.id,
    kind: 'work',
    slug: 'a',
    title: 'a',
    worktreePath: mkdtempSync(join(tmpdir(), 'wt-steps-')),
    branch: 'feature/a',
    status: 'idle',
  });
  let clock = 1_000;
  const steps = new PanelStepRepository(db, () => clock);
  return {
    db,
    chat,
    steps,
    advance: (ms: number) => {
      clock += ms;
    },
    setClock: (ms: number) => {
      clock = ms;
    },
  };
}

const GH = {
  openPr: () => Promise.resolve(null),
  openPrsOf: () => Promise.resolve(['https://github.com/o/r/pull/1']),
  createPr: () => Promise.resolve('https://github.com/o/r/pull/1'),
} as unknown as PilotGh;

describe('timeStep', () => {
  it('leaves a closed row with chat, kind and interval', async () => {
    const s = await setup();
    const value = await s.steps.timeStep(s.chat.id, 'push', () => {
      s.advance(250);
      return Promise.resolve(42);
    });
    expect(value).toBe(42);
    expect(s.steps.listByChat(s.chat.id)).toEqual([
      { id: 1, chatId: s.chat.id, kind: 'push', startedAt: 1_000, endedAt: 1_250, result: 'ok' },
    ]);
  });

  it('closes the interval when the step fails and rethrows the error', async () => {
    const s = await setup();
    await expect(
      s.steps.timeStep(s.chat.id, 'analyze', () => {
        s.advance(10);
        return Promise.reject(new Error('boom'));
      }),
    ).rejects.toThrow('boom');
    expect(s.steps.listByChat(s.chat.id)[0]).toMatchObject({
      kind: 'analyze',
      startedAt: 1_000,
      endedAt: 1_010,
      result: 'failed',
    });
  });

  it('keeps the interval of a step that runs before its chat exists, once flushed', async () => {
    const s = await setup();
    const deferred = s.steps.deferred();
    await deferred.run('setup', () => {
      s.advance(5);
      return Promise.resolve();
    });
    expect(s.steps.listByChat(s.chat.id)).toEqual([]);
    deferred.flush(s.chat.id);
    deferred.flush(s.chat.id);
    expect(s.steps.listByChat(s.chat.id)).toMatchObject([
      { kind: 'setup', startedAt: 1_000, endedAt: 1_005, result: 'ok' },
    ]);
  });

  it('closes the open steps with the restart time', async () => {
    const s = await setup();
    s.db
      .prepare('INSERT INTO panel_steps (chat_id, kind, started_at) VALUES (?, ?, ?)')
      .run(s.chat.id, 'merge_validate', 900);
    await s.steps.timeStep(s.chat.id, 'push', () => Promise.resolve());
    s.setClock(5_000);
    s.steps.closeOpen('interrupted');
    const rows = s.steps.listByChat(s.chat.id);
    expect(rows[0]).toMatchObject({ endedAt: 5_000, result: 'interrupted' });
    expect(rows[1]).toMatchObject({ endedAt: 1_000, result: 'ok' });
  });
});

describe('instrumented merge steps', () => {
  function genericDeps(s: Awaited<ReturnType<typeof setup>>, over: Partial<MergeDeps> = {}) {
    let head = 'a';
    const deps: MergeDeps = {
      git: {
        hasPendingChanges: () => Promise.resolve(false),
        commitPending: () => Promise.resolve(),
        head: () => Promise.resolve(head),
        pull: () => {
          head = 'b'; // the base brought changes: validation runs
          return Promise.resolve({ ok: true, output: '' });
        },
        unmergedPaths: () => Promise.resolve([]),
        mergeInProgress: () => Promise.resolve(false),
        push: () => Promise.resolve(),
      } as unknown as MergeDeps['git'],
      gh: GH,
      mark: () => undefined,
      record: () => undefined,
      resolveConflicts: () => Promise.resolve('done'),
      scan: () => Promise.resolve([]),
      validate: () => {
        s.advance(3 * 60_000); // a validate_command that takes 3 minutes
        return Promise.resolve({
          status: 'passed',
          command: 'npm test',
          output: '',
        } as unknown as Awaited<ReturnType<NonNullable<MergeDeps['validate']>>>);
      },
      step: s.steps.runnerFor(s.chat.id),
      ...over,
    };
    const input: MergeInput = {
      chat: { worktreePath: s.chat.worktreePath, branch: 'feature/a' },
      base: 'main',
      project: { validateCommand: 'npm test' },
      name: 'a',
      pr: { title: 't', body: 'b' },
    };
    return { deps, input };
  }

  it('records the 3 minutes of a validate_command and every step of the generic merge', async () => {
    const s = await setup();
    const { deps, input } = genericDeps(s);
    const outcome = await runGenericMerge(deps, input);
    expect(outcome.kind).toBe('pr');
    const rows = s.steps.listByChat(s.chat.id);
    expect(rows.map((r) => r.kind)).toEqual([
      'merge_pull',
      'merge_validate',
      'merge_scan',
      'push',
      'merge_pr',
    ]);
    for (const row of rows) {
      expect(row.chatId).toBe(s.chat.id);
      expect(row.startedAt).toBeGreaterThan(0);
      expect(row.endedAt).not.toBeNull();
      expect(row.result).toBe('ok');
    }
    const validate = rows.find((r) => r.kind === 'merge_validate');
    expect((validate?.endedAt ?? 0) - (validate?.startedAt ?? 0)).toBe(3 * 60_000);
  });

  it('closes the interval of a generic merge step that fails', async () => {
    const s = await setup();
    const { deps, input } = genericDeps(s, { validate: () => Promise.reject(new Error('x')) });
    const outcome = await runGenericMerge(deps, input);
    expect(outcome.kind).toBe('stop');
    const failed = s.steps.listByChat(s.chat.id).find((r) => r.kind === 'merge_validate');
    expect(failed).toMatchObject({ result: 'failed' });
    expect(failed?.endedAt).not.toBeNull();
  });

  it('records the steps of the merge-dev phase with start and end', async () => {
    const s = await setup();
    const root = s.chat.worktreePath;
    mkdirSync(join(root, '.claude', 'skills', 'merge-dev'), { recursive: true });
    writeFileSync(join(root, '.claude', 'skills', 'merge-dev', 'SKILL.md'), '# merge-dev\n');
    const d: MergePhaseDeps = {
      git: {
        isAncestor: () => Promise.resolve(false),
        currentBranch: () => Promise.resolve('feature/a'),
      } as unknown as MergePhaseDeps['git'],
      gh: GH,
      mark: () => undefined,
      record: () => undefined,
      session: () => Promise.resolve('done'),
      conflictPrompt: () => '',
      scan: () => Promise.resolve([]),
      step: s.steps.runnerFor(s.chat.id),
    };
    const input: MergePhaseInput = {
      chat: { worktreePath: root, branch: 'feature/a' },
      base: 'main',
      project: { validateCommand: null },
      name: 'a',
      pr: { title: 't', body: 'b' },
      mergeDevPrompt: 'p',
    };
    const outcome = await runMergePhase(d, input);
    expect(outcome.kind).toBe('done');
    const rows = s.steps.listByChat(s.chat.id);
    expect(rows.map((r) => r.kind)).toEqual(['merge_scan', 'merge_dev_check']);
    for (const row of rows) {
      expect(row.startedAt).toBeGreaterThan(0);
      expect(row.endedAt).not.toBeNull();
    }
  });
});
