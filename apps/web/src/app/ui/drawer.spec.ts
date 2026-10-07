import { describe, expect, it } from 'vitest';
import {
  backdropState,
  closesOnBackdrop,
  closesOnKey,
  closesOnNavigation,
  panelTranslate,
} from './drawer-logic';
import { MATERIAL_VIEW_BOX, svgPathData } from './icon-logic';

describe('drawer', () => {
  it('slides the panel in when open and fully out to the left when closed', () => {
    expect(panelTranslate(true)).toBe('translate-x-0');
    expect(panelTranslate(false)).toBe('-translate-x-full');
  });

  it('shows a clickable backdrop only while open', () => {
    expect(backdropState(true)).toBe('opacity-100');
    expect(backdropState(false)).toContain('pointer-events-none');
    expect(backdropState(false)).toContain('opacity-0');
  });

  it('closes with Esc and with a click on the backdrop, not on the panel', () => {
    const backdrop = {} as EventTarget;
    expect(closesOnKey('Escape')).toBe(true);
    expect(closesOnKey('Enter')).toBe(false);
    expect(closesOnBackdrop(backdrop, backdrop)).toBe(true);
    expect(closesOnBackdrop({} as EventTarget, backdrop)).toBe(false);
  });

  it('closes when the path changes but not on a query or fragment change', () => {
    expect(closesOnNavigation('/', '/versions')).toBe(true);
    expect(closesOnNavigation('/projects/1/chats/2', '/projects/1/chats/3')).toBe(true);
    expect(closesOnNavigation('/accounts', '/accounts?x=1')).toBe(false);
    expect(closesOnNavigation('/accounts#a', '/accounts')).toBe(false);
  });
});

describe('icon', () => {
  it('keeps the path data of a Material Symbols SVG', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 -960 960 960"><path d="M120-240v-60h720v60H120Z"/></svg>';
    expect(svgPathData(svg)).toBe('M120-240v-60h720v60H120Z');
    expect(MATERIAL_VIEW_BOX).toBe('0 -960 960 960');
  });

  it('joins several paths and returns empty when there is none', () => {
    expect(svgPathData('<svg><path d="M1 1Z"/><path fill="x" d="M2 2Z"/></svg>')).toBe(
      'M1 1Z M2 2Z',
    );
    expect(svgPathData('<svg></svg>')).toBe('');
  });
});
