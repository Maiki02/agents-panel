import type { ChatEvent } from '@agents-panel/shared';
import { toViewItems, type ViewItem } from './event-view';

/** Events per window, for the first one and for each earlier one. */
export const FEED_WINDOW_TAIL = 10;

/** One rendered item with a key that does not change when older items are put before it. */
export interface FeedRow {
  readonly key: string;
  readonly item: ViewItem;
}

/** Rows of some events: the key is the event's seq plus the item's index inside that event. */
export function rowsFromEvents(events: readonly ChatEvent[]): FeedRow[] {
  return events.flatMap((event) =>
    toViewItems(event).map((item, index) => ({
      key: `${String(event.seq)}:${String(index)}`,
      item,
    })),
  );
}

/** Only the events strictly before `firstSeq`, so a window that overlaps what is shown adds nothing twice. */
export function olderThan(events: readonly ChatEvent[], firstSeq: number | null): ChatEvent[] {
  return firstSeq === null ? [...events] : events.filter((event) => event.seq < firstSeq);
}

/** The smallest seq between the shown one and a new older window. */
export function nextFirstSeq(current: number | null, older: readonly ChatEvent[]): number | null {
  const seqs = older.map((event) => event.seq);
  if (current !== null) seqs.push(current);
  return seqs.length === 0 ? null : Math.min(...seqs);
}

/** Whether an earlier window should be requested now: near the top, none in flight, and there is more. */
export function shouldLoadOlder(state: {
  nearTop: boolean;
  loading: boolean;
  hasMore: boolean;
  firstSeq: number | null;
}): boolean {
  return state.nearTop && !state.loading && state.hasMore && state.firstSeq !== null;
}

/** New scrollTop after putting items before the current ones: the same content stays under the eyes. */
export function scrollTopAfterPrepend(
  scrollTop: number,
  heightBefore: number,
  heightAfter: number,
): number {
  return scrollTop + Math.max(0, heightAfter - heightBefore);
}
