import type { AskedQuestion, ChatEvent, QuestionAnswer } from '@agents-panel/shared';
import { formatAnswer } from './question-logic';

/** What the chat screen renders. Everything here is plain text: nothing is ever injected as HTML. */
export type ViewItem =
  | { kind: 'user'; seq: number; text: string }
  | { kind: 'assistant'; seq: number; text: string }
  | { kind: 'tool'; seq: number; name: string; input: string }
  | { kind: 'tool_result'; seq: number; text: string; isError: boolean }
  | { kind: 'denied'; seq: number; tool: string; reason: string }
  | { kind: 'result'; seq: number; ok: boolean; text: string }
  | { kind: 'question'; seq: number; questionId: number; questions: AskedQuestion[] }
  | {
      kind: 'answer';
      seq: number;
      questionId: number;
      lines: { question: string; answer: string }[];
    }
  | { kind: 'question_cancelled'; seq: number; questionId: number }
  | { kind: 'error'; seq: number; text: string }
  | { kind: 'log'; seq: number; text: string };

type Json = Record<string, unknown>;

const MAX_TEXT = 4000;

function asObject(value: unknown): Json {
  return typeof value === 'object' && value !== null ? (value as Json) : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}… (recortado)` : text;
}

function blocks(payload: Json): Json[] {
  const content = asObject(payload['message'])['content'];
  return Array.isArray(content) ? content.map(asObject) : [];
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(asObject)
      .map((part) => asString(part['text']))
      .filter((text) => text !== '')
      .join('\n');
  }
  return '';
}

/** Maps one stored event to zero or more display items (system noise is hidden). */
export function toViewItems(event: ChatEvent): ViewItem[] {
  const payload = asObject(event.payload);
  const seq = event.seq;

  switch (event.type) {
    case 'user_prompt':
      return [{ kind: 'user', seq, text: asString(payload['text']) }];

    case 'assistant':
      return blocks(payload).flatMap((block): ViewItem[] => {
        if (block['type'] === 'text') {
          const text = asString(block['text']);
          return text.trim() === '' ? [] : [{ kind: 'assistant', seq, text }];
        }
        // The question card shows what AskUserQuestion asked; the raw tool call would repeat it.
        if (block['type'] === 'tool_use' && block['name'] !== 'AskUserQuestion') {
          return [
            {
              kind: 'tool',
              seq,
              name: asString(block['name']),
              input: clip(JSON.stringify(block['input'] ?? {}, null, 2)),
            },
          ];
        }
        return [];
      });

    case 'user':
      return blocks(payload)
        .filter((block) => block['type'] === 'tool_result')
        .map((block) => ({
          kind: 'tool_result' as const,
          seq,
          text: clip(resultText(block['content'])),
          isError: block['is_error'] === true,
        }));

    case 'permission_denied':
      return [
        {
          kind: 'denied',
          seq,
          tool: asString(payload['tool']),
          reason: asString(payload['reason']),
        },
      ];

    case 'question_asked': {
      const questions = payload['questions'];
      return Array.isArray(questions)
        ? [
            {
              kind: 'question',
              seq,
              questionId: asNumber(payload['questionId']),
              questions: questions as AskedQuestion[],
            },
          ]
        : [];
    }

    case 'question_answered': {
      const answer = asObject(payload['answer']) as QuestionAnswer;
      return [
        {
          kind: 'answer',
          seq,
          questionId: asNumber(payload['questionId']),
          lines: Object.entries(answer).map(([question, item]) => ({
            question,
            answer: formatAnswer(item),
          })),
        },
      ];
    }

    case 'question_cancelled':
      return [{ kind: 'question_cancelled', seq, questionId: asNumber(payload['questionId']) }];

    case 'error':
      return [{ kind: 'error', seq, text: asString(payload['message']) }];

    case 'worktree_output': {
      const text = [asString(payload['stdout']), asString(payload['stderr'])]
        .filter((part) => part.trim() !== '')
        .join('\n');
      return [{ kind: 'log', seq, text: clip(`${asString(payload['step'])}: ${text}`.trim()) }];
    }

    default:
      if (event.type.startsWith('result:')) {
        const ok = event.type === 'result:success' && payload['is_error'] !== true;
        return [{ kind: 'result', seq, ok, text: clip(asString(payload['result'])) }];
      }
      return [];
  }
}

/** True for events after which the server updates the chat status. */
export function endsTurn(event: ChatEvent): boolean {
  return event.type.startsWith('result:') || event.type === 'error';
}

/** Ids of the questions the agent is still waiting on: asked, and not answered or cancelled since. */
export function pendingQuestionIds(items: readonly ViewItem[]): number[] {
  const closed = new Set(
    items
      .filter((item) => item.kind === 'answer' || item.kind === 'question_cancelled')
      .map((item) => (item as { questionId: number }).questionId),
  );
  return items.flatMap((item) =>
    item.kind === 'question' && !closed.has(item.questionId) ? [item.questionId] : [],
  );
}
