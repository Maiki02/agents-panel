import { execFile } from 'node:child_process';
import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** What kind of secret a finding is. The value itself is never part of a finding (R20). */
export const SECRET_KINDS = [
  'env_file',
  'key_file',
  'credentials_file',
  'private_key',
  'github_token',
  'anthropic_key',
  'aws_access_key',
  'slack_token',
] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

export interface SecretFinding {
  file: string;
  kind: SecretKind;
}

const KIND_LABEL: Record<SecretKind, string> = {
  env_file: 'archivo .env',
  key_file: 'archivo de clave',
  credentials_file: 'archivo de credenciales',
  private_key: 'clave privada',
  github_token: 'token de GitHub',
  anthropic_key: 'clave de Anthropic',
  aws_access_key: 'clave de acceso de AWS',
  slack_token: 'token de Slack',
};

/** File names that must never be committed, by base name. `.env.example` is the allowed one. */
function kindOfFileName(file: string): SecretKind | null {
  const name = path.posix.basename(file);
  if (name === '.env.example') return null;
  if (name === '.env' || name.startsWith('.env.')) return 'env_file';
  if (name.endsWith('.pem') || name.endsWith('.key')) return 'key_file';
  if (name.startsWith('id_rsa') || name.startsWith('id_ed25519')) return 'key_file';
  if (name === 'credentials.json') return 'credentials_file';
  return null;
}

const CONTENT_PATTERNS: readonly { kind: SecretKind; pattern: RegExp }[] = [
  { kind: 'private_key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: 'github_token', pattern: /\bghp_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { kind: 'anthropic_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'slack_token', pattern: /\bxox[abpr]-[A-Za-z0-9-]{10,}/ },
];

/**
 * Looks for secrets in the ADDED lines of a unified diff and in the names of the files it adds or
 * changes. Pure. Deleted lines and deleted files are ignored; a finding is a file and a kind,
 * never the matched text.
 */
export function scanSecrets(diff: string): SecretFinding[] {
  const found = new Map<string, SecretFinding>();
  const add = (file: string, kind: SecretKind) => {
    found.set(`${file}\0${kind}`, { file, kind });
  };
  let file: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      file = target === '/dev/null' ? null : target.replace(/^b\//, '');
      const nameKind = file === null ? null : kindOfFileName(file);
      if (file !== null && nameKind !== null) add(file, nameKind);
      continue;
    }
    if (line.startsWith('--- ') || file === null || !line.startsWith('+')) continue;
    const added = line.slice(1);
    for (const { kind, pattern } of CONTENT_PATTERNS) {
      if (pattern.test(added)) add(file, kind);
    }
  }
  // Plain code point order, so the result does not depend on the locale of the server.
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...found.values()].sort((a, b) => order(a.file, b.file) || order(a.kind, b.kind));
}

/** The detail of the stop: files and kinds only. */
export function describeSecrets(findings: readonly SecretFinding[]): string {
  return findings.map((f) => `${f.file} (${KIND_LABEL[f.kind]})`).join(', ');
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, '--no-optional-locks', ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

const MAX_UNTRACKED_BYTES = 1024 * 1024;

/** A pseudo diff of one untracked file (all its lines count as added). */
async function untrackedAsDiff(cwd: string, rel: string): Promise<string> {
  const header = `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n`;
  try {
    const full = path.join(cwd, rel);
    const info = await lstat(full);
    // A symlink or a huge file: only its name is checked.
    if (!info.isFile() || info.size > MAX_UNTRACKED_BYTES) return header;
    const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const text = await handle.readFile({ encoding: 'utf8' });
      return (
        header +
        text
          .split('\n')
          .map((line) => `+${line}`)
          .join('\n') +
        '\n'
      );
    } finally {
      await handle.close();
    }
  } catch {
    return header;
  }
}

/**
 * Secrets in what the branch adds over `origin/<base>` plus what is not committed yet (changes
 * and untracked files that are not ignored). Falls back to the local base when origin has none.
 */
export async function scanWorktreeSecrets(cwd: string, base: string): Promise<SecretFinding[]> {
  let committed = '';
  try {
    committed = await git(cwd, ['diff', `origin/${base}...HEAD`]);
  } catch {
    try {
      committed = await git(cwd, ['diff', `${base}...HEAD`]);
    } catch {
      // A child repo without that base: what is pending below is still checked.
    }
  }
  const pending = await git(cwd, ['diff', 'HEAD']);
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']))
    .split('\0')
    .filter((file) => file !== '');
  const pieces = [committed, pending];
  for (const file of untracked) pieces.push(await untrackedAsDiff(cwd, file));
  return scanSecrets(pieces.join('\n'));
}
