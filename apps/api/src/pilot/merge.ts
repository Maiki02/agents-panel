import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BlockedReason, Chat, WorktreeStateId } from '@agents-panel/shared';
import {
  DEFAULT_VALIDATE_TIMEOUT_MS,
  runValidation,
  validationEventPayload,
  type ValidateTarget,
  type ValidationResult,
} from '../worktrees/validate.js';
import type { PilotGh } from './github-cli.js';
import type { MergeGit, PilotGit } from './git-ops.js';
import { describeSecrets, scanWorktreeSecrets, type SecretFinding } from './secrets.js';

/** What the merge needs to know about the work it brings to the base. */
export interface MergeInput {
  chat: Pick<Chat, 'worktreePath' | 'branch'>;
  /** The project's registered base branch (R14). */
  base: string;
  project: ValidateTarget;
  /** Scope or work, for the commit and the PR. */
  name: string;
  pr: { title: string; body: string };
}

export interface MergeDeps {
  git: PilotGit & MergeGit;
  gh: PilotGh;
  /** Writes a Timeline transition of the merge phase. */
  mark: (state: WorktreeStateId, reason: string, extra?: MergeMark) => void;
  /** Keeps a chat event (the trimmed output of the validation). */
  record: (type: string, payload: Record<string, unknown>) => void;
  /** Opens the `merge` session (executor) over the conflicting paths; 'exit' when the loop must stop. */
  resolveConflicts: (conflicts: readonly string[]) => Promise<'done' | 'exit'>;
  scan?: (cwd: string, base: string) => Promise<SecretFinding[]>;
  validate?: (project: ValidateTarget, cwd: string, timeoutMs: number) => Promise<ValidationResult>;
  validateTimeoutMs?: number;
}

export interface MergeMark {
  data?: Record<string, unknown>;
  detail?: string | null;
  /** Keeps the Timeline entry even if the state does not change. */
  record?: boolean;
}

export type MergeOutcome =
  | { kind: 'pr'; url: string }
  | { kind: 'stop'; blockedReason: BlockedReason; detail: string }
  | { kind: 'exit' };

const stop = (blockedReason: BlockedReason, detail: string): MergeOutcome => ({
  kind: 'stop',
  blockedReason,
  detail,
});

const message = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

/**
 * Generic merge of a work into its project's base branch (R13, R14): commit what is pending, bring
 * the base in with `git pull --no-rebase`, let an executor session resolve the conflicts, validate
 * the result, look for secrets, push the branch (never forced) and open the PR (or reuse the open
 * one). Never merges the PR. Every stop carries its reason; nothing here reads the agent's text.
 */
export async function runGenericMerge(deps: MergeDeps, input: MergeInput): Promise<MergeOutcome> {
  const { git, gh } = deps;
  const cwd = input.chat.worktreePath;
  const branch = input.chat.branch;
  const scan = deps.scan ?? scanWorktreeSecrets;
  const validate = deps.validate ?? runValidation;

  deps.mark('trayendo_dev', `Trae ${input.base} a ${branch}`, { data: { base: input.base } });

  try {
    // 1. Pending work is committed, unless it carries a secret.
    if (await git.hasPendingChanges(cwd)) {
      const secrets = await scan(cwd, input.base);
      if (secrets.length > 0) return stop('secretos', describeSecrets(secrets));
      await git.commitPending(cwd, `chore: cambios pendientes de ${input.name}`);
    }

    // 2. The base comes in as a merge, never a rebase.
    const headBefore = await git.head(cwd);
    const pulled = await git.pull(cwd, input.base);
    if (!pulled.ok) {
      const unmerged = await git.unmergedPaths(cwd);
      if (unmerged.length === 0 && !(await git.mergeInProgress(cwd))) {
        return stop('git', pulled.output);
      }
      // 3. Conflicts: an executor session resolves the mechanical ones; logic is a question.
      deps.mark('resolviendo_conflictos', `Conflictos al traer ${input.base}`, {
        data: { conflicts: unmerged },
        detail: unmerged.join(', '),
      });
      if ((await deps.resolveConflicts(unmerged)) === 'exit') return { kind: 'exit' };
      const left = await git.unmergedPaths(cwd);
      if (left.length > 0)
        return stop('conflicto', `Quedaron rutas sin mergear: ${left.join(', ')}`);
      if (await git.mergeInProgress(cwd)) {
        return stop('conflicto', 'El merge sigue abierto: falta terminarlo con "git commit"');
      }
    }
    const brought = (await git.head(cwd)) !== headBefore;

    // 4. Validation of what the base brought in.
    const check = await validateMerge(deps, validate, input, brought);
    if (check !== null) return check;

    // 5. No secret goes to the remote.
    const secrets = await scan(cwd, input.base);
    if (secrets.length > 0) return stop('secretos', describeSecrets(secrets));

    // 6. Push (never forced) and the PR.
    await git.push(cwd, branch);
    deps.mark('abriendo_pr', `Abre la PR de ${branch} hacia ${input.base}`, {
      data: { base: input.base },
    });
    const url = await openOrReusePr(gh, input);
    deps.mark('pr_lista', 'La PR está lista para revisar', { data: { prUrl: url }, detail: url });
    return { kind: 'pr', url };
  } catch (error) {
    return stop('git', message(error, 'El merge falló'));
  }
}

async function validateMerge(
  deps: MergeDeps,
  validate: NonNullable<MergeDeps['validate']>,
  input: MergeInput,
  brought: boolean,
): Promise<MergeOutcome | null> {
  const command = input.project.validateCommand?.trim() ?? '';
  if (command === '') {
    deps.mark('validando_post_merge', 'Sin validate_command: no hubo validación', {
      data: { validation: 'skipped' },
      record: true,
    });
    return null;
  }
  if (!brought) {
    deps.mark('validando_post_merge', `${input.base} no trajo cambios: no se valida de nuevo`, {
      data: { validation: 'not_needed' },
      record: true,
    });
    return null;
  }
  deps.mark('validando_post_merge', 'Valida el resultado del merge', {
    data: { validation: 'running', command },
  });
  const result = await validate(
    input.project,
    input.chat.worktreePath,
    deps.validateTimeoutMs ?? DEFAULT_VALIDATE_TIMEOUT_MS,
  );
  deps.record('validation', validationEventPayload(result));
  if (result.status === 'failed' || result.status === 'timeout') {
    const why = result.status === 'timeout' ? 'se pasó del tiempo' : 'falló';
    return stop('build_roto', `${result.command} ${why}: ${result.output.slice(-500)}`);
  }
  return null;
}

async function openOrReusePr(gh: PilotGh, input: MergeInput): Promise<string> {
  const cwd = input.chat.worktreePath;
  const existing = await gh.openPr(cwd, input.chat.branch, input.base);
  if (existing !== null) return existing;
  const dir = await mkdtemp(path.join(tmpdir(), 'panel-pr-'));
  try {
    const bodyFile = path.join(dir, 'body.md');
    await writeFile(bodyFile, input.pr.body, 'utf8');
    return await gh.createPr(cwd, {
      base: input.base,
      head: input.chat.branch,
      title: input.pr.title,
      bodyFile,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
