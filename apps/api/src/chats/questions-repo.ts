import type {
  AskedQuestion,
  PendingQuestion,
  PendingQuestionStatus,
  QuestionAnswer,
} from '@agents-panel/shared';
import type { Db } from '../db/index.js';

/** Longest free text accepted for one question. */
export const MAX_ANSWER_TEXT = 2000;

export class QuestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuestionError';
  }
}

/** The answer does not match the question (HTTP 400). */
export class QuestionAnswerError extends QuestionError {
  constructor(message: string) {
    super(message);
    this.name = 'QuestionAnswerError';
  }
}

/** The question is not pending anymore: already answered or cancelled (HTTP 409). */
export class QuestionNotPendingError extends QuestionError {
  constructor(
    readonly questionId: number,
    readonly status: PendingQuestionStatus,
  ) {
    super(`La pregunta ${String(questionId)} ya está ${status}`);
    this.name = 'QuestionNotPendingError';
  }
}

export class QuestionNotFoundError extends QuestionError {
  constructor(questionId: number) {
    super(`No existe la pregunta ${String(questionId)}`);
    this.name = 'QuestionNotFoundError';
  }
}

interface QuestionRow {
  id: number;
  chat_id: number;
  tool_use_id: string;
  questions: string;
  status: PendingQuestionStatus;
  answer: string | null;
  answered_by: number | null;
  created_at: number;
  answered_at: number | null;
}

function toQuestion(row: QuestionRow): PendingQuestion {
  return {
    id: row.id,
    chatId: row.chat_id,
    toolUseId: row.tool_use_id,
    questions: JSON.parse(row.questions) as AskedQuestion[],
    status: row.status,
    answer: row.answer === null ? null : (JSON.parse(row.answer) as QuestionAnswer),
    answeredBy: row.answered_by,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the questions out of an AskUserQuestion tool input (1-4 questions, 2-4 options each) and
 * keeps only what the panel stores. Throws QuestionError when the shape is not what the SDK sends.
 */
export function parseAskedQuestions(input: unknown): AskedQuestion[] {
  const raw = isRecord(input) ? input['questions'] : undefined;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) {
    throw new QuestionError('AskUserQuestion needs between 1 and 4 questions');
  }
  const seen = new Set<string>();
  return raw.map((item: unknown, index) => {
    const where = `questions[${String(index)}]`;
    if (!isRecord(item)) throw new QuestionError(`${where} must be an object`);
    const question = item['question'];
    const header = item['header'];
    const options = item['options'];
    if (typeof question !== 'string' || question.trim() === '') {
      throw new QuestionError(`${where}.question must be a non-empty string`);
    }
    if (seen.has(question)) throw new QuestionError(`${where}.question is repeated`);
    seen.add(question);
    if (typeof header !== 'string') throw new QuestionError(`${where}.header must be a string`);
    if (!Array.isArray(options) || options.length < 2 || options.length > 4) {
      throw new QuestionError(`${where}.options needs between 2 and 4 options`);
    }
    const labels = new Set<string>();
    const parsed = options.map((option: unknown, optionIndex) => {
      if (!isRecord(option) || typeof option['label'] !== 'string' || option['label'] === '') {
        throw new QuestionError(`${where}.options[${String(optionIndex)}].label must be a string`);
      }
      const label = option['label'];
      if (labels.has(label)) throw new QuestionError(`${where} repeats the option "${label}"`);
      labels.add(label);
      const description = option['description'];
      const preview = option['preview'];
      return {
        label,
        description: typeof description === 'string' ? description : '',
        ...(typeof preview === 'string' ? { preview } : {}),
      };
    });
    return { question, header, options: parsed, multiSelect: item['multiSelect'] === true };
  });
}

/**
 * Checks an answer against its questions: one entry per question, each with chosen labels that
 * exist among the options (at most one unless multiSelect) and/or free text ("Other").
 * Returns the answer normalized (trimmed text, null when empty); throws QuestionAnswerError.
 */
export function validateAnswer(questions: AskedQuestion[], answer: unknown): QuestionAnswer {
  if (!isRecord(answer)) throw new QuestionAnswerError('La respuesta debe ser un objeto');
  const expected = new Set(questions.map((q) => q.question));
  for (const key of Object.keys(answer)) {
    if (!expected.has(key))
      throw new QuestionAnswerError(
        `La respuesta no corresponde a una pregunta: ${key.slice(0, 80)}`,
      );
  }
  const normalized: QuestionAnswer = {};
  for (const question of questions) {
    const item = answer[question.question];
    if (!isRecord(item))
      throw new QuestionAnswerError(`Falta la respuesta a: ${question.question.slice(0, 80)}`);
    const selected = item['selected'] ?? [];
    const rawText = item['text'] ?? null;
    if (!Array.isArray(selected) || selected.some((label) => typeof label !== 'string')) {
      throw new QuestionAnswerError('selected debe ser una lista de opciones');
    }
    if (rawText !== null && typeof rawText !== 'string') {
      throw new QuestionAnswerError('text debe ser un texto');
    }
    const labels = new Set(question.options.map((o) => o.label));
    const chosen = selected as string[];
    for (const label of chosen) {
      if (!labels.has(label)) {
        throw new QuestionAnswerError(
          `"${label.slice(0, 80)}" no es una opción de: ${question.question.slice(0, 80)}`,
        );
      }
    }
    if (new Set(chosen).size !== chosen.length) throw new QuestionAnswerError('Opciones repetidas');
    const text = rawText === null ? null : rawText.trim() || null;
    if (text !== null && text.length > MAX_ANSWER_TEXT) {
      throw new QuestionAnswerError(`El texto libre supera ${String(MAX_ANSWER_TEXT)} caracteres`);
    }
    if (chosen.length === 0 && text === null) {
      throw new QuestionAnswerError(
        `Elegí una opción o escribí un texto en: ${question.question.slice(0, 80)}`,
      );
    }
    if (!question.multiSelect && chosen.length + (text === null ? 0 : 1) > 1) {
      throw new QuestionAnswerError(
        `Solo se admite una respuesta en: ${question.question.slice(0, 80)}`,
      );
    }
    normalized[question.question] = { selected: chosen, text };
  }
  return normalized;
}

/**
 * The `answers` map the SDK expects in AskUserQuestion's updatedInput (spike H1): question text ->
 * answer string, with multi-select answers (and free text) joined by ", ".
 */
export function toSdkAnswers(answer: QuestionAnswer): Record<string, string> {
  return Object.fromEntries(
    Object.entries(answer).map(([question, item]) => [
      question,
      [...item.selected, ...(item.text === null ? [] : [item.text])].join(', '),
    ]),
  );
}

export class QuestionRepository {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Stores a new pending question. There is no timeout: it stays pending until answered or cancelled. */
  create(chatId: number, toolUseId: string, questions: AskedQuestion[]): PendingQuestion {
    const row = this.db
      .prepare(
        `INSERT INTO pending_questions (chat_id, tool_use_id, questions, status, created_at)
         VALUES (?, ?, ?, 'pending', ?) RETURNING *`,
      )
      .get(chatId, toolUseId, JSON.stringify(questions), this.now()) as unknown as QuestionRow;
    return toQuestion(row);
  }

  get(id: number): PendingQuestion | undefined {
    const row = this.db.prepare('SELECT * FROM pending_questions WHERE id = ?').get(id) as
      QuestionRow | undefined;
    return row ? toQuestion(row) : undefined;
  }

  /** Every question of a chat, oldest first; pass 'pending' to get only those still waiting. */
  listByChat(chatId: number, status?: PendingQuestionStatus): PendingQuestion[] {
    const where = status === undefined ? '' : ' AND status = ?';
    const args = status === undefined ? [chatId] : [chatId, status];
    return (
      this.db
        .prepare(`SELECT * FROM pending_questions WHERE chat_id = ?${where} ORDER BY id`)
        .all(...args) as unknown as QuestionRow[]
    ).map(toQuestion);
  }

  /**
   * Records the user's answer, once. The UPDATE only matches a pending row, so two concurrent
   * answers cannot both win: the second one throws QuestionNotPendingError (HTTP 409).
   */
  answer(id: number, answer: unknown, answeredBy: number): PendingQuestion {
    const current = this.get(id);
    if (!current) throw new QuestionNotFoundError(id);
    if (current.status !== 'pending') throw new QuestionNotPendingError(id, current.status);
    const normalized = validateAnswer(current.questions, answer);
    const result = this.db
      .prepare(
        `UPDATE pending_questions SET status = 'answered', answer = ?, answered_by = ?, answered_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(JSON.stringify(normalized), answeredBy, this.now(), id);
    if (Number(result.changes) !== 1) {
      throw new QuestionNotPendingError(id, this.get(id)?.status ?? 'cancelled');
    }
    const updated = this.get(id);
    if (!updated) throw new QuestionNotFoundError(id);
    return updated;
  }

  /** Startup: no session survives a restart, so nothing is waiting for an answer anymore. */
  cancelAllPending(): number {
    const result = this.db
      .prepare("UPDATE pending_questions SET status = 'cancelled' WHERE status = 'pending'")
      .run();
    return Number(result.changes);
  }

  /** Cancels what a chat is still waiting on (cancel, delete, restart). Returns how many. */
  cancelPending(chatId: number): number {
    const result = this.db
      .prepare(
        "UPDATE pending_questions SET status = 'cancelled' WHERE chat_id = ? AND status = 'pending'",
      )
      .run(chatId);
    return Number(result.changes);
  }
}
