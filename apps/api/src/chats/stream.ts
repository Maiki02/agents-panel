import type { OutgoingHttpHeaders } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { ChatEvent } from '@agents-panel/shared';
import type { ChatEventBus } from './events.js';
import type { ChatRepository } from './repo.js';

export const HEARTBEAT_MS = 15_000;
const REPLAY_PAGE = 500;

function frame(event: ChatEvent): string {
  return `id: ${String(event.seq)}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Server-sent events for one chat. Replays what is stored after Last-Event-ID (or ?afterSeq=)
 * and then follows live, with no gaps or duplicates: we subscribe first, buffer while replaying
 * from the database, and drop anything at or below the last seq already sent.
 */
export function registerStreamRoute(
  app: FastifyInstance,
  deps: { chats: ChatRepository; bus: ChatEventBus; heartbeatMs?: number },
): void {
  const { chats, bus, heartbeatMs = HEARTBEAT_MS } = deps;

  app.get<{ Params: { id: number }; Querystring: { afterSeq?: number } }>(
    '/api/chats/:id/stream',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'integer', minimum: 1 } },
        },
        querystring: { type: 'object', properties: { afterSeq: { type: 'integer', minimum: 0 } } },
      },
    },
    (request, reply) => {
      const chatId = request.params.id;
      if (!chats.findById(chatId)) return reply.code(404).send({ error: 'Chat not found' });

      const header = request.headers['last-event-id'];
      const fromHeader = typeof header === 'string' && /^\d+$/.test(header) ? Number(header) : 0;
      let lastSent = Math.max(request.query.afterSeq ?? 0, fromHeader);

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        ...(reply.getHeaders() as OutgoingHttpHeaders),
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });

      let replaying = true;
      const buffer: ChatEvent[] = [];
      const send = (event: ChatEvent) => {
        if (event.seq <= lastSent) return;
        lastSent = event.seq;
        raw.write(frame(event));
      };

      const unsubscribe = bus.subscribe(chatId, (event) => {
        if (replaying) buffer.push(event);
        else send(event);
      });
      const heartbeat = setInterval(() => {
        raw.write(': ping\n\n');
      }, heartbeatMs);
      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      };
      request.raw.on('close', cleanup);
      raw.on('error', cleanup);

      raw.write('retry: 3000\n\n');
      for (;;) {
        const page = chats.eventsAfter(chatId, lastSent, REPLAY_PAGE);
        for (const event of page) send(event);
        if (page.length < REPLAY_PAGE) break;
      }
      replaying = false;
      buffer.sort((a, b) => a.seq - b.seq).forEach(send);
      return reply;
    },
  );
}
