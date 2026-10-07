import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ChatEvent, ChatEventWindow } from '@agents-panel/shared';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import { ChatEventBus } from '../src/chats/events.js';
import { clipEventForWeb } from '../src/chats/event-window.js';
import { ChatRepository } from '../src/chats/repo.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { PASSWORD, makeApp, makeGitRepo } from './helpers.js';

let apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

const CLIPPED = `${'x'.repeat(4000)}… (recortado)`;

async function boot() {
  const bus = new ChatEventBus();
  const made = makeApp({}, undefined, { bus });
  apps.push(made.app);
  await made.app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${String((made.app.server.address() as AddressInfo).port)}`;
  const user = await new UserRepository(made.db).create('alice', PASSWORD);
  const { token } = new SessionService(made.db, {
    idleTtlSeconds: 1800,
    absoluteTtlSeconds: 43200,
  }).create(user.id);
  const project = await new ProjectRepository(made.db).add({
    name: 'demo',
    repoPath: makeGitRepo(),
    baseBranch: 'main',
  });
  const chats = new ChatRepository(made.db);
  const chat = chats.create({
    projectId: project.id,
    kind: 'work',
    slug: 'a',
    title: 'a',
    worktreePath: '/tmp/wt/a',
    branch: 'feature/a',
    status: 'idle',
  });
  const headers = { cookie: `${SESSION_COOKIE}=${token}` };
  const url = (query: string) => `${base}/api/chats/${String(chat.id)}/events${query}`;
  const get = async (query: string) => fetch(url(query), { headers });
  const window = async (query: string) => (await get(query)).json() as Promise<ChatEventWindow>;
  return { base, chat, chats, headers, get, window };
}

const text = (t: string) => ({ message: { content: [{ type: 'text', text: t }] } });
const toolUse = {
  message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
};
const toolResult = (content: unknown) => ({
  message: { content: [{ type: 'tool_result', content }] },
});

/** 30 agent messages, each preceded by a prompt and a tool round trip (4 events per message). */
function seedThirty(chats: ChatRepository, chatId: number): void {
  for (let i = 1; i <= 30; i++) {
    chats.appendEvent(chatId, 'user_prompt', { text: `p${String(i)}` });
    chats.appendEvent(chatId, 'assistant', toolUse);
    chats.appendEvent(chatId, 'user', toolResult('ok'));
    chats.appendEvent(chatId, 'assistant', text(`m${String(i)}`));
  }
}

describe('GET /api/chats/:id/events windows', () => {
  it('walks 30 messages in windows of 10 without repeating or skipping events', async () => {
    const { chat, chats, window } = await boot();
    seedThirty(chats, chat.id);
    const last = chats.lastSeq(chat.id);

    const newest = await window('?tail=10');
    // Message 21 is the 10th from the end: its seq is 21*4, the window starts there.
    expect(newest.firstSeq).toBe(84);
    expect(newest.events[0]?.seq).toBe(84);
    expect(newest.events.at(-1)?.seq).toBe(last);
    expect(newest.events).toHaveLength(last - 84 + 1);
    expect(newest.hasMore).toBe(true);

    const middle = await window(`?beforeSeq=${String(newest.firstSeq)}&tail=10`);
    expect(middle.events.at(-1)?.seq).toBe(83);
    expect(middle.firstSeq).toBe(44);
    expect(middle.hasMore).toBe(true);

    const oldest = await window(`?beforeSeq=${String(middle.firstSeq)}&tail=10`);
    expect(oldest.events.at(-1)?.seq).toBe(43);
    expect(oldest.firstSeq).toBe(4);
    expect(oldest.hasMore).toBe(true);

    const rest = await window(`?beforeSeq=${String(oldest.firstSeq)}&tail=10`);
    expect(rest.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(rest.hasMore).toBe(false);

    const all = [...rest.events, ...oldest.events, ...middle.events, ...newest.events];
    expect(all.map((e) => e.seq)).toEqual(Array.from({ length: last }, (_, i) => i + 1));
  });

  it('does not count assistant events without text as messages', async () => {
    const { chat, chats, window } = await boot();
    chats.appendEvent(chat.id, 'assistant', text('uno'));
    for (let i = 0; i < 5; i++) chats.appendEvent(chat.id, 'assistant', toolUse);
    chats.appendEvent(chat.id, 'assistant', text('   '));
    chats.appendEvent(chat.id, 'assistant', text('dos'));
    const result = await window('?tail=2');
    expect(result.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(result.hasMore).toBe(false);
    const one = await window('?tail=1');
    expect(one.firstSeq).toBe(8);
    expect(one.hasMore).toBe(true);
  });

  it('extends the newest window to the oldest open question, not to an answered one', async () => {
    const { chat, chats, window } = await boot();
    chats.appendEvent(chat.id, 'question_asked', { questionId: 1, questions: [] });
    chats.appendEvent(chat.id, 'question_answered', { questionId: 1, answer: {} });
    chats.appendEvent(chat.id, 'question_asked', { questionId: 2, questions: [] });
    chats.appendEvent(chat.id, 'question_asked', { questionId: 3, questions: [] });
    chats.appendEvent(chat.id, 'question_cancelled', { questionId: 3 });
    for (let i = 0; i < 3; i++) chats.appendEvent(chat.id, 'assistant', text(`m${String(i)}`));

    const open = await window('?tail=1');
    expect(open.firstSeq).toBe(3);
    expect(open.events.map((e) => e.seq)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(open.hasMore).toBe(true);

    chats.appendEvent(chat.id, 'question_cancelled', { questionId: 2 });
    const closed = await window('?tail=1');
    expect(closed.firstSeq).toBe(9 - 1);
  });

  it('clips big texts for windows, afterSeq and the stream, keeping the stored row whole', async () => {
    const { base, chat, chats, headers, get, window } = await boot();
    const big = 'x'.repeat(100 * 1024);
    chats.appendEvent(chat.id, 'user', toolResult(big));
    chats.appendEvent(chat.id, 'worktree_output', { step: 's', stdout: big, stderr: big });
    chats.appendEvent(chat.id, 'result:success', { result: big });
    chats.appendEvent(chat.id, 'assistant', {
      message: { content: [{ type: 'tool_use', name: 'Write', input: { content: big } }] },
    });
    chats.appendEvent(chat.id, 'assistant', text('fin'));

    const fromWindow = await window('?tail=1');
    const fromAfter = (await (await get('?afterSeq=0')).json()) as ChatEvent[];
    const response = await fetch(`${base}/api/chats/${String(chat.id)}/stream`, { headers });
    const reader = response.body?.getReader() as
      | { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> }
      | undefined;
    if (!reader) throw new Error('no body');
    const decoder = new TextDecoder();
    let raw = '';
    while ((raw.match(/^data: /gm) ?? []).length < 5) {
      const chunk = await reader.read();
      if (chunk.done) break;
      raw += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel();
    const fromStream = [...raw.matchAll(/^data: (.*)$/gm)].map(
      (m) => JSON.parse(m[1] ?? '{}') as ChatEvent,
    );

    for (const events of [fromAfter, fromStream]) {
      expect(events).toHaveLength(5);
      const [tr, wo, res, tu] = events as [ChatEvent, ChatEvent, ChatEvent, ChatEvent];
      const trBlock = (tr.payload as { message: { content: { content: string }[] } }).message
        .content[0];
      expect(trBlock?.content).toBe(CLIPPED);
      expect(wo.payload).toMatchObject({ stdout: CLIPPED, stderr: CLIPPED });
      expect(res.payload).toMatchObject({ result: CLIPPED.replace(/x+/, 'x'.repeat(4000)) });
      const input = (tu.payload as { message: { content: { input: string }[] } }).message.content[0]
        ?.input;
      expect(typeof input === 'string' && input.endsWith('… (recortado)')).toBe(true);
    }
    // The window starts at the only message with text: only the last event.
    expect(fromWindow.events).toHaveLength(1);

    const stored = chats.eventsAfter(chat.id, 0)[0]?.payload as {
      message: { content: { content: string }[] };
    };
    expect(stored.message.content[0]?.content).toHaveLength(100 * 1024);

    const wide = await window('?tail=50');
    const widePayload = wide.events[0]?.payload as { message: { content: { content: string }[] } };
    expect(widePayload.message.content[0]?.content).toBe(CLIPPED);
  });

  it('clips list-style tool_result content and leaves small events untouched', () => {
    const small: ChatEvent = {
      id: 1,
      chatId: 1,
      seq: 1,
      type: 'user',
      payload: toolResult([{ type: 'text', text: 'y'.repeat(5000) }]),
      createdAt: 0,
    };
    const clipped = clipEventForWeb(small);
    const part = (clipped.payload as { message: { content: { content: { text: string }[] }[] } })
      .message.content[0]?.content[0];
    expect(part?.text).toBe(`${'y'.repeat(4000)}… (recortado)`);
    const tiny: ChatEvent = { ...small, payload: toolResult('ok') };
    expect(clipEventForWeb(tiny)).toEqual(tiny);
  });

  it('keeps afterSeq as before and validates the query', async () => {
    const { base, chat, chats, headers, get } = await boot();
    seedThirty(chats, chat.id);
    const after = (await (await get('?afterSeq=115')).json()) as ChatEvent[];
    expect(after.map((e) => e.seq)).toEqual([116, 117, 118, 119, 120]);

    expect((await fetch(`${base}/api/chats/${String(chat.id)}/events?tail=1`)).status).toBe(401);
    expect((await fetch(`${base}/api/chats/999/events?tail=1`, { headers })).status).toBe(404);
    for (const bad of ['?tail=0', '?tail=51', '?tail=x', '?beforeSeq=5', '?tail=5&afterSeq=1']) {
      expect((await get(bad)).status).toBe(400);
    }
    expect((await get('?tail=50')).status).toBe(200);
    expect((await get('?tail=1')).status).toBe(200);
  });
});
