import type { MaintenanceRun } from '@agents-panel/shared';

function parts(version: string): number[] {
  return version
    .replace(/^v/, '')
    .split(/[.+-]/)
    .map((part) => Number.parseInt(part, 10))
    .map((n) => (Number.isNaN(n) ? 0 : n));
}

/** True when `latest` is a higher version than `installed` (numeric, dot-separated). */
export function isNewer(latest: string, installed: string): boolean {
  const a = parts(latest);
  const b = parts(installed);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/** "última: desconocida" without network; otherwise whether the installed one is up to date. */
export function latestLabel(installed: string | null, latest: string | null): string {
  if (latest === null) return 'última: desconocida';
  if (installed !== null && isNewer(latest, installed)) {
    return `última: ${latest} (hay una nueva)`;
  }
  return installed === null ? `última: ${latest}` : `última: ${latest} (al día)`;
}

export function runLabel(run: Pick<MaintenanceRun, 'fromVersion' | 'toVersion'>): string {
  return `${run.fromVersion ?? '?'} → ${run.toVersion ?? '?'}`;
}
