import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatRepository } from '../src/chats/repo.js';
import { QuestionRepository } from '../src/chats/questions-repo.js';
import { openDatabase } from '../src/db/index.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { makeApp, makeGitRepo } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
});

describe('restart with a pending question', () => {
  it('cancels it and leaves a question_cancelled event so the web drops the answer card', async () => {
    const db = openDatabase(':memory:');
    const project = await new ProjectRepository(db).add({
      name: 'demo',
      repoPath: makeGitRepo(),
      baseBranch: 'main',
    });
    const chats = new ChatRepository(db);
    const chat = chats.create({
      projectId: project.id,
      kind: 'work',
      slug: 'w',
      title: 'w',
      worktreePath: '/tmp/wt/w',
      branch: 'feature/w',
      status: 'running',
    });
    const questions = new QuestionRepository(db);
    const asked = questions.create(chat.id, 'tool-1', [
      { question: '¿Idioma?', header: 'Idioma', multiSelect: false, options: [] },
    ]);

    const made = makeApp({}, undefined, { db });
    app = made.app;
    await app.ready();

    expect(questions.get(asked.id)?.status).toBe('cancelled');
    const events = chats.allEventsAfter(chat.id, 0);
    expect(events.filter((e) => e.type === 'question_cancelled').map((e) => e.payload)).toEqual([
      { questionId: asked.id },
    ]);
    expect(chats.findById(chat.id)?.status).toBe('interrupted');
  });

  it('gives an event, once, to a question an older version cancelled without one', async () => {
    const db = openDatabase(':memory:');
    const project = await new ProjectRepository(db).add({
      name: 'demo',
      repoPath: makeGitRepo(),
      baseBranch: 'main',
    });
    const chats = new ChatRepository(db);
    const chat = chats.create({
      projectId: project.id,
      kind: 'work',
      slug: 'w',
      title: 'w',
      worktreePath: '/tmp/wt/w',
      branch: 'feature/w',
      status: 'interrupted',
    });
    const questions = new QuestionRepository(db);
    const old = questions.create(chat.id, 'tool-old', [
      { question: '¿Idioma?', header: 'Idioma', multiSelect: false, options: [] },
    ]);
    questions.cancelPending(chat.id);

    const made = makeApp({}, undefined, { db });
    app = made.app;
    await app.ready();

    const cancelled = chats
      .allEventsAfter(chat.id, 0)
      .filter(
        (e) =>
          e.type === 'question_cancelled' &&
          (e.payload as { questionId: number }).questionId === old.id,
      );
    expect(cancelled).toHaveLength(1);
  });
});
