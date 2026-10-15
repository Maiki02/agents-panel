import type { GitProvider } from '@agents-panel/shared';
import { parseBranch, parseGithubPath, parseGithubRepo } from './github.js';
import { ProjectError } from './repo.js';

/** A repository on a git provider, as the panel registers it. */
export interface RemoteRepo {
  provider: GitProvider;
  /** `github.com`, `gitlab.com` or the host of a linked self-hosted GitLab. */
  host: string;
  /** `owner/repo` (GitHub) or `group[/subgroup...]/repo` (GitLab): the path on the host. */
  slug: string;
  /** Last segment of the path: the base of the internal project name. */
  name: string;
  /** Canonical URL: https://<host>/<slug>, no `.git`. */
  httpsUrl: string;
  /** Branch named by a `/tree/<branch>` (GitHub) or `/-/tree/<branch>` (GitLab) URL. */
  branch: string | null;
}

export const GITHUB_HOST = 'github.com';
export const GITLAB_COM = 'gitlab.com';

const GITLAB_SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/;
const GITLAB_MAX_DEPTH = 20;

function invalid(reason: string): never {
  throw new ProjectError(`Invalid repository: ${reason}`);
}

function lowerHosts(hosts: readonly string[]): Set<string> {
  return new Set([GITLAB_COM, ...hosts.map((host) => host.toLowerCase())]);
}

function fromGithub(path: string, allowBranch: boolean): RemoteRepo {
  const github = parseGithubPath(path, allowBranch);
  return {
    provider: 'github',
    host: GITHUB_HOST,
    slug: github.slug,
    name: github.repo,
    httpsUrl: github.httpsUrl,
    branch: github.branch,
  };
}

/** `group[/subgroup...]/repo[.git][/-/tree/<branch>]`, the branch only when `allowBranch`. */
function fromGitlab(host: string, path: string, allowBranch: boolean): RemoteRepo {
  const parts = path.split('/');
  if (parts.at(-1) === '') parts.pop();
  const dash = parts.indexOf('-');
  let segments = parts;
  let branch: string | null = null;
  if (dash !== -1) {
    segments = parts.slice(0, dash);
    const [tree, ...rest] = parts.slice(dash + 1);
    if (!allowBranch || tree !== 'tree' || rest.length === 0)
      invalid('only group/repo or group/repo/-/tree/<branch>');
    branch = parseBranch(rest);
  }
  const last = segments.length - 1;
  if (last >= 0 && segments[last]?.endsWith('.git')) {
    segments = [...segments.slice(0, last), (segments[last] ?? '').slice(0, -4)];
  }
  if (segments.length < 2 || segments.length > GITLAB_MAX_DEPTH)
    invalid('expected group/repo or group/subgroup/repo');
  for (const segment of segments) {
    if (
      !GITLAB_SEGMENT_RE.test(segment) ||
      segment.includes('..') ||
      segment.endsWith('.git') ||
      segment.endsWith('.atom')
    ) {
      invalid(`invalid segment "${segment.slice(0, 40)}" in the path`);
    }
  }
  const slug = segments.join('/');
  return {
    provider: 'gitlab',
    host,
    slug,
    name: segments[segments.length - 1] ?? slug,
    httpsUrl: `https://${host}/${slug}`,
    branch,
  };
}

/**
 * Parses what the user typed to register a project. GitHub: `owner/repo` or
 * `https://github.com/owner/repo[/tree/<branch>]`. GitLab: `https://<host>/<group>[/<subgroup>...]/<repo>`
 * (optional `.git`, optional `/-/tree/<branch>`), where `<host>` is gitlab.com or the host of a
 * linked GitLab account (`gitlabHosts`). Only https, no credentials, port, query or fragment.
 * This is the only validation before a clone: its result is used solely as argv.
 */
export function parseRemote(input: string, gitlabHosts: readonly string[] = []): RemoteRepo {
  const text = input.trim();
  if (text === '' || /[\s\p{Cc}]/u.test(text)) invalid('empty or contains whitespace');
  const isUrl = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(text) || text.includes('//') || text.includes('@');
  if (!isUrl) return fromGithub(parseGithubRepo(text).slug, false);

  if (!text.startsWith('https://')) invalid('only https:// URLs or owner/repo are accepted');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return invalid('malformed URL');
  }
  if (url.port !== '') invalid('a port in the URL is not accepted');
  if (url.username !== '' || url.password !== '')
    invalid('credentials in the URL are not accepted');
  if (url.search !== '' || url.hash !== '') invalid('query and fragment are not accepted');
  const host = url.hostname.toLowerCase();
  if (host === GITHUB_HOST) {
    const github = parseGithubRepo(text);
    return { ...fromGithub(github.slug, false), branch: github.branch };
  }
  if (lowerHosts(gitlabHosts).has(host)) return fromGitlab(host, url.pathname.slice(1), true);
  return invalid(`${host} is not github.com, gitlab.com or the host of a linked GitLab account`);
}

/**
 * Brings the https and ssh forms of a remote (with or without `.git`) to its canonical
 * `https://<host>/<path>`, lowercased (names are case-insensitive on both providers). GitLab is
 * only recognized on gitlab.com and on `gitlabHosts`. Returns null for anything else.
 */
export function normalizeOrigin(url: string, gitlabHosts: readonly string[] = []): string | null {
  const text = url.trim();
  let host: string;
  let path: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s@]+):([^/].*)$/.exec(text);
  if (scp?.[1] !== undefined && scp[2] !== undefined && !text.includes('://')) {
    host = scp[1].toLowerCase();
    path = scp[2];
  } else {
    try {
      const parsed = new URL(text);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') return null;
      host = parsed.hostname.toLowerCase();
      path = parsed.pathname.slice(1);
    } catch {
      return null;
    }
  }
  try {
    if (host === GITHUB_HOST) return fromGithub(path, false).httpsUrl.toLowerCase();
    if (lowerHosts(gitlabHosts).has(host))
      return fromGitlab(host, path, false).httpsUrl.toLowerCase();
  } catch {
    return null;
  }
  return null;
}
