import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PermissionSuggestion } from '@agents-panel/shared';
import type { BashExtras } from '../agent/permissions.js';
import { NOT_CONFIGURABLE } from '../agent/permissions.js';

/** Files of the repo that hint at tools the agent will need, and the commands for each. */
const HINTS: { files: string[]; commands: string[] }[] = [
  { files: ['uv.lock', 'pyproject.toml'], commands: ['uv', 'python', 'pytest'] },
  { files: ['Makefile'], commands: ['make'] },
  { files: ['Cargo.toml'], commands: ['cargo'] },
];

/**
 * Commands to offer for a project, from the file names in its base clone (read-only: nothing is
 * executed). Whatever the base already allows, or the project already added, is left out.
 */
export function suggestPermissions(repoPath: string, current: BashExtras): PermissionSuggestion[] {
  const suggestions: PermissionSuggestion[] = [];
  for (const hint of HINTS) {
    const file = hint.files.find((name) => existsSync(join(repoPath, name)));
    if (file === undefined) continue;
    const commands = hint.commands.filter(
      (command) => !NOT_CONFIGURABLE.has(command) && !current.commands.includes(command),
    );
    if (commands.length > 0) suggestions.push({ file, commands });
  }
  return suggestions;
}
