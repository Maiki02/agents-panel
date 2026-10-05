import { describe, expect, it } from 'vitest';
import type { PermissionSuggestion } from '@agents-panel/shared';
import {
  applySuggestion,
  commandProblem,
  hostProblem,
  permissionsChanged,
  remainingSuggestions,
  withItem,
  withoutItem,
} from './permissions-logic';

const permissions = {
  base: ['git', 'gh', 'npm', 'go', 'kyro', 'ls', 'cat', 'head'],
  fixedDenied: ['oci', 'sudo', 'ssh', 'tailscale', 'terraform', 'wget'],
  curlBaseHosts: ['localhost', '127.0.0.1'],
};

describe('commandProblem', () => {
  it('accepts a simple name', () => {
    expect(commandProblem('uv', permissions, [])).toBeNull();
    expect(commandProblem('  python3.12 ', permissions, [])).toBeNull();
    expect(commandProblem('cargo-nextest', permissions, ['uv'])).toBeNull();
  });

  it.each(['/usr/bin/uv', './uv', 'uv run', 'uv;ls', 'a|b', '$(id)', '`id`', 'a>b', '-rf', ''])(
    'rejects %j',
    (name) => {
      expect(commandProblem(name, permissions, [])).not.toBeNull();
    },
  );

  it('explains that fixed denied commands cannot be enabled', () => {
    for (const name of permissions.fixedDenied) {
      expect(commandProblem(name, permissions, [])).toContain('no se puede habilitar');
    }
  });

  it('rejects the base, curl and cd, and a name already in the list', () => {
    expect(commandProblem('git', permissions, [])).toContain('base');
    expect(commandProblem('ls', permissions, [])).toContain('base');
    expect(commandProblem('curl', permissions, [])).toContain('base');
    expect(commandProblem('cd', permissions, [])).toContain('base');
    expect(commandProblem('uv', permissions, ['uv'])).toContain('ya está');
  });

  it('limits the list to 50 names', () => {
    const full = Array.from({ length: 50 }, (_, i) => `tool${String(i)}`);
    expect(commandProblem('uv', permissions, full)).toContain('50');
  });
});

describe('hostProblem', () => {
  it('accepts a hostname and ignores case', () => {
    expect(hostProblem('api.example.com', permissions, [])).toBeNull();
    expect(hostProblem('API.Example.com', permissions, [])).toBeNull();
    expect(hostProblem('db', permissions, [])).toBeNull();
  });

  it.each([
    'https://example.com',
    'example.com/path',
    'example.com:8080',
    'exa mple.com',
    '-bad.com',
    'bad-.com',
    'a@b.com',
    '*.example.com',
    'bad_host.com',
    '',
  ])('rejects %j', (host) => {
    expect(hostProblem(host, permissions, [])).not.toBeNull();
  });

  it('rejects the hosts curl already reaches and repeated ones', () => {
    expect(hostProblem('localhost', permissions, [])).toContain('ya está permitido');
    expect(hostProblem('127.0.0.1', permissions, [])).toContain('ya está permitido');
    expect(hostProblem('API.example.com', permissions, ['api.example.com'])).toContain('ya está');
  });
});

describe('lists and suggestions', () => {
  const uv: PermissionSuggestion = { file: 'uv.lock', commands: ['uv', 'python', 'pytest'] };
  const make: PermissionSuggestion = { file: 'Makefile', commands: ['make'] };

  it('adds an item once and removes it', () => {
    expect(withItem(['a'], 'b')).toEqual(['a', 'b']);
    expect(withItem(['a', 'b'], 'b')).toEqual(['a', 'b']);
    expect(withoutItem(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('applying a suggestion never repeats a command already present', () => {
    expect(applySuggestion([], uv)).toEqual(['uv', 'python', 'pytest']);
    expect(applySuggestion(['python', 'make'], uv)).toEqual(['python', 'make', 'uv', 'pytest']);
    expect(applySuggestion(applySuggestion([], uv), uv)).toEqual(['uv', 'python', 'pytest']);
  });

  it('hides what the draft already has and drops a suggestion left empty', () => {
    expect(remainingSuggestions([uv, make], [])).toEqual([uv, make]);
    expect(remainingSuggestions([uv, make], ['uv', 'make'])).toEqual([
      { file: 'uv.lock', commands: ['python', 'pytest'] },
    ]);
    expect(remainingSuggestions([uv], ['uv', 'python', 'pytest'])).toEqual([]);
  });

  it('tells whether the draft differs from what is saved', () => {
    const saved = { commands: ['uv'], hosts: ['a.com'] };
    expect(permissionsChanged(saved, { commands: ['uv'], hosts: ['a.com'] })).toBe(false);
    expect(permissionsChanged(saved, { commands: ['uv', 'make'], hosts: ['a.com'] })).toBe(true);
    expect(permissionsChanged(saved, { commands: ['uv'], hosts: [] })).toBe(true);
  });
});
