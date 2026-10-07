import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { UsageRepository } from '../src/usage/repo.js';
import {
  createUsageReader,
  type RawUsage,
  type UsageReadParams,
  type UsageReader,
  type UsageSessionOpener,
} from '../src/usage/sdk-usage.js';
import { UsageService } from '../src/usage/service.js';

const FIXTURE: RawUsage = {
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 42, resets_at: '2026-10-06T18:00:00.000Z' },
    seven_day: { utilization: 75, resets_at: '2026-10-10T00:00:00.000Z' },
    seven_day_opus: { utilization: 95, resets_at: null },
    seven_day_sonnet: null,
  },
};

function setup(reader: UsageReader, timeoutMs = 50) {
  const db = openDatabase(':memory:');
  db.prepare(
    "INSERT INTO claude_accounts (name, config_dir, active, created_at) VALUES ('Segunda', '/tmp/c2', 0, 1)",
  ).run();
  let now = 1_000_000;
  const repo = new UsageRepository(db, () => now);
  const service = new UsageService(repo, reader, () => now, timeoutMs);
  return {
    repo,
    service,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function fakeSession(
  usage: (signal: AbortSignal) => Promise<unknown>,
  log: string[],
): UsageSessionOpener {
  return ({ options }) => {
    log.push(`env:${options.env['CLAUDE_CONFIG_DIR'] ?? 'unset'}`);
    return {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => {
        log.push('usage');
        return usage(options.abortController.signal);
      },
      interrupt: () => {
        log.push('interrupt');
        return Promise.resolve();
      },
      close: () => {
        log.push('close');
      },
    };
  };
}

describe('createUsageReader', () => {
  it('reads with the account env and closes the session', async () => {
    const log: string[] = [];
    const reader = createUsageReader(fakeSession(() => Promise.resolve(FIXTURE), log));
    const raw = await reader({ configDir: '/tmp/c2', signal: new AbortController().signal });
    expect(raw).toBe(FIXTURE);
    expect(log).toEqual(['env:/tmp/c2', 'usage', 'interrupt', 'close']);
  });

  it('removes CLAUDE_CONFIG_DIR for the default account', async () => {
    const log: string[] = [];
    const previous = process.env['CLAUDE_CONFIG_DIR'];
    process.env['CLAUDE_CONFIG_DIR'] = '/tmp/other';
    try {
      const reader = createUsageReader(fakeSession(() => Promise.resolve(FIXTURE), log));
      await reader({ configDir: null, signal: new AbortController().signal });
    } finally {
      if (previous === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
      else process.env['CLAUDE_CONFIG_DIR'] = previous;
    }
    expect(log[0]).toBe('env:unset');
  });

  it('closes the session also when the call fails', async () => {
    const log: string[] = [];
    const reader = createUsageReader(fakeSession(() => Promise.reject(new Error('gone')), log));
    await expect(reader({ configDir: null, signal: new AbortController().signal })).rejects.toThrow(
      'gone',
    );
    expect(log).toEqual(['env:unset', 'usage', 'interrupt', 'close']);
  });

  it('closes the session when the service times out', async () => {
    const log: string[] = [];
    // Like the SDK, the pending call rejects when its abort controller fires.
    const reader = createUsageReader(
      fakeSession(
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          }),
        log,
      ),
    );
    const { service } = setup(reader, 10);
    const usage = await service.read({ id: 1, configDir: null });
    expect(usage.degraded).toBe(true);
    expect(log).toContain('close');
  });
});

const MAIN = { id: 1, configDir: null };
const SECOND = { id: 2, configDir: '/tmp/c2' };

describe('UsageService', () => {
  it('maps the SDK windows with utilization, resetsAt, tone and source query', async () => {
    const { service } = setup(() => Promise.resolve(FIXTURE));
    const usage = await service.read(MAIN);
    expect(usage.degraded).toBe(false);
    expect(usage.source).toBe('query');
    expect(usage.windows.map((w) => [w.window, w.utilization, w.tone, w.source])).toEqual([
      ['five_hour', 42, 'ok', 'query'],
      ['seven_day', 75, 'warn', 'query'],
      ['seven_day_opus', 95, 'danger', 'query'],
    ]);
    expect(usage.windows[0]?.resetsAt).toBe(Date.parse('2026-10-06T18:00:00.000Z'));
    expect(usage.windows[2]?.resetsAt).toBeNull();
  });

  it('launches one reading for two requests within 60 s and refresh forces another', async () => {
    let calls = 0;
    const { service, advance } = setup(() => {
      calls++;
      return Promise.resolve(FIXTURE);
    });
    await service.read(MAIN);
    advance(59_000);
    await service.read(MAIN);
    expect(calls).toBe(1);
    await service.read(MAIN, { refresh: true });
    expect(calls).toBe(2);
    advance(61_000);
    await service.read(MAIN);
    expect(calls).toBe(3);
  });

  it('shares one reading in flight per account', async () => {
    let calls = 0;
    let release: (raw: RawUsage) => void = () => undefined;
    const { service } = setup(() => {
      calls++;
      return new Promise<RawUsage>((resolve) => {
        release = resolve;
      });
    }, 1000);
    const first = service.read(MAIN);
    const second = service.read(MAIN, { refresh: true });
    release(FIXTURE);
    expect((await first).windows).toHaveLength(3);
    expect((await second).windows).toHaveLength(3);
    expect(calls).toBe(1);
  });

  it('answers with the last stored data and degraded when the reading throws', async () => {
    const { service, repo, advance } = setup(() => Promise.reject(new Error('unknown method')));
    repo.upsert(1, {
      window: 'five_hour',
      utilization: 30,
      status: 'allowed',
      resetsAt: 5,
      source: 'event',
    });
    advance(10_000);
    const usage = await service.read(MAIN);
    expect(usage).toMatchObject({
      degraded: true,
      error: 'unknown method',
      source: 'event',
      observedAt: 1_000_000,
    });
    expect(usage.windows).toHaveLength(1);
  });

  it('degrades when the reading takes too long and aborts it', async () => {
    let signal: AbortSignal | undefined;
    const { service } = setup((params: UsageReadParams) => {
      signal = params.signal;
      return new Promise<RawUsage>(() => undefined);
    }, 10);
    const usage = await service.read(MAIN);
    expect(usage.degraded).toBe(true);
    expect(usage.error).toContain('tardó');
    expect(signal?.aborted).toBe(true);
  });

  it('degrades when rate_limits_available is false and keeps what was stored', async () => {
    const { service, repo } = setup(() =>
      Promise.resolve({ rate_limits_available: false, rate_limits: null }),
    );
    repo.upsert(1, {
      window: 'seven_day',
      utilization: 10,
      status: null,
      resetsAt: null,
      source: 'event',
    });
    const usage = await service.read(MAIN);
    expect(usage.degraded).toBe(true);
    expect(usage.windows.map((w) => w.window)).toEqual(['seven_day']);
    // A failed reading does not fill the cache: the next request tries again.
    expect(usage.source).toBe('event');
  });

  it('without data answers empty windows and degraded, never an error', async () => {
    const { service } = setup(() => Promise.reject(new Error('boom')));
    const usage = await service.read(MAIN);
    expect(usage).toMatchObject({ windows: [], degraded: true, observedAt: null });
  });

  it('retries after a failure instead of caching it', async () => {
    let calls = 0;
    const { service } = setup(() => {
      calls++;
      return calls === 1 ? Promise.reject(new Error('x')) : Promise.resolve(FIXTURE);
    });
    expect((await service.read(MAIN)).degraded).toBe(true);
    expect((await service.read(MAIN)).degraded).toBe(false);
  });

  it('reads with the configDir of the account and never mixes accounts', async () => {
    const seen: (string | null)[] = [];
    const { service } = setup(({ configDir }) => {
      seen.push(configDir);
      return Promise.resolve(
        configDir === null
          ? FIXTURE
          : {
              rate_limits_available: true,
              rate_limits: { five_hour: { utilization: 5, resets_at: null } },
            },
      );
    });
    const main = await service.read(MAIN);
    const second = await service.read(SECOND);
    expect(seen).toEqual([null, '/tmp/c2']);
    expect(main.windows).toHaveLength(3);
    expect(second.windows.map((w) => [w.window, w.utilization])).toEqual([['five_hour', 5]]);
    expect(second.accountId).toBe(2);
  });
});
