import type { PrData, PrSprint, PrTask } from '../kyro/state.js';

/** GitHub rejects a PR body longer than this many characters. */
export const PR_BODY_MAX = 65536;

/** Footer the pilot ends every PR description with. */
export const PR_FOOTER = 'Abierta por el piloto del panel. Revisá los cambios antes de mergear.';

/** A single task never takes more than this; the evidence of a long task is cut. */
const TASK_TEXT_MAX = 2000;

const TRUNCATED = '…(recortado)';

export interface PrText {
  title: string;
  body: string;
}

/** Cuts `text` to `max` characters, marking the cut; never splits a surrogate pair. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max - TRUNCATED.length);
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end) + TRUNCATED;
}

/** Indents the continuation lines so a multi-line summary stays inside its list item. */
function indent(text: string): string {
  return text.replace(/\r\n?/g, '\n').split('\n').join('\n  ');
}

/** One list item: id, title and the evidence summary (or the description when there is none). */
export function taskLine(task: PrTask): string {
  const head = task.title === '' ? `**${task.id}**` : `**${task.id}** — ${task.title}`;
  if (task.discarded !== null) {
    return `- ~~${head}~~ _(descartada: ${task.discarded.replace(/\s+/g, ' ')})_`;
  }
  const detail = task.summary !== '' ? task.summary : task.description;
  if (detail === '') return `- ${head}`;
  return `- ${head}: ${indent(clip(detail, TASK_TEXT_MAX))}`;
}

function sprintBlock(sprint: PrSprint): string[] {
  const title = sprint.title === '' ? 'cerrado' : sprint.title;
  return [
    `### Sprint ${String(sprint.n)}: ${title}`,
    ...(sprint.tasks.length === 0 ? ['- sin tareas en el archivo'] : sprint.tasks.map(taskLine)),
    '',
  ];
}

/** Cuts the body so it fits in `max`, closing a code fence the cut left open. */
function fit(body: string, max: number): string {
  if (body.length <= max) return body;
  let cut = body.slice(0, Math.max(0, max - TRUNCATED.length - 5));
  const newline = cut.lastIndexOf('\n');
  if (newline > 0) cut = cut.slice(0, newline);
  const fences = cut.match(/^\s*```/gm)?.length ?? 0;
  return `${cut}${fences % 2 === 1 ? '\n```' : ''}\n${TRUNCATED}`;
}

/** The part of KyroReader that reads what a PR description is built from; tests inject a fake. */
export interface PrDataReader {
  workPrData(cwd: string, work: string): Promise<PrData>;
  scopePrData(cwd: string, scope: string): Promise<PrData>;
}

/**
 * The detailed PR text of a work or scope, or null when the reader is missing or fails: the caller
 * then keeps its plain text and the PR opens anyway.
 */
export async function readPrText(
  reader: Partial<PrDataReader> | undefined,
  cwd: string,
  target: { kind: 'work' | 'scope'; name: string },
): Promise<PrText | null> {
  try {
    const data =
      target.kind === 'work'
        ? await reader?.workPrData?.(cwd, target.name)
        : await reader?.scopePrData?.(cwd, target.name);
    return data === undefined ? null : buildPrText(data);
  } catch {
    return null;
  }
}

/**
 * Title and Markdown body of the PR from the Kyro state. Pure: it takes what was read and never
 * throws, so a missing title, objective, task or sprint only leaves that part out. The body never
 * passes {@link PR_BODY_MAX} and always ends with the pilot's footer.
 */
export function buildPrText(data: PrData): PrText {
  const label = data.kind === 'work' ? 'Work' : 'Scope';
  const title = clip(data.title.replace(/\s+/g, ' ').trim() || `${label} ${data.slug}`, 250);
  const lines: string[] = [];
  lines.push(data.objective === '' ? `${label} \`${data.slug}\`.` : data.objective, '');
  if (data.kind === 'work') {
    lines.push('## Tareas');
    lines.push(...(data.tasks.length === 0 ? ['- ninguna'] : data.tasks.map(taskLine)));
    lines.push('');
  } else {
    lines.push('## Sprints cerrados');
    if (data.sprints.length === 0) lines.push('- ninguno', '');
    else {
      lines.push('');
      for (const sprint of data.sprints) lines.push(...sprintBlock(sprint));
    }
  }
  const footer = `\n${PR_FOOTER}`;
  const content = lines.join('\n').replace(/\n+$/, '\n');
  return { title, body: fit(content, PR_BODY_MAX - footer.length) + footer };
}
