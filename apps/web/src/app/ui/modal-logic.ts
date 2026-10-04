/** Esc closes the modal. */
export function closesOnKey(key: string): boolean {
  return key === 'Escape';
}

/** A click closes only when it lands on the backdrop itself, never on the dialog content. */
export function closesOnBackdrop(
  target: EventTarget | null,
  backdrop: EventTarget | null,
): boolean {
  return target !== null && target === backdrop;
}

/** Index of the focusable element to focus next while tabbing inside the dialog (wraps around). */
export function nextFocusIndex(count: number, current: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return backwards ? count - 1 : 0;
  return (current + (backwards ? -1 : 1) + count) % count;
}
