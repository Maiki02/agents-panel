import { describe, expect, it } from 'vitest';
import {
  WORKTREE_STATE_IDS,
  WORKTREE_STATE_INFO,
  type Chat,
  type ChatStatus,
} from '@agents-panel/shared';
import {
  CHAT_FILTERS,
  chatBucket,
  emptyFilterText,
  filterChats,
  filterCounts,
  loadChatFilter,
  saveChatFilter,
} from './chat-filter-logic';

const STATUSES: ChatStatus[] = ['running', 'idle', 'error', 'interrupted', 'cancelled'];

const chat = (status: ChatStatus, workState: Chat['workState'] = null) => ({ status, workState });

describe('chatBucket', () => {
  it('classifies every worktree state by who has to move', () => {
    for (const id of WORKTREE_STATE_IDS) {
      const who = WORKTREE_STATE_INFO[id].who;
      const expected =
        who === 'working' || who === 'waiting' ? 'active' : who === 'ok' ? 'done' : 'mine';
      // The session status must not matter once the chat has a fine state.
      for (const status of STATUSES) expect(chatBucket(chat(status, id))).toBe(expected);
    }
  });

  it('classifies chats without a fine state by session status', () => {
    expect(chatBucket(chat('running'))).toBe('active');
    expect(chatBucket(chat('error'))).toBe('mine');
    expect(chatBucket(chat('interrupted'))).toBe('mine');
    expect(chatBucket(chat('idle'))).toBe('done');
    expect(chatBucket(chat('cancelled'))).toBe('done');
    for (const status of STATUSES) expect(chatBucket(chat(status, undefined))).toBeDefined();
  });
});

describe('filters', () => {
  const chats = [
    chat('running'),
    chat('error'),
    chat('idle'),
    chat('running', 'esperando_aclaracion'),
    chat('idle', 'en_cola'),
  ];

  it('Todos shows everything and the others only their bucket', () => {
    expect(filterChats(chats, 'all')).toHaveLength(5);
    expect(filterChats(chats, 'active')).toHaveLength(2);
    expect(filterChats(chats, 'mine')).toHaveLength(2);
    expect(filterChats(chats, 'done')).toHaveLength(1);
  });

  it('counts each filter, and the four counts add up consistently', () => {
    const counts = filterCounts(chats);
    expect(counts).toEqual({ active: 2, mine: 2, done: 1, all: 5 });
    expect(counts.active + counts.mine + counts.done).toBe(counts.all);
  });

  it('has an empty-state text for every filter, and a filter without chats is empty', () => {
    for (const filter of CHAT_FILTERS) expect(emptyFilterText(filter.id).length).toBeGreaterThan(0);
    expect(filterChats([chat('idle')], 'mine')).toEqual([]);
  });
});

describe('persistence', () => {
  const memory = () => {
    const data = new Map<string, string>();
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    };
  };

  it('remembers the chosen filter and ignores an invalid stored value', () => {
    const storage = memory();
    expect(loadChatFilter(storage)).toBe('all');
    saveChatFilter(storage, 'mine');
    expect(loadChatFilter(storage)).toBe('mine');
    storage.setItem('chat-sidebar-filter', 'otra');
    expect(loadChatFilter(storage)).toBe('all');
  });

  it('works without storage or with a storage that throws', () => {
    expect(loadChatFilter(undefined)).toBe('all');
    expect(() => {
      saveChatFilter(undefined, 'done');
    }).not.toThrow();
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadChatFilter(broken)).toBe('all');
  });
});
