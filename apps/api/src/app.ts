import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { HealthResponse } from '@agents-panel/shared';
import { LoginAudit } from './auth/attempts.js';
import { ChallengeService } from './auth/challenge.js';
import { AgentManager } from './agent/manager.js';
import { KyroLock } from './maintenance/lock.js';
import { registerMaintenanceRoutes } from './maintenance/routes.js';
import { MaintenanceRunRepository } from './maintenance/runs.js';
import { KyroUpdater, type ScriptRunner } from './maintenance/updater.js';
import { KyroVersions } from './maintenance/versions.js';
import type { AgentRunner } from './agent/runner.js';
import { SdkRunner } from './agent/sdk-runner.js';
import { AgentSessionRepository } from './chats/sessions-repo.js';
import { registerAutopilotRoutes } from './pilot/routes.js';
import { Autopilot, type PilotKyro } from './pilot/autopilot.js';
import { AutopilotRunRepository } from './pilot/runs-repo.js';
import { ChatEventBus } from './chats/events.js';
import { QuestionRepository } from './chats/questions-repo.js';
import { ChatRepository } from './chats/repo.js';
import { KyroReader } from './kyro/reader.js';
import { WorktreeStateRepository } from './worktrees/state-repo.js';
import { WorktreeStateTracker, type KyroStateReader } from './worktrees/state-tracker.js';
import { registerChatRoutes } from './chats/routes.js';
import { registerStreamRoute } from './chats/stream.js';
import { ChatService } from './chats/service.js';
import { registerGuard } from './auth/guard.js';
import { registerPermissionRoutes } from './projects/permissions-routes.js';
import { ReauthVerifier } from './auth/reauth.js';
import { registerAuthRoutes } from './auth/routes.js';
import { SessionService } from './auth/sessions.js';
import { SecondFactorRepository } from './auth/totp.js';
import {
  MAX_BODY_BYTES,
  registerCsrfCheck,
  registerHeaders,
  registerOriginCheck,
} from './auth/security.js';
import { EnvFileRepository } from './env-files/repo.js';
import { registerEnvFileRoutes } from './env-files/routes.js';
import { ProjectRepository } from './projects/repo.js';
import { ProjectService } from './projects/service.js';
import { KyroBranchService } from './projects/kyro-branch.js';
import type { KyroInitializer } from './projects/service.js';
import { registerKyroBranchRoutes } from './projects/kyro-branch-routes.js';
import { ProjectDeleter } from './projects/delete.js';
import { registerDeleteRoutes } from './projects/delete-routes.js';
import { PullService } from './projects/pull.js';
import { registerPullRoutes } from './projects/pull-routes.js';
import { registerProjectRoutes } from './projects/routes.js';
import { UserRepository } from './auth/users.js';
import type { Config } from './config.js';
import type { Db } from './db/index.js';

export const APP_VERSION = '0.0.0';

/**
 * Logger options shared by main.ts and the tests. A .env body must never reach the logs,
 * even if a request body or an object holding it gets logged.
 */
export const LOGGER_OPTIONS: { level: string; redact: { paths: string[]; censor: string } } = {
  level: 'info',
  redact: {
    paths: ['req.body.content', 'body.content', 'content'],
    censor: '[redacted]',
  },
};

export interface AppDeps {
  config: Config;
  db: Db;
  now?: () => number;
  /** Agent backend; tests inject a fake, production uses the Claude Agent SDK. */
  runner?: AgentRunner;
  /** Shared with the agent manager; tests can inject their own to publish events. */
  bus?: ChatEventBus;
  heartbeatMs?: number;
  /** Tests inject the manager to drive the maintenance lock; production builds its own. */
  manager?: AgentManager;
  /** Reads the installed and latest Kyro versions; tests inject fixed ones. */
  kyroVersions?: KyroVersions;
  /** Runs the Kyro update script; tests inject a fake instead of touching the VM. */
  kyroScriptRunner?: ScriptRunner;
  /** Replaces `kyro install` for the Kyro init branch (tests). */
  kyroInstaller?: KyroInitializer;
  /** Clones and registers projects; tests inject one with a fake cloner and wait on whenIdle(). */
  projectService?: ProjectService;
  /** Reads Kyro state after each turn; tests inject one backed by fixtures. */
  kyroReader?: KyroStateReader;
  /** Everything the pilot reads from Kyro; tests inject fixtures. */
  pilotKyro?: PilotKyro;
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

  // One lock for `kyro install` (project registration) and `kyro update` (Versiones).
  const kyroLock = new KyroLock();
  const projects = new ProjectRepository(deps.db, now);
  const chats = new ChatRepository(deps.db, now);
  const bus = deps.bus ?? new ChatEventBus();
  const questions = new QuestionRepository(deps.db, now);
  const autopilotRuns = new AutopilotRunRepository(deps.db, now);
  const worktreeState = new WorktreeStateRepository(deps.db, chats, bus, now);
  const realKyro = new KyroReader();
  const kyroReader = deps.kyroReader ?? realKyro;
  const tracker = new WorktreeStateTracker(worktreeState, kyroReader);
  const manager =
    deps.manager ??
    new AgentManager(
      chats,
      deps.runner ?? new SdkRunner(),
      bus,
      undefined,
      questions,
      new AgentSessionRepository(deps.db, now),
      tracker,
      (projectId) => projects.getBashExtras(projectId),
    );
  // Nothing survives a restart: sessions that were running when the server stopped are interrupted
  // and the questions they were waiting on are cancelled (the resumed agent asks again).
  const interrupted = chats.listRunning();
  chats.markRunningAsInterrupted();
  tracker.markInterrupted(interrupted);
  questions.cancelAllPending();
  const pilot = new Autopilot({
    chats,
    runs: autopilotRuns,
    manager,
    kyro: deps.pilotKyro ?? realKyro,
    tracker,
    questions,
    maxSessionsPerSprint: deps.config.pilotMaxSessionsPerSprint,
    now,
  });
  const envFiles = new EnvFileRepository(deps.db, deps.config.secretKey, now);
  const chatService = new ChatService({
    chats,
    projects,
    manager,
    questions,
    worktreesDir: deps.config.worktreesDir,
    envFiles,
    tracker,
    autopilot: autopilotRuns,
    onAutopilotStart: (chatId) => {
      pilot.kick(chatId);
    },
  });

  const runs = new MaintenanceRunRepository(deps.db, now);
  const kyroVersions = deps.kyroVersions ?? new KyroVersions();
  const kyroUpdater = new KyroUpdater({
    manager,
    runs,
    versions: kyroVersions,
    projects,
    lock: kyroLock,
    scriptPath: deps.config.kyroUpdateScript,
    ...(deps.kyroScriptRunner ? { runner: deps.kyroScriptRunner } : {}),
  });

  const projectService =
    deps.projectService ?? new ProjectService({ repo: projects, config: deps.config, kyroLock });
  // Clones that were running when the server stopped can never finish: mark them as errors.
  app.addHook('onReady', async () => {
    await projectService.recoverInterrupted();
    // Same for Kyro updates: a run left 'running' by a restart can never finish.
    runs.failInterrupted();
  });

  registerProjectRoutes(app, { projects, service: projectService });
  registerPullRoutes(app, { service: new PullService({ projects, manager }) });
  const reauth = new ReauthVerifier({ users, secondFactor, audit, now });
  // A plugin, like the auth routes, so the per-route rate limit applies.
  const kyroBranch = new KyroBranchService({
    projects,
    worktreesDir: deps.config.worktreesDir,
    kyroLock,
    manager,
    ...(deps.kyroInstaller ? { installer: deps.kyroInstaller } : {}),
  });
  const projectDeleter = new ProjectDeleter({ projects, chats, manager, config: deps.config });
  void app.register((instance) => {
    registerDeleteRoutes(instance, { deleter: projectDeleter, reauth });
  });
  void app.register((instance) => {
    registerKyroBranchRoutes(instance, { service: kyroBranch, reauth });
  });
  void app.register((instance) => {
    registerEnvFileRoutes(instance, { projects, envFiles, reauth, chats });
    registerPermissionRoutes(instance, { projects, reauth });
  });
  void app.register((instance) => {
    registerMaintenanceRoutes(instance, {
      versions: kyroVersions,
      updater: kyroUpdater,
      runs,
      reauth,
      isUpdating: () => manager.inMaintenance,
    });
  });
  registerChatRoutes(app, {
    chats,
    service: chatService,
    worktreeState,
  });
  registerAutopilotRoutes(app, {
    service: chatService,
    runs: autopilotRuns,
    maxSessionsPerSprint: deps.config.pilotMaxSessionsPerSprint,
    onResume: (chatId) => {
      pilot.kick(chatId);
    },
  });
  registerStreamRoute(app, {
    chats,
    bus,
    ...(deps.heartbeatMs === undefined ? {} : { heartbeatMs: deps.heartbeatMs }),
  });

  return app;
}
