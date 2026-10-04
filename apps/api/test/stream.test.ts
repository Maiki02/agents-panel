import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ChatEvent } from '@agents-panel/shared';
import { SESSION_COOKIE, SessionService } from '../src/auth/sessions.js';
import { UserRepository } from '../src/auth/users.js';
import { ChatEventBus } from '../src/chats/events.js';
import { ChatRepository } from '../src/chats/repo.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { PASSWORD, makeApp, makeGitRepo } from './helpers.js';

let apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

async function boot(heartbeatMs?: number) {
  const bus = new ChatEventBus();
  const made = makeApp({}, undefined, { bus, ...(heartbeatMs ? { heartbeatMs } : {}) });
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
    status: 'running',
  });
  const emit = (type: string) => {
    bus.publish(chats.appendEvent(chat.id, type, { type }));
  };
  const headers = { cookie: `${SESSION_COOKIE}=${token}` };
  return { base, bus, chat, emit, headers, chats };
}

interface Reader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}

function readerOf(response: Response): Reader {
  const reader = response.body?.getReader() as Reader | undefined;
  if (!reader) throw new Error('no body');
  return reader;
}

/** Minimal SSE client: collects data frames until `count` events arrived. */
async function readEvents(
  response: Response,
  count: number,
): Promise<{ events: ChatEvent[]; ids: string[]; raw: string }> {
  const reader = readerOf(response);
  const decoder = new TextDecoder();
  let raw = '';
  const events: ChatEvent[] = [];
  const ids: string[] = [];
  while (events.length < count) {
    const chunk = await reader.read();
    if (chunk.done) break;
    raw += decoder.decode(chunk.value, { stream: true });
    for (const block of raw.split('\n\n').slice(0, -1)) {
      const id = /^id: (\d+)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (id && data && !ids.includes(id)) {
        ids.push(id);
        events.push(JSON.parse(data) as ChatEvent);
      }
    }
  }
  await reader.cancel();
  return { events, ids, raw };
}

describe('GET /api/chats/:id/stream', () => {
  it('delivers stored and live events in order, with id = seq', async () => {
    const { base, chat, emit, headers } = await boot();
    emit('one');
    emit('two');
    const response = await fetch(`${base}/api/chats/${String(chat.id)}/stream`, { headers });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    setTimeout(() => {
      emit('three');
      emit('four');
    }, 50);
    const { events, ids } = await readEvents(response, 4);
    expect(events.map((e) => e.type)).toEqual(['one', 'two', 'three', 'four']);
    expect(ids).toEqual(['1', '2', '3', '4']);
  });

  it('reconnects with Last-Event-ID and receives only later events', async () => {
    const { base, chat, emit, headers } = await boot();
    for (const t of ['a', 'b', 'c', 'd']) emit(t);
    const response = await fetch(`${base}/api/chats/${String(chat.id)}/stream`, {
      headers: { ...headers, 'last-event-id': '2' },
    });
    setTimeout(() => {
      emit('e');
    }, 50);
    const { ids } = await readEvents(response, 3);
    expect(ids).toEqual(['3', '4', '5']);
  });

  it('supports ?afterSeq= as an alternative to the header', async () => {
    const { base, chat, emit, headers } = await boot();
    for (const t of ['a', 'b', 'c']) emit(t);
    const response = await fetch(`${base}/api/chats/${String(chat.id)}/stream?afterSeq=2`, {
      headers,
    });
    expect((await readEvents(response, 1)).ids).toEqual(['3']);
  });

  it('has no gaps or duplicates when events arrive while replaying', async () => {
    const { base, chat, emit, headers } = await boot();
    for (let i = 0; i < 1200; i++) emit(`e${String(i)}`);
    const response = await fetch(`${base}/api/chats/${String(chat.id)}/stream`, { headers });
    for (let i = 0; i < 5; i++) emit(`live${String(i)}`);
    const { ids } = await readEvents(response, 1205);
    expect(ids).toEqual(Array.from({ length: 1205 }, (_, i) => String(i + 1)));
  });

  it('answers 401 without a session and 404 for an unknown chat', async () => {
    const { base, chat, headers } = await boot();
    expect((await fetch(`${base}/api/chats/${String(chat.id)}/stream`)).status).toBe(401);
    expect((await fetch(`${base}/api/chats/999/stream`, { headers })).status).toBe(404);
  });

  it('removes its listener when the client disconnects', async () => {
    const { base, bus, chat, emit, headers } = await boot();
    emit('x');
    const response = await fetch(`${base}/api/chats/${String(chat.id)}/stream`, { headers });
    const reader = readerOf(response);
    await reader.read();
    expect(bus.listenerCount(chat.id)).toBe(1);
    await reader.cancel();
    for (let i = 0; i < 100 && bus.listenerCount(chat.id) > 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(bus.listenerCount(chat.id)).toBe(0);
  });

  it('sends heartbeats while idle', async () => {
    const { base, chat, headers } = await boot(30);
    const response = await fetch(`${base}/api/chats/${String(chat.id)}/stream`, { headers });
    const reader = readerOf(response);
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes(': ping')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
    await reader.cancel();
    expect(text).toContain(': ping');
  });
});
