import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = join(import.meta.dirname, '..', '..', '..');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fake repo copy plus fake `sudo`, `systemctl`, `ss` and `npm`; nothing touches the real system. */
function sandbox(options: { portBusy?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'panel-service-'));
  dirs.push(dir);
  const repo = join(dir, 'repo');
  const bin = join(dir, 'bin');
  const units = join(dir, 'units');
  const log = join(dir, 'calls.log');
  const active = join(dir, 'active');
  const enabled = join(dir, 'enabled');
  mkdirSync(join(repo, 'scripts', 'vm'), { recursive: true });
  mkdirSync(join(repo, 'apps', 'api', 'dist'), { recursive: true });
  mkdirSync(join(repo, 'apps', 'web', 'dist', 'web', 'browser'), { recursive: true });
  mkdirSync(bin);
  mkdirSync(units);
  cpSync(
    join(REPO, 'scripts', 'vm', '10-panel-service.sh'),
    join(repo, 'scripts/vm/10-panel-service.sh'),
  );
  cpSync(
    join(REPO, 'scripts', 'vm', 'agents-panel.service'),
    join(repo, 'scripts/vm/agents-panel.service'),
  );
  writeFileSync(join(repo, 'apps/api/.env'), 'PANEL_SECRET_KEY=fake\n');
  writeFileSync(join(repo, 'apps/api/dist/main.js'), '');
  writeFileSync(join(repo, 'apps/web/dist/web/browser/index.html'), '');
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub('sudo', `echo "sudo $*" >> "${log}"; exec "$@"`);
  stub('npm', `echo "npm $*" >> "${log}"`);
  stub('ss', options.portBusy ? 'echo "LISTEN 0 511 127.0.0.1:3000"' : 'exit 0');
  stub(
    'systemctl',
    `echo "systemctl $*" >> "${log}"
case "$1" in
  is-active) [ -f "${active}" ] ;;
  is-enabled) [ -f "${enabled}" ] ;;
  enable) touch "${enabled}" ;;
  start|restart) touch "${active}" ;;
esac`,
  );
  const run = (...args: string[]) =>
    execFileSync('bash', [join(repo, 'scripts/vm/10-panel-service.sh'), ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env['PATH'] ?? ''}`,
        UNIT_DIR: units,
      },
    });
  const calls = () => {
    try {
      return readFileSync(log, 'utf8').trim().split('\n');
    } catch {
      return [];
    }
  };
  return { run, calls, repo, unit: join(units, 'agents-panel.service') };
}

describe('10-panel-service.sh', () => {
  it('builds, installs the unit and starts the service; the second run changes nothing', () => {
    const { run, calls, unit, repo } = sandbox();
    run();
    expect(calls()).toContain('npm ci');
    expect(calls()).toContain('npm run build');
    expect(calls()).toContain('systemctl enable agents-panel');
    expect(calls()).toContain('systemctl start agents-panel');
    const text = readFileSync(unit, 'utf8');
    expect(text).toContain(`WorkingDirectory=${repo}/apps/api`);
    expect(text).toContain(`PANEL_WEB_DIR=${repo}/apps/web/dist/web/browser`);
    expect(text).toContain('HOST=127.0.0.1');
    expect(text).toContain('PORT=3000');
    expect(text).toContain('Restart=on-failure');
    expect(text).not.toMatch(/@(REPO|NODE|HOME)@/);

    const before = calls().length;
    const second = run();
    const after = calls().slice(before);
    expect(second).toContain('sin cambios');
    expect(second).toContain('activo, sin cambios');
    expect(readFileSync(unit, 'utf8')).toBe(text);
    expect(after.filter((c) => /restart|start|install|daemon-reload|enable /.test(c))).toEqual([]);
  });

  it('restarts only when asked (after a pull) or when the unit changed', () => {
    const { run, calls, unit } = sandbox();
    run();
    const before = calls().length;
    run('--restart');
    expect(calls().slice(before)).toContain('systemctl restart agents-panel');
    writeFileSync(unit, 'stale unit\n');
    const mid = calls().length;
    run();
    const changed = calls().slice(mid);
    expect(changed).toContain('systemctl daemon-reload');
    expect(changed).toContain('systemctl restart agents-panel');
  });

  it('refuses to install while a development server holds port 3000', () => {
    const { run, calls } = sandbox({ portBusy: true });
    expect(() => run()).toThrow();
    expect(calls().filter((c) => /install|start|enable/.test(c))).toEqual([]);
  });

  it('refuses unknown arguments and carries no secrets or CRLF', () => {
    const { run } = sandbox();
    expect(() => run('--nope')).toThrow();
    for (const file of ['10-panel-service.sh', 'agents-panel.service']) {
      const text = readFileSync(join(REPO, 'scripts', 'vm', file), 'utf8');
      expect(text).not.toContain('\r');
      expect(text).not.toMatch(/PANEL_SECRET_KEY=|PUSH_VAPID_PRIVATE_KEY=/);
    }
  });
});
