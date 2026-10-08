import type { ClaudeAccount } from '@agents-panel/shared';
import { describe, expect, it } from 'vitest';
import { accountLabel, accountWarnings, canActivate, canAddAccount } from './accounts-logic';

const account = (extra: Partial<ClaudeAccount> = {}): ClaudeAccount => ({
  id: 2,
  name: 'Miqueas - Bimtrazer',
  configDir: '/home/ubuntu/.claude2',
  active: false,
  email: 'm@example.com',
  organization: 'Bimtrazer',
  loggedIn: true,
  linked: true,
  createdAt: 1,
  ...extra,
});

describe('accountLabel', () => {
  it('adds the email when it is known', () => {
    expect(accountLabel(account())).toBe('Miqueas - Bimtrazer (m@example.com)');
    expect(accountLabel(account({ email: null }))).toBe('Miqueas - Bimtrazer');
  });
});

describe('accountWarnings', () => {
  it('is empty for a logged in, linked account', () => {
    expect(accountWarnings(account())).toEqual([]);
  });

  it('tells how to log in and how to link', () => {
    const warnings = accountWarnings(account({ loggedIn: false, linked: false }));
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('CLAUDE_CONFIG_DIR=/home/ubuntu/.claude2 claude');
    expect(warnings[1]).toContain('11-claude-cuentas.sh');
  });
});

describe('canAddAccount', () => {
  it('needs a name and a directory, and no request in flight', () => {
    expect(canAddAccount(false, 'Cuenta', '/home/ubuntu/.claude2')).toBe(true);
    expect(canAddAccount(false, '  ', '/home/ubuntu/.claude2')).toBe(false);
    expect(canAddAccount(false, 'Cuenta', ' ')).toBe(false);
    expect(canAddAccount(true, 'Cuenta', '/home/ubuntu/.claude2')).toBe(false);
  });
});

describe('canActivate', () => {
  it('only allows a logged in account that is not already active', () => {
    expect(canActivate(account())).toBe(true);
    expect(canActivate(account({ loggedIn: false }))).toBe(false);
    expect(canActivate(account({ active: true }))).toBe(false);
  });
});
