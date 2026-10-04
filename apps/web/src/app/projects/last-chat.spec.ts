import { describe, expect, it } from 'vitest';
import {
  chatsPath,
  lastChatKey,
  parseChatId,
  readLastChat,
  selectionFromUrl,
  writeLastChat,
  type StorageLike,
} from './last-chat';

function memory(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

const broken: StorageLike = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

describe('last chat memory', () => {
  it('stores and returns the last chat per project', () => {
    const storage = memory();
    writeLastChat(storage, 1, 12);
    writeLastChat(storage, 2, 40);
    expect(readLastChat(storage, 1)).toBe(12);
    expect(readLastChat(storage, 2)).toBe(40);
    expect(readLastChat(storage, 3)).toBeNull();
  });

  it('forgets the selection when asked (back to "Nuevo chat")', () => {
    const storage = memory();
    writeLastChat(storage, 1, 12);
    writeLastChat(storage, 1, null);
    expect(readLastChat(storage, 1)).toBeNull();
  });

  it.each(['', 'abc', '0', '-3', '1.5', '12abc', ' 4', '99999999999'])(
    'ignores the invalid stored value %j',
    (raw) => {
      const storage = memory();
      storage.setItem(lastChatKey(1), raw);
      expect(readLastChat(storage, 1)).toBeNull();
      expect(parseChatId(raw)).toBeNull();
    },
  );

  it('does not fail without storage or when it throws', () => {
    expect(readLastChat(null, 1)).toBeNull();
    expect(readLastChat(broken, 1)).toBeNull();
    expect(() => {
      writeLastChat(null, 1, 5);
    }).not.toThrow();
    expect(() => {
      writeLastChat(broken, 1, 5);
    }).not.toThrow();
  });
});

describe('selectionFromUrl / chatsPath', () => {
  it('reads the project and chat from the chat routes', () => {
    expect(selectionFromUrl('/projects/3/chats/12')).toEqual({ projectId: 3, chat: 12 });
    expect(selectionFromUrl('/projects/3/chats/new')).toEqual({ projectId: 3, chat: 'new' });
    expect(selectionFromUrl('/projects/3/chats/12?x=1')).toEqual({ projectId: 3, chat: 12 });
  });

  it('ignores other routes', () => {
    for (const url of [
      '/',
      '/versions',
      '/projects/3',
      '/projects/3/settings/general',
      '/projects/0/chats/1',
      '/projects/3/chats/x',
      '/projects/3/chats/12abc',
    ]) {
      expect(selectionFromUrl(url), url).toBeNull();
    }
  });

  it('builds the chat path', () => {
    expect(chatsPath(3, 12)).toBe('/projects/3/chats/12');
    expect(chatsPath(3, null)).toBe('/projects/3/chats/new');
  });
});
