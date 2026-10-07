import { usageTone, type UsageTone, type UsageWindow } from '@agents-panel/shared';

/** The window the header icon shows. */
export const HEADLINE_WINDOW = 'five_hour';

/** Display order: the 5 h window first, then the weekly one, then the per-model weekly ones. */
const WINDOW_ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

const WINDOW_LABELS: Record<string, string> = {
  five_hour: '5 horas',
  seven_day: 'Semanal',
  seven_day_opus: 'Semanal (Opus)',
  seven_day_sonnet: 'Semanal (Sonnet)',
};

export function windowLabel(window: string): string {
  return WINDOW_LABELS[window] ?? window;
}

/** Known windows in their fixed order, then any other one by name. */
export function sortWindows<T extends Pick<UsageWindow, 'window'>>(windows: readonly T[]): T[] {
  const rank = (name: string): number => {
    const index = WINDOW_ORDER.indexOf(name);
    return index === -1 ? WINDOW_ORDER.length : index;
  };
  return [...windows].sort(
    (a, b) => rank(a.window) - rank(b.window) || a.window.localeCompare(b.window),
  );
}

/** Tone of a window, from the shared thresholds (never duplicated here). */
export function windowTone(window: Pick<UsageWindow, 'utilization' | 'status'>): UsageTone {
  return usageTone(window);
}

/** Percent shown on the icon: the 5 h window of the account, or null without data. */
export function headlinePercent(windows: readonly UsageWindow[]): number | null {
  return windows.find((w) => w.window === HEADLINE_WINDOW)?.utilization ?? null;
}

export function headlineTone(windows: readonly UsageWindow[]): UsageTone | null {
  const window = windows.find((w) => w.window === HEADLINE_WINDOW);
  return window ? windowTone(window) : null;
}

/** "5 %"-style text; a dash when the source did not report it. */
export function formatPercent(percent: number | null): string {
  return percent === null ? '–' : `${String(Math.round(percent))} %`;
}

/** "hace 3 min" for an epoch-ms observation; "ahora" under a minute. */
export function formatAgo(observedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - observedAt) / 1000));
  if (seconds < 60) return 'ahora';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${String(hours)} h`;
  return `hace ${String(Math.floor(hours / 24))} d`;
}

/** Reset time in the browser's local time: "14:30" today, "mar 14:30" on another day. */
export function formatReset(resetsAt: number, now: number): string {
  const date = new Date(resetsAt);
  const time = date.toLocaleTimeString('es-AR', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  if (date.toDateString() === new Date(now).toDateString()) return time;
  const day = date.toLocaleDateString('es-AR', { weekday: 'short' });
  return `${day} ${time}`;
}

/** Tailwind classes of the bar fill and the text for a tone. */
export function toneClasses(tone: UsageTone | null): { bar: string; text: string } {
  switch (tone) {
    case 'danger':
      return { bar: 'bg-danger', text: 'text-danger' };
    case 'warn':
      return { bar: 'bg-warn', text: 'text-warn' };
    case 'ok':
      return { bar: 'bg-ok', text: 'text-ok' };
    case null:
      return { bar: 'bg-border', text: 'text-muted' };
  }
}
