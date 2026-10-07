import { describe, expect, it } from 'vitest';
import { SwrCache, clearAllSwrCaches } from './swr-cache';

describe('SwrCache', () => {
  it('has nothing the first time, then returns the previous value while the new one loads', async () => {
    const cache = new SwrCache<string>();
    expect(cache.peek()).toBeUndefined();
    await cache.load(() => Promise.resolve('old'));
    let release: (value: string) => void = () => undefined;
    const pending = cache.load(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    expect(cache.peek()).toBe('old');
    release('new');
    await pending;
    expect(cache.peek()).toBe('new');
  });

  it('keeps one entry per key', async () => {
    const cache = new SwrCache<number>();
    await cache.load(() => Promise.resolve(1), 'a');
    await cache.load(() => Promise.resolve(2), 'b');
    expect(cache.peek('a')).toBe(1);
    expect(cache.peek('b')).toBe(2);
    cache.invalidate('a');
    expect(cache.peek('a')).toBeUndefined();
    expect(cache.peek('b')).toBe(2);
  });

  it('an action invalidates it, even for an answer already in flight', async () => {
    const cache = new SwrCache<string>();
    await cache.load(() => Promise.resolve('old'));
    let release: (value: string) => void = () => undefined;
    const pending = cache.load(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    cache.invalidate();
    expect(cache.peek()).toBeUndefined();
    release('late');
    expect(await pending).toBe('late');
    expect(cache.peek()).toBeUndefined();
  });

  it('closing the session empties every cache', async () => {
    const a = new SwrCache<string>();
    const b = new SwrCache<string>();
    await a.load(() => Promise.resolve('x'));
    await b.load(() => Promise.resolve('y'), 'k');
    clearAllSwrCaches();
    expect(a.peek()).toBeUndefined();
    expect(b.peek('k')).toBeUndefined();
  });

  it('does not store a failed load', async () => {
    const cache = new SwrCache<string>();
    await cache.load(() => Promise.resolve('kept'));
    await expect(cache.load(() => Promise.reject(new Error('down')))).rejects.toThrow('down');
    expect(cache.peek()).toBe('kept');
  });
});
