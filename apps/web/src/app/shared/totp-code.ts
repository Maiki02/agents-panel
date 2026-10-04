/** Keeps only digits, at most 6: what the code field may hold. */
export function sanitizeCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 6);
}

export function isCompleteCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}

/**
 * Takes the code out of the field to send it: returns it (or null when incomplete) and the value
 * the field must hold afterwards, always empty once a code was taken (R18: never kept).
 */
export function takeCode(code: string): { send: string | null; remaining: string } {
  return isCompleteCode(code) ? { send: code, remaining: '' } : { send: null, remaining: code };
}
