import { chmodSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/index.js';
import type { GitAccountRepository } from './repo.js';

/** The askpass script of the repo (apps/api/scripts); resolves the same from src and from dist. */
export const GIT_ASKPASS_SCRIPT = fileURLToPath(
  new URL('../../scripts/git-askpass.sh', import.meta.url),
);

let askpassChecked = false;

/** git runs the askpass program directly: a checkout that lost the exec bit gets it back, once. */
function ensureAskpassExecutable(): void {
  if (askpassChecked) return;
  askpassChecked = true;
  try {
    if ((statSync(GIT_ASKPASS_SCRIPT).mode & 0o111) === 0) chmodSync(GIT_ASKPASS_SCRIPT, 0o755);
  } catch {
    // Best effort: git reports the failure to run the script.
  }
}

/** What a git/gh process needs to act as a git account. The token is only ever read from env. */
export interface GitCredential {
  host: string;
  username: string;
  token: string;
}

/** The token of the project's account can no longer be read (the secret changed or the row broke). */
export class GitCredentialError extends Error {
  override readonly name = 'GitCredentialError';
}

/**
 * Variables added to the environment of a git/gh process for the account: askpass answers with the
 * user and the token from here. `GH_TOKEN` is only set for github.com, where `gh` is used: sending a
 * GitLab token to `gh` would hand it to GitHub.
 */
export function credentialEnv(credential: GitCredential): Record<string, string> {
  ensureAskpassExecutable();
  return {
    GIT_ASKPASS: GIT_ASKPASS_SCRIPT,
    GIT_TERMINAL_PROMPT: '0',
    PANEL_GIT_USERNAME: credential.username,
    PANEL_GIT_TOKEN: credential.token,
    ...(credential.host === 'github.com' ? { GH_TOKEN: credential.token } : {}),
  };
}

/**
 * Leading git arguments that drop the global credential helper for the account's host only, so the
 * login of `gh` (its helper) does not win over askpass there.
 */
export function credentialConfigArgs(credential: GitCredential): string[] {
  return ['-c', `credential.https://${credential.host}.helper=`];
}

/**
 * The same override as environment variables (git >= 2.31), for processes the panel does not build
 * the argv of: the agent's own `git` calls.
 */
export function credentialConfigEnv(credential: GitCredential): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `credential.https://${credential.host}.helper`,
    GIT_CONFIG_VALUE_0: '',
  };
}

/** Everything the Claude Agent SDK process gets for a project with an account. */
export function agentCredentialEnv(credential: GitCredential): Record<string, string> {
  return { ...credentialEnv(credential), ...credentialConfigEnv(credential) };
}

/** How to run one git/gh process: extra leading git args and the full environment (or undefined). */
export interface ProcessAuth {
  configArgs: string[];
  env: NodeJS.ProcessEnv | undefined;
}

export const NO_AUTH: ProcessAuth = { configArgs: [], env: undefined };

export function processAuth(
  credential: GitCredential | null,
  base: NodeJS.ProcessEnv = process.env,
): ProcessAuth {
  if (!credential) return NO_AUTH;
  return {
    configArgs: credentialConfigArgs(credential),
    env: { ...base, ...credentialEnv(credential) },
  };
}

/** Finds the credential of the project that owns a folder or id. Null: the global login applies. */
export interface GitCredentialLookup {
  forPath(cwd: string): GitCredential | null;
  forProject(projectId: number): GitCredential | null;
}

interface ProjectAccountRow {
  id: number;
  name: string;
  repo_path: string;
  git_account_id: number | null;
}

function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Resolves projects to their account's credential, reading both tables on each call. */
export class GitCredentialResolver implements GitCredentialLookup {
  constructor(
    private readonly db: Db,
    private readonly accounts: Pick<GitAccountRepository, 'findById' | 'readToken'>,
    private readonly worktreesDir: string,
  ) {}

  forProject(projectId: number): GitCredential | null {
    const row = this.db
      .prepare('SELECT id, name, repo_path, git_account_id FROM projects WHERE id = ?')
      .get(projectId) as ProjectAccountRow | undefined;
    return row ? this.credentialOf(row) : null;
  }

  /** A folder belongs to a project when it is inside its base clone or its worktrees folder. */
  forPath(cwd: string): GitCredential | null {
    const rows = this.db
      .prepare('SELECT id, name, repo_path, git_account_id FROM projects')
      .all() as unknown as ProjectAccountRow[];
    const row = rows.find(
      (candidate) =>
        contains(candidate.repo_path, cwd) ||
        contains(join(this.worktreesDir, candidate.name), cwd),
    );
    return row ? this.credentialOf(row) : null;
  }

  private credentialOf(row: ProjectAccountRow): GitCredential | null {
    if (row.git_account_id === null) return null;
    const account = this.accounts.findById(row.git_account_id);
    const token = account ? this.accounts.readToken(account.id) : null;
    if (!account || token === null) {
      throw new GitCredentialError(
        `No se pudo leer la cuenta de git del proyecto ${row.name}: cargá el token de nuevo`,
      );
    }
    return { host: account.host, username: account.username, token };
  }
}

let active: GitCredentialLookup | null = null;

/** The app registers its resolver once built (and clears it on close) so every git helper uses it. */
export function setGitCredentialLookup(lookup: GitCredentialLookup | null): void {
  active = lookup;
}

/** Auth for a process that runs in `cwd`; none when no resolver is registered or no account. */
export function authForPath(cwd: string): ProcessAuth {
  return processAuth(active?.forPath(cwd) ?? null);
}
