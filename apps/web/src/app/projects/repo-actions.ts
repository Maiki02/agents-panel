import { HttpErrorResponse } from '@angular/common/http';
import type { DeleteBlocker, KyroBranchResult, PullResult } from '@agents-panel/shared';

/** One line saying what a pull did. */
export function pullSummary(result: PullResult): string {
  const ahead =
    result.ahead > 0 ? ` Hay ${String(result.ahead)} commit(s) locales que GitHub no tiene.` : '';
  if (result.status === 'up_to_date') return `Ya está al día con GitHub.${ahead}`;
  const plural = result.commits === 1 ? 'commit' : 'commits';
  return `Se trajeron ${String(result.commits)} ${plural} de GitHub.`;
}

/** What to do with the branch the Kyro init leaves behind. */
export function kyroBranchSummary(result: KyroBranchResult, baseBranch: string): string {
  return (
    `Kyro quedó commiteado en la rama ${result.branch} (${result.path}). ` +
    `Revisala, pusheala y mergeala a ${baseBranch}: hasta entonces el proyecto sigue sin Kyro.`
  );
}

/** True when the typed text is the name the project shows (case sensitive, spaces around ignored). */
export function nameMatches(label: string, typed: string): boolean {
  return typed.trim() !== '' && typed.trim() === label.trim();
}

/** The reasons a delete was refused (409), or [] for any other failure. */
export function deleteBlockers(error: unknown): DeleteBlocker[] {
  if (!(error instanceof HttpErrorResponse) || error.status !== 409) return [];
  const blockers = (error.error as { blockers?: unknown } | null)?.blockers;
  if (!Array.isArray(blockers)) return [];
  return blockers.filter(
    (item): item is DeleteBlocker =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as DeleteBlocker).path === 'string' &&
      typeof (item as DeleteBlocker).detail === 'string' &&
      ((item as DeleteBlocker).kind === 'uncommitted' ||
        (item as DeleteBlocker).kind === 'unpushed'),
  );
}

export function blockerLabel(blocker: DeleteBlocker): string {
  return blocker.kind === 'uncommitted' ? 'Sin commitear' : 'Sin pushear';
}
