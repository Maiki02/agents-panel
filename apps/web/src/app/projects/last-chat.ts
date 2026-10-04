/** Pure helpers behind "remember the selected chat per project" (R30). No Angular, no globals. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ChatSelection {
  projectId: number;
  chat: number | 'new';
}

export function lastChatKey(projectId: number): string {
  return `agents-panel:last-chat:${String(projectId)}`;
}

/** A stored value is a chat id only when it is a positive integer; anything else is ignored. */
export function parseChatId(raw: string | null): number | null {
  if (raw === null || !/^[1-9]\d{0,9}$/.test(raw)) return null;
  return Number(raw);
}

/** Never throws: without storage (private window, blocked data) there is simply no memory. */
export function readLastChat(storage: StorageLike | null, projectId: number): number | null {
  try {
    return parseChatId(storage?.getItem(lastChatKey(projectId)) ?? null);
  } catch {
    return null;
  }
}

/** `null` forgets the selection (the user went back to "Nuevo chat"). */
export function writeLastChat(
  storage: StorageLike | null,
  projectId: number,
  chatId: number | null,
): void {
  try {
    if (chatId === null) storage?.removeItem(lastChatKey(projectId));
    else storage?.setItem(lastChatKey(projectId), String(chatId));
  } catch {
    // Storage is a convenience only: the app works the same without it.
  }
}

/** The chat route of a project: a given chat, or the new-chat form. */
export function chatsPath(projectId: number, chatId: number | null): string {
  return `/projects/${String(projectId)}/chats/${chatId === null ? 'new' : String(chatId)}`;
}

/** Reads the project and chat out of a URL like /projects/3/chats/12 or /projects/3/chats/new. */
export function selectionFromUrl(url: string): ChatSelection | null {
  const match = /^\/projects\/([1-9]\d*)\/chats\/(new|[1-9]\d*)(?:[/?#]|$)/.exec(url);
  if (!match) return null;
  const projectId = Number(match[1]);
  return { projectId, chat: match[2] === 'new' ? 'new' : Number(match[2]) };
}
