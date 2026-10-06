import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '..', '..', '..', 'scripts', 'vm', '11-claude-cuentas.sh');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fake home with a main config dir and an extra account dir; nothing touches the real ~/.claude. */
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'claude-cuentas-'));
  dirs.push(home);
  const main = join(home, '.claude');
  const extra = join(home, '.claude2');
  mkdirSync(join(main, 'projects', '-repo'), { recursive: true });
  mkdirSync(join(main, 'skills', 'kyro-work'), { recursive: true });
  writeFileSync(join(main, 'projects', '-repo', 'a.jsonl'), 'main\n');
  writeFileSync(join(main, 'settings.json'), '{"model":"sonnet"}');
  writeFileSync(join(main, 'history.jsonl'), 'h1\n');
  writeFileSync(join(main, '.credentials.json'), 'main-login');
  mkdirSync(join(extra, 'projects', '-repo', 'memory'), { recursive: true });
  mkdirSync(join(extra, 'projects', '-other'), { recursive: true });
  writeFileSync(join(extra, 'projects', '-repo', 'b.jsonl'), 'extra\n');
  writeFileSync(join(extra, 'projects', '-other', 'c.jsonl'), 'other\n');
  writeFileSync(join(extra, 'settings.json'), '{"model":"opus"}');
  writeFileSync(join(extra, 'history.jsonl'), 'h2\n');
  writeFileSync(join(extra, '.credentials.json'), 'extra-login');
  const run = () =>
    execFileSync('bash', [SCRIPT, extra], {
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  return { home, main, extra, run };
}

describe('11-claude-cuentas.sh', () => {
  it('links the shared config, merges what the extra account had and keeps its login', () => {
    const { main, extra, run } = sandbox();
    run();
    for (const name of [
      'projects',
      'skills',
      'agents',
      'plugins',
      'settings.json',
      'history.jsonl',
    ]) {
      expect(lstatSync(join(extra, name)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(extra, name))).toBe(join(main, name));
    }
    expect(readFileSync(join(main, 'projects', '-repo', 'b.jsonl'), 'utf8')).toBe('extra\n');
    expect(readFileSync(join(main, 'projects', '-other', 'c.jsonl'), 'utf8')).toBe('other\n');
    expect(existsSync(join(main, 'projects', '-repo', 'memory'))).toBe(true);
    expect(readFileSync(join(main, 'history.jsonl'), 'utf8')).toBe('h1\nh2\n');
    expect(readFileSync(join(main, 'settings.json'), 'utf8')).toBe('{"model":"sonnet"}');
    expect(readFileSync(join(extra, '.credentials.json'), 'utf8')).toBe('extra-login');
    expect(existsSync(join(extra, 'CLAUDE.md'))).toBe(false);
  });

  it('is idempotent', () => {
    const { main, run } = sandbox();
    run();
    const second = run();
    expect(second).toContain('ya enlazado: projects');
    expect(readFileSync(join(main, 'history.jsonl'), 'utf8')).toBe('h1\nh2\n');
  });
});
