import { deriveKey, signPayload, verifyPayload } from './crypto.js';

export const MFA_COOKIE = '__Host-panel_mfa';
export const MFA_TTL_SECONDS = 5 * 60;

/** Short-lived proof that the password step passed. Signed and stateless, so it is not a session. */
export class ChallengeService {
  private readonly key: Buffer;

  constructor(
    secret: Buffer,
    private readonly now: () => number = Date.now,
  ) {
    this.key = deriveKey(secret, 'mfa-challenge');
  }

  issue(userId: number): string {
    return signPayload(this.key, { uid: userId, exp: this.now() + MFA_TTL_SECONDS * 1000 });
  }

  /** Returns the user id if the challenge is authentic and not expired. */
  verify(token: string | undefined): number | undefined {
    const payload = verifyPayload(this.key, token);
    if (typeof payload !== 'object' || payload === null) return undefined;
    const { uid, exp } = payload as { uid?: unknown; exp?: unknown };
    if (typeof uid !== 'number' || typeof exp !== 'number' || exp < this.now()) return undefined;
    return uid;
  }
}
