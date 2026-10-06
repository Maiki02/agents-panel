import { describe, expect, it } from 'vitest';
import { FOLLOW_THRESHOLD_PX, isNearBottom } from './scroll-logic';

describe('chat feed scroll', () => {
  it('follows new events when the feed is at its end', () => {
    expect(isNearBottom({ scrollTop: 600, clientHeight: 400, scrollHeight: 1000 })).toBe(true);
  });

  it('follows when the user is a little above the end', () => {
    expect(
      isNearBottom({
        scrollTop: 600 - FOLLOW_THRESHOLD_PX,
        clientHeight: 400,
        scrollHeight: 1000,
      }),
    ).toBe(true);
  });

  it('does not move the feed when the user scrolled up to read', () => {
    expect(
      isNearBottom({
        scrollTop: 600 - FOLLOW_THRESHOLD_PX - 1,
        clientHeight: 400,
        scrollHeight: 1000,
      }),
    ).toBe(false);
    expect(isNearBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 5000 })).toBe(false);
  });

  it('counts a feed shorter than its box as at the end', () => {
    expect(isNearBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 300 })).toBe(true);
  });

  it('accepts a custom threshold', () => {
    expect(isNearBottom({ scrollTop: 500, clientHeight: 400, scrollHeight: 1000 }, 50)).toBe(false);
    expect(isNearBottom({ scrollTop: 500, clientHeight: 400, scrollHeight: 1000 }, 100)).toBe(true);
  });
});
