/**
 * Stale-while-revalidate cell for a slow, failure-tolerant lookup (git fetch, npm view).
 * With a previous value `get()` answers at once; once the TTL has passed it refreshes in the
 * background, one refresh at a time. Without a value the caller waits for the (shared) first load.
 */
export class SwrCell<T> {
  private cached: { value: T; at: number } | undefined;
  private inflight: Promise<T> | undefined;
  private generation = 0;

  constructor(
    private readonly load: () => Promise<T>,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(): Promise<T> {
    const cached = this.cached;
    if (cached) {
      if (this.now() - cached.at >= this.ttlMs) void this.refresh();
      return Promise.resolve(cached.value);
    }
    return this.refresh();
  }

  /** Starts the first load without waiting for it; never rejects. */
  warm(): void {
    if (!this.cached) void this.refresh();
  }

  /** Forgets the value: the next `get()` loads again. A load in flight no longer stores its result. */
  invalidate(): void {
    this.cached = undefined;
    this.inflight = undefined;
    this.generation += 1;
  }

  private refresh(): Promise<T> {
    if (this.inflight) return this.inflight;
    const generation = this.generation;
    // Through a promise chain so a loader that throws synchronously is a rejection too.
    const job = Promise.resolve()
      .then(() => this.load())
      .then((value) => {
        if (generation === this.generation) this.cached = { value, at: this.now() };
        return value;
      })
      .finally(() => {
        if (this.inflight === job) this.inflight = undefined;
      });
    this.inflight = job;
    // A background refresh nobody awaits must not leave an unhandled rejection.
    job.catch(() => undefined);
    return job;
  }
}
