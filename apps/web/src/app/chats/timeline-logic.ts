import { WORKTREE_STATE_INFO, type Actor, type WorktreeTransition } from '@agents-panel/shared';
import type { BadgeTone } from '../ui/badge';
import { sessionLabel } from './phase-logic';
import { workStateBadge } from './work-state';

export const ACTOR_LABEL: Record<Actor, string> = {
  user: 'Usuario',
  pilot: 'Piloto',
  agent: 'Agente',
  system: 'Panel',
};

export interface TimelineEntry {
  id: number;
  /** Label of the previous state; null for the first entry. */
  from: string | null;
  to: string;
  tone: BadgeTone;
  actor: string;
  /** Role and model of the session; null when none ran. */
  session: string | null;
  reason: string | null;
  /** Debt postponed or accepted with this transition, as "T1.2 título". */
  debt: string[];
  /** Decision the pilot recorded as an ADR, when the transition carries one. */
  decision: string | null;
  at: number;
}

function debtLines(data: unknown): string[] {
  const debt = (data as { debt?: unknown } | null)?.debt;
  if (!Array.isArray(debt)) return [];
  return debt.flatMap((item: unknown) => {
    const row = item as { id?: unknown; title?: unknown } | null;
    if (typeof row?.id !== 'string') return [];
    return [typeof row.title === 'string' && row.title !== '' ? `${row.id} ${row.title}` : row.id];
  });
}

function decisionOf(data: unknown): string | null {
  const adr = (data as { adr?: unknown } | null)?.adr;
  if (typeof adr === 'string' && adr.trim() !== '') return adr.trim();
  const row = adr as { title?: unknown; decision?: unknown } | null;
  const parts = [row?.title, row?.decision].filter(
    (part): part is string => typeof part === 'string' && part.trim() !== '',
  );
  return parts.length === 0 ? null : parts.join(': ');
}

/** One transition of the Timeline as the page shows it. */
export function formatTransition(transition: WorktreeTransition): TimelineEntry {
  const badge = workStateBadge(transition.toState);
  return {
    id: transition.id,
    from: transition.fromState === null ? null : WORKTREE_STATE_INFO[transition.fromState].label,
    to: badge.label,
    tone: badge.tone,
    actor: ACTOR_LABEL[transition.actor],
    session: sessionLabel(transition.role, transition.model),
    reason:
      transition.reason !== null && transition.reason.trim() !== '' ? transition.reason : null,
    debt: debtLines(transition.data),
    decision: decisionOf(transition.data),
    at: transition.createdAt,
  };
}

/** Newest first, as the Timeline lists them. */
export function timelineEntries(transitions: readonly WorktreeTransition[]): TimelineEntry[] {
  return [...transitions].sort((a, b) => b.id - a.id).map(formatTransition);
}

/** Local date and time of an entry ("5 oct 22:10"). */
export function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString('es-AR', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "hace 2 min", "hace 3 h", "hace 4 d"; the full date goes in the `title` (identidad-visual.md). */
export function formatRelative(epochMs: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
  if (seconds < 60) return 'hace un momento';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${String(hours)} h`;
  return `hace ${String(Math.floor(hours / 24))} d`;
}
