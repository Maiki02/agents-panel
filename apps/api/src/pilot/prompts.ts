import { homedir } from 'node:os';
import { join } from 'node:path';
import type { KyroReadResult } from '../kyro/reader.js';
import type { KyroTaskContext } from '../kyro/state.js';
import type { PilotDecision } from './decide.js';
import { buildPolicy, type PolicyStep } from './policy.js';

/** The sessions the pilot opens: the plan, the execution, a fix after analyze, and the closing. */
export type PromptStep = 'plan' | 'execute' | 'fix' | 'close';

/** Verbs the pilot needs from Kyro before every step. */
export const REQUIRED_CAPABILITIES = [
  'record-evidence',
  'review',
  'close-sprint',
  'analyze',
  'context-pack',
] as const;

/** Policy block of each step: a fix is executed work, so it follows the execution clauses. */
const POLICY_OF: Record<PromptStep, PolicyStep> = {
  plan: 'plan',
  execute: 'execute',
  fix: 'execute',
  close: 'close',
};

const INTRO: Record<PromptStep, string> = {
  plan: 'Plan the next piece of work.',
  execute: 'Execute the next task.',
  fix: 'Fix the findings of "kyro analyze" listed below, as tasks of the active sprint (kyro add-emergent when they are new work).',
  close:
    'Close the sprint: run QA, resolve or postpone the debt, commit, and close it with the CLI.',
};

export interface StepPromptContext {
  /** Task context from `context-pack --task` (scope) or `work context-pack` (work). */
  task: KyroTaskContext;
  /** Findings of `kyro analyze` that the fix step must address. */
  findings?: readonly string[];
  /** Where the skills live; the user's home by default. */
  home?: string;
}

function skillPath(home: string, skill: string): string {
  return join(home, '.agents', 'skills', skill, 'SKILL.md');
}

/** Skills to read, in order. A work always runs through kyro-work; QA comes before closing. */
function skillsFor(step: PromptStep, kind: KyroTaskContext['kind']): string[] {
  if (kind === 'work') return ['kyro-work'];
  return step === 'close' ? ['kyro-qa', 'kyro-forge'] : ['kyro-forge'];
}

function list(items: readonly string[], empty = 'none'): string[] {
  return items.length === 0 ? [`- ${empty}`] : items.map((item) => `- ${item}`);
}

/**
 * First message of a pilot session. Deterministic: the same step and Kyro context always give the
 * same text, so it can be tested with fixtures. Skills are named by path because the SDK has no
 * slash commands on the VM (see buildInitialPrompt in chats/service.ts).
 */
export function buildStepPrompt(step: PromptStep, ctx: StepPromptContext): string {
  const { task } = ctx;
  const home = ctx.home ?? homedir();
  const skills = skillsFor(step, task.kind);
  const lines: string[] = [
    INTRO[step],
    ...skills.map((skill, index) =>
      index === 0
        ? `Read ${skillPath(home, skill)} first and follow it exactly.`
        : `Then read ${skillPath(home, skill)} and follow it for the rest.`,
    ),
    '',
    `${task.kind === 'work' ? 'Work' : 'Scope'}: ${task.name}`,
  ];
  if (task.sprintSlug !== null) {
    lines.push(
      `Sprint: ${task.sprintSlug}${task.sprintObjective ? ` — ${task.sprintObjective}` : ''}`,
    );
  }
  lines.push(`Next action: ${task.nextAction}`);
  if (task.taskId !== null) {
    lines.push(
      '',
      `Task ${task.taskId}${task.title ? `: ${task.title}` : ''}`,
      task.description ?? '',
      '',
      'Files:',
      ...list(task.files),
      '',
      `Context: ${task.context ?? 'none'}`,
      '',
      'Acceptance criteria:',
      ...list(task.criteria),
      '',
      'Scenarios:',
      ...list(
        task.scenarios.map(
          (s) => `${s.id} (${s.requirement}): given ${s.given}; when ${s.when}; then ${s.then}`,
        ),
      ),
    );
  }
  lines.push(
    '',
    `Open debt: ${String(task.openDebt)}`,
    '',
    'Conventions:',
    ...list(task.conventions),
  );
  if (step === 'fix') {
    lines.push('', 'Analyze findings to fix:', ...list(ctx.findings ?? []));
  }
  lines.push('', buildPolicy(POLICY_OF[step]));
  return lines.join('\n');
}

/** The part of KyroReader the capability check needs; tests inject a fake. */
export interface CapabilityReader {
  capabilities(cwd: string): Promise<KyroReadResult<string[]>>;
}

/**
 * Before each step: the installed Kyro must have every verb the pilot relies on. Returns null when
 * all are there, or the stop decision (kyro_bloqueado, with what is missing) otherwise.
 */
export async function checkCapabilities(
  reader: CapabilityReader,
  cwd: string,
): Promise<PilotDecision | null> {
  const read = await reader.capabilities(cwd);
  if (!read.ok) {
    return {
      kind: 'stop',
      state: 'bloqueado',
      blockedReason: 'kyro_bloqueado',
      detail: `No se pudo leer kyro capabilities: ${read.error.message}`,
    };
  }
  const missing = REQUIRED_CAPABILITIES.filter((verb) => !read.state.includes(verb));
  if (missing.length === 0) return null;
  return {
    kind: 'stop',
    state: 'bloqueado',
    blockedReason: 'kyro_bloqueado',
    detail: `A la versión de Kyro instalada le faltan: ${missing.join(', ')}. Actualizá Kyro desde Versiones.`,
  };
}
