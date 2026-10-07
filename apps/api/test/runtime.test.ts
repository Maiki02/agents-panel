import { describe, expect, it } from 'vitest';
import { netRuntimeMs } from '../src/chats/runtime.js';

const MIN = 60_000;

describe('netRuntimeMs', () => {
  it('subtracts a question open 60 minutes inside a 65 minute session', () => {
    const work = [{ start: 0, end: 65 * MIN }];
    const waits = [{ start: 2 * MIN, end: 62 * MIN }];
    expect(netRuntimeMs(work, waits, 100 * MIN)).toBe(5 * MIN);
  });

  it('counts an overlapping session and step once', () => {
    const work = [
      { start: 0, end: 10 * MIN },
      { start: 5 * MIN, end: 15 * MIN },
    ];
    expect(netRuntimeMs(work, [], 100 * MIN)).toBe(15 * MIN);
  });

  it('counts open intervals up to now and an open question holds the time still', () => {
    expect(netRuntimeMs([{ start: 0, end: null }], [], 7 * MIN)).toBe(7 * MIN);
    expect(netRuntimeMs([{ start: 0, end: null }], [{ start: 3 * MIN, end: null }], 20 * MIN)).toBe(
      3 * MIN,
    );
  });

  it('does not subtract a question outside every session and never goes negative', () => {
    const work = [{ start: 10 * MIN, end: 20 * MIN }];
    expect(netRuntimeMs(work, [{ start: 30 * MIN, end: 40 * MIN }], 50 * MIN)).toBe(10 * MIN);
    expect(netRuntimeMs(work, [{ start: 0, end: 100 * MIN }], 100 * MIN)).toBe(0);
    expect(netRuntimeMs([], [{ start: 0, end: null }], 100 * MIN)).toBe(0);
  });

  it('counts overlapping questions once', () => {
    const work = [{ start: 0, end: 10 * MIN }];
    const waits = [
      { start: 2 * MIN, end: 6 * MIN },
      { start: 4 * MIN, end: 8 * MIN },
    ];
    expect(netRuntimeMs(work, waits, 100 * MIN)).toBe(4 * MIN);
  });
});
