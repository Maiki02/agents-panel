import { describe, expect, it } from 'vitest';
import { slugProblem } from './new-chat.form';

describe('slugProblem', () => {
  it('accepts kebab-case and the empty draft', () => {
    expect(slugProblem('')).toBeNull();
    expect(slugProblem('fix-login-2')).toBeNull();
  });

  it('flags invalid slugs before submitting', () => {
    for (const bad of ['Fix', 'a b', 'a_b', '-a', 'a-', 'a--b', 'ñandú']) {
      expect(slugProblem(bad), bad).not.toBeNull();
    }
    expect(slugProblem('a'.repeat(51))).toMatch(/Máximo/);
  });
});
