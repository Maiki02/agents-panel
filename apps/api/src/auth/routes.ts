import type { FastifyInstance, FastifyRequest } from 'fastify';
import { LoginAudit, type AttemptStep } from './attempts.js';
import { ChallengeService, MFA_COOKIE, MFA_TTL_SECONDS } from './challenge.js';
import type { SecondFactorRepository } from './totp.js';
import { SESSION_COOKIE, type SessionService, cookieOptions } from './sessions.js';
import type { UserRepository } from './users.js';

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MS = 15 * 60 * 1000;
export const AUTH_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;

export interface AuthDeps {
  sessions: SessionService;
  users: UserRepository;
  challenges: ChallengeService;
  secondFactor: SecondFactorRepository;
  sessionMaxAgeSeconds: number;
  audit: LoginAudit;
  now: () => number;
}

const INVALID = { error: 'invalid_credentials' } as const;

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { sessions, users, challenges, secondFactor, audit, now } = deps;

  function log(
    request: FastifyRequest,
    username: string,
    step: AttemptStep,
    success: boolean,
    reason?: string,
  ): void {
    audit.record({
      username,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      step,
      success,
      reason,
    });
  }

  app.post<{ Body: { username: string; password: string } }>(
    '/api/auth/login',
    {
      config: { public: true, rateLimit: AUTH_RATE_LIMIT },
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          additionalProperties: false,
          properties: {
            username: { type: 'string', minLength: 1, maxLength: 100 },
            password: { type: 'string', minLength: 1, maxLength: 1024 },
          },
        },
      },
    },
    async (request, reply) => {
      const { username, password } = request.body;
      const existing = users.findByUsername(username);

      if (existing && users.isLocked(existing, now())) {
        // Same cost and same answer as a wrong password; only the audit log knows why.
        await users.verifyCredentials(username, password);
        log(request, username, 'password', false, 'locked');
        return reply.code(401).send(INVALID);
      }

      const user = await users.verifyCredentials(username, password);
      if (!user) {
        if (existing) users.registerFailure(existing.id, now(), MAX_FAILED_ATTEMPTS, LOCK_MS);
        log(request, username, 'password', false, existing ? 'bad_password' : 'unknown_user');
        return reply.code(401).send(INVALID);
      }

      // Password is right, but no session yet: the second factor is still pending.
      log(request, username, 'password', true);
      void reply.setCookie(MFA_COOKIE, challenges.issue(user.id), cookieOptions(MFA_TTL_SECONDS));
      return { mfaRequired: true };
    },
  );

  app.post<{ Body: { code: string } }>(
    '/api/auth/totp',
    {
      config: { public: true, rateLimit: AUTH_RATE_LIMIT },
      schema: {
        body: {
          type: 'object',
          required: ['code'],
          additionalProperties: false,
          properties: { code: { type: 'string', minLength: 1, maxLength: 32 } },
        },
      },
    },
    (request, reply) => {
      const userId = challenges.verify(request.cookies[MFA_COOKIE]);
      const user = userId === undefined ? undefined : users.findById(userId);
      if (!user) return reply.code(401).send({ error: 'unauthorized' });

      const code = request.body.code.trim();
      const isTotpShape = /^\d{6}$/.test(code);
      const step: AttemptStep = isTotpShape ? 'totp' : 'recovery';

      if (users.isLocked(user, now())) {
        log(request, user.username, step, false, 'locked');
        return reply.code(401).send(INVALID);
      }

      const ok = isTotpShape
        ? secondFactor.consumeTotp(user.id, code)
        : secondFactor.consumeRecoveryCode(user.id, code);
      if (!ok) {
        users.registerFailure(user.id, now(), MAX_FAILED_ATTEMPTS, LOCK_MS);
        log(request, user.username, step, false, 'bad_code');
        return reply.code(401).send(INVALID);
      }

      users.clearFailures(user.id);
      log(request, user.username, step, true);
      const session = sessions.create(user.id);
      void reply.clearCookie(MFA_COOKIE, cookieOptions());
      void reply.setCookie(SESSION_COOKIE, session.token, cookieOptions(deps.sessionMaxAgeSeconds));
      return { user: { id: user.id, username: user.username }, csrfToken: session.csrfToken };
    },
  );

  app.get('/api/auth/me', (request, reply) => {
    const session = request.session;
    const user = session ? users.findById(session.userId) : undefined;
    if (!session || !user) return reply.code(401).send({ error: 'unauthorized' });
    return { user: { id: user.id, username: user.username }, csrfToken: session.csrfToken };
  });

  app.post('/api/auth/logout', (request, reply) => {
    sessions.destroy(request.cookies[SESSION_COOKIE]);
    void reply.clearCookie(SESSION_COOKIE, cookieOptions());
    return { ok: true };
  });
}
