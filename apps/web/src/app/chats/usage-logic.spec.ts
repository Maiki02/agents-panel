import { describe, expect, it } from 'vitest';
import type { AgentSession } from '@agents-panel/shared';
import { formatCost, formatTokens, usageRows } from './usage-logic';

const session = (over: Partial<AgentSession>): AgentSession => ({
  id: 1,
  chatId: 1,
  role: 'executor',
  provider: 'claude',
  model: 'claude-sonnet-5-5',
  sdkSessionId: null,
  accountId: null,
  sprintN: null,
  step: 'manual',
  policyVersion: null,
  startedAt: 1,
  endedAt: 2,
  result: 'idle',
  usage: null,
  ...over,
});

describe('usageRows', () => {
  it('shows the newest session first with its pilot step and usage', () => {
    const usage = {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheCreationTokens: 4,
      costUsd: 0.5,
    };
    const rows = usageRows([
      session({ id: 1, step: 'plan', usage }),
      session({ id: 2, step: 'execute' }),
    ]);
    expect(rows.map((r) => [r.id, r.step, r.usage])).toEqual([
      [2, 'Ejecución', null],
      [1, 'Plan', usage],
    ]);
  });

  it('labels a session started by hand as Manual', () => {
    expect(usageRows([session({})])[0]?.step).toBe('Manual');
  });
});

describe('formatters', () => {
  it('groups tokens by thousands', () => {
    expect(formatTokens(1234567)).toBe('1.234.567');
  });

  it('shows cents, and four decimals under one cent', () => {
    expect(formatCost(1.5)).toBe('US$ 1,50');
    expect(formatCost(0.0042)).toBe('US$ 0,0042');
    expect(formatCost(0)).toBe('US$ 0,00');
  });
});
