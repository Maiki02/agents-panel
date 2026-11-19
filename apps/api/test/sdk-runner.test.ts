import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { accountEnv, buildQueryOptions, enabledPluginIds } from '../src/agent/sdk-runner.js';
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

  it('starts a pilot session without MCP servers, claude.ai connectors or plugins', () => {
    const options = buildQueryOptions(params({ pilot: true }), new AbortController(), [
      'a@m',
      'b@m',
    ]);
    expect(options.mcpServers).toEqual({});
    expect(options.strictMcpConfig).toBe(true);
    expect(options.settings).toEqual({
      disableClaudeAiConnectors: true,
      enabledPlugins: { 'a@m': false, 'b@m': false },
    });
  });

  it('keeps project config, permissions and hooks in a pilot session, with no bypass', () => {
    const manual = buildQueryOptions(params(), new AbortController());
    const pilot = buildQueryOptions(params({ pilot: true }), new AbortController());
    expect(pilot.settingSources).toEqual(['project', 'user']);
    expect(pilot.permissionMode).toBe('acceptEdits');
    expect(pilot.allowedTools).toEqual(manual.allowedTools);
    expect(pilot.hooks?.PreToolUse).toHaveLength(1);
    expect(pilot.canUseTool).toBeTypeOf('function');
    expect(JSON.stringify(pilot)).not.toContain('bypassPermissions');
    expect(pilot.allowDangerouslySkipPermissions).toBeUndefined();
  });

  it('leaves a manual chat as it was', () => {
    const options = buildQueryOptions(params(), new AbortController(), ['a@m']);
    expect(options.settingSources).toEqual(['project', 'user']);
    expect(options.mcpServers).toBeUndefined();
    expect(options.strictMcpConfig).toBeUndefined();
    expect(options.settings).toBeUndefined();
  });
});

describe('enabledPluginIds', () => {
  const dirWith = (settings: string | null): string => {
    const dir = mkdtempSync(join(tmpdir(), 'sdk-runner-'));
    if (settings !== null) writeFileSync(join(dir, 'settings.json'), settings);
    return dir;
  };

  it('lists only the plugins the user settings enable', () => {
    const dir = dirWith(JSON.stringify({ enabledPlugins: { 'a@m': true, 'b@m': false } }));
    expect(enabledPluginIds(dir)).toEqual(['a@m']);
  });

  it('gives none when the settings are missing, malformed or have no plugins', () => {
    expect(enabledPluginIds(dirWith(null))).toEqual([]);
    expect(enabledPluginIds(dirWith('not json'))).toEqual([]);
    expect(enabledPluginIds(dirWith('{}'))).toEqual([]);
  });
});
