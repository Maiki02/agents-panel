import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { BlockedReason, WorktreeStateId } from '@agents-panel/shared';
import type { PilotGh } from './github-cli.js';
import type { MergeGit, PilotGit } from './git-ops.js';
import {
  runGenericMerge,
  type MergeDeps,
  type MergeInput,
  type MergeMark,
  type MergeOutcome,
} from './merge.js';
import { describeSecrets, scanWorktreeSecrets, type SecretFinding } from './secrets.js';
import type { ValidateTarget, ValidationResult } from '../worktrees/validate.js';

/** The skill a project ships to merge its own way (child repos included). */
export const MERGE_DEV_SKILL = path.join('.claude', 'skills', 'merge-dev', 'SKILL.md');

export interface MergePhaseInput extends MergeInput {
  /** Prompt of the `merge_dev` session; the caller builds it with the policy of that step. */
  mergeDevPrompt: string;
}

export interface MergePhaseDeps {
  git: PilotGit & MergeGit;
  gh: PilotGh;
  mark: (state: WorktreeStateId, reason: string, extra?: MergeMark) => void;
  record: (type: string, payload: Record<string, unknown>) => void;
  /** Opens the executor session of a step; 'exit' when the loop must stop (limit, cancel, queue). */
  session: (step: 'merge' | 'merge_dev', prompt: string) => Promise<'done' | 'exit'>;
  /** Prompt of the `merge` session over the conflicts. */
  conflictPrompt: (conflicts: readonly string[]) => string;
  scan?: (cwd: string, base: string) => Promise<SecretFinding[]>;
  validate?: (project: ValidateTarget, cwd: string, timeoutMs: number) => Promise<ValidationResult>;
  validateTimeoutMs?: number;
}

export type MergePhaseOutcome =
  /** The work reached the PR stage (or the base): the PRs found, possibly none when it merged directly. */
  | { kind: 'done'; prUrls: string[]; merged: boolean }
  | { kind: 'stop'; blockedReason: BlockedReason; detail: string }
  | { kind: 'exit' };

/** First-level folders of the worktree that are git repos of their own (child repos). */
export async function childRepos(worktree: string): Promise<string[]> {
  try {
    const entries = await readdir(worktree, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => path.join(worktree, entry.name))
      .filter((dir) => existsSync(path.join(dir, '.git')))
      .sort();
  } catch {
    return [];
  }
}

const stop = (blockedReason: BlockedReason, detail: string): MergePhaseOutcome => ({
  kind: 'stop',
  blockedReason,
  detail,
});

/**
 * The phase after the work is completed (R12, R14): the project's merge-dev skill when it ships
 * one, otherwise the generic merge. Both end at the same place: the branch is on origin and the
 * PRs are open (or the branch already reached the base). The panel never merges a PR.
 */
export async function runMergePhase(
  deps: MergePhaseDeps,
  input: MergePhaseInput,
): Promise<MergePhaseOutcome> {
  const cwd = input.chat.worktreePath;
  if (!existsSync(path.join(cwd, MERGE_DEV_SKILL))) {
    const generic: MergeDeps = {
      git: deps.git,
      gh: deps.gh,
      mark: deps.mark,
      record: deps.record,
      resolveConflicts: (conflicts) => deps.session('merge', deps.conflictPrompt(conflicts)),
      ...(deps.scan ? { scan: deps.scan } : {}),
      ...(deps.validate ? { validate: deps.validate } : {}),
      ...(deps.validateTimeoutMs !== undefined
        ? { validateTimeoutMs: deps.validateTimeoutMs }
        : {}),
    };
    const outcome: MergeOutcome = await runGenericMerge(generic, input);
    if (outcome.kind === 'pr') return { kind: 'done', prUrls: [outcome.url], merged: false };
    return outcome;
  }
  return runMergeDev(deps, input);
}

async function runMergeDev(
  deps: MergePhaseDeps,
  input: MergePhaseInput,
): Promise<MergePhaseOutcome> {
  const { git, gh } = deps;
  const cwd = input.chat.worktreePath;
  const scan = deps.scan ?? scanWorktreeSecrets;
  deps.mark('trayendo_dev', 'El merge-dev del proyecto trae y mergea el trabajo', {
    data: { skill: 'merge-dev', base: input.base },
  });
  if ((await deps.session('merge_dev', input.mergeDevPrompt)) === 'exit') return { kind: 'exit' };

  try {
    const repos = [cwd, ...(await childRepos(cwd))];
    // Before the phase ends nothing may carry a secret, in the root or in a child repo.
    const secrets: string[] = [];
    for (const repo of repos) {
      const found = await scan(repo, input.base);
      if (found.length > 0) {
        const where = repo === cwd ? '' : `${path.basename(repo)}/`;
        secrets.push(describeSecrets(found.map((f) => ({ ...f, file: where + f.file }))));
      }
    }
    if (secrets.length > 0) return stop('secretos', secrets.join(', '));

    // Success signal: the root branch is already in origin/<base>, or there are open PRs.
    const merged = await git.isAncestor(cwd, `origin/${input.base}`);
    const urls: string[] = [];
    for (const repo of repos) {
      const branch = repo === cwd ? input.chat.branch : await git.currentBranch(repo);
      if (branch === '' || branch === input.base) continue;
      urls.push(...(await gh.openPrsOf(repo, branch)));
    }
    if (!merged && urls.length === 0) {
      return stop(
        'merge_sin_pr',
        `El merge-dev terminó y no hay PR abierta ni la rama llegó a ${input.base}`,
      );
    }
    deps.mark(
      urls.length > 0 ? 'pr_lista' : 'mergeada',
      urls.length > 0 ? 'Las PR están listas para revisar' : `La rama ya está en ${input.base}`,
      { data: { prUrls: urls }, detail: urls.join(', ') || null },
    );
    return { kind: 'done', prUrls: urls, merged };
  } catch (error) {
    return stop('git', error instanceof Error ? error.message : 'No se pudo comprobar el merge');
  }
}
