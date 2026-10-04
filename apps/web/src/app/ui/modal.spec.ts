import { describe, expect, it } from 'vitest';
import { closesOnBackdrop, closesOnKey, nextFocusIndex } from './modal-logic';

describe('modal logic', () => {
  it('closes on Escape and ignores other keys', () => {
    expect(closesOnKey('Escape')).toBe(true);
    expect(closesOnKey('Enter')).toBe(false);
    expect(closesOnKey('Tab')).toBe(false);
  });

  it('closes on a click on the backdrop but not inside the dialog', () => {
    const backdrop = {} as EventTarget;
    const inside = {} as EventTarget;
    expect(closesOnBackdrop(backdrop, backdrop)).toBe(true);
    expect(closesOnBackdrop(inside, backdrop)).toBe(false);
    expect(closesOnBackdrop(null, backdrop)).toBe(false);
  });

  it('cycles focus forwards and backwards, entering from outside', () => {
    expect(nextFocusIndex(3, 2, false)).toBe(0);
    expect(nextFocusIndex(3, 0, true)).toBe(2);
    expect(nextFocusIndex(3, 1, false)).toBe(2);
    expect(nextFocusIndex(3, -1, false)).toBe(0);
    expect(nextFocusIndex(3, -1, true)).toBe(2);
    expect(nextFocusIndex(0, -1, false)).toBe(-1);
  });
});
