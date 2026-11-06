import { DOCUMENT } from '@angular/common';
import { DestroyRef, inject, signal, type Signal } from '@angular/core';

/** Tailwind's `lg` breakpoint: below it the chat behaves like mobile (back arrow, no project tabs). */
export const WIDE_QUERY = '(min-width: 64rem)';

/** Whether a media query matches, kept up to date. Call it in an injection context. */
export function mediaMatches(query: string): Signal<boolean> {
  const list = inject(DOCUMENT).defaultView?.matchMedia(query);
  const matches = signal(list?.matches ?? true);
  if (list) {
    const onChange = (event: MediaQueryListEvent): void => {
      matches.set(event.matches);
    };
    list.addEventListener('change', onChange);
    inject(DestroyRef).onDestroy(() => {
      list.removeEventListener('change', onChange);
    });
  }
  return matches.asReadonly();
}
