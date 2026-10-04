import { ProjectError } from '../projects/repo.js';

/**
 * An invalid .env path or content: HTTP 400. Messages never include the file's
 * text or values, only line numbers (R13 applies to errors too).
 */
export class EnvFileError extends ProjectError {
  override readonly name = 'EnvFileError';
}

export const ENV_PATH_MAX_LENGTH = 200;
export const ENV_CONTENT_MAX_BYTES = 64 * 1024;

const ENV_BASENAME_RE = /^\.env(\.[A-Za-z0-9_-]+)*$/;
const TEMPLATE_SUFFIXES = new Set(['example', 'sample', 'ejemplo', 'template']);
const ENV_LINE_RE = /^(?:export )?([A-Za-z_][A-Za-z0-9_]*)=/;

/**
 * Validates the relative path of a development .env inside a project
 * (`.env`, `backend/.env.local`, …) and returns it normalized.
 * Production files and templates are rejected.
 */
export function validateEnvPath(relPath: string): string {
  if (relPath.length === 0) throw new EnvFileError('La ruta del .env está vacía');
  if (relPath.length > ENV_PATH_MAX_LENGTH)
    throw new EnvFileError(`La ruta del .env supera los ${String(ENV_PATH_MAX_LENGTH)} caracteres`);
  if (relPath.includes('\0') || relPath.includes('\\'))
    throw new EnvFileError('La ruta del .env no puede contener "\\" ni caracteres nulos');
  if (relPath.startsWith('/')) throw new EnvFileError('La ruta del .env tiene que ser relativa');

  const segments = relPath.split('/');
  for (const segment of segments) {
    if (segment === '') throw new EnvFileError('La ruta del .env tiene segmentos vacíos');
    if (segment === '.' || segment === '..')
      throw new EnvFileError('La ruta del .env no puede contener "." ni ".."');
    if (segment === '.git')
      throw new EnvFileError('La ruta del .env no puede estar dentro de .git');
  }

  const basename = segments.at(-1) ?? '';
  if (!ENV_BASENAME_RE.test(basename))
    throw new EnvFileError(
      'El archivo tiene que llamarse .env o .env.<sufijo> (por ejemplo .env.local)',
    );
  if (basename.toLowerCase().includes('prod'))
    throw new EnvFileError('No se aceptan .env de producción');
  const suffix = basename.split('.').at(-1)?.toLowerCase() ?? '';
  if (TEMPLATE_SUFFIXES.has(suffix))
    throw new EnvFileError('No se aceptan plantillas de .env (example, sample, ejemplo, template)');

  return segments.join('/');
}

/**
 * Checks that `content` is a plain KEY=value .env (comments, blank lines,
 * optional `export ` prefix, LF or CRLF) and returns its unique key names in
 * order of appearance. Quoted multi-line values are not supported.
 */
export function parseEnvContent(content: string): string[] {
  if (Buffer.byteLength(content, 'utf8') > ENV_CONTENT_MAX_BYTES)
    throw new EnvFileError(`El .env supera los ${String(ENV_CONTENT_MAX_BYTES)} bytes`);
  if (content.includes('\0')) throw new EnvFileError('El .env contiene caracteres nulos');

  const keys = new Set<string>();
  const lines = content.split('\n');
  lines.forEach((rawLine, index) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const lineNumber = String(index + 1);
    if (line.includes('\r'))
      throw new EnvFileError(`Línea ${lineNumber}: final de línea inválido (se acepta LF o CRLF)`);
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    const match = ENV_LINE_RE.exec(line);
    if (!match?.[1]) throw new EnvFileError(`Línea ${lineNumber}: se esperaba CLAVE=valor`);
    keys.add(match[1]);
  });
  return [...keys];
}
