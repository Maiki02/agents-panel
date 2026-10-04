import type { FastifyReply, FastifyRequest } from 'fastify';
import type { LoginAudit } from './attempts.js';
import { LOCK_MS, MAX_FAILED_ATTEMPTS } from './routes.js';
import type { SecondFactorRepository } from './totp.js';
import type { UserRepository } from './users.js';

/** Distinct from `unauthorized` so the web can tell a wrong code from an expired session. */
export const INVALID_TOTP = { error: 'invalid_totp' } as const;

const TOTP_RE = /^\d{6}$/;

export interface ReauthDeps {
  users: UserRepository;
  secondFactor: SecondFactorRepository;
  audit: LoginAudit;
  now: () => number;
}

/**
 * Asks for a fresh TOTP on top of the session before high-impact actions (.env files,
 * Kyro updates). Recovery codes are not accepted. Failures share the login lockout,
 * and a code already used (for login or a previous re-auth) is rejected.
 */
export class ReauthVerifier {
  constructor(private readonly deps: ReauthDeps) {}

  /** Returns true if the code is valid; otherwise it has already sent the 401. */
  verify(request: FastifyRequest, reply: FastifyReply, code: unknown): boolean {
    const { users, secondFactor, audit, now } = this.deps;
    const user = request.session ? users.findById(request.session.userId) : undefined;
    if (!user) {
      void reply.code(401).send({ error: 'unauthorized' });
      return false;
    }

    const record = (success: boolean, reason?: string): void => {
      audit.record({
        username: user.username,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        step: 'reauth',
        success,
        reason,
      });
    };

    if (users.isLocked(user, now())) {
      record(false, 'locked');
      void reply.code(401).send(INVALID_TOTP);
      return false;
    }

    const text = typeof code === 'string' ? code.trim() : '';
    let reason: string | undefined;
    if (text === '') reason = 'missing_code';
    else if (!TOTP_RE.test(text)) reason = 'bad_format';
    else if (!secondFactor.consumeTotp(user.id, text)) reason = 'bad_code';

    if (reason !== undefined) {
      users.registerFailure(user.id, now(), MAX_FAILED_ATTEMPTS, LOCK_MS);
      record(false, reason);
      void reply.code(401).send(INVALID_TOTP);
      return false;
    }

    users.clearFailures(user.id);
    record(true);
    return true;
  }
}
