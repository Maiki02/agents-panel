import { signal } from '@angular/core';

/** Every live cache, so closing the session can empty all of them at once. */
const registry = new Set<SwrCache<unknown>>();

/** Empties every cache: called when the session ends so no data of it shows up in the next one. */
export function clearAllSwrCaches(): void {
  for (const cache of registry) cache.clear();
}

/**
 * In-memory stale-while-revalidate cache, one entry per key. A screen reads `peek` to paint the
 * last known answer at once and calls `load` to fetch the new one, which replaces it. Nothing is
 * written to localStorage: a reload of the page starts empty.
 */
export class SwrCache<T> {
  private readonly entries = signal<ReadonlyMap<string, T>>(new Map());
  /** Bumped by invalidate/clear so an answer that was already in flight cannot bring old data back. */
  private generation = 0;

  constructor() {
    registry.add(this);
  }

  /** The last known value for the key, or undefined the first time. Reactive when read in a computed. */
  peek(key = ''): T | undefined {
    return this.entries().get(key);
  }

  /** Runs the fetcher and stores its answer, unless the entry was invalidated meanwhile. */
  async load(fetcher: () => Promise<T>, key = ''): Promise<T> {
    const generation = this.generation;
    const value = await fetcher();
    if (generation === this.generation) this.set(value, key);
    return value;
  }

  set(value: T, key = ''): void {
    this.entries.update((entries) => new Map(entries).set(key, value));
  }

  /** An action changed the data: the old answer is dropped so the next visit does not show it. */
  invalidate(key?: string): void {
    this.generation += 1;
    if (key === undefined) {
      this.entries.set(new Map());
      return;
    }
    this.entries.update((entries) => {
      const next = new Map(entries);
      next.delete(key);
      return next;
    });
  }

  clear(): void {
    this.invalidate();
  }
}
