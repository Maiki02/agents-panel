import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { PermissionDecision } from './runner.js';

/** Binaries the agent may run through Bash. Everything else is denied. */
export const ALLOWED_BASH_COMMANDS = ['git', 'gh', 'npm', 'go', 'kyro'] as const;

/**
 * Commands no project can enable: anything that can change what Oracle charges (oci, tailscale,
 * terraform), escalate privileges (sudo, su) or move data or open shells to other machines (ssh,
 * scp, sftp, nc, ncat, socat, wget). The rule of costs in CLAUDE.md depends on this list.
 */
export const FIXED_DENIED_COMMANDS = [
  'oci',
  'tailscale',
  'terraform',
  'sudo',
  'su',
  'ssh',
  'scp',
  'sftp',
  'nc',
  'ncat',
  'socat',
  'wget',
] as const;

/**
 * Commands that run the command passed to them (shells and wrappers). The check only sees the first
 * word of each stage, so enabling one would turn `env sudo …` or `xargs ssh` into an allowed call:
 * they are never enabled either.
 */
export const COMMAND_RUNNERS = [
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'busybox',
  'env',
  'xargs',
  'exec',
  'eval',
  'command',
  'builtin',
  'nohup',
  'timeout',
  'nice',
  'setsid',
  'stdbuf',
  'script',
  'time',
  'watch',
  'chroot',
  'runuser',
  'doas',
  'pkexec',
  'parallel',
] as const;

/** Everything no project configuration can enable: the fixed list plus the command runners. */
export const NEVER_ENABLED_COMMANDS: readonly string[] = [
  ...FIXED_DENIED_COMMANDS,
  ...COMMAND_RUNNERS,
];

/** Per-project additions to the Bash base: extra command names and hosts `curl` may reach. */
export interface BashExtras {
  commands: readonly string[];
  hosts: readonly string[];
}

export const NO_BASH_EXTRAS: BashExtras = { commands: [], hosts: [] };

/**
 * Auto-approved by the SDK without asking. Bare tool names are left out on purpose: they would
 * shadow canUseTool, which is where file paths and the safe tools (Skill, TodoWrite) are checked.
 */
export const ALLOWED_TOOLS: string[] = [...ALLOWED_BASH_COMMANDS.map((c) => `Bash(${c}:*)`)];

const SAFE_TOOLS = new Set(['Skill', 'TodoWrite', 'Task', 'Agent']);
const READ_TOOLS: Record<string, string> = { Read: 'file_path', Glob: 'path', Grep: 'path' };
const WRITE_TOOLS: Record<string, string> = {
  Edit: 'file_path',
  Write: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

function realish(path: string): string {
  // Resolve symlinks on the deepest existing ancestor so a link cannot escape the root.
  const absolute = resolve(path);
  let probe = absolute;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  try {
    return join(realpathSync(probe), absolute.slice(probe.length));
  } catch {
    return absolute;
  }
}

function isInside(root: string, path: string, cwd: string): boolean {
  const base = realish(root);
  // Relative paths are relative to the agent's worktree, not to this server process.
  const target = realish(isAbsolute(path) ? path : resolve(cwd, path));
  return target === base || target.startsWith(base + sep);
}

function deny(message: string): PermissionDecision {
  return { behavior: 'deny', message };
}

/** Read-only text filters, allowed only after a pipe (never as the start of a command). */
export const PIPE_FILTERS = ['head', 'tail', 'grep', 'wc', 'sort', 'uniq', 'cut'];

/**
 * Read-only commands allowed as the start of a command, so an agent without Kyro can look around.
 * Every argument that is not a flag must resolve inside the worktree.
 */
export const READ_COMMANDS = ['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'pwd'];

function checkReadArgs(stage: string, cwd: string): PermissionDecision {
  if (/[$~*?[{]/.test(stage))
    return deny('Variables, ~ and globs are not allowed in read commands');
  for (const raw of stage.split(/\s+/).slice(1)) {
    // A quoting layer around the whole token is harmless, but quotes or backslashes inside it
    // change what bash resolves (`\/etc/x`, `""../../x`), so the path checked would not be the path read.
    const arg = raw.replace(/^["']/, '').replace(/["']$/, '');
    if (/["'\\]/.test(arg)) return deny('Quotes and backslashes inside a path are not allowed');
    if (arg === '') continue;
    if (arg.startsWith('-')) {
      // Options that carry a path (--file=/etc/x) would skip the check below.
      if (/[/=]/.test(arg)) return deny('Options with a path or value are not allowed');
      continue;
    }
    if (!isInside(cwd, arg, cwd))
      return deny(`Reading outside the worktree is not allowed: ${arg.slice(0, 80)}`);
  }
  return { behavior: 'allow' };
}

/** Hosts `curl` may always reach, besides the ones the project lists. */
export const CURL_BASE_HOSTS = ['localhost', '127.0.0.1'];

/** Flags without a value that only read or shape the output. */
const CURL_FLAGS = new Set([
  '-s',
  '-S',
  '-f',
  '-v',
  '-i',
  '-I',
  '--silent',
  '--show-error',
  '--fail',
  '--verbose',
  '--include',
  '--head',
  '--compressed',
]);
/** Flags that take one numeric value (seconds). */
const CURL_NUMERIC_FLAGS = new Set(['-m', '--max-time', '--connect-timeout']);

/**
 * `curl` is a read-only probe: GET or HEAD to localhost or to a host of the project's policy. Only
 * flags in an allowlist pass, so -L, -d, -F, -T, -X, -o, -O, -K and every unknown flag are denied;
 * so is anything with `@` (file upload or credentials in the URL).
 */
function checkCurl(stage: string, hosts: readonly string[]): PermissionDecision {
  if (/[$~*?[\]{}\\"'`]/.test(stage)) {
    return deny('Variables, quotes and globs are not allowed in curl');
  }
  const allowedHosts = new Set([...CURL_BASE_HOSTS, ...hosts.map((host) => host.toLowerCase())]);
  const args = stage.split(/\s+/).slice(1);
  let urls = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg.includes('@')) return deny('curl arguments with @ are not allowed');
    if (arg.startsWith('-')) {
      const [flag = '', inlineValue] = arg.startsWith('--') ? arg.split('=', 2) : [arg];
      if (CURL_NUMERIC_FLAGS.has(flag)) {
        const value = inlineValue ?? args[++i] ?? '';
        if (!/^\d+(\.\d+)?$/.test(value)) return deny(`${flag} needs a number`);
        continue;
      }
      if (inlineValue === undefined && CURL_FLAGS.has(flag)) continue;
      // A cluster such as -sS: every letter must be a plain flag.
      if (
        !arg.startsWith('--') &&
        arg.length > 2 &&
        Array.from(arg.slice(1)).every((letter) => CURL_FLAGS.has(`-${letter}`))
      ) {
        continue;
      }
      return deny(`curl option not allowed: ${arg.slice(0, 40)}`);
    }
    let url: URL;
    try {
      url = new URL(arg);
    } catch {
      return deny(`curl needs a full http(s) URL: ${arg.slice(0, 80)}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return deny('curl only reaches http and https URLs');
    }
    if (url.username !== '' || url.password !== '') {
      return deny('curl URLs cannot carry credentials');
    }
    if (!allowedHosts.has(url.hostname)) {
      return deny(`curl host not allowed: ${url.hostname.slice(0, 80)}`);
    }
    urls++;
  }
  return urls > 0 ? { behavior: 'allow' } : deny('curl needs a URL');
}

export class PermissionConfigError extends Error {
  override readonly name = 'PermissionConfigError';
}

const COMMAND_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,49}$/;
const HOST_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
export const MAX_EXTRA_COMMANDS = 50;
export const MAX_EXTRA_HOSTS = 50;

/** Everything a project may not add because the base or the fixed list already decides it. */
export const NOT_CONFIGURABLE = new Set<string>([
  ...ALLOWED_BASH_COMMANDS,
  ...NEVER_ENABLED_COMMANDS,
  ...READ_COMMANDS,
  ...PIPE_FILTERS,
  'cd',
  'curl',
]);

/**
 * Validates a project's Bash additions and returns them normalized (deduplicated, hosts in lower
 * case). Commands are bare names: no paths, spaces or shell metacharacters.
 */
export function validateProjectPermissions(input: {
  commands: readonly string[];
  hosts: readonly string[];
}): BashExtras {
  if (input.commands.length > MAX_EXTRA_COMMANDS || input.hosts.length > MAX_EXTRA_HOSTS) {
    throw new PermissionConfigError('Demasiados comandos o hosts');
  }
  for (const command of input.commands) {
    if (!COMMAND_NAME_RE.test(command)) {
      throw new PermissionConfigError(`Nombre de comando inválido: ${command.slice(0, 50)}`);
    }
    if (NEVER_ENABLED_COMMANDS.includes(command)) {
      throw new PermissionConfigError(`El comando ${command} no se puede habilitar`);
    }
    if (NOT_CONFIGURABLE.has(command)) {
      throw new PermissionConfigError(`El comando ${command} ya forma parte de la base`);
    }
  }
  const hosts = input.hosts.map((host) => host.toLowerCase());
  for (const host of hosts) {
    const labels = host.split('.');
    if (host.length > 253 || labels.some((label) => !HOST_LABEL_RE.test(label))) {
      throw new PermissionConfigError(`Host inválido: ${host.slice(0, 80)}`);
    }
  }
  return { commands: [...new Set(input.commands)], hosts: [...new Set(hosts)] };
}

export function checkBash(
  command: string,
  cwd?: string,
  extras: BashExtras = NO_BASH_EXTRAS,
): PermissionDecision {
  if (/\$\(|`|<\(|>\(/.test(command)) return deny('Command substitution is not allowed');
  const withoutSafeRedirects = command.replace(/\d?>\s*&\d|\d?>\s*\/dev\/null/g, '');
  if (/[<>]/.test(withoutSafeRedirects)) return deny('Redirection is not allowed');

  // A lone & (background job) also starts a new command, so it is a separator too.
  for (const chain of withoutSafeRedirects.split(/&&|\|\||;|\n|&/)) {
    const stages = chain.split('|').map((stage) => stage.trim());
    for (const [index, stage] of stages.entries()) {
      if (stage === '') continue;
      const [first = ''] = stage.split(/\s+/);
      if (index === 0 && first === 'cd') continue;
      if (index === 0 && cwd !== undefined && READ_COMMANDS.includes(first)) {
        const verdict = checkReadArgs(stage, cwd);
        if (verdict.behavior === 'deny') return verdict;
        continue;
      }
      // The fixed list wins over everything, a project's configuration included (even one stored
      // before a name joined the list).
      if (NEVER_ENABLED_COMMANDS.includes(first)) {
        return deny(`Bash command never allowed: ${first}`);
      }
      if (first === 'curl') {
        const verdict = checkCurl(stage, extras.hosts);
        if (verdict.behavior === 'deny') return verdict;
        continue;
      }
      const allowed =
        (ALLOWED_BASH_COMMANDS as readonly string[]).includes(first) ||
        extras.commands.includes(first) ||
        (index > 0 && PIPE_FILTERS.includes(first));
      if (!allowed) return deny(`Bash command not allowed: ${first.slice(0, 40)}`);
    }
  }
  return { behavior: 'allow' };
}

export interface PermissionPolicy {
  /** Worktree of the chat: the only place the agent may write. */
  cwd: string;
  /** Extra read-only roots (Kyro runtime and skills live outside the worktree). */
  extraReadRoots?: string[];
  /** The project's own Bash commands and curl hosts, on top of the base. */
  bashExtras?: BashExtras;
}

/** Allowlist policy: the agent never gets more than this, and what is not listed is denied. */
export function decide(
  policy: PermissionPolicy,
  toolName: string,
  input: Record<string, unknown>,
): PermissionDecision {
  if (SAFE_TOOLS.has(toolName)) return { behavior: 'allow' };

  if (toolName === 'Bash') {
    const command = input['command'];
    return typeof command === 'string'
      ? checkBash(command, policy.cwd, policy.bashExtras)
      : deny('Bash needs a command');
  }

  const readKey = READ_TOOLS[toolName];
  if (readKey !== undefined) {
    const raw = input[readKey];
    const path = typeof raw === 'string' ? raw : policy.cwd;
    const roots = [policy.cwd, ...(policy.extraReadRoots ?? defaultReadRoots())];
    return roots.some((root) => isInside(root, path, policy.cwd))
      ? { behavior: 'allow' }
      : deny(`Reading outside the worktree is not allowed: ${path}`);
  }

  const writeKey = WRITE_TOOLS[toolName];
  if (writeKey !== undefined) {
    const raw = input[writeKey];
    return typeof raw === 'string' && isInside(policy.cwd, raw, policy.cwd)
      ? { behavior: 'allow' }
      : deny('Writing outside the worktree is not allowed');
  }

  return deny(`Tool not allowed: ${toolName}`);
}

export function defaultReadRoots(): string[] {
  return [join(homedir(), '.agents'), join(homedir(), '.claude', 'skills')];
}
