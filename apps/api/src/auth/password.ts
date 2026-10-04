import { hash, verify, type Algorithm } from '@node-rs/argon2';

// Algorithm is an ambient const enum, unusable under verbatimModuleSyntax; 2 is Argon2id.
const ARGON2ID = 2 as unknown as Algorithm;

export const MIN_PASSWORD_LENGTH = 14;

// OWASP minimum for Argon2id: m=19 MiB, t=2, p=1.
export interface Argon2Params {
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

export const DEFAULT_ARGON2_PARAMS: Argon2Params = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export class PasswordPolicyError extends Error {
  override readonly name = 'PasswordPolicyError';
}

export function assertPasswordPolicy(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(
      `Password must be at least ${String(MIN_PASSWORD_LENGTH)} characters`,
    );
  }
}

export async function hashPassword(
  password: string,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): Promise<string> {
  assertPasswordPolicy(password);
  return hash(password, { ...params, algorithm: ARGON2ID });
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Verifies against a throwaway hash so unknown users cost the same as known ones,
 * which avoids leaking which usernames exist through response timing.
 */
export async function verifyDummy(password: string): Promise<false> {
  dummyHash ??= hash('dummy-password-for-timing-only', {
    ...DEFAULT_ARGON2_PARAMS,
    algorithm: ARGON2ID,
  });
  await verifyPassword(await dummyHash, password);
  return false;
}
