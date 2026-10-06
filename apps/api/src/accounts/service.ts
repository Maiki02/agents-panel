import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import type { ClaudeAccount, NewClaudeAccount } from '@agents-panel/shared';
import type { AccountRecord, AccountRepository } from './repo.js';

/** A refused account operation; `status` is the HTTP code the route answers with. */
export class AccountError extends Error {
  override readonly name = 'AccountError';
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

const MAX_NAME = 80;

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Claude accounts as the web sees them: the stored rows plus what is read from each config
 * directory (email, organization, login, shared projects/). Credentials are never read: only
 * whether `.credentials.json` exists.
 */
export class AccountService {
  /** `home` is the user's home; tests point it to a temporary directory. */
  constructor(
    private readonly repo: AccountRepository,
    private readonly home: string = homedir(),
  ) {}

  private get defaultDir(): string {
    return join(this.home, '.claude');
  }

  /** Config directory of the account as Claude Code sees it (the default one has ~/.claude.json outside). */
  private paths(account: AccountRecord): { dir: string; claudeJson: string } {
    return account.configDir === null
      ? { dir: this.defaultDir, claudeJson: join(this.home, '.claude.json') }
      : { dir: account.configDir, claudeJson: join(account.configDir, '.claude.json') };
  }

  private identity(claudeJson: string): { email: string | null; organization: string | null } {
    try {
      const parsed = JSON.parse(readFileSync(claudeJson, 'utf8')) as {
        oauthAccount?: { emailAddress?: unknown; organizationName?: unknown };
      };
      const oauth = parsed.oauthAccount;
      return {
        email: typeof oauth?.emailAddress === 'string' ? oauth.emailAddress : null,
        organization: typeof oauth?.organizationName === 'string' ? oauth.organizationName : null,
      };
    } catch {
      return { email: null, organization: null };
    }
  }

  toView(account: AccountRecord): ClaudeAccount {
    const { dir, claudeJson } = this.paths(account);
    const sharedProjects = realpathOrNull(join(this.defaultDir, 'projects'));
    const ownProjects = realpathOrNull(join(dir, 'projects'));
    return {
      id: account.id,
      name: account.name,
      configDir: account.configDir,
      active: account.active,
      ...this.identity(claudeJson),
      loggedIn: existsSync(join(dir, '.credentials.json')),
      linked:
        account.configDir === null ||
        (sharedProjects !== null && ownProjects !== null && sharedProjects === ownProjects),
      createdAt: account.createdAt,
    };
  }

  list(): ClaudeAccount[] {
    return this.repo.list().map((account) => this.toView(account));
  }

  /** The account the next turn runs with: its id and the CLAUDE_CONFIG_DIR (null: unset it). */
  activeForRun(): { id: number; name: string; configDir: string | null } {
    const active = this.repo.active();
    return { id: active.id, name: active.name, configDir: active.configDir };
  }

  private checkName(raw: string, exceptId?: number): string {
    const name = raw.trim();
    if (name === '' || name.length > MAX_NAME) {
      throw new AccountError(
        400,
        `El nombre tiene que tener entre 1 y ${String(MAX_NAME)} caracteres`,
      );
    }
    const taken = this.repo.findByName(name);
    if (taken && taken.id !== exceptId)
      throw new AccountError(409, 'Ya hay una cuenta con ese nombre');
    return name;
  }

  /** Resolves and validates a config directory: absolute, inside the home, existing, logged in. */
  private checkDir(raw: string): string {
    const trimmed = raw.trim();
    if (!isAbsolute(trimmed))
      throw new AccountError(400, 'El directorio tiene que ser una ruta absoluta');
    const real = realpathOrNull(trimmed);
    if (real === null || !statSync(real).isDirectory()) {
      throw new AccountError(400, 'El directorio no existe');
    }
    const home = realpathOrNull(this.home) ?? this.home;
    if (!real.startsWith(home + sep)) {
      throw new AccountError(400, 'El directorio tiene que estar dentro del home');
    }
    if (real === realpathOrNull(this.defaultDir)) {
      throw new AccountError(400, '~/.claude es la cuenta principal; no se da de alta de nuevo');
    }
    if (!existsSync(join(real, '.credentials.json'))) {
      throw new AccountError(
        400,
        `El directorio no tiene login: correr en la VM CLAUDE_CONFIG_DIR=${real} claude y hacer /login`,
      );
    }
    if (this.repo.findByConfigDir(real))
      throw new AccountError(409, 'Ese directorio ya es una cuenta');
    return real;
  }

  create(input: NewClaudeAccount): ClaudeAccount {
    const name = this.checkName(input.name);
    const configDir = this.checkDir(input.configDir);
    return this.toView(this.repo.create(name, configDir));
  }

  private existing(id: number): AccountRecord {
    const account = this.repo.findById(id);
    if (!account) throw new AccountError(404, 'Cuenta no encontrada');
    return account;
  }

  rename(id: number, rawName: string): ClaudeAccount {
    this.existing(id);
    this.repo.rename(id, this.checkName(rawName, id));
    return this.toView(this.existing(id));
  }

  /** Makes the account the active one. Refused without a login: every turn would fail. */
  activate(id: number): ClaudeAccount {
    const account = this.existing(id);
    if (!this.toView(account).loggedIn) {
      throw new AccountError(409, 'La cuenta no tiene login en la VM');
    }
    this.repo.setActive(id);
    return this.toView(this.existing(id));
  }

  delete(id: number): void {
    const account = this.existing(id);
    if (account.configDir === null) throw new AccountError(409, 'La cuenta principal no se borra');
    if (account.active)
      throw new AccountError(409, 'La cuenta activa no se borra: elegí otra antes');
    this.repo.delete(id);
  }
}
