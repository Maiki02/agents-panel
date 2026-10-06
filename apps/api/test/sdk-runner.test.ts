import { describe, expect, it } from 'vitest';
import { accountEnv, buildQueryOptions } from '../src/agent/sdk-runner.js';
import type { RunParams } from '../src/agent/runner.js';

const params = (extra: Partial<RunParams> = {}): RunParams => ({
  cwd: '/tmp/wt',
  prompt: 'hi',
  model: 'claude-opus-5-5',
  role: 'thinker',
  signal: new AbortController().signal,
  canUseTool: () => Promise.resolve({ behavior: 'allow' }),
  ...extra,
});

describe('buildQueryOptions', () => {
  it('passes the model and keeps acceptEdits, never bypassPermissions', () => {
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5']) {
      const options = buildQueryOptions(params({ model }), new AbortController());
      expect(options.model).toBe(model);
      expect(options.permissionMode).toBe('acceptEdits');
      expect(options.permissionMode).not.toBe('bypassPermissions');
      expect(JSON.stringify(options)).not.toContain('bypassPermissions');
      expect(options.allowDangerouslySkipPermissions).toBeUndefined();
    }
  });

  it('resumes the stored session only when there is one', () => {
    expect(buildQueryOptions(params(), new AbortController()).resume).toBeUndefined();
    expect(
      buildQueryOptions(params({ resumeSessionId: 'abc' }), new AbortController()).resume,
    ).toBe('abc');
  });

  it('runs with the account directory as CLAUDE_CONFIG_DIR', () => {
    const options = buildQueryOptions(
      params({ configDir: '/home/u/.claude2' }),
      new AbortController(),
    );
    expect(options.env?.['CLAUDE_CONFIG_DIR']).toBe('/home/u/.claude2');
  });

  it('runs the default account without CLAUDE_CONFIG_DIR, even if the API has one', () => {
    const base = { PATH: '/bin', CLAUDE_CONFIG_DIR: '/home/u/.claude2' };
    for (const configDir of [null, undefined]) {
      const env = accountEnv(configDir, base);
      expect(env).toEqual({ PATH: '/bin' });
      expect('CLAUDE_CONFIG_DIR' in env).toBe(false);
    }
    expect(accountEnv('/home/u/.claude3', base)).toEqual({
      PATH: '/bin',
      CLAUDE_CONFIG_DIR: '/home/u/.claude3',
    });
    const options = buildQueryOptions(params(), new AbortController());
    expect(options.env).toBeDefined();
    expect('CLAUDE_CONFIG_DIR' in (options.env ?? {})).toBe(false);
  });
});
