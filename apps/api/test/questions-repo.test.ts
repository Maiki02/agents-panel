import { describe, expect, it } from 'vitest';
import type { AskedQuestion } from '@agents-panel/shared';
import { ChatRepository } from '../src/chats/repo.js';
import {
  QuestionAnswerError,
  QuestionNotFoundError,
  QuestionNotPendingError,
  QuestionRepository,
  parseAskedQuestions,
  toSdkAnswers,
  validateAnswer,
} from '../src/chats/questions-repo.js';
import { openDatabase } from '../src/db/index.js';
import { ProjectRepository } from '../src/projects/repo.js';
import { makeGitRepo } from './helpers.js';

const COLOR: AskedQuestion = {
  question: '¿Cuál es tu color favorito?',
  header: 'Color',
  options: [
    { label: 'Rojo', description: 'Rojo' },
    { label: 'Azul', description: 'Azul' },
  ],
  multiSelect: false,
};
const TOPPINGS: AskedQuestion = {
  question: '¿Qué agregamos?',
  header: 'Extras',
  options: [
    { label: 'Tests', description: '' },
    { label: 'Docs', description: '' },
  ],
  multiSelect: true,
};

async function setup() {
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
    title: 't',
    worktreePath: '/w',
    branch: 'b',
    status: 'running',
  });
  const userId = Number(
    db
      .prepare("INSERT INTO users (username, password_hash, created_at) VALUES ('ana', 'x', 1)")
      .run().lastInsertRowid,
  );
  let clock = 1000;
  const questions = new QuestionRepository(db, () => (clock += 10));
  return { db, chat, userId, questions };
}

describe('QuestionRepository', () => {
  it('stores a pending question with its options and lists it by chat', async () => {
    const { chat, questions } = await setup();
    const created = questions.create(chat.id, 'toolu_1', [COLOR, TOPPINGS]);
    expect(created).toMatchObject({
      chatId: chat.id,
      toolUseId: 'toolu_1',
      status: 'pending',
      answer: null,
      answeredBy: null,
      answeredAt: null,
    });
    expect(created.questions).toEqual([COLOR, TOPPINGS]);
    expect(questions.get(created.id)).toEqual(created);
    expect(questions.listByChat(chat.id)).toEqual([created]);
    expect(questions.listByChat(chat.id, 'answered')).toEqual([]);
  });

  it('is unique per chat and tool_use_id', async () => {
    const { chat, questions } = await setup();
    questions.create(chat.id, 'toolu_1', [COLOR]);
    expect(() => questions.create(chat.id, 'toolu_1', [COLOR])).toThrow(/UNIQUE/);
  });

  it('answers once and saves who answered and when', async () => {
    const { chat, userId, questions } = await setup();
    const { id } = questions.create(chat.id, 'toolu_1', [COLOR]);
    const answered = questions.answer(id, { [COLOR.question]: { selected: ['Azul'] } }, userId);
    expect(answered).toMatchObject({
      status: 'answered',
      answeredBy: userId,
      answer: { [COLOR.question]: { selected: ['Azul'], text: null } },
    });
    expect(answered.answeredAt).toBeGreaterThan(answered.createdAt);
    expect(toSdkAnswers(answered.answer ?? {})).toEqual({ [COLOR.question]: 'Azul' });
  });

  it('rejects a second answer and an answer to a cancelled question (409)', async () => {
    const { chat, userId, questions } = await setup();
    const first = questions.create(chat.id, 'toolu_1', [COLOR]);
    questions.answer(first.id, { [COLOR.question]: { selected: ['Rojo'] } }, userId);
    expect(() =>
      questions.answer(first.id, { [COLOR.question]: { selected: ['Azul'] } }, userId),
    ).toThrow(QuestionNotPendingError);
    expect(questions.get(first.id)?.answer).toEqual({
      [COLOR.question]: { selected: ['Rojo'], text: null },
    });

    const second = questions.create(chat.id, 'toolu_2', [COLOR]);
    expect(questions.cancelPending(chat.id)).toBe(1);
    expect(() =>
      questions.answer(second.id, { [COLOR.question]: { selected: ['Rojo'] } }, userId),
    ).toThrow(/ya está cancelled/);
    expect(() => questions.answer(999, {}, userId)).toThrow(QuestionNotFoundError);
  });

  it('stays pending as time passes and never answers itself', async () => {
    const { chat, db, questions } = await setup();
    const { id } = questions.create(chat.id, 'toolu_1', [COLOR]);
    const later = new QuestionRepository(db, () => Date.now() + 365 * 24 * 3600 * 1000);
    expect(later.get(id)?.status).toBe('pending');
    expect(later.listByChat(chat.id, 'pending')).toHaveLength(1);
    // The table itself refuses an answer without who gave it.
    expect(() =>
      db
        .prepare("UPDATE pending_questions SET status = 'answered', answer = '{}' WHERE id = ?")
        .run(id),
    ).toThrow(/CHECK/);
  });

  it('cancels only the pending questions of that chat', async () => {
    const { chat, userId, questions } = await setup();
    const done = questions.create(chat.id, 'toolu_1', [COLOR]);
    questions.answer(done.id, { [COLOR.question]: { selected: ['Rojo'] } }, userId);
    questions.create(chat.id, 'toolu_2', [COLOR]);
    expect(questions.cancelPending(chat.id)).toBe(1);
    expect(questions.get(done.id)?.status).toBe('answered');
    expect(questions.cancelPending(chat.id)).toBe(0);
  });

  it('deletes its questions with the chat', async () => {
    const { chat, db, questions } = await setup();
    questions.create(chat.id, 'toolu_1', [COLOR]);
    new ChatRepository(db).delete(chat.id);
    expect(db.prepare('SELECT count(*) AS n FROM pending_questions').get()).toEqual({ n: 0 });
  });
});

describe('validateAnswer', () => {
  it('accepts an option, free text, or both for multi-select', () => {
    expect(validateAnswer([COLOR], { [COLOR.question]: { selected: ['Rojo'] } })).toEqual({
      [COLOR.question]: { selected: ['Rojo'], text: null },
    });
    expect(validateAnswer([COLOR], { [COLOR.question]: { text: '  Verde  ' } })).toEqual({
      [COLOR.question]: { selected: [], text: 'Verde' },
    });
    expect(
      toSdkAnswers(
        validateAnswer([TOPPINGS], {
          [TOPPINGS.question]: { selected: ['Tests', 'Docs'], text: 'CI' },
        }),
      ),
    ).toEqual({ [TOPPINGS.question]: 'Tests, Docs, CI' });
  });

  it.each([
    [
      'an option that does not exist',
      COLOR,
      { [COLOR.question]: { selected: ['Verde'] } },
      /no es una opción/,
    ],
    [
      'no answer at all',
      COLOR,
      { [COLOR.question]: { selected: [], text: '   ' } },
      /Elegí una opción/,
    ],
    [
      'two answers to a single-choice question',
      COLOR,
      { [COLOR.question]: { selected: ['Rojo'], text: 'x' } },
      /Solo se admite una/,
    ],
    [
      'a repeated option',
      TOPPINGS,
      { [TOPPINGS.question]: { selected: ['Tests', 'Tests'] } },
      /repetidas/,
    ],
    [
      'text that is too long',
      COLOR,
      { [COLOR.question]: { text: 'x'.repeat(2001) } },
      /supera 2000/,
    ],
    [
      'an unknown question',
      COLOR,
      { otra: { selected: ['Rojo'] }, [COLOR.question]: { selected: ['Rojo'] } },
      /no corresponde/,
    ],
    ['a missing question', COLOR, {}, /Falta la respuesta/],
    ['a non-object answer', COLOR, 'Azul', /debe ser un objeto/],
    ['non-string labels', COLOR, { [COLOR.question]: { selected: [1] } }, /lista de opciones/],
  ])('rejects %s', (_name, question, answer, message) => {
    expect(() => validateAnswer([question], answer)).toThrow(QuestionAnswerError);
    expect(() => validateAnswer([question], answer)).toThrow(message);
  });

  it('does not store a rejected answer', async () => {
    const { chat, userId, questions } = await setup();
    const { id } = questions.create(chat.id, 'toolu_1', [COLOR]);
    expect(() =>
      questions.answer(id, { [COLOR.question]: { selected: ['Verde'] } }, userId),
    ).toThrow(QuestionAnswerError);
    expect(questions.get(id)?.status).toBe('pending');
  });
});

describe('parseAskedQuestions', () => {
  it('reads the AskUserQuestion input and drops what the panel does not store', () => {
    expect(
      parseAskedQuestions({
        questions: [
          {
            ...COLOR,
            extra: 1,
            options: [{ label: 'Rojo', description: 'r', preview: 'p' }, { label: 'Azul' }],
          },
        ],
      }),
    ).toEqual([
      {
        ...COLOR,
        options: [
          { label: 'Rojo', description: 'r', preview: 'p' },
          { label: 'Azul', description: '' },
        ],
      },
    ]);
  });

  it.each([
    ['no questions', { questions: [] }],
    [
      'five questions',
      { questions: Array.from({ length: 5 }, (_, i) => ({ ...COLOR, question: `q${String(i)}` })) },
    ],
    ['one option', { questions: [{ ...COLOR, options: [COLOR.options[0]] }] }],
    ['repeated questions', { questions: [COLOR, COLOR] }],
    [
      'repeated option labels',
      { questions: [{ ...COLOR, options: [COLOR.options[0], COLOR.options[0]] }] },
    ],
    ['not an object', 'x'],
  ])('rejects %s', (_name, input) => {
    expect(() => parseAskedQuestions(input)).toThrow();
  });
});
