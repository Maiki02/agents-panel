import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const GH_TIMEOUT_MS = 60_000;

/** What the pilot asks GitHub through `gh`; injectable so tests never call GitHub. */
export interface PilotGh {
  /** URL of the open PR of `head` into `base`, or null when there is none. */
  openPr(cwd: string, head: string, base: string): Promise<string | null>;
  /** URLs of every open PR of the branch (a work may span child repos: one call per repo). */
  openPrsOf(cwd: string, head: string): Promise<string[]>;
  /** Opens the PR and returns its URL. The body travels in a file, never in argv. */
  createPr(
    cwd: string,
    input: { base: string; head: string; title: string; bodyFile: string },
  ): Promise<string>;
}

async function gh(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gh', args, {
      cwd,
      timeout: GH_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const out = error as { stderr?: unknown; message?: string };
    const detail = typeof out.stderr === 'string' && out.stderr !== '' ? out.stderr : out.message;
    throw new Error(
      `gh ${args[0] ?? ''} ${args[1] ?? ''} falló: ${(detail ?? '').trim().slice(0, 500)}`,
      {
        cause: error,
      },
    );
  }
}

function urlsOf(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item: unknown) => {
    const url = (item as { url?: unknown } | null)?.url;
    return typeof url === 'string' ? [url] : [];
  });
}

/** argv of the lookup of the open PR of a branch into a base. */
export function listPrArgs(head: string, base: string): string[] {
  return ['pr', 'list', '--head', head, '--base', base, '--state', 'open', '--json', 'url'];
}

/** argv of the PR creation. */
export function createPrArgs(input: {
  base: string;
  head: string;
  title: string;
  bodyFile: string;
}): string[] {
  return [
    'pr',
    'create',
    '--base',
    input.base,
    '--head',
    input.head,
    '--title',
    input.title,
    '--body-file',
    input.bodyFile,
  ];
}

export const realGh: PilotGh = {
  async openPr(cwd, head, base) {
    return urlsOf(await gh(cwd, listPrArgs(head, base)))[0] ?? null;
  },
  async openPrsOf(cwd, head) {
    return urlsOf(
      await gh(cwd, ['pr', 'list', '--head', head, '--state', 'open', '--json', 'url']),
    );
  },
  async createPr(cwd, input) {
    const out = (await gh(cwd, createPrArgs(input))).trim().split('\n');
    const url = out.at(-1)?.trim() ?? '';
    if (!/^https?:\/\//.test(url)) throw new Error('gh pr create no devolvió la URL de la PR');
    return url;
  },
};

/** URLs of every PR of the branch, open, merged or closed (the PR a work left behind). */
export async function allPrsOf(cwd: string, head: string): Promise<string[]> {
  return urlsOf(await gh(cwd, ['pr', 'list', '--head', head, '--state', 'all', '--json', 'url']));
}
