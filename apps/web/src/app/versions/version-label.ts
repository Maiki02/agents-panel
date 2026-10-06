import type { MaintenanceRun, PanelDeployInfo } from '@agents-panel/shared';

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

const KIND_LABEL: Record<MaintenanceRun['kind'], string> = {
  'kyro-update': 'Kyro',
  'panel-deploy': 'Panel',
};

export function runLabel(run: Pick<MaintenanceRun, 'kind' | 'fromVersion' | 'toVersion'>): string {
  return `${KIND_LABEL[run.kind]} ${run.fromVersion ?? '?'} → ${run.toVersion ?? '?'}`;
}

/** What origin/main has that the running panel does not. */
export function behindLabel(behind: number | null): string {
  if (behind === null) return 'commits sin desplegar: desconocido';
  if (behind === 0) return 'al día con main';
  return behind === 1 ? '1 commit sin desplegar' : `${String(behind)} commits sin desplegar`;
}

/**
 * Where a deploy started from this page is: still running, waiting for the restart (the run ended
 * ok with a new commit but the server still runs the old one, or does not answer), done (the
 * server runs another commit: refresh) or finished without a restart (up to date or failed).
 */
export type DeployPhase = 'running' | 'restarting' | 'done' | 'finished';

export function deployPhase(
  from: string | null,
  panel: Pick<PanelDeployInfo, 'commit' | 'deployRunning'> | null,
  last: Pick<MaintenanceRun, 'status' | 'toVersion'> | undefined,
): DeployPhase {
  if (panel === null) return 'restarting';
  if (panel.commit !== null && panel.commit !== from) return 'done';
  if (panel.deployRunning || last === undefined || last.status === 'running') return 'running';
  return last.status === 'ok' && last.toVersion !== from ? 'restarting' : 'finished';
}
