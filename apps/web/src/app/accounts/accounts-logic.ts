import type { ClaudeAccount } from '@agents-panel/shared';

/** Name plus who is logged in: "Miqueas - Bimtrazer (m@bimtrazer.com)". */
export function accountLabel(account: ClaudeAccount): string {
  return account.email ? `${account.name} (${account.email})` : account.name;
}

/** What keeps an account from working as expected; empty when nothing does. */
export function accountWarnings(account: ClaudeAccount): string[] {
  const warnings: string[] = [];
  if (!account.loggedIn) {
    warnings.push(
      `Sin login en la VM: correr CLAUDE_CONFIG_DIR=${account.configDir ?? '~/.claude'} claude y hacer /login.`,
    );
  }
  if (!account.linked) {
    warnings.push(
      'Sin enlazar a ~/.claude: no puede retomar sesiones de otra cuenta. Correr scripts/vm/11-claude-cuentas.sh.',
    );
  }
  return warnings;
}

/** Only an account with a login can be chosen: every turn of one without it would fail. */
export function canActivate(account: ClaudeAccount): boolean {
  return account.loggedIn && !account.active;
}
