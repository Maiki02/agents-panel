import { describe, expect, it } from 'vitest';
import { moveTab, resolveTab } from './tabs-logic';
import { badgeClasses } from './badge';
import { buttonClasses } from './button';

const IDS = ['general', 'environment'];

describe('resolveTab', () => {
  it('returns the requested tab when it exists', () => {
    expect(resolveTab(IDS, 'environment')).toBe('environment');
  });

  it('falls back to the first tab when the requested one does not exist or is empty', () => {
    expect(resolveTab(IDS, 'nope')).toBe('general');
    expect(resolveTab(IDS, null)).toBe('general');
    expect(resolveTab(IDS, undefined)).toBe('general');
    expect(resolveTab([], 'x')).toBe('');
  });
});

describe('moveTab', () => {
  it('moves with the arrows, wrapping around', () => {
    expect(moveTab(IDS, 'general', 'ArrowRight')).toBe('environment');
    expect(moveTab(IDS, 'environment', 'ArrowRight')).toBe('general');
    expect(moveTab(IDS, 'general', 'ArrowLeft')).toBe('environment');
  });

  it('jumps with Home and End and ignores other keys', () => {
    expect(moveTab(IDS, 'environment', 'Home')).toBe('general');
    expect(moveTab(IDS, 'general', 'End')).toBe('environment');
    expect(moveTab(IDS, 'general', 'a')).toBeNull();
    expect(moveTab([], 'general', 'Home')).toBeNull();
  });
});

describe('variant classes use tokens only', () => {
  it('has no literal colors or sizes in px', () => {
    const all = [
      buttonClasses('primary'),
      buttonClasses('secondary'),
      buttonClasses('danger'),
      buttonClasses('icon'),
      badgeClasses('ok'),
      badgeClasses('danger'),
    ].join(' ');
    expect(all).not.toMatch(/#[0-9a-f]{3,8}|\[\d+px\]|\[#/i);
  });

  it('never paints a text with the primary color (only borders and primary buttons)', () => {
    const tones = ['neutral', 'accent', 'ok', 'warn', 'danger'] as const;
    for (const tone of tones) expect(badgeClasses(tone)).not.toMatch(/\btext-accent\b/);
    expect(badgeClasses('accent')).toContain('border-accent');
    expect(badgeClasses('accent')).toContain('text-text');
    expect(buttonClasses('secondary')).not.toMatch(/\btext-accent\b/);
  });
});
