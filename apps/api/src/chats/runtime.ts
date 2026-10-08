/** A span of time; `end` null means it is still open (it counts up to `now`). */
export interface Interval {
  start: number;
  end: number | null;
}

type Closed = [number, number];

function close(intervals: readonly Interval[], now: number): Closed[] {
  const closed: Closed[] = [];
  for (const { start, end } of intervals) {
    const to = Math.min(end ?? now, now);
    if (to > start) closed.push([start, to]);
  }
  return closed;
}

/** Sorted, non-overlapping union of the intervals. */
function union(intervals: Closed[]): Closed[] {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const merged: Closed[] = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/**
 * Net execution time of a chat: the union of its work intervals (AI sessions and panel steps, so an
 * overlap counts once) minus only the part that falls inside a question wait. Queue, usage limit and
 * approvals happen between sessions, so they never add. Open intervals run up to `now` (an open
 * question keeps the time still). Never negative.
 */
export function netRuntimeMs(
  work: readonly Interval[],
  waits: readonly Interval[],
  now: number,
): number {
  const worked = union(close(work, now));
  const waiting = union(close(waits, now));
  let total = 0;
  for (const [start, end] of worked) total += end - start;
  for (const [wStart, wEnd] of waiting) {
    for (const [start, end] of worked) {
      const overlap = Math.min(end, wEnd) - Math.max(start, wStart);
      if (overlap > 0) total -= overlap;
    }
  }
  return Math.max(0, total);
}
