import { HttpErrorResponse } from '@angular/common/http';
import type { ProjectRepo, PullBaseResult, RepoPullResult } from '@agents-panel/shared';
import type { BadgeTone } from '../ui/badge';

/** What the last pull did to one repo. */
export type PullRowState = 'updated' | 'up_to_date' | 'rejected';

export interface PullRowView {
  state: PullRowState;
  tone: BadgeTone;
  label: string;
  /** What to show next to the badge: how much came, what is left local, or the reason. */
  detail: string;
}

export interface RepoRowView {
  repo: ProjectRepo;
  /** The result of the last pull; null before any pull. */
  pull: PullRowView | null;
}

export function repoTitle(path: string): string {
  return path === '.' ? 'Raíz' : path;
}

/** The row of one repo after a pull: updated, already up to date, or rejected with its reason. */
export function pullRowView(result: RepoPullResult): PullRowView {
  if (result.error !== null || result.result === null) {
    return {
      state: 'rejected',
      tone: 'danger',
      label: 'Rechazado',
      detail: result.error ?? 'No se pudo actualizar.',
    };
  }
  const ahead =
    result.result.ahead > 0
      ? ` · ${String(result.result.ahead)} commit(s) locales que GitHub no tiene`
      : '';
  if (result.result.status === 'up_to_date') {
    return { state: 'up_to_date', tone: 'neutral', label: 'Sin cambios', detail: `Al día${ahead}` };
  }
  const n = result.result.commits;
  return {
    state: 'updated',
    tone: 'ok',
    label: 'Actualizado',
    detail: `${String(n)} ${n === 1 ? 'commit traído' : 'commits traídos'}${ahead}`,
  };
}

/**
 * The list of repos with the result of the last pull in each row. A pull result for a path that is
 * not in the list (a repo detected meanwhile) is ignored; a repo the pull did not reach shows none.
 */
export function mergeRepoRows(
  repos: readonly ProjectRepo[],
  pull: readonly RepoPullResult[] | null,
): RepoRowView[] {
  return repos.map((repo) => {
    const result = pull?.find((r) => r.path === repo.path);
    return { repo, pull: result ? pullRowView(result) : null };
  });
}

/** What a pull produced: its repo rows, plus the error when the root was rejected (409/502). */
export interface PullOutcome {
  repos: RepoPullResult[];
  /** Set when the pull as a whole failed (the root could not be updated). */
  error: string | null;
}

export function pullOutcomeOf(result: PullBaseResult): PullOutcome {
  return { repos: result.repos, error: null };
}

/** The outcome behind a failed pull: its message and, when the API sent them, every repo's row. */
export function pullFailureOf(error: unknown): PullOutcome | null {
  if (!(error instanceof HttpErrorResponse)) return null;
  const body = error.error as { error?: unknown; repos?: unknown } | null;
  if (body === null || typeof body !== 'object') return null;
  const repos = Array.isArray(body.repos) ? (body.repos as RepoPullResult[]) : [];
  const message = typeof body.error === 'string' ? body.error : `Error ${String(error.status)}`;
  return { repos, error: message };
}

/** A base branch can be saved when it is not empty and changed. */
export function canSaveBase(current: string, typed: string): boolean {
  const next = typed.trim();
  return next !== '' && next !== current && next.length <= 200;
}
