import type { AskedQuestion, QuestionAnswer, QuestionAnswerItem } from '@agents-panel/shared';

/** What the user has picked and typed for one question while the card is open. */
export interface QuestionDraft {
  selected: string[];
  text: string;
}

/** Drafts keyed by the exact question text, like the answer the API expects. */
export type AnswerDraft = Record<string, QuestionDraft>;

export function emptyDraft(questions: readonly AskedQuestion[]): AnswerDraft {
  return Object.fromEntries(questions.map((q) => [q.question, { selected: [], text: '' }]));
}

/**
 * Picks or unpicks an option. A single-choice question holds one answer: picking an option clears
 * the typed text, and picking the chosen one again clears it.
 */
export function toggleOption(
  question: Pick<AskedQuestion, 'multiSelect'>,
  draft: QuestionDraft,
  label: string,
): QuestionDraft {
  if (draft.selected.includes(label)) {
    return { ...draft, selected: draft.selected.filter((item) => item !== label) };
  }
  return question.multiSelect
    ? { ...draft, selected: [...draft.selected, label] }
    : { selected: [label], text: '' };
}

/** Typing "Otra respuesta" on a single-choice question replaces the chosen option. */
export function setText(
  question: Pick<AskedQuestion, 'multiSelect'>,
  draft: QuestionDraft,
  text: string,
): QuestionDraft {
  return question.multiSelect || text.trim() === '' ? { ...draft, text } : { selected: [], text };
}

function isAnswered(draft: QuestionDraft | undefined): boolean {
  return draft !== undefined && (draft.selected.length > 0 || draft.text.trim() !== '');
}

/** Every question needs an option or some text before the answer can be sent. */
export function isComplete(questions: readonly AskedQuestion[], draft: AnswerDraft): boolean {
  return questions.every((q) => isAnswered(draft[q.question]));
}

/** Why Enviar is disabled, or null when it can be used. Shown next to the button. */
export function incompleteReason(
  questions: readonly AskedQuestion[],
  draft: AnswerDraft,
): string | null {
  const missing = questions.filter((q) => !isAnswered(draft[q.question]));
  if (missing.length === 0) return null;
  const names = missing.map((q) => q.header || q.question).join(', ');
  return `Elegí una opción o escribí una respuesta en: ${names}.`;
}

/** The body of POST /api/chats/:id/questions/:qid/answer. Free text is trimmed; empty becomes null. */
export function buildAnswerBody(
  questions: readonly AskedQuestion[],
  draft: AnswerDraft,
): { answer: QuestionAnswer } {
  const answer: QuestionAnswer = {};
  for (const q of questions) {
    const item = draft[q.question] ?? { selected: [], text: '' };
    const text = item.text.trim();
    answer[q.question] = { selected: [...item.selected], text: text === '' ? null : text };
  }
  return { answer };
}

/** One line of text for the history: chosen options and free text joined by ", ". */
export function formatAnswer(item: QuestionAnswerItem): string {
  return [...item.selected, ...(item.text === null ? [] : [item.text])].join(', ');
}
