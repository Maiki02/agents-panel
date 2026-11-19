import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { PrData, PrSprint, PrTask } from '../kyro/state.js';

/** GitHub rejects a PR body longer than this many characters. */
export const PR_BODY_MAX = 65536;

/**
 * GitLab rejects a MR description over 1 MiB (bytes). Characters can take up to 4 bytes, so this
 * cut keeps any text under the limit.
 */
export const MR_BODY_MAX = 250_000;

/** Footer the pilot ends every PR description with. */
export const PR_FOOTER = 'Abierta por el piloto del panel. Revisá los cambios antes de mergear.';

/** A single task never takes more than this; the evidence of a long task is cut. */
const TASK_TEXT_MAX = 2000;

const TRUNCATED = '…(recortado)';

export interface PrText {
  title: string;
  body: string;
}

/** Limits of the manual checks file: it never grows the PR past its limit. */
const MANUAL_MAX_BYTES = 32_768;
const MANUAL_MAX_LINES = 100;
const MANUAL_LINE_MAX = 500;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Fixed path, relative to the worktree, of the manual checks of a scope or work. */
export function manualChecksPath(name: string): string {
  return path.posix.join('.agents', 'kyro', 'manual-checks', `${name}.md`);
}

/** Lines of the manual checks file: bullets and checkboxes dropped, blanks and headings skipped. */
export function parseManualChecks(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw
      .trim()
      .replace(/^(?:[-*+]\s+)?(?:\[[ xX]\]\s+)?/, '')
      .trim();
    if (line === '' || line.startsWith('#')) continue;
    lines.push(line.length > MANUAL_LINE_MAX ? `${line.slice(0, MANUAL_LINE_MAX)}…` : line);
    if (lines.length >= MANUAL_MAX_LINES) break;
  }
  return lines;
}

/**
 * The manual checks the agent noted for a scope or work, or [] when the file is missing, empty,
 * unreadable or not a regular file inside the worktree (symlinks included).
 */
export async function readManualChecks(worktree: string, name: string): Promise<string[]> {
  if (!SAFE_NAME.test(name) || name.includes('..')) return [];
  const file = path.join(worktree, manualChecksPath(name));
  try {
    const root = await realpath(worktree);
    const real = await realpath(path.dirname(file));
    if (real !== root && !real.startsWith(root + path.sep)) return [];
    if (!(await lstat(file)).isFile()) return [];
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buffer = Buffer.alloc(MANUAL_MAX_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, MANUAL_MAX_BYTES, 0);
      return parseManualChecks(buffer.toString('utf8', 0, bytesRead));
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
}

/** The «Verificación manual» section (a checkbox per line), or '' when there is nothing to check. */
export function manualChecksSection(checks: readonly string[]): string {
  if (checks.length === 0) return '';
  const items = checks.map((check) => `- [ ] ${check.replace(/\s+/g, ' ')}`);
  return ['## Verificación manual', ...items, ''].join('\n');
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

/** A user-written body cut to the limit of the provider. */
export function clipPrBody(body: string, max: number): string {
  return fit(body, max);
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
    if (data === undefined) return null;
    return buildPrText(data, await readManualChecks(cwd, target.name));
  } catch {
    return null;
  }
}

/**
 * Title and Markdown body of the PR from the Kyro state. Pure: it takes what was read and never
 * throws, so a missing title, objective, task or sprint only leaves that part out. The body never
 * passes {@link PR_BODY_MAX} and always ends with the pilot's footer.
 */
export function buildPrText(data: PrData, manualChecks: readonly string[] = []): PrText {
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
  const manual = manualChecksSection(manualChecks);
  const tail = `${manual === '' ? '' : `\n${manual}`}\n${PR_FOOTER}`;
  const content = lines.join('\n').replace(/\n+$/, '\n');
  return { title, body: fit(content, PR_BODY_MAX - tail.length) + tail };
}
