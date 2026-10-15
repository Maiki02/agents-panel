/**
 * Client-side mirror of the API's repository rule (R3, R29), only to fail fast while typing.
 * The web asks for the full URL: `https://github.com/user/repo[/tree/branch]` or, for GitLab,
 * `https://<host>/group[/subgroup...]/repo[/-/tree/branch]` where `<host>` is gitlab.com or the host
 * of a linked GitLab account. The server stays the authority and re-validates everything.
 */
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const BAD_REF_CHARS = /[\s~^:?*[\\\p{Cc}]/u;
const GITLAB_SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/;
const GITLAB_MAX_DEPTH = 20;

export const GITHUB_HOST = 'github.com';
export const GITLAB_COM = 'gitlab.com';

export type RepoProvider = 'github' | 'gitlab';

export type RepoParse =
  | {
      ok: true;
      provider: RepoProvider;
      host: string;
      /** GitHub user, or the group path (with subgroups) on GitLab. */
      owner: string;
      repo: string;
      slug: string;
      branch: string | null;
    }
  | { ok: false; reason: string };

function fail(reason: string): RepoParse {
  return { ok: false, reason };
}

function branchProblem(segments: string[]): string | null {
  let branch: string;
  try {
    branch = segments.map((segment) => decodeURIComponent(segment)).join('/');
  } catch {
    return 'La rama de la URL no es válida.';
  }
  const bad =
    branch === '' ||
    branch.length > 200 ||
    segments.includes('') ||
    BAD_REF_CHARS.test(branch) ||
    branch.startsWith('-') ||
    branch.includes('..') ||
    branch.includes('@{') ||
    branch.endsWith('.') ||
    branch.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'));
  return bad ? 'La rama de la URL no es válida.' : null;
}

function parseGithub(url: URL): RepoParse {
  const parts = url.pathname.slice(1).split('/');
  if (parts.at(-1) === '') parts.pop();
  const [owner, rawRepo, tree, ...rest] = parts;
  if (!owner || !rawRepo) return fail('La URL tiene que ser https://github.com/usuario/repo');
  const repo = rawRepo.endsWith('.git') ? rawRepo.slice(0, -4) : rawRepo;
  if (!OWNER_RE.test(owner)) {
    return fail('El usuario lleva hasta 39 letras, números o guiones, y no empieza con guion.');
  }
  if (!REPO_RE.test(repo)) {
    return fail('El repo lleva hasta 100 letras, números, puntos, guiones o guiones bajos.');
  }

  let branch: string | null = null;
  if (tree !== undefined) {
    if (tree !== 'tree' || rest.length === 0) {
      return fail('Solo se admite la URL del repo o …/tree/<rama>.');
    }
    const problem = branchProblem(rest);
    if (problem !== null) return fail(problem);
    branch = rest.map((segment) => decodeURIComponent(segment)).join('/');
  }
  return {
    ok: true,
    provider: 'github',
    host: GITHUB_HOST,
    owner,
    repo,
    slug: `${owner}/${repo}`,
    branch,
  };
}

/** `group[/subgroup...]/repo[.git][/-/tree/<branch>]`. */
function parseGitlab(host: string, url: URL): RepoParse {
  const parts = url.pathname.slice(1).split('/');
  if (parts.at(-1) === '') parts.pop();
  const dash = parts.indexOf('-');
  let segments = parts;
  let branch: string | null = null;
  if (dash !== -1) {
    segments = parts.slice(0, dash);
    const [tree, ...rest] = parts.slice(dash + 1);
    if (tree !== 'tree' || rest.length === 0) {
      return fail('Solo se admite la URL del repo o …/-/tree/<rama>.');
    }
    const problem = branchProblem(rest);
    if (problem !== null) return fail(problem);
    branch = rest.map((segment) => decodeURIComponent(segment)).join('/');
  }
  const last = segments.length - 1;
  if (last >= 0 && segments[last]?.endsWith('.git')) {
    segments = [...segments.slice(0, last), (segments[last] ?? '').slice(0, -4)];
  }
  if (segments.length < 2 || segments.length > GITLAB_MAX_DEPTH) {
    return fail(`La URL tiene que ser https://${host}/grupo/repo (admite subgrupos).`);
  }
  for (const segment of segments) {
    if (
      !GITLAB_SEGMENT_RE.test(segment) ||
      segment.includes('..') ||
      segment.endsWith('.git') ||
      segment.endsWith('.atom')
    ) {
      return fail(`"${segment.slice(0, 40)}" no es un nombre válido de grupo o repo.`);
    }
  }
  const repo = segments[segments.length - 1] ?? '';
  const owner = segments.slice(0, -1).join('/');
  return { ok: true, provider: 'gitlab', host, owner, repo, slug: `${owner}/${repo}`, branch };
}

/**
 * Accepts a GitHub or GitLab URL with optional `.git`, trailing slash and branch. `gitlabHosts` are
 * the hosts of the linked GitLab accounts: gitlab.com is always accepted.
 */
export function parseRepoInput(input: string, gitlabHosts: readonly string[] = []): RepoParse {
  const text = input.trim();
  if (text === '') return fail('Pegá la URL del repositorio de GitHub o GitLab.');
  if (/[\s\p{Cc}]/u.test(text)) return fail('No puede tener espacios.');
  if (!text.startsWith('https://')) {
    return fail('Pegá la URL completa: https://github.com/usuario/repo');
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail('La URL no es válida.');
  }
  if (url.port !== '') return fail('La URL no puede llevar puerto.');
  if (url.username !== '' || url.password !== '') {
    return fail('La URL no puede llevar credenciales.');
  }
  if (url.search !== '' || url.hash !== '') {
    return fail('La URL no puede llevar query ni fragmento.');
  }

  const host = url.hostname.toLowerCase();
  if (host === GITHUB_HOST) return parseGithub(url);
  const known = new Set([GITLAB_COM, ...gitlabHosts.map((h) => h.toLowerCase())]);
  if (known.has(host)) return parseGitlab(host, url);
  return fail(
    `${host} no es github.com, gitlab.com ni el host de una cuenta de GitLab vinculada. Vinculá la cuenta en Cuentas primero.`,
  );
}
