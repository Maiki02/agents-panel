import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ProviderUsage } from '@agents-panel/shared';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import type { RawUsage, UsageReadParams } from '../src/usage/sdk-usage.js';
import { PASSWORD, makeApp, mutatingHeaders } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const FIXTURE: RawUsage = {
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 42, resets_at: '2026-10-06T18:00:00.000Z' },
    seven_day: { utilization: 95, resets_at: '2026-10-10T00:00:00.000Z' },
    seven_day_sonnet: { utilization: 10, resets_at: null },
  },
};

async function boot(reader: (params: UsageReadParams) => Promise<RawUsage>) {
  const made = makeApp({}, undefined, { usageReader: reader });
  app = made.app;
  await made.app.ready();
  const user = await new UserRepository(made.db).create('alice', PASSWORD);
  const { token, csrfToken } = new SessionService(made.db, {
    idleTtlSeconds: 1800,
    absoluteTtlSeconds: 43200,
  }).create(user.id);
  const headers = mutatingHeaders(`${SESSION_COOKIE}=${token}`, csrfToken);
  return { app: made.app, headers };
}

describe('GET /api/usage', () => {
  it('needs a session', async () => {
    const { app: server } = await boot(() => Promise.resolve(FIXTURE));
    expect((await server.inject({ url: '/api/usage' })).statusCode).toBe(401);
  });

  it('serves the windows of the active account read from the SDK, cached for 60 s', async () => {
    const configDirs: (string | null)[] = [];
    const { app: server, headers } = await boot(({ configDir }) => {
      configDirs.push(configDir);
      return Promise.resolve(FIXTURE);
    });
    const first = await server.inject({ url: '/api/usage', headers });
    expect(first.statusCode).toBe(200);
    const body = first.json<ProviderUsage>();
    expect(body).toMatchObject({
      provider: 'claude',
      accountId: 1,
      degraded: false,
      source: 'query',
    });
    expect(body.windows.map((w) => [w.window, w.utilization, w.tone])).toEqual([
      ['five_hour', 42, 'ok'],
      ['seven_day', 95, 'danger'],
      ['seven_day_sonnet', 10, 'ok'],
    ]);
    await server.inject({ url: '/api/usage', headers });
    expect(configDirs).toEqual([null]);
    await server.inject({ url: '/api/usage?refresh=1', headers });
    expect(configDirs).toEqual([null, null]);
  });

  it('answers 200 with empty windows and degraded when the SDK fails and nothing is stored', async () => {
    const { app: server, headers } = await boot(() => Promise.reject(new Error('no such call')));
    const res = await server.inject({ url: '/api/usage', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json<ProviderUsage>()).toMatchObject({
      windows: [],
      degraded: true,
      error: 'no such call',
    });
  });
});
