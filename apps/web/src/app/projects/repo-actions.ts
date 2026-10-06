import { HttpErrorResponse } from '@angular/common/http';
import type { DeleteBlocker, KyroBranchResult, Project, PullResult } from '@agents-panel/shared';

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

export interface KyroInitView {
  /** `has_kyro`: nothing to do; `pending`: the init branch waits for its merge; `none`: not started. */
  state: 'has_kyro' | 'pending' | 'none';
  /** Chip shown next to the title while the branch is pending. */
  chip: string | null;
  /** What is left to do, in order. */
  steps: string[];
  canInit: boolean;
  /** Why `Inicializar Kyro` is disabled; null when it can be pressed. */
  initReason: string | null;
  /** The branch is local only: it can be pushed from the web. */
  canPush: boolean;
  prUrl: string | null;
}

/**
 * What the Kyro block of Repositorio shows. `pushedNow` is true right after the web pushed the
 * branch, before the project is read again. With the branch pending the init button is disabled:
 * a second init would only fail with a conflict.
 */
export function kyroInitView(
  project: Pick<Project, 'hasKyro' | 'status' | 'baseBranch' | 'kyroInit'>,
  pushedNow = false,
): KyroInitView {
  if (project.hasKyro) {
    return {
      state: 'has_kyro',
      chip: null,
      steps: [],
      canInit: false,
      initReason: 'Este proyecto ya tiene Kyro.',
      canPush: false,
      prUrl: null,
    };
  }
  const pending = project.kyroInit ?? null;
  if (pending !== null) {
    const pushed = pending.pushed || pushedNow;
    return {
      state: 'pending',
      chip: pushed ? 'Pendiente de merge' : 'Pendiente de subir y mergear',
      steps: [
        ...(pushed ? [] : [`Subí la rama ${pending.branch} a GitHub (botón de abajo).`]),
        `Abrí la PR y mergeala a ${project.baseBranch}.`,
        'Traé los cambios de GitHub (botón de arriba): recién ahí el proyecto pasa a tener Kyro.',
      ],
      canInit: false,
      initReason: `Ya hay una inicialización pendiente (rama ${pending.branch}): falta mergearla.`,
      canPush: !pushed,
      prUrl: pending.prUrl,
    };
  }
  const ready = project.status === 'ready';
  return {
    state: 'none',
    chip: null,
    steps: [],
    canInit: ready,
    initReason: ready ? null : 'El proyecto todavía no está listo.',
    canPush: false,
    prUrl: null,
  };
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
