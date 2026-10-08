export interface TabItem {
  id: string;
  label: string;
}

/** The requested tab when it exists, otherwise the first one ('' when there are none). */
export function resolveTab(ids: readonly string[], requested: string | null | undefined): string {
  if (requested !== null && requested !== undefined && ids.includes(requested)) return requested;
  return ids[0] ?? '';
}

/** Options to bring the active tab into view with the least scrolling, in both axes. */
export const REVEAL_OPTIONS = { block: 'nearest', inline: 'nearest' } as const;

/** Arrow/Home/End navigation between tabs; null when the key is not a tab key. */
export function moveTab(ids: readonly string[], current: string, key: string): string | null {
  if (ids.length === 0) return null;
  const index = Math.max(ids.indexOf(current), 0);
  if (key === 'ArrowRight') return ids[(index + 1) % ids.length] ?? null;
  if (key === 'ArrowLeft') return ids[(index - 1 + ids.length) % ids.length] ?? null;
  if (key === 'Home') return ids[0] ?? null;
  if (key === 'End') return ids[ids.length - 1] ?? null;
  return null;
}
