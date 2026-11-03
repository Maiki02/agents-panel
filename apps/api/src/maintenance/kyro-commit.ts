import type { Project } from '@agents-panel/shared';
import { git, pullFastForward } from '../projects/git.js';

const KYRO_DIR = '.agents/kyro';
const NETWORK_TIMEOUT_MS = 120_000;
const REASON_MAX = 300;

export type KyroCommitOutcome =
  | { status: 'unchanged' }
  | { status: 'committed'; commit: string }
  | { status: 'failed'; reason: string };

/** Commits what `kyro update` left in one base clone and pushes it to the base branch. */
export type KyroCommitter = (
  project: Pick<Project, 'repoPath' | 'baseBranch'>,
  version: string | null,
) => Promise<KyroCommitOutcome>;

/** One line, short: the reason goes into a `KYRO_COMMIT_FAILED=` output line. */
function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, ' ').trim().slice(0, REASON_MAX);
}

/**
 * The only operation that commits in a base clone and pushes its base branch (user decision of the
 * work `kyro-sin-ramas-e-historial`): only `.agents/kyro/`, never forced, never rebased. The clone
 * must be on its base branch with nothing of its own unpushed; origin is brought in by fast-forward
 * first. When the push fails the own commit is undone (mixed reset to the commit before it), so the
 * clone never ends up ahead of origin and the changes stay in the tree for the next update.
 */
export const commitKyroToBase: KyroCommitter = async (project, version) => {
  const { repoPath, baseBranch } = project;
  let pending: string;
  try {
    pending = await git(repoPath, ['status', '--porcelain', '--', KYRO_DIR]);
  } catch (error) {
    return { status: 'failed', reason: reasonOf(error) };
  }
  if (pending === '') return { status: 'unchanged' };

  let before: string;
  try {
    // Refuses another branch, local changes outside .agents/kyro/ and a divergence from origin.
    const pull = await pullFastForward(repoPath, baseBranch);
    if (pull.ahead > 0) {
      return {
        status: 'failed',
        reason: `el clon tiene ${String(pull.ahead)} commit(s) sin pushear en ${baseBranch}`,
      };
    }
    before = await git(repoPath, ['rev-parse', 'HEAD']);
  } catch (error) {
    return { status: 'failed', reason: reasonOf(error) };
  }

  try {
    await git(repoPath, ['add', '-A', '--', KYRO_DIR]);
    // The pathspec limits the commit to .agents/kyro/ even if something else was staged by hand.
    const message = `chore(kyro): actualizar Kyro${version === null ? '' : ` a ${version}`}`;
    await git(repoPath, ['commit', '-q', '-m', message, '--', KYRO_DIR]);
  } catch (error) {
    await git(repoPath, ['reset', '-q', '--', KYRO_DIR]).catch(() => undefined);
    return { status: 'failed', reason: reasonOf(error) };
  }

  const commit = await git(repoPath, ['rev-parse', 'HEAD']);
  try {
    await git(repoPath, ['push', 'origin', `HEAD:refs/heads/${baseBranch}`], NETWORK_TIMEOUT_MS);
  } catch (error) {
    // Only our own unpushed commit is undone; its changes stay in the tree.
    await git(repoPath, ['reset', '-q', '--mixed', before]).catch(() => undefined);
    return { status: 'failed', reason: `push rechazado: ${reasonOf(error)}` };
  }
  return { status: 'committed', commit };
};
