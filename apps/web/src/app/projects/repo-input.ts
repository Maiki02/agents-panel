/**
 * Client-side mirror of the API's GitHub rule (R3, R29), only to fail fast while typing.
 * The web asks for the full URL (`https://github.com/user/repo[/tree/branch]`); the server stays
 * the authority and re-validates everything before running anything.
 */
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const BAD_REF_CHARS = /[\s~^:?*[\\\p{Cc}]/u;

export type RepoParse =
  | { ok: true; owner: string; repo: string; slug: string; branch: string | null }
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

/** Accepts `https://github.com/user/repo` with optional `.git`, trailing slash and `/tree/branch`. */
export function parseRepoInput(input: string): RepoParse {
  const text = input.trim();
  if (text === '') return fail('Pegá la URL del repositorio de GitHub.');
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
  if (url.hostname !== 'github.com' || url.port !== '') return fail('Solo se admite github.com.');
  if (url.username !== '' || url.password !== '') {
    return fail('La URL no puede llevar credenciales.');
  }
  if (url.search !== '' || url.hash !== '') {
    return fail('La URL no puede llevar query ni fragmento.');
  }

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
  return { ok: true, owner, repo, slug: `${owner}/${repo}`, branch };
}
