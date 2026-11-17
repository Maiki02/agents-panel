import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClaudeAccount, NewClaudeAccount } from '@agents-panel/shared';
import type { AccountRecord, AccountRepository } from './repo.js';

/** A refused account operation; `status` is the HTTP code the route answers with. */
export class AccountError extends Error {
  override readonly name = 'AccountError';
  constructor(
    readonly status: 400 | 404 | 409 | 502,
    message: string,
  ) {
    super(message);
  }
}

const MAX_NAME = 80;

/** Slug of an account: its folder is ~/.claude-<slug> and its command claude-<slug>. */
export const ACCOUNT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DIR_SLUG_RE = /^\.claude-([a-z0-9][a-z0-9-]{0,31})$/;

/** Creates and links an account folder to the global ~/.claude (scripts/vm/11-claude-cuentas.sh). */
export type AccountProvisioner = (configDir: string) => Promise<void>;

const DEFAULT_SCRIPT = fileURLToPath(
  new URL('../../../../scripts/vm/11-claude-cuentas.sh', import.meta.url),
);

/** Real provisioner: runs the VM script with this home, so a test home never touches the real one. */
export function scriptProvisioner(home: string, script = DEFAULT_SCRIPT): AccountProvisioner {
  return (configDir) =>
    new Promise((resolve, reject) => {
      execFile(
        'bash',
        [script, configDir],
        { env: { ...process.env, HOME: home }, timeout: 60_000, maxBuffer: 1024 * 1024 },
        (error, _stdout, stderr) => {
          if (error) reject(new Error(`11-claude-cuentas.sh failed: ${stderr.trim().slice(-500)}`));
          else resolve();
        },
      );
    });
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Claude accounts as the web sees them: the stored rows plus what is read from each config
 * directory (email, organization, login, shared projects/, command). Credentials are never read:
 * only whether `.credentials.json` exists.
 *
 * ~/.claude is the global config (skills, settings, sessions); every account has its own folder
 * (~/.claude-<slug>, its CLAUDE_CONFIG_DIR) linked to it, and the command claude-<slug>. A row with
 * no folder (config_dir NULL) is the legacy layout, where ~/.claude also held the main login.
 */
export class AccountService {
  private readonly provision: AccountProvisioner;

  /** `home` is the user's home; tests point it to a temporary directory. */
  constructor(
    private readonly repo: AccountRepository,
    private readonly home: string = homedir(),
    provision?: AccountProvisioner,
  ) {
    this.provision = provision ?? scriptProvisioner(home);
  }

  /** The global config every account links to. */
  private get defaultDir(): string {
    return join(this.home, '.claude');
  }

  /** The command that opens Claude Code with this folder, when the folder has one and it exists. */
  private command(configDir: string | null): string | null {
    if (configDir === null) return null;
    const match = DIR_SLUG_RE.exec(basename(configDir));
    if (!match) return null;
    const command = `claude-${match[1] ?? ''}`;
    return existsSync(join(this.home, '.local', 'bin', command)) ? command : null;
  }

  /** Config directory of the account as Claude Code sees it (the legacy one has ~/.claude.json outside). */
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
      command: this.command(account.configDir),
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

  /** Resolves and validates a config directory: absolute, inside the home, existing, not ~/.claude. */
  private checkDir(raw: string, exceptId?: number): string {
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
      throw new AccountError(400, '~/.claude es la config global; cada cuenta tiene su carpeta');
    }
    const taken = this.repo.findByConfigDir(real);
    if (taken && taken.id !== exceptId)
      throw new AccountError(409, 'Ese directorio ya es una cuenta');
    return real;
  }

  /**
   * New account: creates ~/.claude-<slug> linked to the global ~/.claude and the command
   * claude-<slug> (11-claude-cuentas.sh). It starts without a login: «Reloguear» from the web.
   */
  async create(input: NewClaudeAccount): Promise<ClaudeAccount> {
    const name = this.checkName(input.name);
    const slug = input.slug.trim();
    if (!ACCOUNT_SLUG_RE.test(slug)) {
      throw new AccountError(
        400,
        'El comando lleva minúsculas, números y guiones (hasta 32), por ejemplo «work»',
      );
    }
    const configDir = join(realpathOrNull(this.home) ?? this.home, `.claude-${slug}`);
    if (this.repo.findByConfigDir(configDir)) {
      throw new AccountError(409, `Ya hay una cuenta en ~/.claude-${slug}`);
    }
    if (!existsSync(this.defaultDir)) {
      throw new AccountError(
        409,
        'No existe ~/.claude, la config global a la que enlaza la cuenta',
      );
    }
    try {
      await this.provision(configDir);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new AccountError(502, `No se pudo crear ~/.claude-${slug}: ${detail}`);
    }
    return this.toView(this.repo.create(name, configDir));
  }

  /** Points an account to another folder (CLI `account:dir`, used when the folders were renamed). */
  setDir(id: number, rawDir: string): ClaudeAccount {
    this.existing(id);
    this.repo.setConfigDir(id, this.checkDir(rawDir, id));
    return this.toView(this.existing(id));
  }

  private existing(id: number): AccountRecord {
    const account = this.repo.findById(id);
    if (!account) throw new AccountError(404, 'Cuenta no encontrada');
    return account;
  }

  /** One account as the web sees it; 404 when it does not exist. */
  view(id: number): ClaudeAccount {
    return this.toView(this.existing(id));
  }

  /**
   * Where a Claude login for this account lands: the `CLAUDE_CONFIG_DIR` to run it with (null: the
   * main account, the variable stays unset) and the credentials file it writes. 404 when missing.
   */
  loginTarget(id: number): { configDir: string | null; credentialsFile: string } {
    const account = this.existing(id);
    return {
      configDir: account.configDir,
      credentialsFile: join(this.paths(account).dir, '.credentials.json'),
    };
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
    if (account.configDir === null)
      throw new AccountError(409, 'La cuenta sin carpeta no se borra');
    if (account.active)
      throw new AccountError(409, 'La cuenta activa no se borra: elegí otra antes');
    this.repo.delete(id);
  }
}
