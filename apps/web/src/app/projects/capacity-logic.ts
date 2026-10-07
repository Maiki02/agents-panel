import type { DiskProjectUsage, DiskUsage, MemoryUsage } from '@agents-panel/shared';

/** Text shown instead of numbers; never a 0 for a value that is unknown. */
export const MEASURING_TEXT = 'Midiendo…';
export const NO_DATA_TEXT = 'sin dato';

export type CapacityState = 'measuring' | 'error' | 'ready';

export interface BarSegment {
  key: string;
  label: string;
  bytes: number;
  /** Integer percent; the segments of a bar always add up to 100. */
  percent: number;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** Binary units with one decimal and a decimal comma: 1536 → "1,5 KB". Bytes have no decimals. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return NO_DATA_TEXT;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1).replace('.', ',');
  return `${text} ${UNITS[unit] ?? 'B'}`;
}

/** Gigabytes with one decimal, as the project cards show them: "3,2 GB". */
export function formatGb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return NO_DATA_TEXT;
  return `${(bytes / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;
}

/**
 * Integer percents of each value over the sum, by largest remainder, so they add up to exactly 100.
 * With no positive total there is nothing to split: all zeros.
 */
export function percents(values: readonly number[]): number[] {
  const safe = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const total = safe.reduce((a, b) => a + b, 0);
  if (total === 0) return safe.map(() => 0);
  const exact = safe.map((v) => (v / total) * 100);
  const result = exact.map((v) => Math.floor(v));
  let left = 100 - result.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, index) => ({ index, rest: v - Math.floor(v) }))
    .sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (const { index } of order) {
    if (left <= 0) break;
    result[index] = (result[index] ?? 0) + 1;
    left -= 1;
  }
  return result;
}

function toSegments(items: { key: string; label: string; bytes: number }[]): BarSegment[] {
  const split = percents(items.map((i) => i.bytes));
  return items.map((item, i) => ({ ...item, percent: split[i] ?? 0 }));
}

/**
 * measuring: no measurement yet (or a failed load that never had data → error).
 * error: the request failed with nothing to show, or the measurement has no totals.
 */
export function diskState(usage: DiskUsage | null, loadFailed: boolean): CapacityState {
  if (usage === null) return loadFailed ? 'error' : 'measuring';
  if (usage.totals === null)
    return usage.measuredAt === null && usage.measuring ? 'measuring' : 'error';
  return 'ready';
}

export function memoryState(usage: MemoryUsage | null, loadFailed: boolean): CapacityState {
  if (usage === null) return loadFailed ? 'error' : 'measuring';
  return usage.totals === null ? 'error' : 'ready';
}

export function diskSegments(usage: DiskUsage | null): BarSegment[] {
  const t = usage?.totals;
  if (!t) return [];
  return toSegments([
    { key: 'projects', label: 'Proyectos', bytes: t.projectsBytes },
    { key: 'worktrees', label: 'Worktrees', bytes: t.worktreesBytes },
    { key: 'other', label: 'Otros', bytes: t.otherBytes },
    { key: 'free', label: 'Libre', bytes: t.freeBytes },
  ]);
}

export function memorySegments(usage: MemoryUsage | null): BarSegment[] {
  const t = usage?.totals;
  if (!t) return [];
  return toSegments([
    { key: 'ai', label: 'Sesiones de IA y builds', bytes: t.aiBytes },
    { key: 'panel', label: 'Panel', bytes: t.panelBytes },
    { key: 'other', label: 'Otros', bytes: t.otherBytes },
    { key: 'available', label: 'Disponible', bytes: t.availableBytes },
  ]);
}

/** "2,0 GB de 4,0 GB"; sin dato when the system has no swap information. */
export function swapText(usage: MemoryUsage | null): string {
  const swap = usage?.swap;
  if (!swap) return NO_DATA_TEXT;
  if (swap.totalBytes === 0) return 'sin swap';
  return `${formatBytes(swap.usedBytes)} de ${formatBytes(swap.totalBytes)}`;
}

/** Hour of a measurement, 24 h, local time: "14:05". */
export function formatMeasuredAt(epochMs: number | null): string | null {
  if (epochMs === null) return null;
  const date = new Date(epochMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Line of a project card: "Repositorio 1,2 GB · Worktrees 3,4 GB"; never says "clon". */
export function projectDiskText(state: CapacityState, entry: DiskProjectUsage | undefined): string {
  if (state === 'measuring') return MEASURING_TEXT;
  if (state === 'error' || !entry) return NO_DATA_TEXT;
  const part = (bytes: number | null): string => (bytes === null ? NO_DATA_TEXT : formatGb(bytes));
  return `Repositorio ${part(entry.repositoryBytes)} · Worktrees ${part(entry.worktreesBytes)}`;
}
