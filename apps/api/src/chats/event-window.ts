import type { ChatEvent, ChatEventWindow } from '@agents-panel/shared';
import type { ChatRepository } from './repo.js';

/** Largest text the web receives per field; the database keeps the full text. */
export const MAX_EVENT_TEXT = 4000;
const CLIP_SUFFIX = '… (recortado)';
const PAGE = 200;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clip(text: string): string {
  return text.length > MAX_EVENT_TEXT ? `${text.slice(0, MAX_EVENT_TEXT)}${CLIP_SUFFIX}` : text;
}

function clipField(value: unknown): unknown {
  return typeof value === 'string' ? clip(value) : value;
}

/** tool_result content: a string, or a list of parts with a `text`. */
function clipResultContent(content: unknown): unknown {
  if (typeof content === 'string') return clip(content);
  if (!Array.isArray(content)) return content;
  return content.map((part: unknown) =>
    isObject(part) && typeof part['text'] === 'string'
      ? { ...part, text: clip(part['text']) }
      : part,
  );
}

/** A tool_use input too large once serialized becomes its clipped JSON text. */
function clipToolInput(input: unknown): unknown {
  const json = JSON.stringify(input ?? {});
  return json.length > MAX_EVENT_TEXT ? clip(json) : input;
}

function clipBlock(block: unknown): unknown {
  if (!isObject(block)) return block;
  if (block['type'] === 'tool_result') {
    return { ...block, content: clipResultContent(block['content']) };
  }
  if (block['type'] === 'tool_use' && 'input' in block) {
    return { ...block, input: clipToolInput(block['input']) };
  }
  return block;
}

/**
 * Pure: a copy of the event with its big texts clipped to MAX_EVENT_TEXT characters plus a
 * marker (tool_result content, tool_use input, `result:*` result, worktree_output stdout/stderr).
 * The stored row is never touched.
 */
export function clipEventForWeb(event: ChatEvent): ChatEvent {
  const payload = event.payload;
  if (!isObject(payload)) return event;

  if (event.type === 'assistant' || event.type === 'user') {
    const message = payload['message'];
    if (!isObject(message) || !Array.isArray(message['content'])) return event;
    const content = (message['content'] as unknown[]).map(clipBlock);
    return { ...event, payload: { ...payload, message: { ...message, content } } };
  }
  if (event.type === 'worktree_output') {
    return {
      ...event,
      payload: {
        ...payload,
        stdout: clipField(payload['stdout']),
        stderr: clipField(payload['stderr']),
      },
    };
  }
  if (event.type.startsWith('result:')) {
    return { ...event, payload: { ...payload, result: clipField(payload['result']) } };
  }
  return event;
}

/** True for an assistant event that has at least one non-blank text block (counts as a message). */
export function isAgentMessage(event: ChatEvent): boolean {
  if (event.type !== 'assistant' || !isObject(event.payload)) return false;
  const message = event.payload['message'];
  if (!isObject(message) || !Array.isArray(message['content'])) return false;
  return (message['content'] as unknown[]).some(
    (block) =>
      isObject(block) &&
      block['type'] === 'text' &&
      typeof block['text'] === 'string' &&
      block['text'].trim() !== '',
  );
}

/**
 * The window of `tail` agent messages that ends right before `beforeSeq` (or at the end of the
 * chat). It starts at the `tail`-th message counting backwards and holds every event after it, so
 * consecutive windows neither repeat nor skip events. The newest window also reaches back to the
 * oldest question still open. Events come clipped for the web.
 */
export function readEventWindow(
  chats: ChatRepository,
  chatId: number,
  opts: { tail: number; beforeSeq?: number },
): ChatEventWindow {
  const upper = opts.beforeSeq ?? Number.MAX_SAFE_INTEGER;
  const collected: ChatEvent[] = []; // newest first
  let seen = 0;
  let startSeq: number | null = null;
  let cursor = upper;

  while (startSeq === null) {
    const page = chats.eventsBefore(chatId, cursor, PAGE);
    if (page.length === 0) break;
    for (let i = page.length - 1; i >= 0; i--) {
      const event = page[i];
      if (!event) continue;
      collected.push(event);
      if (isAgentMessage(event) && ++seen === opts.tail) {
        startSeq = event.seq;
        break;
      }
    }
    cursor = page[0]?.seq ?? 0;
    if (page.length < PAGE) break;
  }

  if (opts.beforeSeq === undefined) {
    const open = chats.oldestOpenQuestionSeq(chatId);
    const oldest = collected.at(-1)?.seq;
    if (open !== null && oldest !== undefined && open < oldest) {
      // Read what is missing between the open question and what we already have.
      let from = oldest;
      for (;;) {
        const page = chats.eventsBefore(chatId, from, PAGE);
        const kept = page.filter((event) => event.seq >= open);
        for (let i = kept.length - 1; i >= 0; i--) {
          const event = kept[i];
          if (event) collected.push(event);
        }
        if (kept.length < PAGE || page.length < PAGE) break;
        from = kept[0]?.seq ?? open;
      }
    }
  }

  const events = collected.reverse().map(clipEventForWeb);
  const firstSeq = events[0]?.seq ?? null;
  const hasMore = firstSeq !== null && chats.eventsBefore(chatId, firstSeq, 1).length > 0;
  return { events, hasMore, firstSeq };
}
