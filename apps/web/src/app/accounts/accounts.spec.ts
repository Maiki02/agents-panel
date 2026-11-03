import type { ClaudeAccount } from '@agents-panel/shared';
import { describe, expect, it } from 'vitest';
import {
  accountLabel,
  accountWarnings,
  canActivate,
  canAddAccount,
  canRelogin,
  canSendReloginCode,
  safeAuthLink,
} from './accounts-logic';

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

describe('canRelogin', () => {
  it('is offered for every account, with or without login, unless a request is in flight', () => {
    expect(canRelogin(account(), false)).toBe(true);
    expect(canRelogin(account({ loggedIn: false }), false)).toBe(true);
    expect(canRelogin(account({ active: true }), false)).toBe(true);
    expect(canRelogin(account(), true)).toBe(false);
  });

  it('points the «Sin login» warning to the button', () => {
    expect(accountWarnings(account({ loggedIn: false }))[0]).toContain('Reloguear');
  });
});

describe('canSendReloginCode', () => {
  it('needs a well formed code and no request in flight', () => {
    expect(canSendReloginCode(false, 'AbCd1234-efGh5678#state9')).toBe(true);
    expect(canSendReloginCode(false, '  AbCd1234xyz  ')).toBe(true);
    expect(canSendReloginCode(true, 'AbCd1234-efGh5678#state9')).toBe(false);
    expect(canSendReloginCode(false, '')).toBe(false);
    expect(canSendReloginCode(false, 'short')).toBe(false);
    expect(canSendReloginCode(false, 'has spaces in the middle')).toBe(false);
    expect(canSendReloginCode(false, 'semi;colon&&rm -rf /')).toBe(false);
  });
});

describe('safeAuthLink', () => {
  it('lets through an https link of Claude or Anthropic', () => {
    expect(safeAuthLink('https://claude.ai/oauth/authorize?code=true&state=x')).toBe(
      'https://claude.ai/oauth/authorize?code=true&state=x',
    );
    expect(safeAuthLink('https://console.anthropic.com/oauth/authorize')).not.toBeNull();
  });

  it('refuses any other link, scheme or text', () => {
    expect(safeAuthLink('http://claude.ai/oauth')).toBeNull();
    expect(safeAuthLink('https://evil.example.com/claude.ai')).toBeNull();
    expect(safeAuthLink('https://claude.ai.evil.com/')).toBeNull();
    expect(safeAuthLink('javascript:alert(1)')).toBeNull();
    expect(safeAuthLink('not a url')).toBeNull();
  });
});

describe('canActivate', () => {
  it('only allows a logged in account that is not already active', () => {
    expect(canActivate(account())).toBe(true);
    expect(canActivate(account({ loggedIn: false }))).toBe(false);
    expect(canActivate(account({ active: true }))).toBe(false);
  });
});
