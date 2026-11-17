import webpush from 'web-push';
import type { Db } from '../db/index.js';
import { PasswordPolicyError, assertPasswordPolicy } from '../auth/password.js';
import { SessionService } from '../auth/sessions.js';
import { SecondFactorRepository, checkTotp, generateTotpSecret, totpUri } from '../auth/totp.js';
import { UserRepository, type User } from '../auth/users.js';
import { ProjectRepository } from '../projects/repo.js';
import { ProjectRepoRepository } from '../projects/repos-repo.js';
import { ProjectService } from '../projects/service.js';
import type { Config } from '../config.js';
import { AccountRepository } from '../accounts/repo.js';
import { AccountError, AccountService } from '../accounts/service.js';
import { PROJECT_USAGE, runProjectCommand } from './projects.js';

export interface CliIo {
  /** Reads a line; hidden input must not be echoed. */
  prompt(question: string, options?: { hidden?: boolean }): Promise<string>;
  print(line: string): void;
  /** Renders text as a QR code in the terminal. */
  qr(text: string): void;
}

export interface CliDeps {
  db: Db;
  secretKey: Buffer;
  sessionTimings: { idleTtlSeconds: number; absoluteTtlSeconds: number };
  now?: () => number;
  /** Clone settings; `project:add` only registers local folders, so tests may leave it out. */
  projectConfig?: Pick<Config, 'projectsDir' | 'minFreeDiskGb'>;
  /** Home of the Claude accounts (~/.claude and ~/.claude-<slug>); tests use a temporary one. */
  accountsHome?: string;
}

export class CliError extends Error {
  override readonly name = 'CliError';
}

export const USAGE = `Usage: npm run -w @agents-panel/api cli -- <command>

  user:create <username>          Create a user (password + TOTP + recovery codes)
  user:list                       List users
  user:reset-password <username>  Set a new password and end all sessions
  user:reset-2fa <username>       Enroll a new TOTP secret and recovery codes
  user:unlock <username>          Clear a login lock
  push:vapid-keys                 Print a VAPID key pair for the Web Push variables of the .env
  account:list                    List the Claude accounts (id, folder, command, name)
  account:dir <id> <folder>       Point a Claude account to another folder (absolute, in the home)

${PROJECT_USAGE}`;

export async function runCli(argv: readonly string[], io: CliIo, deps: CliDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const users = new UserRepository(deps.db);
  const factor = new SecondFactorRepository(deps.db, deps.secretKey, now);
  const sessions = new SessionService(deps.db, deps.sessionTimings, now);
  const [command, username] = argv;
  const projectRepo = new ProjectRepository(deps.db, now);
  const projectService = new ProjectService({
    repo: projectRepo,
    config: deps.projectConfig ?? { projectsDir: '', minFreeDiskGb: 10 },
    projectRepos: new ProjectRepoRepository(deps.db, now),
  });
  if (
    await runProjectCommand(command, argv.slice(1), io, {
      projects: projectRepo,
      service: projectService,
    })
  ) {
    return;
  }

  function accountService(): AccountService {
    return new AccountService(new AccountRepository(deps.db, now), deps.accountsHome);
  }

  function requireUser(): User {
    if (!username) throw new CliError('Missing <username>');
    const user = users.findByUsername(username);
    if (!user) throw new CliError(`User not found: ${username}`);
    return user;
  }

  async function askNewPassword(): Promise<string> {
    const first = await io.prompt('Password: ', { hidden: true });
    try {
      assertPasswordPolicy(first);
    } catch (error) {
      if (error instanceof PasswordPolicyError) throw new CliError(error.message);
      throw error;
    }
    const second = await io.prompt('Repeat password: ', { hidden: true });
    if (first !== second) throw new CliError('Passwords do not match');
    return first;
  }

  /** Shows the secret and only returns it once the user proves their authenticator works. */
  async function enrollTotp(label: string): Promise<string> {
    const secret = generateTotpSecret();
    const uri = totpUri(label, secret);
    io.print('Scan this QR with your authenticator app:');
    io.qr(uri);
    io.print(`Or add it manually: ${uri}`);
    const code = (await io.prompt('Enter the 6-digit code to confirm: ')).trim();
    if (checkTotp(secret, code, now()) === undefined) {
      throw new CliError('Invalid code. Nothing was saved.');
    }
    return secret;
  }

  function printRecoveryCodes(codes: string[]): void {
    io.print('Recovery codes (shown once, each works one time):');
    for (const code of codes) io.print(`  ${code}`);
  }

  switch (command) {
    case 'user:create': {
      if (!username) throw new CliError('Missing <username>');
      if (users.findByUsername(username)) throw new CliError(`User already exists: ${username}`);
      const password = await askNewPassword();
      const secret = await enrollTotp(username);
      const user = await users.create(username, password);
      try {
        factor.setTotpSecret(user.id, secret);
        printRecoveryCodes(factor.regenerateRecoveryCodes(user.id));
      } catch (error) {
        deps.db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
        throw error;
      }
      io.print(`User created: ${username}`);
      return;
    }
    case 'user:list': {
      for (const user of users.list()) {
        const locked = users.isLocked(user, now()) ? ' (locked)' : '';
        io.print(`${String(user.id)}\t${user.username}${locked}`);
      }
      return;
    }
    case 'user:reset-password': {
      const user = requireUser();
      await users.setPassword(user.id, await askNewPassword());
      sessions.destroyAllForUser(user.id);
      io.print(`Password updated for ${user.username}; sessions ended.`);
      return;
    }
    case 'user:reset-2fa': {
      const user = requireUser();
      const secret = await enrollTotp(user.username);
      factor.setTotpSecret(user.id, secret);
      printRecoveryCodes(factor.regenerateRecoveryCodes(user.id));
      sessions.destroyAllForUser(user.id);
      io.print(`Second factor replaced for ${user.username}; sessions ended.`);
      return;
    }
    case 'user:unlock': {
      const user = requireUser();
      users.clearFailures(user.id);
      io.print(`Unlocked ${user.username}.`);
      return;
    }
    case 'push:vapid-keys': {
      const keys = webpush.generateVAPIDKeys();
      io.print('Paste these into the .env of the panel (the private key is a secret):');
      io.print(`PUSH_VAPID_PUBLIC_KEY=${keys.publicKey}`);
      io.print(`PUSH_VAPID_PRIVATE_KEY=${keys.privateKey}`);
      io.print('PUSH_VAPID_SUBJECT=mailto:you@example.com');
      return;
    }
    case 'account:list': {
      for (const account of accountService().list()) {
        const dir = account.configDir ?? '(sin carpeta: ~/.claude)';
        const flags = `${account.active ? ' [activa]' : ''}${account.loggedIn ? '' : ' [sin login]'}`;
        io.print(
          `${String(account.id)}\t${dir}\t${account.command ?? '-'}\t${account.name}${flags}`,
        );
      }
      return;
    }
    case 'account:dir': {
      const [, rawId, dir] = argv;
      const id = Number(rawId);
      if (!Number.isInteger(id) || id < 1 || !dir)
        throw new CliError('Usage: account:dir <id> <folder>');
      try {
        const account = accountService().setDir(id, dir);
        io.print(
          `${account.name}: ${account.configDir ?? ''} (${account.command ?? 'sin comando'})`,
        );
      } catch (error) {
        if (error instanceof AccountError) throw new CliError(error.message);
        throw error;
      }
      return;
    }
    default:
      throw new CliError(command ? `Unknown command: ${command}\n\n${USAGE}` : USAGE);
  }
}
