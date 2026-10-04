import type { ChatEvent } from '@agents-panel/shared';
import { describe, expect, it } from 'vitest';
import { endsTurn, toViewItems } from './event-view';

const ev = (type: string, payload: unknown, seq = 1): ChatEvent => ({
  id: seq,
  chatId: 1,
  seq,
  type,
  payload,
  createdAt: 0,
});

describe('toViewItems', () => {
  it('shows assistant text and tool use from one SDK message', () => {
    const items = toViewItems(
      ev('assistant', {
        message: {
          content: [
            { type: 'text', text: 'Voy a mirar el repo' },
            { type: 'tool_use', name: 'Bash', input: { command: 'git status' } },
            { type: 'thinking', thinking: 'hidden' },
          ],
        },
      }),
    );
    expect(items.map((i) => i.kind)).toEqual(['assistant', 'tool']);
    expect(items[1]).toMatchObject({ name: 'Bash' });
    expect((items[1] as { input: string }).input).toContain('git status');
  });

  it('maps tool results, denials, errors, final results and the user prompt', () => {
    expect(
      toViewItems(
        ev('user', {
          message: { content: [{ type: 'tool_result', content: 'ok', is_error: true }] },
        }),
      ),
    ).toEqual([{ kind: 'tool_result', seq: 1, text: 'ok', isError: true }]);
    expect(toViewItems(ev('permission_denied', { tool: 'Bash', reason: 'no curl' }))).toMatchObject(
      [{ kind: 'denied', tool: 'Bash', reason: 'no curl' }],
    );
    expect(toViewItems(ev('error', { message: 'boom' }))).toMatchObject([{ kind: 'error' }]);
    expect(toViewItems(ev('result:success', { result: 'listo' }))).toMatchObject([
      { kind: 'result', ok: true, text: 'listo' },
    ]);
    expect(toViewItems(ev('result:error_max_turns', {}))).toMatchObject([
      { kind: 'result', ok: false },
    ]);
    expect(toViewItems(ev('user_prompt', { text: 'hola' }))).toEqual([
      { kind: 'user', seq: 1, text: 'hola' },
    ]);
  });

  it('hides system noise and tolerates malformed payloads', () => {
    expect(toViewItems(ev('system:init', { session_id: 'x' }))).toEqual([]);
    expect(toViewItems(ev('assistant', null))).toEqual([]);
    expect(toViewItems(ev('assistant', { message: { content: 'nope' } }))).toEqual([]);
  });

  it('keeps markup as plain text and truncates huge output', () => {
    const [item] = toViewItems(
      ev('assistant', {
        message: { content: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }] },
      }),
    );
    expect(item).toMatchObject({ kind: 'assistant', text: '<img src=x onerror=alert(1)>' });
    const [big] = toViewItems(
      ev('user', { message: { content: [{ type: 'tool_result', content: 'x'.repeat(10000) }] } }),
    );
    expect((big as { text: string }).text.length).toBeLessThan(4100);
  });

  it('flags the events after which the status must be re-read', () => {
    expect(endsTurn(ev('result:success', {}))).toBe(true);
    expect(endsTurn(ev('error', {}))).toBe(true);
    expect(endsTurn(ev('assistant', {}))).toBe(false);
  });
});
