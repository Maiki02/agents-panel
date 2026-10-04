import type { Chat, ChatStatus } from '@agents-panel/shared';
import type { BadgeTone } from '../ui/badge';

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

/** What identifies a chat besides its title: kind and branch (the worktree's branch). */
export function chatSubtitle(chat: Pick<Chat, 'kind' | 'branch'>): string {
  return `${chat.kind === 'scope' ? 'scope' : 'work'} · ${chat.branch}`;
}
