import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ConfigError, loadConfig } from '../src/config.js';
import { ORIGIN, PASSWORD, TEST_ENV, makeApp } from './helpers.js';

const SCRIPT = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'scripts',
  'vm',
  '09-tailscale-funnel.sh',
);
const FUNNEL = 'https://vm-ia.tail1234.ts.net';

let app: FastifyInstance | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await app?.close();
  app = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('PANEL_EXTRA_ORIGINS', () => {
  it('adds the Funnel origin next to the main one, normalized and without duplicates', () => {
    expect(loadConfig(TEST_ENV).allowedOrigins).toEqual([ORIGIN]);
    const config = loadConfig({
      ...TEST_ENV,
      PANEL_EXTRA_ORIGINS: ` ${FUNNEL}/some/path , ${ORIGIN} `,
    });
    expect(config.allowedOrigins).toEqual([ORIGIN, FUNNEL]);
    expect(config.origin).toBe(ORIGIN);
  });

  it('refuses a value that is not an http(s) URL', () => {
    for (const bad of ['not a url', 'ftp://x.example', `${FUNNEL},nope`]) {
      expect(() => loadConfig({ ...TEST_ENV, PANEL_EXTRA_ORIGINS: bad })).toThrow(ConfigError);
    }
  });

  it('accepts a write from the Funnel origin and still refuses a foreign one', async () => {
    const made = makeApp({ PANEL_EXTRA_ORIGINS: FUNNEL });
    app = made.app;
    await app.ready();
    const login = (origin: string) =>
      made.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin },
        payload: { username: 'nobody', password: PASSWORD },
      });
    expect((await login(FUNNEL)).statusCode).not.toBe(403);
    expect((await login(ORIGIN)).statusCode).not.toBe(403);
    expect((await login('https://evil.example')).statusCode).toBe(403);
  });
});

/** Fake `sudo`, `tailscale`, `systemctl` and `apt-get`: they log the calls and keep Funnel state in a file. */
function sandbox(options: { loggedIn: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'panel-funnel-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  const log = join(dir, 'calls.log');
  const state = join(dir, 'funnel.state');
  mkdirSync(bin);
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub('sudo', `echo "sudo $*" >> "${log}"; exec "$@"`);
  stub('systemctl', `echo "systemctl $*" >> "${log}"`);
  stub('apt-get', `echo "apt-get $*" >> "${log}"`);
  stub(
    'tailscale',
    `case "$1 $2" in
  "version "*) echo 1.80.0 ;;
  "status "*) ${options.loggedIn ? 'exit 0' : 'exit 1'} ;;
  "funnel status") if [ -f "${state}" ]; then cat "${state}"; else echo "No serve config"; fi ;;
  "funnel --bg")
    echo "tailscale funnel --bg $3" >> "${log}"
    printf '${FUNNEL} (Funnel on)\\n|-- / proxy http://127.0.0.1:%s\\n' "$3" > "${state}" ;;
esac`,
  );
  const run = (...args: string[]) =>
    execFileSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` },
    });
  const calls = () => {
    try {
      return readFileSync(log, 'utf8').trim().split('\n');
    } catch {
      return [];
    }
  };
  return { run, calls };
}

describe('09-tailscale-funnel.sh', () => {
  it('publishes the web port once and changes nothing on the second run', () => {
    const { run, calls } = sandbox({ loggedIn: true });
    const first = run();
    expect(first).toContain(`FUNNEL_URL=${FUNNEL}`);
    expect(calls().filter((c) => c.startsWith('tailscale funnel --bg'))).toEqual([
      'tailscale funnel --bg 3000',
    ]);
    const before = calls().length;
    const second = run();
    expect(second).toContain('ya publicado');
    expect(second.trim().split('\n').at(-1)).toBe(`FUNNEL_URL=${FUNNEL}`);
    expect(
      calls()
        .slice(before)
        .filter((c) => c.includes('funnel --bg')),
    ).toEqual([]);
  });

  it('without a login it enables the service, asks for `tailscale up` and publishes nothing', () => {
    const { run, calls } = sandbox({ loggedIn: false });
    const out = run();
    expect(out).toContain('sudo tailscale up');
    expect(out.trim().split('\n').at(-1)).toBe('FUNNEL_URL=');
    expect(calls()).toContain('systemctl enable --now tailscaled');
    expect(calls().some((c) => c.includes('funnel'))).toBe(false);
  });

  it('takes the port as an argument and refuses a bad one before touching anything', () => {
    const { run, calls } = sandbox({ loggedIn: true });
    expect(run('8080')).toContain('proxy http://127.0.0.1:8080');
    expect(() => run('web')).toThrow();
    expect(calls().filter((c) => c.includes('web'))).toEqual([]);
  });

  it('carries no auth key or token', () => {
    const text = readFileSync(SCRIPT, 'utf8');
    expect(text).not.toMatch(/tskey-|--auth-key|authkey=/i);
    expect(text).not.toContain('\r');
  });
});
