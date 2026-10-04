/** Client-side checks for a .env upload (R14). The API stays the authority and shows its own 400. */
export const ENV_MAX_BYTES = 64 * 1024;
const ENV_BASENAME_RE = /^\.env(\.[A-Za-z0-9_-]+)*$/;
const TEMPLATE_SUFFIXES = ['example', 'sample', 'ejemplo', 'template'];

/** Why a relative path cannot hold a development .env; null when the name is acceptable. */
export function envPathProblem(path: string): string | null {
  const value = path.trim();
  if (value === '') return 'Escribí la ruta del archivo, por ejemplo .env o backend/.env.';
  const basename = value.split('/').at(-1) ?? '';
  if (!ENV_BASENAME_RE.test(basename)) {
    return 'El nombre tiene que ser .env o .env.<sufijo> (por ejemplo .env.local).';
  }
  if (basename.toLowerCase().includes('prod')) return 'No se aceptan .env de producción.';
  const suffixes = basename.toLowerCase().split('.').slice(2);
  if (suffixes.some((part) => TEMPLATE_SUFFIXES.includes(part))) {
    return 'No se aceptan plantillas de .env (example, sample, ejemplo, template).';
  }
  return null;
}

export function envSizeProblem(content: string): string | null {
  return new TextEncoder().encode(content).length > ENV_MAX_BYTES
    ? 'El archivo supera los 64 KB.'
    : null;
}

export interface EnvDraft {
  path: string;
  content: string;
  applyToActive: boolean;
}

export const EMPTY_ENV_DRAFT: EnvDraft = { path: '', content: '', applyToActive: false };

/**
 * Runs `send` with the draft and always returns the draft without its content, whether the send
 * succeeded or failed: the content only lives in the local `draft` argument while it is sent.
 * The error is rethrown after cleaning so the caller can show it.
 */
export async function sendAndForget<T>(
  draft: EnvDraft,
  send: (draft: EnvDraft) => Promise<T>,
): Promise<{ draft: EnvDraft; result: T }> {
  const result = await send(draft);
  return { draft: { ...draft, content: '' }, result };
}

/** Same as `sendAndForget` for the failure path: the cleaned draft travels with the error. */
export class EnvSendError extends Error {
  constructor(
    readonly reason: unknown,
    readonly draft: EnvDraft,
  ) {
    super('env send failed');
  }
}

export async function trySend<T>(
  draft: EnvDraft,
  send: (draft: EnvDraft) => Promise<T>,
): Promise<{ draft: EnvDraft; result: T }> {
  try {
    return await sendAndForget(draft, send);
  } catch (cause) {
    throw new EnvSendError(cause, { ...draft, content: '' });
  }
}
