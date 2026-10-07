import { usageTone, type ProviderUsage, type UsageWindow } from '@agents-panel/shared';
import type { RawUsage, UsageReader } from './sdk-usage.js';
import type { UsageObservation, UsageRepository } from './repo.js';

export const USAGE_CACHE_MS = 60_000;
export const USAGE_READ_TIMEOUT_MS = 20_000;
const MAX_ERROR_LENGTH = 200;

/** Windows the SDK reports; anything else it adds is ignored. */
const WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'] as const;

export interface UsageAccount {
  id: number;
  configDir: string | null;
}

function toObservations(raw: RawUsage): UsageObservation[] {
  const out: UsageObservation[] = [];
  for (const name of WINDOWS) {
    const window = raw.rate_limits?.[name];
    if (!window) continue;
    const utilization =
      typeof window.utilization === 'number' && Number.isFinite(window.utilization)
        ? Math.min(100, Math.max(0, window.utilization))
        : null;
    const parsed = typeof window.resets_at === 'string' ? Date.parse(window.resets_at) : NaN;
    out.push({
      window: name,
      utilization,
      status: null,
      resetsAt: Number.isFinite(parsed) ? parsed : null,
      source: 'query',
    });
  }
  return out;
}

function shortError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}…` : text;
}

function newest(windows: UsageWindow[]): UsageWindow | null {
  let best: UsageWindow | null = null;
  for (const window of windows) {
    if (best === null || window.observedAt > best.observedAt) best = window;
  }
  return best;
}

/**
 * Usage of the Claude accounts. On demand it reads the SDK (a short session without a prompt,
 * cached 60 s, one reading in flight per account); when that is not possible it answers with the
 * last stored observation and `degraded`, never with an error.
 */
export class UsageService {
  private readonly lastQuery = new Map<number, number>();
  private readonly inFlight = new Map<number, Promise<ProviderUsage>>();

  constructor(
    private readonly repo: UsageRepository,
    private readonly reader: UsageReader,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs: number = USAGE_READ_TIMEOUT_MS,
    private readonly cacheMs: number = USAGE_CACHE_MS,
  ) {}

  /** Stored windows of the account as the API serves them (no reading). */
  stored(accountId: number, degraded: boolean, error?: string): ProviderUsage {
    const windows = this.repo.listByAccount(accountId);
    const latest = newest(windows);
    return {
      provider: 'claude',
      accountId,
      windows: windows.map((window) => ({ ...window, tone: usageTone(window) })),
      source: latest?.source ?? 'event',
      observedAt: latest?.observedAt ?? null,
      degraded,
      ...(error === undefined ? {} : { error }),
    };
  }

  async read(account: UsageAccount, options: { refresh?: boolean } = {}): Promise<ProviderUsage> {
    const at = this.lastQuery.get(account.id);
    if (!options.refresh && at !== undefined && this.now() - at < this.cacheMs) {
      return this.stored(account.id, false);
    }
    const running = this.inFlight.get(account.id);
    if (running) return running;
    const reading = this.fetch(account).finally(() => {
      this.inFlight.delete(account.id);
    });
    this.inFlight.set(account.id, reading);
    return reading;
  }

  private async fetch(account: UsageAccount): Promise<ProviderUsage> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('La lectura de uso tardó demasiado'));
        }, this.timeoutMs);
      });
      const reading = this.reader({ configDir: account.configDir, signal: controller.signal });
      // If the timeout wins, the reader's late rejection must not be unhandled.
      reading.catch(() => undefined);
      const raw = await Promise.race([reading, timeout]);
      if (!raw.rate_limits_available) {
        return this.stored(account.id, true, 'El SDK informa que no hay límites del plan');
      }
      for (const observation of toObservations(raw)) this.repo.upsert(account.id, observation);
      this.lastQuery.set(account.id, this.now());
      return this.stored(account.id, false);
    } catch (error) {
      return this.stored(account.id, true, shortError(error));
    } finally {
      clearTimeout(timer);
      // Closes the session when the reading is still pending (timeout) or already done.
      controller.abort();
    }
  }
}
