import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KyroReadResult } from '../src/kyro/reader.js';
import {
  parseCapabilities,
  parseScopeTaskContext,
  parseWorkTaskContext,
  type KyroTaskContext,
} from '../src/kyro/state.js';
import { buildPolicy } from '../src/pilot/policy.js';
import {
  REQUIRED_CAPABILITIES,
  buildStepPrompt,
  checkCapabilities,
  type PromptStep,
} from '../src/pilot/prompts.js';

const dir = join(import.meta.dirname, 'fixtures', 'kyro');
const load = (name: string): unknown => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const scopeTask = parseScopeTaskContext(load('context-pack-task.execute_task.json'));
const workTask = parseWorkTaskContext(load('work-context-pack.execute_task.json'));
const home = '/home/u';

describe('the typed task context', () => {
  it('reads the real context-pack --task output', () => {
    expect(scopeTask).toMatchObject({
      kind: 'scope',
      name: 'demo',
      nextAction: 'execute_task',
      sprintSlug: 'uno',
      taskId: 'T1.1',
      title: 'Primera',
      files: ['a.txt'],
      criteria: ['a.txt existe'],
    });
  });

  it('reads the work context-pack', () => {
    expect(workTask).toMatchObject({
      kind: 'work',
      name: 'demo-work',
      taskId: 'W1',
      title: 'Typo',
    });
    expect(workTask.files).toEqual(['README.md']);
  });
});

describe('step prompts', () => {
  const steps: PromptStep[] = ['plan', 'execute', 'fix', 'close'];
  const policyStep = { plan: 'plan', execute: 'execute', fix: 'execute', close: 'close' } as const;

  it.each(steps)('%s carries the skill, the task context and the policy of its step', (step) => {
    const prompt = buildStepPrompt(step, { task: scopeTask, home, findings: ['HIGH: algo roto'] });
    expect(prompt).toContain(`${home}/.agents/skills/kyro-forge/SKILL.md`);
    expect(prompt).toContain('Scope: demo');
    expect(prompt).toContain('Sprint: uno — Sprint 1 objective.');
    expect(prompt).toContain('Task T1.1: Primera');
    expect(prompt).toContain('Hacer a.txt');
    expect(prompt).toContain('- a.txt');
    expect(prompt).toContain('- a.txt existe');
    expect(prompt).toContain(buildPolicy(policyStep[step]));
  });

  it('the closing session reads kyro-qa first and then kyro-forge', () => {
    const prompt = buildStepPrompt('close', { task: scopeTask, home });
    expect(prompt.indexOf('kyro-qa/SKILL.md')).toBeGreaterThan(-1);
    expect(prompt.indexOf('kyro-qa/SKILL.md')).toBeLessThan(prompt.indexOf('kyro-forge/SKILL.md'));
  });

  it('a work always runs through kyro-work', () => {
    for (const step of steps) {
      const prompt = buildStepPrompt(step, { task: workTask, home });
      expect(prompt).toContain('kyro-work/SKILL.md');
      expect(prompt).not.toContain('kyro-forge/SKILL.md');
      expect(prompt).toContain('Work: demo-work');
    }
  });

  it('the fix step lists the analyze findings and the others do not', () => {
    const fix = buildStepPrompt('fix', { task: scopeTask, home, findings: ['HIGH: algo roto'] });
    expect(fix).toContain('Analyze findings to fix:\n- HIGH: algo roto');
    expect(buildStepPrompt('execute', { task: scopeTask, home, findings: ['x'] })).not.toContain(
      'Analyze findings',
    );
  });

  it('a planning prompt without a task has no task section', () => {
    const planning: KyroTaskContext = {
      ...scopeTask,
      nextAction: 'plan_sprint',
      taskId: null,
      title: null,
      description: null,
    };
    const prompt = buildStepPrompt('plan', { task: planning, home });
    expect(prompt).not.toContain('Acceptance criteria');
    expect(prompt).toContain('Next action: plan_sprint');
  });

  it('is deterministic', () => {
    expect(buildStepPrompt('execute', { task: scopeTask, home })).toBe(
      buildStepPrompt('execute', { task: scopeTask, home }),
    );
  });

  it('never invokes kyro-sprint-executor nor mentions bypassPermissions', () => {
    for (const task of [scopeTask, workTask]) {
      for (const step of steps) {
        const prompt = buildStepPrompt(step, { task, home, findings: ['x'] });
        expect(prompt).not.toMatch(/bypassPermissions/i);
        for (const line of prompt.split('\n').filter((l) => l.includes('kyro-sprint-executor'))) {
          expect(line).toContain('Never use the kyro-sprint-executor');
        }
        expect(prompt).not.toContain('skills/kyro-sprint-executor');
      }
    }
  });
});

describe('capability check', () => {
  const reader = (result: KyroReadResult<string[]>) => ({
    capabilities: () => Promise.resolve(result),
  });
  const all = parseCapabilities(load('capabilities.json'));

  it('the real Kyro has every verb the pilot needs', async () => {
    for (const verb of REQUIRED_CAPABILITIES) expect(all).toContain(verb);
    expect(await checkCapabilities(reader({ ok: true, state: all }), '/wt')).toBeNull();
  });

  it.each(['record-evidence', 'review', 'close-sprint', 'analyze', 'context-pack'])(
    'stops with kyro_bloqueado when %s is missing',
    async (verb) => {
      const decision = await checkCapabilities(
        reader({ ok: true, state: all.filter((v) => v !== verb) }),
        '/wt',
      );
      expect(decision).toMatchObject({
        kind: 'stop',
        state: 'bloqueado',
        blockedReason: 'kyro_bloqueado',
        detail: expect.stringContaining(verb) as string,
      });
    },
  );

  it('stops with kyro_bloqueado when the CLI cannot answer', async () => {
    const decision = await checkCapabilities(
      reader({ ok: false, error: { kind: 'cli_failed', message: 'ENOENT' } }),
      '/wt',
    );
    expect(decision).toMatchObject({
      blockedReason: 'kyro_bloqueado',
      detail: expect.stringContaining('ENOENT') as string,
    });
  });
});
