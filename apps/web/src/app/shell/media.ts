import { DOCUMENT } from '@angular/common';
import { DestroyRef, inject, signal, type Signal } from '@angular/core';

/** Tailwind's `md` breakpoint: from here on the chat list sits next to the chat. */
export const WIDE_QUERY = '(min-width: 48rem)';

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
