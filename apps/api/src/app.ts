import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { HealthResponse } from '@agents-panel/shared';
import { LoginAudit } from './auth/attempts.js';
import { ChallengeService } from './auth/challenge.js';
import { AgentManager } from './agent/manager.js';
import type { AgentRunner } from './agent/runner.js';
import { SdkRunner } from './agent/sdk-runner.js';
import { ChatEventBus } from './chats/events.js';
import { ChatRepository } from './chats/repo.js';
import { registerChatRoutes } from './chats/routes.js';
import { registerStreamRoute } from './chats/stream.js';
import { ChatService } from './chats/service.js';
import { registerGuard } from './auth/guard.js';
import { registerAuthRoutes } from './auth/routes.js';
import { SessionService } from './auth/sessions.js';
import { SecondFactorRepository } from './auth/totp.js';
import {
  MAX_BODY_BYTES,
  registerCsrfCheck,
  registerHeaders,
  registerOriginCheck,
} from './auth/security.js';
import { ProjectRepository } from './projects/repo.js';
import { registerProjectRoutes } from './projects/routes.js';
import { UserRepository } from './auth/users.js';
import type { Config } from './config.js';
import type { Db } from './db/index.js';

export const APP_VERSION = '0.0.0';

export interface AppDeps {
  config: Config;
  db: Db;
  now?: () => number;
  /** Agent backend; tests inject a fake, production uses the Claude Agent SDK. */
  runner?: AgentRunner;
  /** Shared with the agent manager; tests can inject their own to publish events. */
  bus?: ChatEventBus;
  heartbeatMs?: number;
}

export function buildApp(deps: AppDeps, options: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify({ bodyLimit: MAX_BODY_BYTES, ...options });
  const sessions = new SessionService(
    deps.db,
    {
      idleTtlSeconds: deps.config.sessionIdleTtlSeconds,
      absoluteTtlSeconds: deps.config.sessionAbsoluteTtlSeconds,
    },
    deps.now,
  );
  const users = new UserRepository(deps.db);

  const now = deps.now ?? Date.now;
  const challenges = new ChallengeService(deps.config.secretKey, now);
  const secondFactor = new SecondFactorRepository(deps.db, deps.config.secretKey, now);
  const audit = new LoginAudit(deps.db, now);

  void app.register(cookie);
  void app.register(rateLimit, { global: false });
  registerHeaders(app);
  registerOriginCheck(app, deps.config.origin);
  registerGuard(app, sessions);
  registerCsrfCheck(app);

  // Public allowlist (documented in docs/plan.md): health check and the login steps.
  app.get('/api/health', { config: { public: true } }, (): HealthResponse => ({
    status: 'ok',
    version: APP_VERSION,
  }));

  // Registered as a plugin so it loads after cookie and rate-limit (avvio keeps registration order).
  void app.register((instance) => {
    registerAuthRoutes(instance, {
      sessions,
      users,
      challenges,
      secondFactor,
      audit,
      now,
      sessionMaxAgeSeconds: deps.config.sessionAbsoluteTtlSeconds,
    });
  });

  const projects = new ProjectRepository(deps.db, now);
  const chats = new ChatRepository(deps.db, now);
  const bus = deps.bus ?? new ChatEventBus();
  const manager = new AgentManager(chats, deps.runner ?? new SdkRunner(), bus);
  // Nothing survives a restart: sessions that were running when the server stopped are interrupted.
  chats.markRunningAsInterrupted();
  const chatService = new ChatService({
    chats,
    projects,
    manager,
    worktreesDir: deps.config.worktreesDir,
  });

  registerProjectRoutes(app, projects);
  registerChatRoutes(app, { chats, service: chatService });
  registerStreamRoute(app, {
    chats,
    bus,
    ...(deps.heartbeatMs === undefined ? {} : { heartbeatMs: deps.heartbeatMs }),
  });

  return app;
}
