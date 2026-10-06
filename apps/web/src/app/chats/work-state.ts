import { WORKTREE_STATE_INFO, type StateActor, type WorktreeStateId } from '@agents-panel/shared';
import type { BadgeTone } from '../ui/badge';

/** Who has to move sets the tone of the badge (docs/identidad-visual.md). */
const TONE: Record<StateActor, BadgeTone> = {
  working: 'accent',
  user: 'warn',
  ok: 'ok',
  waiting: 'neutral',
  error: 'danger',
};

/** The single badge of a work: the label of its fine state and the tone of who has to move. */
export function workStateBadge(state: WorktreeStateId): { label: string; tone: BadgeTone } {
  const entry = WORKTREE_STATE_INFO[state];
  return { label: entry.label, tone: TONE[entry.who] };
}
