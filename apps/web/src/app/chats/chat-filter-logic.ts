import { WORKTREE_STATE_INFO, type Chat, type ChatStatus } from '@agents-panel/shared';

export type ChatFilterId = 'active' | 'mine' | 'done' | 'all';

export const CHAT_FILTERS: readonly { id: ChatFilterId; label: string }[] = [
  { id: 'active', label: 'Activos' },
  { id: 'mine', label: 'Te toca' },
  { id: 'done', label: 'Terminados' },
  { id: 'all', label: 'Todos' },
];

export const DEFAULT_CHAT_FILTER: ChatFilterId = 'all';

const FILTER_STORAGE_KEY = 'chat-sidebar-filter';

/** Bucket of each session status, for the chats that have no fine state (queries, direct requests). */
const STATUS_BUCKET: Record<ChatStatus, Exclude<ChatFilterId, 'all'>> = {
  running: 'active',
  error: 'mine',
  interrupted: 'mine',
  idle: 'done',
  cancelled: 'done',
};

/**
 * The bucket a chat belongs to. A work uses who has to move in its fine state (working or waiting
 * → active, user or error → mine, ok → done); a chat without one uses its session status.
 */
export function chatBucket(chat: Pick<Chat, 'status' | 'workState'>): Exclude<ChatFilterId, 'all'> {
  if (chat.workState != null) {
    switch (WORKTREE_STATE_INFO[chat.workState].who) {
      case 'working':
      case 'waiting':
        return 'active';
      case 'user':
      case 'error':
        return 'mine';
      case 'ok':
        return 'done';
    }
  }
  return STATUS_BUCKET[chat.status];
}

export function matchesFilter(
  chat: Pick<Chat, 'status' | 'workState'>,
  filter: ChatFilterId,
): boolean {
  return filter === 'all' || chatBucket(chat) === filter;
}

export function filterChats<T extends Pick<Chat, 'status' | 'workState'>>(
  chats: readonly T[],
  filter: ChatFilterId,
): T[] {
  return chats.filter((chat) => matchesFilter(chat, filter));
}

/** How many chats each filter would show. */
export function filterCounts(
  chats: readonly Pick<Chat, 'status' | 'workState'>[],
): Record<ChatFilterId, number> {
  const counts: Record<ChatFilterId, number> = { active: 0, mine: 0, done: 0, all: chats.length };
  for (const chat of chats) counts[chatBucket(chat)]++;
  return counts;
}

export function isChatFilter(value: unknown): value is ChatFilterId {
  return CHAT_FILTERS.some((filter) => filter.id === value);
}

export function loadChatFilter(storage: Pick<Storage, 'getItem'> | undefined): ChatFilterId {
  try {
    const value = storage?.getItem(FILTER_STORAGE_KEY);
    return isChatFilter(value) ? value : DEFAULT_CHAT_FILTER;
  } catch {
    return DEFAULT_CHAT_FILTER;
  }
}

export function saveChatFilter(
  storage: Pick<Storage, 'setItem'> | undefined,
  filter: ChatFilterId,
): void {
  try {
    storage?.setItem(FILTER_STORAGE_KEY, filter);
  } catch {
    // Storage may be blocked; the filter then lasts until reload.
  }
}

/** Text of the empty state of a filter. */
export function emptyFilterText(filter: ChatFilterId): string {
  switch (filter) {
    case 'active':
      return 'No hay chats activos ahora.';
    case 'mine':
      return 'Nada espera tu respuesta.';
    case 'done':
      return 'Todavía no hay chats terminados.';
    case 'all':
      return 'Todavía no hay chats en este proyecto.';
  }
}
