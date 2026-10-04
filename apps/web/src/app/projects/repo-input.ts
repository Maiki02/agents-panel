/**
 * Client-side mirror of the API's GitHub repo rule (R3), only to fail fast while typing.
 * The server stays the authority: it re-validates everything before running anything.
 */
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

export type RepoParse = { ok: true; slug: string } | { ok: false; reason: string };

function fail(reason: string): RepoParse {
  return { ok: false, reason };
}

/** Accepts `owner/repo` or `https://github.com/owner/repo` (optional `.git` and trailing slash). */
export function parseRepoInput(input: string): RepoParse {
  const text = input.trim();
  if (text === '') return fail('Escribí owner/repo o la URL de GitHub.');
  if (/[\s\p{Cc}]/u.test(text)) return fail('No puede tener espacios.');

  let path = text;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text) || text.includes('//') || text.includes('@')) {
    if (!text.startsWith('https://')) return fail('Solo owner/repo o URLs https://github.com.');
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return fail('La URL no es válida.');
    }
    if (url.hostname !== 'github.com' || url.port !== '') return fail('Solo se admite github.com.');
    if (url.username !== '' || url.password !== '')
      return fail('La URL no puede llevar credenciales.');
    if (url.search !== '' || url.hash !== '')
      return fail('La URL no puede llevar query ni fragmento.');
    path = url.pathname.slice(1);
  }

  const parts = path.split('/');
  if (parts.at(-1) === '') parts.pop();
  const [owner, rawRepo] = parts;
  if (parts.length !== 2 || !owner || !rawRepo)
    return fail('Tiene que ser exactamente owner/repo.');
  const repo = rawRepo.endsWith('.git') ? rawRepo.slice(0, -4) : rawRepo;
  if (!OWNER_RE.test(owner)) {
    return fail('El owner lleva hasta 39 letras, números o guiones, y no empieza con guion.');
  }
  if (!REPO_RE.test(repo)) {
    return fail('El repo lleva hasta 100 letras, números, puntos, guiones o guiones bajos.');
  }
  return { ok: true, slug: `${owner}/${repo}` };
}
