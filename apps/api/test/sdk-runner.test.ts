import { describe, expect, it } from 'vitest';
import { buildQueryOptions } from '../src/agent/sdk-runner.js';
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
});
