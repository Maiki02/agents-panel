import { readFile } from 'node:fs/promises';
import type { PrState } from '../pilot/github-cli.js';
import { clipPrBody, MR_BODY_MAX } from '../pilot/pr-body.js';
import type { ForgeProvider } from './provider.js';

const REQUEST_TIMEOUT_MS = 30_000;
const TITLE_MAX = 255;
const ERROR_DETAIL_MAX = 300;
const PER_PAGE = 100;

/** Where a GitLab project lives and how to act on it. The token is read per request, never stored. */
export interface GitlabTarget {
  /** Host (with port when it has one) of the instance, e.g. `gitlab.com`. */
  host: string;
  /** Path of the project, e.g. `group/sub/repo` (not encoded). */
  projectPath: string;
  /** The account's token; sent only in the `PRIVATE-TOKEN` header. */
  token: () => string;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class GitlabApiError extends Error {
  override readonly name = 'GitlabApiError';
}

interface MergeRequestJson {
  iid?: unknown;
  state?: unknown;
  web_url?: unknown;
}

/** `opened`/`locked` (being merged) are still open; only merged and closed end a MR. */
export function mapMrState(state: unknown): PrState | null {
  if (state === 'opened' || state === 'locked') return 'OPEN';
  if (state === 'merged') return 'MERGED';
  if (state === 'closed') return 'CLOSED';
  return null;
}

/**
 * Splits `https://<host>/<path>/-/merge_requests/<iid>`; null for anything else (another host, no
 * `/-/merge_requests/`, extra segments, query or fragment).
 */
export function parseMrUrl(url: string, host: string): { projectPath: string; iid: number } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.host.toLowerCase() !== host.toLowerCase()) return null;
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  )
    return null;
  const match = /^\/(.+)\/-\/merge_requests\/(\d+)$/.exec(parsed.pathname);
  const path = match?.[1];
  const iid = match?.[2];
  if (path === undefined || iid === undefined) return null;
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
    return null;
  return { projectPath: path, iid: Number(iid) };
}

/** GitLab merge requests through the REST API v4 (fetch; nothing to install on the VM). */
export class GitlabForge implements ForgeProvider {
  constructor(
    private readonly target: GitlabTarget,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async openPr(_cwd: string, head: string, base: string): Promise<string | null> {
    const list = await this.list({ source_branch: head, target_branch: base, state: 'opened' });
    return urlsOf(list)[0] ?? null;
  }

  async openPrsOf(_cwd: string, head: string): Promise<string[]> {
    return urlsOf(await this.list({ source_branch: head, state: 'opened' }));
  }

  async allPrsOf(_cwd: string, head: string): Promise<string[]> {
    return urlsOf(await this.list({ source_branch: head, state: 'all' }));
  }

  async createPr(
    _cwd: string,
    input: { base: string; head: string; title: string; bodyFile: string },
  ): Promise<string> {
    const description = clipPrBody(await readFile(input.bodyFile, 'utf8'), MR_BODY_MAX);
    const created = (await this.request(
      'POST',
      this.projectApi('/merge_requests'),
      JSON.stringify({
        source_branch: input.head,
        target_branch: input.base,
        title: input.title.slice(0, TITLE_MAX),
        description,
      }),
    )) as MergeRequestJson | null;
    const url = created?.web_url;
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      throw new GitlabApiError('GitLab no devolvió la URL de la MR');
    }
    return url;
  }

  async prStateOf(_cwd: string, url: string): Promise<PrState> {
    const mr = parseMrUrl(url, this.target.host);
    if (mr === null)
      throw new Error(`No es la URL de una MR de GitLab (${this.target.host}): ${url}`);
    const found = (await this.request(
      'GET',
      `${this.base()}/projects/${encodeURIComponent(mr.projectPath)}/merge_requests/${String(mr.iid)}`,
    )) as MergeRequestJson | null;
    const state = mapMrState(found?.state);
    if (state === null)
      throw new GitlabApiError(`GitLab devolvió un estado desconocido para ${url}`);
    return state;
  }

  private base(): string {
    return `https://${this.target.host}/api/v4`;
  }

  private projectApi(path: string): string {
    return `${this.base()}/projects/${encodeURIComponent(this.target.projectPath)}${path}`;
  }

  private async list(query: Record<string, string>): Promise<MergeRequestJson[]> {
    const params = new URLSearchParams({ ...query, per_page: String(PER_PAGE) });
    const out = await this.request(
      'GET',
      `${this.projectApi('/merge_requests')}?${params.toString()}`,
    );
    return Array.isArray(out) ? (out as MergeRequestJson[]) : [];
  }

  /** One call. The token only goes in the header; errors never carry it. */
  private async request(method: 'GET' | 'POST', url: string, body?: string): Promise<unknown> {
    const token = this.target.token();
    const scrub = (text: string): string => (token === '' ? text : text.split(token).join('***'));
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          'PRIVATE-TOKEN': token,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body }),
        // A redirect would resend the header to another host.
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new GitlabApiError(`GitLab ${method} falló: ${scrub(why).slice(0, ERROR_DETAIL_MAX)}`);
    }
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      throw new GitlabApiError(
        `GitLab ${method} respondió ${String(response.status)}: ${scrub(text).slice(0, ERROR_DETAIL_MAX)}`,
      );
    }
    try {
      return text === '' ? null : (JSON.parse(text) as unknown);
    } catch {
      throw new GitlabApiError('GitLab devolvió una respuesta que no es JSON');
    }
  }
}

function urlsOf(list: MergeRequestJson[]): string[] {
  return list.flatMap((item) => (typeof item.web_url === 'string' ? [item.web_url] : []));
}
