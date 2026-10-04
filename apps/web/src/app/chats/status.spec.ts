import { describe, expect, it } from 'vitest';
import { chatSubtitle, hasRunning, statusTone } from './status';

describe('chat status helpers', () => {
  it('polls only while some chat is running', () => {
    expect(hasRunning([{ status: 'idle' }, { status: 'running' }])).toBe(true);
    expect(hasRunning([{ status: 'idle' }, { status: 'error' }])).toBe(false);
    expect(hasRunning([])).toBe(false);
  });

  it('identifies a chat by kind and branch', () => {
    expect(chatSubtitle({ kind: 'work', branch: 'feature/fix-login' })).toBe(
      'work · feature/fix-login',
    );
    expect(chatSubtitle({ kind: 'scope', branch: 'feature/panel' })).toBe('scope · feature/panel');
  });

  it('maps each status to a badge tone', () => {
    expect(statusTone('running')).toBe('accent');
    expect(statusTone('idle')).toBe('ok');
    expect(statusTone('error')).toBe('danger');
    expect(statusTone('interrupted')).toBe('warn');
  });
});
