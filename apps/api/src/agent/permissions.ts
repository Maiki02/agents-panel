import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { PermissionDecision } from './runner.js';

/** Binaries the agent may run through Bash. Everything else is denied. */
export const ALLOWED_BASH_COMMANDS = ['git', 'gh', 'npm', 'go', 'kyro'] as const;

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
const PIPE_FILTERS = ['head', 'tail', 'grep', 'wc', 'sort', 'uniq', 'cut'];

export function checkBash(command: string): PermissionDecision {
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
      const allowed =
        (ALLOWED_BASH_COMMANDS as readonly string[]).includes(first) ||
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
    return typeof command === 'string' ? checkBash(command) : deny('Bash needs a command');
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
