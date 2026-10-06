export { closesOnBackdrop, closesOnKey, nextFocusIndex } from './modal-logic';

/** Panel position: on screen when open, fully off the left edge when closed (the slide). */
export function panelTranslate(open: boolean): string {
  return open ? 'translate-x-0' : '-translate-x-full';
}

/** Backdrop fade: visible and clickable only while open. */
export function backdropState(open: boolean): string {
  return open ? 'opacity-100' : 'pointer-events-none opacity-0';
}

/**
 * Whether a navigation should close the drawer: any change of path does, a change that only
 * touches the query or the fragment does not (it is still the same screen).
 */
export function closesOnNavigation(previousUrl: string, nextUrl: string): boolean {
  return pathOf(previousUrl) !== pathOf(nextUrl);
}

function pathOf(url: string): string {
  return url.split(/[?#]/, 1)[0] ?? '';
}
