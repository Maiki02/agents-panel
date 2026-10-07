import { kyroPendingCommit } from './git.js';

const DEFAULT_TTL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 3_000;

export interface KyroPendingCacheOptions {
  compute?: (repoPath: string) => Promise<boolean>;
  ttlMs?: number;
  /** Longest a listing waits for one project's git status; past it the answer is `false`. */
  timeoutMs?: number;
  now?: () => number;
}

/**
 * `kyroPendingCommit` per clone, cached for a few seconds so listing projects does not run
 * `git status` on every load. Concurrent reads share one computation; an action that changes the
 * Kyro state of a clone calls `invalidate`.
 */
export class KyroPendingCache {
  private readonly compute: (repoPath: string) => Promise<boolean>;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly values = new Map<string, { value: boolean; at: number }>();
  private readonly inflight = new Map<string, Promise<boolean>>();
  private generation = 0;

  constructor(options: KyroPendingCacheOptions = {}) {
    this.compute = options.compute ?? kyroPendingCommit;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  async get(repoPath: string): Promise<boolean> {
    const hit = this.values.get(repoPath);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    let job = this.inflight.get(repoPath);
    if (!job) {
      const generation = this.generation;
      const started = this.compute(repoPath)
        .catch(() => false)
        .then((value) => {
          if (generation === this.generation) {
            this.values.set(repoPath, { value, at: this.now() });
          }
          return value;
        })
        .finally(() => {
          if (this.inflight.get(repoPath) === started) this.inflight.delete(repoPath);
        });
      this.inflight.set(repoPath, started);
      job = started;
    }
    return this.withTimeout(job);
  }

  /** Drops one clone (or every one) so the next read runs git again. */
  invalidate(repoPath?: string): void {
    this.generation += 1;
    this.inflight.clear();
    if (repoPath === undefined) this.values.clear();
    else this.values.delete(repoPath);
  }

  private withTimeout(job: Promise<boolean>): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, this.timeoutMs);
      void job.then((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }
}
