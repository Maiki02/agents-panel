import type {
  ChatKind,
  IdeaAction,
  IdeaDocument,
  WorktreeStateId,
  WorktreeTransition,
} from '@agents-panel/shared';

/** The card the chat page shows for the state of a work, if any. */
export type ApprovalCard = 'idea' | 'debt' | 'pr';

export function approvalCard(
  kind: ChatKind,
  state: WorktreeStateId | null | undefined,
): ApprovalCard | null {
  if (state === 'esperando_aprobacion_plan' && kind === 'idea') return 'idea';
  if (state === 'esperando_aprobacion_cierre' && kind === 'scope') return 'debt';
  if (state === 'pr_lista') return 'pr';
  // A finished work may have left a PR the pilot did not open (the agent opened it by itself).
  if (state === 'terminado' && (kind === 'scope' || kind === 'work')) return 'pr';
  return null;
}

/** The PR card shows in `pr_lista` even without links; in `terminado` only when GitHub has one. */
export function showPrCard(
  state: WorktreeStateId | null | undefined,
  urls: readonly string[],
): boolean {
  return state === 'pr_lista' || urls.length > 0;
}

/** An action of a card: why it is disabled (null when it can be sent). */
export interface ActionState {
  disabled: boolean;
  reason: string | null;
}

const enabled: ActionState = { disabled: false, reason: null };
const blocked = (reason: string): ActionState => ({ disabled: true, reason });

export interface IdeaActionStates {
  approve_scope: ActionState;
  approve_work: ActionState;
  request_changes: ActionState;
}

/**
 * Which of the three decisions about the plan can be sent. Approving needs exactly one document;
 * asking for changes needs the text of what to change. Nothing is sent while a call is running.
 */
export function ideaActionStates(input: {
  document: Pick<IdeaDocument, 'path' | 'documents'> | null;
  changes: string;
  busy: boolean;
}): IdeaActionStates {
  const { document, changes, busy } = input;
  const running = busy ? blocked('Enviando tu decisión…') : null;
  let approval: ActionState = enabled;
  if (document === null) approval = blocked('Cargando el plan…');
  else if (document.documents.length > 1) {
    approval = blocked('Hay más de un documento de idea: pedí cambios para dejar uno.');
  } else if (document.path === null) approval = blocked('Todavía no hay un plan escrito.');
  const approve = running ?? approval;
  return {
    approve_scope: approve,
    approve_work: approve,
    request_changes:
      running ?? (changes.trim() === '' ? blocked('Escribí qué querés cambiar.') : enabled),
  };
}

/** Completing with open debt needs the reason; it is sent once at a time. */
export function debtActionState(input: { reason: string; busy: boolean }): ActionState {
  if (input.busy) return blocked('Completando el scope…');
  if (input.reason.trim() === '') return blocked('Escribí por qué aceptás la deuda abierta.');
  return enabled;
}

export interface DebtView {
  id: string;
  title: string;
  priority: string;
}

/** The debt the pilot stopped for, from the latest entry of the Timeline that carries it. */
export function debtFromTimeline(timeline: readonly WorktreeTransition[]): DebtView[] {
  for (const entry of [...timeline].reverse()) {
    if (entry.toState !== 'esperando_aprobacion_cierre') continue;
    const debt = (entry.data as { debt?: unknown } | null)?.debt;
    if (!Array.isArray(debt)) continue;
    return debt.flatMap((item: unknown) => {
      const row = item as Partial<DebtView> | null;
      return typeof row?.id === 'string'
        ? [{ id: row.id, title: row.title ?? '', priority: row.priority ?? 'medium' }]
        : [];
    });
  }
  return [];
}

/** Only https links are shown as links; anything else is dropped. */
export function prLinks(urls: readonly string[]): string[] {
  return urls.filter((url) => /^https:\/\/[^\s]+$/.test(url));
}

export const IDEA_ACTION_LABEL: Record<IdeaAction, string> = {
  approve_scope: 'Aprobar como scope',
  approve_work: 'Aprobar como work',
  request_changes: 'Pedir cambios',
};

/** Whether an event of the stream may have moved the state of the work. */
export function movesState(eventType: string): boolean {
  return eventType === 'state_changed';
}

// --- Markdown without raw HTML ---------------------------------------------------------------

/** A piece of a line: plain text, code, emphasis. Rendered as text, never as HTML. */
export interface Inline {
  kind: 'text' | 'code' | 'strong' | 'em';
  text: string;
}

export type MdBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; inline: Inline[] }
  | { kind: 'paragraph'; inline: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; inline: Inline[] }
  | { kind: 'rule' };

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g;

/** Inline Markdown: code, bold, italics; a link keeps its text and drops the URL. */
export function parseInline(line: string): Inline[] {
  const parts: Inline[] = [];
  let last = 0;
  for (const match of line.matchAll(INLINE)) {
    if (match.index > last) parts.push({ kind: 'text', text: line.slice(last, match.index) });
    const [whole, code, strong, em, linkText] = match;
    if (code !== undefined) parts.push({ kind: 'code', text: code.slice(1, -1) });
    else if (strong !== undefined) parts.push({ kind: 'strong', text: strong.slice(2, -2) });
    else if (em !== undefined) parts.push({ kind: 'em', text: em.slice(1, -1) });
    else parts.push({ kind: 'text', text: linkText ?? whole });
    last = match.index + whole.length;
  }
  if (last < line.length) parts.push({ kind: 'text', text: line.slice(last) });
  return parts;
}

/**
 * Turns the Markdown of a plan into blocks of data. The page renders them with interpolation, so
 * a `<script>` in the document shows up as text: nothing from the repo is ever injected as HTML.
 */
export function parseMarkdown(source: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0)
      blocks.push({ kind: 'paragraph', inline: parseInline(paragraph.join(' ')) });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) code.push(lines[i++] ?? '');
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading?.[1] !== undefined) {
      flush();
      blocks.push({
        kind: 'heading',
        level: heading[1].length as 1 | 2 | 3 | 4,
        inline: parseInline(heading[2] ?? ''),
      });
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      flush();
      blocks.push({ kind: 'rule' });
      continue;
    }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const ordered = item[2] !== undefined;
      const items: Inline[][] = [parseInline(item[3] ?? '')];
      while (i + 1 < lines.length) {
        const next = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(lines[i + 1] ?? '');
        if (!next || (next[2] !== undefined) !== ordered) break;
        items.push(parseInline(next[3] ?? ''));
        i++;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      blocks.push({ kind: 'quote', inline: parseInline(quote[1] ?? '') });
      continue;
    }
    if (line.trim() === '') flush();
    else paragraph.push(line.trim());
  }
  flush();
  return blocks;
}
