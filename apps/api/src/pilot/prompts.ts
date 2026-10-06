import { homedir } from 'node:os';
import { join } from 'node:path';
import type { KyroReadResult } from '../kyro/reader.js';
import type { ModelRole } from '@agents-panel/shared';
import type { AnalyzeFinding, KyroTaskContext } from '../kyro/state.js';
import type { PilotDecision } from './decide.js';
import { buildPolicy, type PolicyStep } from './policy.js';

/**
 * How a Work session reaches Kyro without hitting the tool policy. In the sprint 5 run the agent
 * got 8 denials: `cat`/`ls`/`find`/`which`/`od` and `~` or `$()` in Bash, reads of the Kyro docs
 * outside ~/.agents, and brief/evidence files written to /tmp or to .agents/briefs. The policy is
 * not loosened: the text points at what is allowed.
 */
export function workToolingHints(home: string): string[] {
  const runtime = join(home, '.agents', 'kyro', 'current');
  return [
    'Working in this worktree (the panel denies anything else):',
    `- The Kyro command guide is ${join(runtime, 'commands', 'work.md')} (the skill stub says "~/.agents/kyro/current/commands/work.md": that is this absolute path). Read it, and the files it points at under ${runtime}, with the Read tool and absolute paths. Do not use "~", "$()", variables or globs, and do not use ls, find, which or od in Bash.`,
    '- Run "kyro work --help" for the verbs. "kyro work create --id <slug> --from <brief.md>" creates the Work; the proposal goes in with "kyro work plan --work <slug> --from <proposal.json> --expect-revision <n>"; evidence and review with "kyro work record-evidence" and "kyro work review", each with --from <json>.',
    '- Write the input files (brief, proposal.json, evidence.json, review.json) only inside the worktree, under .agents/kyro/inputs/. Never write to /tmp or to any other folder outside .agents/kyro.',
    '- When a verb has consumed an input file, remove it with "git clean -f <path>" (untracked) so no working file stays in the pull request. Nothing outside .agents/kyro and the files of the task itself may remain.',
  ];
}

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
  if (task.kind === 'work') lines.push('', ...workToolingHints(home));
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

/**
 * First message of the `init` session: the idea was approved as a scope, which does not exist in
 * Kyro yet, so kyro-forge runs its INIT mode on the idea document (no re-interview).
 */
export function buildInitPrompt(input: { scope: string; seedPath: string; home?: string }): string {
  const home = input.home ?? homedir();
  return [
    'Create the scope of an approved idea.',
    `Read ${skillPath(home, 'kyro-forge')} first and follow it exactly.`,
    '',
    `Scope: ${input.scope}`,
    `The scope does not exist yet: run the INIT mode of kyro-forge for it, from the matured idea document ${input.seedPath} (relative to the worktree). Apply the Seedbed mapping of the document and do not re-ask what it already decides.`,
    'Stop once the scope exists with its roadmap; the panel plans and runs the sprints after that.',
    '',
    buildPolicy('plan'),
  ].join('\n');
}

/**
 * First message of a `merge` session: bringing the base into the branch left conflicts. The panel
 * pushed nothing yet and will verify that no path is left unmerged when the session ends.
 */
export function buildMergePrompt(input: {
  base: string;
  conflicts: readonly string[];
  /** Plain-language name of the work, for context. */
  name: string;
}): string {
  return [
    `Resolve the merge conflicts of ${input.name}.`,
    `The panel ran "git pull --no-rebase origin ${input.base}" in this worktree and a merge is in progress with conflicts in:`,
    ...list(input.conflicts),
    '',
    'Resolve them in place, "git add" every resolved path and finish the merge with "git commit --no-edit". The panel checks afterwards that no path is left unmerged.',
    '',
    buildPolicy('merge'),
  ].join('\n');
}

/**
 * First message of a `merge_dev` session: the project ships its own merge-dev skill (it knows the
 * child repos and the way the project merges), so the agent follows it for this work.
 */
export function buildMergeDevPrompt(input: {
  worktree: string;
  base: string;
  /** Scope or work being merged. */
  name: string;
}): string {
  return [
    `Merge ${input.name} into ${input.base} with the merge-dev skill of this project.`,
    `Read ${join(input.worktree, MERGE_DEV_SKILL)} first and follow it exactly for ${input.name}.`,
    '',
    `Base branch: ${input.base}`,
    'Stop once the branch is pushed and the pull requests are open; the panel looks for them afterwards.',
    '',
    buildPolicy('merge_dev'),
  ].join('\n');
}

/** Role of the session of a step: the plan thinks, everything else executes. */
export function stepRole(step: PromptStep): ModelRole {
  return step === 'plan' ? 'thinker' : 'executor';
}

const BLOCKING_SEVERITIES = new Set(['CRITICAL', 'HIGH']);

/**
 * What follows `kyro analyze` (the check_quality decision): a fix with the blocking findings, or
 * the closing when there are none. The pilot and the manual QA step both use it.
 */
export function afterAnalyze(findings: readonly AnalyzeFinding[]): {
  step: 'fix' | 'close';
  findings: string[];
} {
  const blocking = findings.filter((f) => BLOCKING_SEVERITIES.has(f.severity));
  return {
    step: blocking.length > 0 ? 'fix' : 'close',
    findings: blocking.map((f) => `${f.severity} ${f.id} (${f.category}): ${f.detail}`),
  };
}

/** Where a project that ships its own merge-dev skill keeps it, relative to the worktree. */
export const MERGE_DEV_SKILL = join('.claude', 'skills', 'merge-dev', 'SKILL.md');

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
