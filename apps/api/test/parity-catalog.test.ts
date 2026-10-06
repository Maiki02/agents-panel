import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  AUTOPILOT_STEPS,
  MANUAL_STEPS,
  PARITY_CATALOG,
  type ParityAction,
} from '@agents-panel/shared';
import { ChatEventBus } from '../src/chats/events.js';
import { ChatRepository } from '../src/chats/repo.js';
import { openDatabase } from '../src/db/index.js';
import type { PromptStep } from '../src/pilot/prompts.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { ProjectRepoRepository } from '../src/projects/repos-repo.js';
import { WorktreeOps, type PilotActions } from '../src/worktrees/ops.js';
import { WorktreeStateRepository } from '../src/worktrees/state-repo.js';
import { makeApp, makeGitRepo, makeRepoWithRemote } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const byPilot = PARITY_CATALOG.filter((a) => a.automatic === 'pilot');

// A step added to the pilot's prompts or to the service it calls breaks the build here until the
// catalog (and so the manual button) knows about it.
const PROMPT_STEPS: Record<PromptStep, true> = {
  plan: true,
  execute: true,
  fix: true,
  close: true,
};
const PILOT_SERVICE: Record<keyof PilotActions, true> = {
  pushBranch: true,
  commitKyro: true,
  openPr: true,
};
/** Steps of the pilot's loop that are not actions of the pilot: the person typing is `manual`. */
const NOT_PILOT_ACTIONS: readonly string[] = ['manual'];

function pilotSource(): string {
  const dir = join(import.meta.dirname, '..', 'src', 'pilot');
  return readdirSync(dir)
    .filter((file) => file.endsWith('.ts'))
    .map((file) => readFileSync(join(dir, file), 'utf8'))
    .join('\n');
}

describe('parity catalog (D26)', () => {
  it('has unique ids', () => {
    const ids = PARITY_CATALOG.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every action of the pilot a manual access', () => {
    const without = byPilot.filter((a) => a.manual === null).map((a) => a.id);
    expect(without).toEqual([]);
  });

  it('has every manual route registered in the API', async () => {
    const made = makeApp();
    app = made.app;
    await made.app.ready();
    const missing: string[] = [];
    for (const action of PARITY_CATALOG) {
      if (action.manual?.type !== 'route') continue;
      const { method, path } = action.manual;
      if (!made.app.hasRoute({ method, url: path }))
        missing.push(`${action.id}: ${method} ${path}`);
    }
    expect(missing).toEqual([]);
    // and the step route that serves every manual step of the catalog
    expect(made.app.hasRoute({ method: 'POST', url: '/api/chats/:id/steps' })).toBe(true);
  });

  it('points every step access at a step the steps route accepts', () => {
    const steps = PARITY_CATALOG.flatMap((a) => (a.manual?.type === 'step' ? [a.manual.step] : []));
    for (const step of steps) expect(MANUAL_STEPS).toContain(step);
  });

  it('lists every step of the pilot', () => {
    const named = new Set(byPilot.map((a) => a.pilotStep).filter((s) => s !== undefined));
    const expected = [
      ...AUTOPILOT_STEPS.filter((s) => !NOT_PILOT_ACTIONS.includes(s)),
      ...Object.keys(PROMPT_STEPS),
      'qa',
      'complete',
    ];
    for (const step of expected)
      expect(named, `paso del piloto sin catalogar: ${step}`).toContain(step);
  });

  it('lists every call of the pilot to the action service', () => {
    const called = new Set([...pilotSource().matchAll(/\bactions\.(\w+)\(/g)].map((m) => m[1]));
    expect([...called].sort()).toEqual(Object.keys(PILOT_SERVICE).sort());
    const catalogued = new Set(byPilot.map((a) => a.service).filter((s) => s !== undefined));
    for (const method of called) {
      expect(catalogued, `llamada del piloto sin catalogar: ${String(method)}`).toContain(method);
    }
  });

  it('marks as pilot only what carries its pilot step or service', () => {
    const loose = byPilot.filter(
      (a: ParityAction) => a.pilotStep === undefined && a.service === undefined,
    );
    expect(loose.map((a) => a.id)).toEqual([]);
  });

  it('leaves the repair of Kyro as manual without a route', () => {
    expect(PARITY_CATALOG.find((a) => a.id === 'repair_kyro')).toMatchObject({
      automatic: null,
      manual: null,
    });
  });
});

describe('Timeline actor of the same action (S16)', () => {
  it('records pilot and user for a push', async () => {
    const db = openDatabase(':memory:');
    const root = makeRepoWithRemote('feature/x');
    const projects = new ProjectRepository(db);
    const project = await projects.add({
      name: 'demo',
      repoPath: makeGitRepo(),
      baseBranch: 'main',
    });
    const chats = new ChatRepository(db);
    const chat = chats.create({
      projectId: project.id,
      kind: 'work',
      slug: 'x',
      title: 'x',
      worktreePath: root.repo,
      branch: 'feature/x',
      status: 'idle',
    });
    const state = new WorktreeStateRepository(db, chats, new ChatEventBus());
    state.transition(chat.id, { state: 'escribiendo_codigo', actor: 'agent' });
    const ops = new WorktreeOps({
      chats,
      projects,
      projectRepos: new ProjectRepoRepository(db),
      manager: { isRunning: () => false, inMaintenance: false },
      state,
      envFiles: { readAll: () => [] },
    });

    await ops.pushBranch(chat.id, 'pilot');
    await ops.push(chat.id, '.', 'user');

    const pushes = state
      .timeline(chat.id)
      .filter((t) => (t.data as { op?: string } | null)?.op === 'push');
    expect(pushes.map((t) => t.actor)).toEqual(['pilot', 'user']);
  });
});
