import { ProjectError } from './repo.js';

export interface GithubRepo {
  owner: string;
  repo: string;
  /** `owner/repo`: the only form ever passed to `gh repo clone`. */
  slug: string;
  /** Canonical URL: https://github.com/owner/repo */
  httpsUrl: string;
  /** Branch named by a `/tree/<branch>` URL; null when the input did not name one. */
  branch: string | null;
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const GITHUB_HOST = 'github.com';

function invalid(reason: string): never {
  throw new ProjectError(`Invalid GitHub repository: ${reason}`);
}

function build(owner: string, rawRepo: string, branch: string | null): GithubRepo {
  const repo = rawRepo.endsWith('.git') ? rawRepo.slice(0, -4) : rawRepo;
  if (!OWNER_RE.test(owner))
    invalid('owner must be 1-39 letters, digits or hyphens, not starting with a hyphen');
  if (!REPO_RE.test(repo))
    invalid(
      'repo must be up to 100 letters, digits, dots, hyphens or underscores, not starting with a dot or hyphen',
    );
  return {
    owner,
    repo,
    slug: `${owner}/${repo}`,
    httpsUrl: `https://${GITHUB_HOST}/${owner}/${repo}`,
    branch,
  };
}

/** Splits `owner/repo[/tree/<branch>]`; the branch may contain slashes (feature/x). */
function splitPath(path: string, allowBranch: boolean): [string, string, string | null] {
  const parts = path.split('/');
  if (parts.at(-1) === '') parts.pop();
  const [owner, repo, tree, ...rest] = parts;
  if (!owner || !repo) invalid('expected exactly owner/repo');
  if (tree === undefined) return [owner, repo, null];
  if (!allowBranch) invalid('expected exactly owner/repo');
  if (tree !== 'tree' || rest.length === 0) invalid('only owner/repo or owner/repo/tree/<branch>');
  return [owner, repo, parseBranch(rest)];
}

const BAD_REF_CHARS = /[\s~^:?*[\\\p{Cc}]/u;

/** A git branch name taken from a URL: strict, because it becomes an argv value. */
function parseBranch(segments: string[]): string {
  let branch: string;
  try {
    branch = segments.map((segment) => decodeURIComponent(segment)).join('/');
  } catch {
    return invalid('malformed branch in the URL');
  }
  if (
    branch === '' ||
    branch.length > 200 ||
    segments.some((segment) => segment === '') ||
    BAD_REF_CHARS.test(branch) ||
    branch.startsWith('-') ||
    branch.startsWith('/') ||
    branch.includes('..') ||
    branch.includes('@{') ||
    branch.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock')) ||
    branch.endsWith('.') ||
    branch === '@'
  ) {
    return invalid('invalid branch in the URL');
  }
  return branch;
}

/**
 * Parses `owner/repo` or `https://github.com/owner/repo[/tree/<branch>]` (optional `.git`, optional
 * trailing slash). A branch is only read from the URL form.
 * This is the only validation before a clone: its result is used solely as argv for `gh`.
 */
export function parseGithubRepo(input: string): GithubRepo {
  const text = input.trim();
  if (text === '' || /[\s\p{Cc}]/u.test(text)) invalid('empty or contains whitespace');

  let path = text;
  let isUrl = false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text) || text.includes('//') || text.includes('@')) {
    if (!text.startsWith('https://'))
      invalid('only https://github.com URLs or owner/repo are accepted');
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return invalid('malformed URL');
    }
    if (url.hostname !== GITHUB_HOST || url.port !== '') invalid('only github.com is accepted');
    if (url.username !== '' || url.password !== '')
      invalid('credentials in the URL are not accepted');
    if (url.search !== '' || url.hash !== '') invalid('query and fragment are not accepted');
    path = url.pathname.slice(1);
    isUrl = true;
  }
  return build(...splitPath(path, isUrl));
}

/**
 * Brings the https and ssh forms of a GitHub remote (with or without `.git`) to
 * `https://github.com/owner/repo`, lowercased (GitHub names are case-insensitive).
 * Returns null for anything that is not a GitHub remote.
 */
export function normalizeOrigin(url: string): string | null {
  const text = url.trim();
  let path: string | undefined;
  const scp = /^(?:[^@/\s]+@)?github\.com:(.+)$/i.exec(text);
  if (scp) {
    path = scp[1];
  } else {
    try {
      const parsed = new URL(text);
      if (
        (parsed.protocol === 'https:' || parsed.protocol === 'ssh:') &&
        parsed.hostname.toLowerCase() === GITHUB_HOST
      ) {
        path = parsed.pathname.slice(1);
      }
    } catch {
      return null;
    }
  }
  if (path === undefined) return null;
  try {
    return build(...splitPath(path, false)).httpsUrl.toLowerCase();
  } catch {
    return null;
  }
}
