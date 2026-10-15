import compress from '@fastify/compress';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { HealthResponse } from '@agents-panel/shared';
import { LoginAudit } from './auth/attempts.js';
import { ChallengeService } from './auth/challenge.js';
import { AccountRepository } from './accounts/repo.js';
import { registerAccountRoutes } from './accounts/routes.js';
import { AccountService } from './accounts/service.js';
import { AgentManager } from './agent/manager.js';
import { DiskMonitor, type DiskMeter } from './capacity/disk.js';
import { readMemory } from './capacity/memory.js';
import { registerCapacityRoutes } from './capacity/routes.js';
import { KyroLock } from './maintenance/lock.js';
import { registerMaintenanceRoutes } from './maintenance/routes.js';
import { MaintenanceRunRepository } from './maintenance/runs.js';
import { KyroUpdater, type ScriptRunner } from './maintenance/updater.js';
import { PanelDeployer, RESTART_EXIT_CODE } from './maintenance/deployer.js';
import { KyroVersions, type Exec } from './maintenance/versions.js';
import type { AgentRunner } from './agent/runner.js';
import { SdkRunner } from './agent/sdk-runner.js';
import { AgentSessionRepository } from './chats/sessions-repo.js';
import { PanelStepRepository } from './chats/steps-repo.js';
import { UsageRepository } from './usage/repo.js';
import { registerUsageRoutes } from './usage/routes.js';
import { UsageService } from './usage/service.js';
import { readUsageWithSdk, type UsageReader } from './usage/sdk-usage.js';
import { registerAutopilotRoutes } from './pilot/routes.js';
import { PushNotifier } from './push/notifier.js';
import { registerPushRoutes } from './push/routes.js';
import { PushSubscriptionRepository } from './push/repo.js';
import { createWebPushSender, type PushSender } from './push/sender.js';
import { PushService } from './push/service.js';
import { Autopilot, type PilotKyro } from './pilot/autopilot.js';
import { AutopilotRunRepository } from './pilot/runs-repo.js';
import { ChatEventBus } from './chats/events.js';
import { QuestionRepository } from './chats/questions-repo.js';
import { ChatRepository } from './chats/repo.js';
import { KyroReader, type CommandRunner } from './kyro/reader.js';
import { WorktreeStateRepository } from './worktrees/state-repo.js';
import { WorktreeStateTracker, type KyroStateReader } from './worktrees/state-tracker.js';
import { scanIdeaDocuments, type IdeaScanner } from './chats/idea.js';
import { IdeaActions } from './chats/idea-actions.js';
import { DebtAcceptance } from './pilot/accept-debt.js';
import type { MergeGit, PilotGit, RepoGit } from './pilot/git-ops.js';
import type { PilotGh } from './pilot/github-cli.js';
import { PrLookup, type BranchPrs } from './pilot/pr-lookup.js';
import { PrWatcher, type PrStateReader } from './pilot/pr-watcher.js';
import { registerChatRoutes } from './chats/routes.js';
import { registerChatGitRoutes } from './chats/git-routes.js';
import { registerStepRoutes, StepService } from './chats/step-routes.js';
import { WorktreeOps } from './worktrees/ops.js';
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
import { ProjectRepoRepository } from './projects/repos-repo.js';
import { ProjectService } from './projects/service.js';
import { KyroBranchService } from './projects/kyro-branch.js';
import type { KyroInitializer } from './projects/service.js';
import { registerKyroBranchRoutes } from './projects/kyro-branch-routes.js';
import { ProjectDeleter } from './projects/delete.js';
import { registerDeleteRoutes } from './projects/delete-routes.js';
import { PullService } from './projects/pull.js';
import { registerPullRoutes } from './projects/pull-routes.js';
import { registerRepoRoutes } from './projects/repos-routes.js';
import { registerProjectRoutes } from './projects/routes.js';
import { KyroPendingCache } from './projects/kyro-pending-cache.js';
import { UserRepository } from './auth/users.js';
import { hasWebBuild, isWebRequest, registerWebStatic } from './web-static.js';
import type { Config } from './config.js';
import { AppFlags } from './db/flags.js';
import type { Db } from './db/index.js';

export const APP_VERSION = '0.0.0';

/** app_flags marker: the one-time `question_cancelled` event backfill already ran. */
const CANCELLED_EVENTS_BACKFILL = 'question_cancelled_backfill';

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
  /** The panel deploy: script, git reads and the restart; tests replace them. */
  panelDeploy?: { runner?: ScriptRunner; exec?: Exec; restart?: () => void };
  /** Replaces `kyro install` for the Kyro init branch (tests). */
  kyroInstaller?: KyroInitializer;
  /** Clones and registers projects; tests inject one with a fake cloner and wait on whenIdle(). */
  projectService?: ProjectService;
  /** Reads Kyro state after each turn; tests inject one backed by fixtures. */
  kyroReader?: KyroStateReader;
  /** Everything the pilot reads from Kyro; tests inject fixtures. */
  pilotKyro?: PilotKyro;
  /** Git operations of the pilot (the closing commit); tests replace them. */
  pilotGit?: PilotGit & MergeGit;
  /** `gh` of the merge phase; tests replace it so nothing calls GitHub. */
  pilotGh?: PilotGh;
  /** Lookup of the PRs of a finished work's branch; tests never call GitHub. */
  branchPrs?: BranchPrs;
  /** State of a PR in GitHub for the PR watcher; tests never call GitHub. */
  prState?: PrStateReader;
  /** Sends Web Push messages; tests inject a fake, production uses the VAPID keys of the config. */
  pushSender?: PushSender;
  /** Runs `kyro work create` when an idea is approved as a work; tests replace it. */
  kyroRunner?: CommandRunner;
  /** Home where the Claude accounts live (~/.claude, ~/.claude.json); tests use a temporary one. */
  accountsHome?: string;
  /** Measures folders for the disk view; tests inject a fake instead of running `du`. */
  diskMeter?: DiskMeter;
  /** Root of the proc filesystem for the RAM view; tests use a simulated one. */
  procRoot?: string;
  /** Reads the plan usage with a short SDK session; tests inject fixtures instead of a process. */
  usageReader?: UsageReader;
}

const COMPRESS_THRESHOLD_BYTES = 1024;
/** JSON, text (except event-stream), JS/CSS/HTML/SVG of the web; images and fonts are already packed. */
const COMPRESSIBLE =
  /^text\/(?!event-stream)|(?:\+|\/)json(?:;|$)|(?:\+|\/)xml(?:;|$)|^application\/(?:javascript|manifest\+json)/u;

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
  // JSON and the compiled web, from 1 KB up. The SSE stream is hijacked (it writes to the raw
  // response, never through onSend) and text/event-stream is excluded from the types anyway.
  // @fastify/compress hooks every route through `onRoute`, and many routes here are added straight
  // on `app` (not in a plugin), before a deferred `app.register` would load. So it is applied
  // synchronously: the plugin is a plain function and its hooks land on the root instance.
  compress(
    app,
    { threshold: COMPRESS_THRESHOLD_BYTES, customTypes: COMPRESSIBLE },
    () => undefined,
  );
  registerHeaders(app);
  registerOriginCheck(app, deps.config.allowedOrigins);
  const serveWeb = hasWebBuild(deps.config.webDir);
  registerGuard(app, sessions, (request) => serveWeb && isWebRequest(request));
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
  const ideaScanner: IdeaScanner = {
    scan: (chat) =>
      scanIdeaDocuments(chat.worktreePath, projects.findById(chat.projectId)?.baseBranch),
  };
  const tracker = new WorktreeStateTracker(worktreeState, kyroReader, ideaScanner, questions);
  const agentSessions = new AgentSessionRepository(deps.db, now);
  const panelSteps = new PanelStepRepository(deps.db, now);
  // A step the old process left open ended with the restart.
  panelSteps.closeOpen('interrupted');
  const accounts = new AccountService(new AccountRepository(deps.db, now), deps.accountsHome);
  const usageRepo = new UsageRepository(deps.db, now);
  const manager =
    deps.manager ??
    new AgentManager(
      chats,
      deps.runner ?? new SdkRunner(),
      bus,
      undefined,
      questions,
      agentSessions,
      tracker,
      (projectId) => projects.getBashExtras(projectId),
      () => accounts.activeForRun(),
      usageRepo,
    );
  // Nothing survives a restart: sessions that were running when the server stopped are interrupted
  // and the questions they were waiting on are cancelled (the resumed agent asks again).
  const interrupted = chats.listRunning();
  chats.markRunningAsInterrupted();
  tracker.markInterrupted(interrupted);
  // The web learns it from the event: without it the card of the dead question stays answerable.
  for (const question of questions.listPending()) {
    chats.appendEvent(question.chatId, 'question_cancelled', { questionId: question.id });
  }
  questions.cancelAllPending();
  // Questions cancelled by an older version left no event: give them one, once (a marker keeps the
  // startup from walking every event of every cancelled question again), so no chat keeps showing
  // an answer card for a question that can never be answered. Newer versions always leave the event.
  const flags = new AppFlags(deps.db, now);
  if (!flags.isSet(CANCELLED_EVENTS_BACKFILL)) {
    for (const question of questions.listCancelled()) {
      const hasEvent = chats
        .allEventsAfter(question.chatId, 0)
        .some(
          (event) =>
            event.type === 'question_cancelled' &&
            (event.payload as { questionId?: unknown }).questionId === question.id,
        );
      if (!hasEvent)
        chats.appendEvent(question.chatId, 'question_cancelled', { questionId: question.id });
    }
    flags.set(CANCELLED_EVENTS_BACKFILL);
  }
  const envFiles = new EnvFileRepository(deps.db, deps.config.secretKey, now);
  const projectRepos = new ProjectRepoRepository(deps.db, now);
  // The single action service (D26): the pilot and the git routes both go through it.
  const worktreeOps = new WorktreeOps({
    chats,
    projects,
    projectRepos,
    manager,
    autopilot: autopilotRuns,
    state: worktreeState,
    envFiles,
    kyro: deps.pilotKyro ?? realKyro,
    // The injected fakes of the tests only implement what the pilot uses.
    ...(deps.pilotGit ? { git: deps.pilotGit as PilotGit & MergeGit & RepoGit } : {}),
    ...(deps.pilotGh ? { gh: deps.pilotGh } : {}),
  });
  const pilot = new Autopilot({
    actions: worktreeOps,
    chats,
    runs: autopilotRuns,
    manager,
    kyro: deps.pilotKyro ?? realKyro,
    tracker,
    questions,
    sessions: agentSessions,
    steps: panelSteps,
    usage: usageRepo,
    ...(deps.pilotGit ? { git: deps.pilotGit } : {}),
    projectOf: (chat) => projects.findById(chat.projectId),
    validateTimeoutMs: deps.config.pilotValidateTimeoutMs,
    ...(deps.pilotGh ? { gh: deps.pilotGh } : {}),
    maxSessionsPerSprint: deps.config.pilotMaxSessionsPerSprint,
    now,
  });
  const chatService = new ChatService({
    chats,
    projects,
    manager,
    questions,
    worktreesDir: deps.config.worktreesDir,
    envFiles,
    tracker,
    steps: panelSteps,
    states: worktreeState,
    autopilot: autopilotRuns,
    onAutopilotStart: (chatId) => {
      pilot.kick(chatId);
    },
  });

  const runs = new MaintenanceRunRepository(deps.db, now);
  const kyroVersions = deps.kyroVersions ?? new KyroVersions();
  const kyroPending = new KyroPendingCache({ now });
  const kyroUpdater = new KyroUpdater({
    manager,
    runs,
    onFinished: () => {
      kyroPending.invalidate();
    },
    versions: kyroVersions,
    projects,
    lock: kyroLock,
    scriptPath: deps.config.kyroUpdateScript,
    ...(deps.kyroScriptRunner ? { runner: deps.kyroScriptRunner } : {}),
  });

  const panelDeployer = new PanelDeployer({
    manager,
    runs,
    pilots: autopilotRuns,
    repoPath: deps.config.panelRepo,
    scriptPath: deps.config.panelDeployScript,
    selfDeploy: deps.config.selfDeploy,
    restart:
      deps.panelDeploy?.restart ??
      (() => {
        // systemd starts the new build (Restart=on-failure); closing first ends streams cleanly.
        app.log.info('Deploy listo: el panel se reinicia');
        void app.close().finally(() => process.exit(RESTART_EXIT_CODE));
      }),
    now,
    ...(deps.panelDeploy?.runner ? { runner: deps.panelDeploy.runner } : {}),
    ...(deps.panelDeploy?.exec ? { exec: deps.panelDeploy.exec } : {}),
  });

  const projectService =
    deps.projectService ??
    new ProjectService({
      repo: projects,
      config: deps.config,
      kyroLock,
      projectRepos,
    });
  // Clones that were running when the server stopped can never finish: mark them as errors.
  app.addHook('onReady', async () => {
    await projectService.recoverInterrupted();
    // The pilots that were moving pick up where they were (after the restart marked their chats).
    pilot.resumeAll();
    // Same for Kyro updates: a run left 'running' by a restart can never finish.
    runs.failInterrupted();
    await panelDeployer.init();
    // First values of Versiones, without holding the start.
    // Only in the real service: tests must not spawn `kyro` or reach npm just by starting.
    if (deps.config.selfDeploy) kyroVersions.warm();
  });
  // A pull, a Kyro init or a git action (commit) can change the Kyro state of a clone.
  app.addHook('onResponse', (request, _reply, done) => {
    const path = request.url.split('?')[0] ?? '';
    if (request.method !== 'GET' && (path.startsWith('/api/projects/') || path.includes('/git/'))) {
      kyroPending.invalidate();
    }
    done();
  });

  const disk = new DiskMonitor({
    projects: () => projects.list(),
    projectsDir: deps.config.projectsDir,
    worktreesDir: deps.config.worktreesDir,
    ...(deps.diskMeter ? { meter: deps.diskMeter } : {}),
    now,
    log: (message) => {
      app.log.warn(message);
    },
  });
  app.addHook('onReady', () => {
    disk.start();
  });
  app.addHook('onClose', () => {
    disk.stop();
  });
  registerCapacityRoutes(app, {
    disk,
    memory: () =>
      readMemory({
        worktreesDir: deps.config.worktreesDir,
        ...(deps.procRoot ? { procRoot: deps.procRoot } : {}),
        now,
        log: (message) => {
          app.log.error(message);
        },
      }),
  });

  registerProjectRoutes(app, { projects, service: projectService, kyroPending });
  registerRepoRoutes(app, { projects, repos: projectRepos });
  registerPullRoutes(app, { service: new PullService({ projects, manager, projectRepos }) });
  const reauth = new ReauthVerifier({ users, secondFactor, audit, now });
  // A plugin, like the auth routes, so the per-route rate limit applies.
  const kyroBranch = new KyroBranchService({
    projects,
    worktreesDir: deps.config.worktreesDir,
    kyroLock,
    manager,
    ...(deps.kyroInstaller ? { installer: deps.kyroInstaller } : {}),
    ...(deps.pilotGit ? { git: deps.pilotGit } : {}),
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
      // The lock is shared: a panel deploy is not a Kyro update.
      isUpdating: () => manager.inMaintenance && !panelDeployer.deployRunning,
      deployer: panelDeployer,
    });
  });
  const ideaActions = new IdeaActions({
    chats,
    states: worktreeState,
    manager,
    runs: autopilotRuns,
    scanner: ideaScanner,
    usernameOf: (userId) => users.findById(userId)?.username,
    onApproved: (chatId) => {
      pilot.kick(chatId);
    },
    ...(deps.kyroRunner ? { run: deps.kyroRunner } : {}),
  });
  registerChatRoutes(app, {
    chats,
    service: chatService,
    worktreeState,
    ideas: ideaScanner,
    ideaActions,
  });
  // A plugin: its own error handler maps the git operation errors without touching the others.
  void app.register((instance) => {
    registerChatGitRoutes(instance, { ops: worktreeOps });
  });
  void app.register((instance) => {
    registerStepRoutes(instance, {
      steps: new StepService({
        chats,
        projects,
        manager,
        kyro: deps.pilotKyro ?? realKyro,
        ops: worktreeOps,
        states: worktreeState,
      }),
    });
  });
  const prLookup = new PrLookup({
    runs: autopilotRuns,
    states: worktreeState,
    projects,
    ...(deps.branchPrs ? { prsOf: deps.branchPrs } : {}),
  });
  // Follows the open PRs of the finished works until GitHub reports them merged (or closed).
  const prWatcher = new PrWatcher({
    chats,
    states: worktreeState,
    projects,
    prs: prLookup,
    ...(deps.prState ? { prState: deps.prState } : {}),
    log: (message) => {
      app.log.warn(message);
    },
  });
  app.addHook('onReady', () => {
    prWatcher.start(deps.config.pilotPrPollMs);
    return Promise.resolve();
  });
  app.addHook('onClose', () => {
    prWatcher.stop();
  });
  registerAutopilotRoutes(app, {
    service: chatService,
    states: worktreeState,
    runs: autopilotRuns,
    maxSessionsPerSprint: deps.config.pilotMaxSessionsPerSprint,
    prs: prLookup,
    prWatcher,
    onResume: (chatId) => {
      // The user resumed or switched it on: a task Kyro holds as blocked is unblocked once.
      pilot.resumeByUser(chatId);
    },
    debt: new DebtAcceptance({
      service: chatService,
      states: worktreeState,
      runs: autopilotRuns,
      kyro: deps.pilotKyro ?? realKyro,
      ...(deps.pilotGit ? { git: deps.pilotGit } : {}),
      usernameOf: (userId) => users.findById(userId)?.username,
      onResume: (chatId) => {
        pilot.kick(chatId);
      },
    }),
  });
  const pushSubscriptions = new PushSubscriptionRepository(deps.db, now);
  // Push is on only with VAPID keys in the config; the sender is replaceable for the tests.
  const vapid = deps.config.pushVapid;
  const push = new PushService(
    pushSubscriptions,
    vapid ? (deps.pushSender ?? createWebPushSender(vapid)) : null,
    vapid?.publicKey ?? null,
  );
  const notifier = new PushNotifier({
    bus,
    chats,
    states: worktreeState,
    push,
    log: (message) => {
      app.log.warn(message);
    },
  });
  notifier.start();
  app.addHook('onClose', () => {
    notifier.close();
  });
  registerPushRoutes(app, { push, subscriptions: pushSubscriptions });
  registerAccountRoutes(app, accounts);
  registerUsageRoutes(app, {
    usage: new UsageService(usageRepo, deps.usageReader ?? readUsageWithSdk, now),
    activeAccount: () => accounts.activeForRun(),
  });
  registerStreamRoute(app, {
    chats,
    bus,
    ...(deps.heartbeatMs === undefined ? {} : { heartbeatMs: deps.heartbeatMs }),
  });

  // Last: the not-found handler must not hide any route.
  registerWebStatic(app, deps.config.webDir);

  return app;
}
