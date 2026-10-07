import { describe, expect, it } from 'vitest';
import type { ChatEvent } from '@agents-panel/shared';
import { isNearTop, TOP_THRESHOLD_PX } from './scroll-logic';
import {
  nextFirstSeq,
  olderThan,
  rowsFromEvents,
  scrollTopAfterPrepend,
  shouldLoadOlder,
} from './feed-window-logic';

function prompt(seq: number, text = `m${String(seq)}`): ChatEvent {
  return { id: seq, chatId: 1, seq, type: 'user_prompt', payload: { text }, createdAt: 0 };
}

function assistant(seq: number, texts: string[]): ChatEvent {
  return {
    id: seq,
    chatId: 1,
    seq,
    type: 'assistant',
    payload: { message: { content: texts.map((text) => ({ type: 'text', text })) } },
    createdAt: 0,
  };
}

describe('feed window rows', () => {
  it('keys each row by seq and index inside the event', () => {
    const rows = rowsFromEvents([prompt(3), assistant(4, ['a', 'b'])]);
    expect(rows.map((row) => row.key)).toEqual(['3:0', '4:0', '4:1']);
  });

  it('keeps keys stable when older rows are put before', () => {
    const shown = rowsFromEvents([prompt(5), prompt(6)]).map((row) => row.key);
    const all = [
      ...rowsFromEvents([prompt(3), prompt(4)]),
      ...rowsFromEvents([prompt(5), prompt(6)]),
    ];
    expect(all.map((row) => row.key).slice(2)).toEqual(shown);
  });
});

describe('older windows', () => {
  it('drops events already shown', () => {
    expect(olderThan([prompt(3), prompt(4), prompt(5)], 5).map((e) => e.seq)).toEqual([3, 4]);
    expect(olderThan([prompt(5)], 5)).toEqual([]);
  });

  it('keeps everything when nothing is shown yet', () => {
    expect(olderThan([prompt(1)], null)).toHaveLength(1);
  });

  it('moves the cursor to the smallest seq', () => {
    expect(nextFirstSeq(5, [prompt(3), prompt(4)])).toBe(3);
    expect(nextFirstSeq(5, [])).toBe(5);
    expect(nextFirstSeq(null, [])).toBeNull();
  });
});

describe('shouldLoadOlder', () => {
  const base = { nearTop: true, loading: false, hasMore: true, firstSeq: 7 };

  it('asks when near the top with more behind', () => {
    expect(shouldLoadOlder(base)).toBe(true);
  });

  it('does not ask twice at once', () => {
    expect(shouldLoadOlder({ ...base, loading: true })).toBe(false);
  });

  it('does not ask without more, away from the top or without a cursor', () => {
    expect(shouldLoadOlder({ ...base, hasMore: false })).toBe(false);
    expect(shouldLoadOlder({ ...base, nearTop: false })).toBe(false);
    expect(shouldLoadOlder({ ...base, firstSeq: null })).toBe(false);
  });
});

describe('scroll position', () => {
  it('adds the height gained so the view does not jump', () => {
    expect(scrollTopAfterPrepend(20, 1000, 1600)).toBe(620);
  });

  it('never moves up when the height did not grow', () => {
    expect(scrollTopAfterPrepend(20, 1000, 900)).toBe(20);
  });

  it('detects the top of the feed', () => {
    expect(isNearTop({ scrollTop: 0, clientHeight: 400, scrollHeight: 5000 })).toBe(true);
    expect(isNearTop({ scrollTop: TOP_THRESHOLD_PX, clientHeight: 400, scrollHeight: 5000 })).toBe(
      true,
    );
    expect(
      isNearTop({ scrollTop: TOP_THRESHOLD_PX + 1, clientHeight: 400, scrollHeight: 5000 }),
    ).toBe(false);
  });
});
