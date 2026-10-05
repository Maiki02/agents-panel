import type { PermissionSuggestion, ProjectPermissions } from '@agents-panel/shared';

/**
 * Client-side checks for a project's Bash additions. They mirror validateProjectPermissions in the
 * API (the authority, which answers 400 on its own) so the form can explain a problem before sending.
 */
const COMMAND_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,49}$/;
const HOST_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Handled elsewhere in the API, so a project cannot add them: shell builtin and curl itself. */
const ALWAYS_HANDLED = ['cd', 'curl'];

export const MAX_EXTRA_ENTRIES = 50;

/** Why a command name cannot be added; null when it can. */
export function commandProblem(
  name: string,
  permissions: Pick<ProjectPermissions, 'base' | 'fixedDenied'>,
  current: readonly string[],
): string | null {
  const value = name.trim();
  if (value === '') return 'Escribí el nombre del comando, por ejemplo uv.';
  if (permissions.fixedDenied.includes(value)) {
    return `${value} no se puede habilitar: puede cambiar costos o sacar datos de la VM.`;
  }
  if (permissions.base.includes(value) || ALWAYS_HANDLED.includes(value)) {
    return `${value} ya forma parte de la base.`;
  }
  if (!COMMAND_NAME_RE.test(value)) {
    return 'Solo el nombre del comando: sin rutas, espacios ni símbolos de shell.';
  }
  if (current.includes(value)) return `${value} ya está en la lista.`;
  if (current.length >= MAX_EXTRA_ENTRIES) return `Hasta ${String(MAX_EXTRA_ENTRIES)} comandos.`;
  return null;
}

/** Why a host cannot be added; null when it can. Hosts are compared in lower case. */
export function hostProblem(
  host: string,
  permissions: Pick<ProjectPermissions, 'curlBaseHosts'>,
  current: readonly string[],
): string | null {
  const value = host.trim().toLowerCase();
  if (value === '') return 'Escribí el host, por ejemplo api.ejemplo.com.';
  if (permissions.curlBaseHosts.includes(value)) return `${value} ya está permitido.`;
  const labels = value.split('.');
  if (value.length > 253 || labels.some((label) => !HOST_LABEL_RE.test(label))) {
    return 'Solo el host, sin https://, puerto ni ruta.';
  }
  if (current.includes(value)) return `${value} ya está en la lista.`;
  if (current.length >= MAX_EXTRA_ENTRIES) return `Hasta ${String(MAX_EXTRA_ENTRIES)} hosts.`;
  return null;
}

/** The list with `item` appended once; the same list when it is already there. */
export function withItem(list: readonly string[], item: string): string[] {
  return list.includes(item) ? [...list] : [...list, item];
}

export function withoutItem(list: readonly string[], item: string): string[] {
  return list.filter((entry) => entry !== item);
}

/** Adds the commands of a suggestion to the draft without repeating any. */
export function applySuggestion(
  draft: readonly string[],
  suggestion: PermissionSuggestion,
): string[] {
  return suggestion.commands.reduce(withItem, [...draft]);
}

/** Suggestions with the commands already in the draft removed; a suggestion left empty is dropped. */
export function remainingSuggestions(
  suggestions: readonly PermissionSuggestion[],
  draft: readonly string[],
): PermissionSuggestion[] {
  return suggestions
    .map((suggestion) => ({
      ...suggestion,
      commands: suggestion.commands.filter((command) => !draft.includes(command)),
    }))
    .filter((suggestion) => suggestion.commands.length > 0);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** True when the draft differs from what the API has saved. */
export function permissionsChanged(
  saved: Pick<ProjectPermissions, 'commands' | 'hosts'>,
  draft: Pick<ProjectPermissions, 'commands' | 'hosts'>,
): boolean {
  return !sameList(saved.commands, draft.commands) || !sameList(saved.hosts, draft.hosts);
}
