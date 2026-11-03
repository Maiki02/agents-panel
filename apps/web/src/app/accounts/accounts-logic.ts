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
      `Sin login en la VM: usá «Reloguear» o, a mano, correr CLAUDE_CONFIG_DIR=${account.configDir ?? '~/.claude'} claude y hacer /login.`,
    );
  }
  if (!account.linked) {
    warnings.push(
      'Sin enlazar a ~/.claude: no puede retomar sesiones de otra cuenta. Correr scripts/vm/11-claude-cuentas.sh.',
    );
  }
  return warnings;
}

/** The "Nueva cuenta" Agregar button needs both fields filled and no request in flight. */
export function canAddAccount(busy: boolean, name: string, configDir: string): boolean {
  return !busy && name.trim() !== '' && configDir.trim() !== '';
}

/** Every Claude account can be logged in again, also one that still has its (expired) credentials. */
export function canRelogin(account: Pick<ClaudeAccount, 'id'>, busy: boolean): boolean {
  return !busy && account.id > 0;
}

/** Same shape the API accepts for the code the browser shows after authorizing. */
const RELOGIN_CODE_RE = /^[A-Za-z0-9._~+/=#:-]{6,512}$/;

/** The code can be sent: well formed and no request in flight. */
export function canSendReloginCode(busy: boolean, code: string): boolean {
  return !busy && RELOGIN_CODE_RE.test(code.trim());
}

const LINK_HOSTS = ['claude.ai', 'claude.com', 'anthropic.com'];

/**
 * The authorization link as an href, only when it is https and points at Claude or Anthropic; the
 * API already checks it, this keeps the page from ever rendering any other link.
 */
export function safeAuthLink(url: string): string | null {
  try {
    const parsed = new URL(url);
    const ok =
      parsed.protocol === 'https:' &&
      LINK_HOSTS.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
    return ok ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** Only an account with a login can be chosen: every turn of one without it would fail. */
export function canActivate(account: ClaudeAccount): boolean {
  return account.loggedIn && !account.active;
}
