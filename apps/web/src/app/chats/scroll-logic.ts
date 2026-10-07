/** Pure helpers behind the chat feed's own scroll. No Angular, no DOM. */
export interface ScrollMetrics {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
}

/** How close to the end (px) still counts as "reading the latest": the feed follows new events. */
export const FOLLOW_THRESHOLD_PX = 80;

/** Whether the feed is at (or near) its end, so a new event should keep it there. */
export function isNearBottom(metrics: ScrollMetrics, threshold = FOLLOW_THRESHOLD_PX): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}
