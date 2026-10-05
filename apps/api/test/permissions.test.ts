import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TOOLS,
  FIXED_DENIED_COMMANDS,
  PermissionConfigError,
  checkBash,
  decide,
  validateProjectPermissions,
  type BashExtras,
} from '../src/agent/permissions.js';

const cwd = '/tmp/wt/a';
const extras = (partial: Partial<BashExtras> = {}): BashExtras => ({
  commands: [],
  hosts: [],
  ...partial,
});
const verdict = (command: string, e: BashExtras = extras()) => checkBash(command, cwd, e).behavior;

describe('curl in restricted mode', () => {
  it('allows GET and HEAD to localhost and to a host of the policy', () => {
    expect(verdict('curl http://localhost:3000/health')).toBe('allow');
    expect(verdict('curl -s -S http://127.0.0.1:8080/api/x')).toBe('allow');
    expect(verdict('curl -sS --max-time 5 https://localhost/x')).toBe('allow');
    expect(verdict('curl -I http://localhost')).toBe('allow');
    expect(verdict('curl https://api.example.com/v1', extras({ hosts: ['api.example.com'] }))).toBe(
      'allow',
    );
    expect(verdict('curl http://localhost:3000/x | head -5')).toBe('allow');
  });

  it('denies a host that is not listed, also with look-alike hosts', () => {
    expect(verdict('curl https://api.example.com/v1')).toBe('deny');
    const e = extras({ hosts: ['api.example.com'] });
    expect(verdict('curl https://api.example.com.evil.io/v1', e)).toBe('deny');
    expect(verdict('curl https://evil.io/api.example.com', e)).toBe('deny');
    expect(verdict('curl http://localhost.evil.io/', e)).toBe('deny');
    expect(verdict('curl http://[::1]:3000/', e)).toBe('deny');
  });

  it.each([
    'curl -L http://localhost',
    'curl --location http://localhost',
    'curl -d x=1 http://localhost',
    'curl --data x=1 http://localhost',
    'curl --data-binary x http://localhost',
    'curl --data-raw x http://localhost',
    'curl --json x http://localhost',
    'curl -F a=b http://localhost',
    'curl --form a=b http://localhost',
    'curl -T file http://localhost',
    'curl --upload-file f http://localhost',
    'curl -X POST http://localhost',
    'curl -XPOST http://localhost',
    'curl --request POST http://localhost',
    'curl -o out http://localhost',
    'curl -O http://localhost/f',
    'curl --output out http://localhost',
    'curl -K cfg http://localhost',
    'curl --config cfg http://localhost',
    'curl -sLo out http://localhost',
    'curl -d @file http://localhost',
    'curl http://user:pass@localhost/',
    'curl http://localhost@evil.io/',
    'curl --unknown-flag http://localhost',
    'curl -H "X: y" http://localhost',
  ])('denies %s', (command) => {
    expect(verdict(command)).toBe('deny');
  });

  it('denies non-http schemes, missing URLs, variables and chained extras', () => {
    expect(verdict('curl file:///etc/passwd')).toBe('deny');
    expect(verdict('curl ftp://localhost/x')).toBe('deny');
    expect(verdict('curl localhost:3000')).toBe('deny');
    expect(verdict('curl')).toBe('deny');
    expect(verdict('curl -s')).toBe('deny');
    expect(verdict('curl http://$HOST/')).toBe('deny');
    expect(verdict('curl http://localhost && curl https://evil.io')).toBe('deny');
    expect(verdict('curl --max-time abc http://localhost')).toBe('deny');
  });

  it('is never in the auto-approved tools and works through decide()', () => {
    expect(ALLOWED_TOOLS.join(' ')).not.toContain('curl');
    expect(decide({ cwd }, 'Bash', { command: 'curl http://localhost:4000' }).behavior).toBe(
      'allow',
    );
    expect(
      decide({ cwd }, 'Bash', { command: 'curl -X DELETE http://localhost:4000' }).behavior,
    ).toBe('deny');
  });
});

describe('fixed denied commands', () => {
  it.each(FIXED_DENIED_COMMANDS)('denies %s even when the project lists it', (name) => {
    expect(verdict(`${name} --help`)).toBe('deny');
    expect(verdict(`git status && ${name} x`, extras({ commands: [name] }))).toBe('deny');
    expect(verdict(`git log | ${name}`, extras({ commands: [name] }))).toBe('deny');
  });

  it('says the command is never allowed', () => {
    const result = checkBash('oci compute instance list', cwd, extras({ commands: ['oci'] }));
    expect(result).toMatchObject({ behavior: 'deny' });
    expect(result.behavior === 'deny' && result.message).toContain('never allowed');
  });
});

describe('project Bash commands', () => {
  it('allows a configured command and denies it without the configuration', () => {
    expect(verdict('uv run pytest', extras({ commands: ['uv'] }))).toBe('allow');
    expect(verdict('uv run pytest')).toBe('deny');
    expect(verdict('uv run pytest && rm -rf x', extras({ commands: ['uv'] }))).toBe('deny');
  });

  it('keeps the base unchanged', () => {
    for (const command of [
      'git status',
      'gh pr list',
      'npm test',
      'go test ./...',
      'kyro status',
    ]) {
      expect(verdict(command)).toBe('allow');
    }
    expect(verdict('python x.py')).toBe('deny');
    expect(verdict('ls', extras())).toBe('allow');
  });
});

describe('validateProjectPermissions', () => {
  it('accepts simple names and hosts and normalizes them', () => {
    expect(
      validateProjectPermissions({
        commands: ['uv', 'pytest', 'uv', 'python3.12', 'cargo-nextest'],
        hosts: ['API.Example.com', 'localhost', 'api.example.com'],
      }),
    ).toEqual({
      commands: ['uv', 'pytest', 'python3.12', 'cargo-nextest'],
      hosts: ['api.example.com', 'localhost'],
    });
  });

  it.each([
    '/usr/bin/uv',
    './uv',
    '../uv',
    'uv run',
    'uv;rm',
    'uv|cat',
    'uv&',
    '$(id)',
    '`id`',
    'uv>x',
    '',
    '-rf',
    'a'.repeat(51),
  ])('rejects the command name %j', (name) => {
    expect(() => validateProjectPermissions({ commands: [name], hosts: [] })).toThrow(
      PermissionConfigError,
    );
  });

  it('rejects base commands and fixed denied ones', () => {
    for (const name of [
      'git',
      'npm',
      'kyro',
      'ls',
      'cat',
      'head',
      'curl',
      'cd',
      'sudo',
      'ssh',
      'oci',
    ]) {
      expect(() => validateProjectPermissions({ commands: [name], hosts: [] }), name).toThrow(
        PermissionConfigError,
      );
    }
  });

  it.each([
    'http://example.com',
    'example.com/path',
    'example.com:8080',
    'exa mple.com',
    '-bad.com',
    'bad-.com',
    '..',
    '',
    'a@b.com',
    '*.example.com',
    '[::1]',
  ])('rejects the host %j', (host) => {
    expect(() => validateProjectPermissions({ commands: [], hosts: [host] })).toThrow(
      PermissionConfigError,
    );
  });

  it('limits how many entries a project can add', () => {
    const many = Array.from({ length: 51 }, (_, i) => `tool${String(i)}`);
    expect(() => validateProjectPermissions({ commands: many, hosts: [] })).toThrow(
      PermissionConfigError,
    );
  });
});
