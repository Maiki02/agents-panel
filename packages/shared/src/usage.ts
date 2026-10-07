/** Rate-limit window names the SDK reports (`rateLimitType`); any other value is kept as a string. */
export type UsageWindowName =
  'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | (string & {});

export type UsageStatus = 'allowed' | 'allowed_warning' | 'rejected';

/** Last observation of one usage window of a provider account. */
export interface UsageWindow {
  window: UsageWindowName;
  /** 0-100, or null when the source did not report it (the tone then comes from `status`). */
  utilization: number | null;
  status: UsageStatus | null;
  /** Epoch milliseconds when the window resets, if known. */
  resetsAt: number | null;
  source: 'event' | 'query';
  /** Epoch milliseconds of the observation. */
  observedAt: number;
}

export type UsageTone = 'ok' | 'warn' | 'danger';

/** A window as the API serves it: the stored observation plus its tone. */
export interface UsageWindowView extends UsageWindow {
  tone: UsageTone;
}

/** Usage of one provider account: what the header icon and its popover show. */
export interface ProviderUsage {
  provider: 'claude';
  accountId: number;
  windows: UsageWindowView[];
  source: 'event' | 'query';
  /** Epoch milliseconds of the newest observation, null when there is none. */
  observedAt: number | null;
  /** True when the on-demand reading failed and only passive data is shown. */
  degraded: boolean;
  error?: string;
}

export const USAGE_WARN_PERCENT = 70;
export const USAGE_DANGER_PERCENT = 90;

/** Same threshold for the API and the web: ok < 70 %, warn >= 70 %, danger >= 90 % or rejected. */
export function usageTone(window: Pick<UsageWindow, 'utilization' | 'status'>): UsageTone {
  if (window.status === 'rejected') return 'danger';
  const percent = window.utilization;
  if (percent !== null) {
    if (percent >= USAGE_DANGER_PERCENT) return 'danger';
    if (percent >= USAGE_WARN_PERCENT) return 'warn';
    return 'ok';
  }
  return window.status === 'allowed_warning' ? 'warn' : 'ok';
}
