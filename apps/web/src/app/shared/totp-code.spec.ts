import { describe, expect, it } from 'vitest';
import { isCompleteCode, sanitizeCode, takeCode } from './totp-code';

describe('totp code', () => {
  it('keeps only up to 6 digits', () => {
    expect(sanitizeCode('12a 34-5678')).toBe('123456');
    expect(sanitizeCode('')).toBe('');
  });

  it('is complete only with exactly 6 digits', () => {
    expect(isCompleteCode('123456')).toBe(true);
    expect(isCompleteCode('12345')).toBe(false);
    expect(isCompleteCode('12345a')).toBe(false);
  });

  it('empties the field when a code is sent, and sends nothing when incomplete', () => {
    expect(takeCode('123456')).toEqual({ send: '123456', remaining: '' });
    expect(takeCode('123')).toEqual({ send: null, remaining: '123' });
  });
});
