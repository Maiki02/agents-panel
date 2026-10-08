import type { Chat, ChatKind, ChatStatus } from '@agents-panel/shared';
import type { BadgeTone } from '../ui/badge';
import { workStateBadge } from './work-state';

const LABELS: Record<ChatStatus, string> = {
  running: 'En curso',
  idle: 'En espera',
  error: 'Error',
  interrupted: 'Interrumpido',
  cancelled: 'Cancelado',
};

export function statusLabel(status: ChatStatus): string {
  return LABELS[status];
}

const TONES: Record<ChatStatus, BadgeTone> = {
  running: 'accent',
  idle: 'ok',
  error: 'danger',
  interrupted: 'warn',
  cancelled: 'warn',
};

export function statusTone(status: ChatStatus): BadgeTone {
  return TONES[status];
}

/** True while any chat has a running agent: the list keeps refreshing only then. */
export function hasRunning(chats: readonly Pick<Chat, 'status'>[]): boolean {
  return chats.some((chat) => chat.status === 'running');
}

const KIND_LABELS: Record<ChatKind, string> = {
  scope: 'Scope',
  work: 'Work',
  idea: 'Idea',
  direct: 'Directo',
};

/** Text of the chip that tells the kind of a chat. */
export function kindChipLabel(kind: ChatKind): string {
  return KIND_LABELS[kind];
}

/** What identifies a chat besides its short name: the worktree's branch (the kind is a chip). */
export function chatSubtitle(chat: Pick<Chat, 'branch'>): string {
  return chat.branch;
}

/**
 * The single badge of a chat. While the agent waits for an answer it is the user's turn, so the
 * label says so (amber) instead of the session status.
 */
export function chatBadge(
  status: ChatStatus,
  waitingForAnswer: boolean,
): { label: string; tone: BadgeTone } {
  return waitingForAnswer && status === 'running'
    ? { label: 'Esperando tu respuesta', tone: 'warn' }
    : { label: statusLabel(status), tone: statusTone(status) };
}

/**
 * The one badge of a chat in the sidebar: the fine state of a scope, work or idea when it has one
 * (tone by who has to move), the session status otherwise (a direct request, or no state yet).
 */
export function sidebarBadge(chat: Pick<Chat, 'status' | 'workState'>): {
  label: string;
  tone: BadgeTone;
} {
  if (chat.workState != null) return workStateBadge(chat.workState);
  return { label: statusLabel(chat.status), tone: statusTone(chat.status) };
}
