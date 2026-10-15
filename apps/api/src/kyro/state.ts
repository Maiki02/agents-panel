/**
 * Typed readers for the JSON that the Kyro CLI prints (`kyro context-pack --json`,
 * `kyro status full --json`, `kyro work status --json`) plus the roadmap and ledger of a scope's
 * `sprint.json`. The shapes were confirmed against the real output of Kyro 6.1.0; the fixtures
 * live in test/fixtures/kyro (regenerate them with capture.sh).
 *
 * The next step of a worktree is decided only from these fields (R7), never from agent text.
 */

export const SCOPE_NEXT_ACTIONS = [
  'init',
  'clarify',
  'plan_sprint',
  'await_scope_completion',
  'execute_task',
  'review_task',
  'qa_or_close',
  'close_sprint',
  'done',
] as const;
export type ScopeNextAction = (typeof SCOPE_NEXT_ACTIONS)[number];

export const WORK_NEXT_ACTIONS = [
  'plan_tasks',
  'execute_task',
  'review_task',
  'resolve_blocker',
  'ready_to_close',
  'done',
] as const;
export type WorkNextAction = (typeof WORK_NEXT_ACTIONS)[number];

export interface SprintProgress {
  /** Number of the active sprint; null when no sprint is active (planning or finished). */
  current: number | null;
  /** Sprints already closed (length of the ledger); null when the roadmap was not provided. */
  closed: number | null;
  /** plannedSprintCount of the roadmap; null when the roadmap was not provided. */
  total: number | null;
}

export interface TaskProgress {
  /** Tasks with a pass verdict (scope) or in a terminal state, verified or disposed (work). */
  done: number;
  total: number;
}

/** One open debt item of a scope (read from the `debt[]` of its `sprint.json`). */
export interface DebtItem {
  id: string;
  title: string;
  priority: string;
}

export interface KyroScopeState {
  kind: 'scope';
  scope: string;
  /** Lifecycle status of the scope: planning, active, completed… */
  status: string;
  nextAction: ScopeNextAction;
  nextTaskId: string | null;
  sprint: SprintProgress;
  tasks: TaskProgress;
  openDebt: number;
  pendingReview: number;
  /** Reason of every blocker the CLI reports for the route (empty when none). */
  blockers: string[];
  /** Tasks Kyro reports as blocked (after three correction rounds); empty when none. */
  blockedTasks?: string[];
  /** Debt not yet resolved, with its title and priority; empty when `sprint.json` was not read. */
  debtItems?: DebtItem[];
}

export interface KyroWorkState {
  kind: 'work';
  work: string;
  /** draft, active, closed… */
  status: string;
  revision: number;
  nextAction: WorkNextAction;
  nextTaskId: string | null;
  tasks: TaskProgress;
  blockedReason: string | null;
}

export class KyroStateError extends Error {
  constructor(message: string) {
    super(`Unexpected Kyro output: ${message}`);
    this.name = 'KyroStateError';
  }
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(obj: Json, key: string, where: string): unknown {
  if (!(key in obj)) throw new KyroStateError(`${where}.${key} is missing`);
  return obj[key];
}

function str(obj: Json, key: string, where: string): string {
  const value = field(obj, key, where);
  if (typeof value !== 'string') throw new KyroStateError(`${where}.${key} must be a string`);
  return value;
}

function nullableStr(obj: Json, key: string, where: string): string | null {
  const value = field(obj, key, where);
  if (value === null) return null;
  if (typeof value !== 'string')
    throw new KyroStateError(`${where}.${key} must be a string or null`);
  return value;
}

function int(obj: Json, key: string, where: string): number {
  const value = field(obj, key, where);
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new KyroStateError(`${where}.${key} must be a non-negative integer`);
  }
  return value;
}

function record(obj: Json, key: string, where: string): Json {
  const value = field(obj, key, where);
  if (!isRecord(value)) throw new KyroStateError(`${where}.${key} must be an object`);
  return value;
}

function strings(obj: Json, key: string, where: string): string[] {
  const value = field(obj, key, where);
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new KyroStateError(`${where}.${key} must be an array of strings`);
  }
  return value as string[];
}

function oneOf<T extends string>(value: string, allowed: readonly T[], where: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new KyroStateError(`${where} has unknown value "${value}"`);
  }
  return value as T;
}

/** Unwraps the `{ ok, command, data }` envelope every `--json` command prints. */
function envelopeData(raw: unknown, command: string): Json {
  if (!isRecord(raw)) throw new KyroStateError(`${command} output is not a JSON object`);
  const { ok, error, data } = raw;
  if (ok === false) {
    const detail = isRecord(error) ? error : {};
    const code = typeof detail['code'] === 'string' ? detail['code'] : 'unknown';
    const message = typeof detail['message'] === 'string' ? detail['message'] : '';
    throw new KyroStateError(`${command} failed (${code}): ${message}`);
  }
  if (ok !== true || !isRecord(data)) {
    throw new KyroStateError(`${command} output has no ok/data envelope`);
  }
  return data;
}

/** Debt of a scope that is not resolved yet: the user decides about it before the scope completes. */
export function parseOpenDebt(sprintJson: unknown): DebtItem[] {
  if (!isRecord(sprintJson) || !Array.isArray(sprintJson['debt'])) return [];
  const items: DebtItem[] = [];
  for (const entry of sprintJson['debt'] as unknown[]) {
    if (!isRecord(entry) || entry['status'] === 'resolved') continue;
    items.push({
      id: typeof entry['id'] === 'string' ? entry['id'] : '?',
      title: typeof entry['title'] === 'string' ? entry['title'] : '',
      priority: typeof entry['priority'] === 'string' ? entry['priority'] : 'medium',
    });
  }
  return items;
}

/** What a PR says about a scope: its title, objective and the sprints it closed. */
export interface ScopeSummary {
  title: string;
  objective: string;
  sprints: string[];
}

export function parseScopeSummary(sprintJson: unknown): ScopeSummary {
  if (!isRecord(sprintJson)) throw new KyroStateError('sprint.json is not a JSON object');
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const ledger = Array.isArray(sprintJson['ledger']) ? (sprintJson['ledger'] as unknown[]) : [];
  const sprints = ledger.map((entry, index) => {
    const item = isRecord(entry) ? entry : {};
    const n = typeof item['n'] === 'number' ? item['n'] : index + 1;
    return `Sprint ${String(n)}: ${text(item['title']) || text(item['slug']) || 'cerrado'}`;
  });
  return { title: text(sprintJson['title']), objective: text(sprintJson['objective']), sprints };
}

/** A task as the PR description shows it. `discarded` is the reason when the task was dropped. */
export interface PrTask {
  id: string;
  title: string;
  description: string;
  /** `evidence.summary`; empty when the task has no evidence. */
  summary: string;
  discarded: string | null;
}

/** A closed sprint of a scope with the tasks its archive snapshot holds. */
export interface PrSprint {
  n: number;
  title: string;
  tasks: PrTask[];
}

/** What the PR description of a work or scope is built from. Every field degrades to empty. */
export interface PrData {
  kind: 'work' | 'scope';
  /** Slug of the work or scope, the fallback for a missing title. */
  slug: string;
  title: string;
  objective: string;
  /** Tasks of a work. */
  tasks: PrTask[];
  /** Closed sprints of a scope. */
  sprints: PrSprint[];
}

const prText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** One task of work.json or of a sprint snapshot. Never throws. */
export function parsePrTask(raw: unknown): PrTask {
  const task = isRecord(raw) ? raw : {};
  const evidence = isRecord(task['evidence']) ? task['evidence'] : {};
  const disposition = task['disposition'];
  const status = prText(task['status']);
  let discarded: string | null = null;
  if (isRecord(disposition)) {
    discarded = prText(disposition['reason']) || prText(disposition['kind']) || 'sin motivo';
  } else if (['cancelled', 'superseded', 'disposed', 'discarded'].includes(status)) {
    discarded = 'sin motivo';
  }
  return {
    id: prText(task['id']) || '?',
    title: prText(task['title']),
    description: prText(task['description']),
    summary: prText(evidence['summary']),
    discarded,
  };
}

/** Title, objective and tasks of a work.json. */
export function parseWorkPrData(workJson: unknown, slug: string): PrData {
  const work = isRecord(workJson) ? workJson : {};
  const tasks = Array.isArray(work['tasks']) ? (work['tasks'] as unknown[]) : [];
  return {
    kind: 'work',
    slug,
    title: prText(work['title']),
    objective: prText(work['objective']),
    tasks: tasks.map(parsePrTask),
    sprints: [],
  };
}

/** Tasks of a sprint snapshot (`phases[].tasks[]`, or a flat `tasks[]`). Never throws. */
export function parseSnapshotTasks(snapshot: unknown): PrTask[] {
  if (!isRecord(snapshot)) return [];
  const raw: unknown[] = [];
  if (Array.isArray(snapshot['phases'])) {
    for (const phase of snapshot['phases'] as unknown[]) {
      if (isRecord(phase) && Array.isArray(phase['tasks']))
        raw.push(...(phase['tasks'] as unknown[]));
    }
  }
  if (Array.isArray(snapshot['tasks'])) raw.push(...(snapshot['tasks'] as unknown[]));
  return raw.map(parsePrTask);
}

/** `ledger[].snapshot` paths (relative to the scope folder) with their sprint number and slug. */
export function parseLedgerEntries(
  sprintJson: unknown,
): { n: number; title: string; snapshot: string | null }[] {
  const sprint = isRecord(sprintJson) ? sprintJson : {};
  const ledger = Array.isArray(sprint['ledger']) ? (sprint['ledger'] as unknown[]) : [];
  return ledger.map((entry, index) => {
    const item = isRecord(entry) ? entry : {};
    return {
      n: typeof item['n'] === 'number' ? item['n'] : index + 1,
      title: prText(item['title']) || prText(item['slug']),
      snapshot: prText(item['snapshot']) || null,
    };
  });
}

/** Roadmap total and closed sprints, read from the scope's `sprint.json` (no CLI prints them). */
export function parseSprintRoadmap(sprintJson: unknown): { total: number; closed: number } {
  if (!isRecord(sprintJson)) throw new KyroStateError('sprint.json is not a JSON object');
  const roadmap = record(sprintJson, 'roadmap', 'sprint.json');
  const total = int(roadmap, 'plannedSprintCount', 'sprint.json.roadmap');
  const ledger = field(sprintJson, 'ledger', 'sprint.json');
  if (!Array.isArray(ledger)) throw new KyroStateError('sprint.json.ledger must be an array');
  return { total, closed: ledger.length };
}

function blockerReasons(data: Json): string[] {
  const blockers = field(data, 'blockers', 'context-pack.data');
  if (!Array.isArray(blockers))
    throw new KyroStateError('context-pack.data.blockers must be an array');
  return blockers.map((blocker, index) => {
    if (!isRecord(blocker))
      throw new KyroStateError(`context-pack.data.blockers[${String(index)}] must be an object`);
    return str(blocker, 'reason', `context-pack.data.blockers[${String(index)}]`);
  });
}

/** `execution.blockedTasks` of the pack: ids of blocked tasks, `[]` when the field is absent. */
function blockedTaskIds(pack: Json): string[] {
  const execution = pack['execution'];
  if (!isRecord(execution)) return [];
  const blocked = execution['blockedTasks'];
  if (!Array.isArray(blocked)) return [];
  return blocked.map((entry) =>
    isRecord(entry) && typeof entry['taskId'] === 'string'
      ? entry['taskId']
      : typeof entry === 'string'
        ? entry
        : 'desconocida',
  );
}

/**
 * Scope state from `kyro context-pack --json` (routing) and `kyro status full --json` (progress).
 * Both must agree on nextAction; a mismatch means the state moved between the two reads.
 */
export function parseScopeState(
  contextPackJson: unknown,
  statusFullJson: unknown,
  sprintJson?: unknown,
): KyroScopeState {
  const pack = envelopeData(contextPackJson, 'kyro context-pack');
  const status = envelopeData(statusFullJson, 'kyro status');

  const nextAction = oneOf(
    str(pack, 'nextAction', 'context-pack.data'),
    SCOPE_NEXT_ACTIONS,
    'context-pack.data.nextAction',
  );
  const statusAction = str(status, 'nextAction', 'status.data');
  if (statusAction !== nextAction) {
    throw new KyroStateError(
      `context-pack says nextAction "${nextAction}" but status says "${statusAction}"`,
    );
  }

  const scope = str(pack, 'scope', 'context-pack.data');
  const activeSprint = field(status, 'activeSprint', 'status.data');
  if (activeSprint !== null && !isRecord(activeSprint)) {
    throw new KyroStateError('status.data.activeSprint must be an object or null');
  }
  const roadmap = sprintJson === undefined ? null : parseSprintRoadmap(sprintJson);
  const taskSummary = record(status, 'taskSummary', 'status.data');

  return {
    kind: 'scope',
    scope,
    status: str(pack, 'status', 'context-pack.data'),
    nextAction,
    nextTaskId: nullableStr(pack, 'nextTaskId', 'context-pack.data'),
    sprint: {
      current: activeSprint === null ? null : int(activeSprint, 'n', 'status.data.activeSprint'),
      closed: roadmap?.closed ?? null,
      total: roadmap?.total ?? null,
    },
    tasks: {
      done: int(taskSummary, 'verified', 'status.data.taskSummary'),
      total: int(taskSummary, 'total', 'status.data.taskSummary'),
    },
    openDebt: int(pack, 'openDebtCount', 'context-pack.data'),
    pendingReview: int(status, 'pendingReviewCount', 'status.data'),
    blockers: blockerReasons(pack),
    blockedTasks: blockedTaskIds(pack),
    debtItems: sprintJson === undefined ? [] : parseOpenDebt(sprintJson),
  };
}

/** Work state from `kyro work status --work <slug> --json`. */
export function parseWorkState(workStatusJson: unknown): KyroWorkState {
  const data = envelopeData(workStatusJson, 'kyro work status');
  const work = record(data, 'work', 'work-status.data');
  const summary = record(data, 'summary', 'work-status.data');
  const verified = strings(summary, 'verified', 'work-status.data.summary');
  const disposed = strings(summary, 'disposed', 'work-status.data.summary');
  const unresolved = strings(summary, 'unresolved', 'work-status.data.summary');

  return {
    kind: 'work',
    work: str(work, 'id', 'work-status.data.work'),
    status: str(work, 'state', 'work-status.data.work'),
    revision: int(work, 'revision', 'work-status.data.work'),
    nextAction: oneOf(
      str(data, 'nextAction', 'work-status.data'),
      WORK_NEXT_ACTIONS,
      'work-status.data.nextAction',
    ),
    nextTaskId: nullableStr(data, 'nextTaskId', 'work-status.data'),
    tasks: {
      done: verified.length + disposed.length,
      total: verified.length + disposed.length + unresolved.length,
    },
    blockedReason: nullableStr(data, 'blockedReason', 'work-status.data'),
  };
}

export interface TaskScenario {
  id: string;
  requirement: string;
  given: string;
  when: string;
  then: string;
}

/** What a session needs to work on one task, from `context-pack --task` or `work context-pack`. */
export interface KyroTaskContext {
  kind: 'scope' | 'work';
  /** Scope or work id. */
  name: string;
  nextAction: string;
  /** Slug and objective of the active sprint; null for a work or when no sprint is active. */
  sprintSlug: string | null;
  sprintObjective: string | null;
  taskId: string | null;
  title: string | null;
  description: string | null;
  files: string[];
  context: string | null;
  criteria: string[];
  scenarios: TaskScenario[];
  openDebt: number;
  conventions: string[];
}

function optionalStrings(obj: Json, key: string): string[] {
  const value = obj[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function optionalStr(obj: Json, key: string): string | null {
  const value = obj[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function conventionTexts(obj: Json): string[] {
  const value = obj['conventions'];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    if (isRecord(entry) && typeof entry['rule'] === 'string') return [entry['rule']];
    return [];
  });
}

function scenarioList(obj: Json): TaskScenario[] {
  const value = obj['taskScenarios'];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const text = (key: string) => (typeof entry[key] === 'string' ? entry[key] : '');
    return [
      {
        id: text('id'),
        requirement: text('requirement'),
        given: text('given'),
        when: text('when'),
        then: text('then'),
      },
    ];
  });
}

/** Task context of a scope from `kyro context-pack --kyro-scope <s> --task --verbosity detailed --json`. */
export function parseScopeTaskContext(contextPackTaskJson: unknown): KyroTaskContext {
  const pack = envelopeData(contextPackTaskJson, 'kyro context-pack --task');
  return {
    kind: 'scope',
    name: str(pack, 'scope', 'context-pack.data'),
    nextAction: str(pack, 'nextAction', 'context-pack.data'),
    sprintSlug: optionalStr(pack, 'activeSprintSlug'),
    sprintObjective: optionalStr(pack, 'activeSprintObjective'),
    taskId: optionalStr(pack, 'taskId'),
    title: optionalStr(pack, 'taskTitle'),
    description: optionalStr(pack, 'taskDescription'),
    files: optionalStrings(pack, 'taskFiles'),
    context: optionalStr(pack, 'taskContext'),
    criteria: optionalStrings(pack, 'taskAcceptanceCriteria'),
    scenarios: scenarioList(pack),
    openDebt: typeof pack['openDebtCount'] === 'number' ? pack['openDebtCount'] : 0,
    conventions: conventionTexts(pack),
  };
}

/** Task context of a work from `kyro work context-pack --work <w> --json`. */
export function parseWorkTaskContext(workContextPackJson: unknown): KyroTaskContext {
  const data = envelopeData(workContextPackJson, 'kyro work context-pack');
  const work = record(data, 'work', 'work-context-pack.data');
  const task = isRecord(data['task']) ? data['task'] : {};
  return {
    kind: 'work',
    name: str(work, 'id', 'work-context-pack.data.work'),
    nextAction: str(data, 'nextAction', 'work-context-pack.data'),
    sprintSlug: null,
    sprintObjective: null,
    taskId: optionalStr(data, 'nextTaskId'),
    title: optionalStr(task, 'title'),
    description: optionalStr(task, 'description'),
    files: optionalStrings(task, 'filesToTouch'),
    context: optionalStr(task, 'context'),
    criteria: optionalStrings(task, 'acceptanceCriteria'),
    scenarios: [],
    openDebt: 0,
    conventions: [],
  };
}

/** Verbs of the installed CLI from `kyro capabilities --json`. */
export function parseCapabilities(capabilitiesJson: unknown): string[] {
  const data = envelopeData(capabilitiesJson, 'kyro capabilities');
  return strings(data, 'capabilities', 'capabilities.data');
}

export interface AnalyzeFinding {
  id: string;
  severity: string;
  category: string;
  detail: string;
  remedy: string;
}

/** Findings of `kyro analyze --kyro-scope <s> --json`. */
export function parseAnalyzeFindings(analyzeJson: unknown): AnalyzeFinding[] {
  const data = envelopeData(analyzeJson, 'kyro analyze');
  const findings = field(data, 'findings', 'analyze.data');
  if (!Array.isArray(findings)) throw new KyroStateError('analyze.data.findings must be an array');
  return findings.map((finding, index) => {
    if (!isRecord(finding))
      throw new KyroStateError(`analyze.data.findings[${String(index)}] must be an object`);
    const where = `analyze.data.findings[${String(index)}]`;
    return {
      id: str(finding, 'id', where),
      severity: str(finding, 'severity', where).toUpperCase(),
      category: str(finding, 'category', where),
      detail: str(finding, 'detail', where),
      remedy: typeof finding['remedy'] === 'string' ? finding['remedy'] : '',
    };
  });
}
