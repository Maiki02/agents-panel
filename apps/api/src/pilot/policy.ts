/**
 * Gates policy the panel injects in every pilot session (R16). Kyro is not modified (`kyro update`
 * overwrites its runtime), so the routine gates are pre-approved by text. The agent text is in
 * English, like the tested draft of spike H2 in docs/plan.md; messages for the user are Spanish.
 */

/** Bump it when any clause changes: every pilot session records the version it ran with. */
export const POLICY_VERSION = 1;

/** The kinds of session the pilot opens: planning, execution of a sprint, and closing it. */
export type PolicyStep = 'plan' | 'execute' | 'close';
export const POLICY_STEPS: readonly PolicyStep[] = ['plan', 'execute', 'close'];

/**
 * What the pilot does at a gate: `proceed` (the policy pre-approves it), `stop` (this session ends
 * and the orchestrator or the user takes over) or `ask` (the user decides; also what an unknown
 * gate gets, so a gate the policy does not cover is never skipped).
 */
export type GateDecision = 'proceed' | 'stop' | 'ask';

export interface PolicyGate {
  /** Word the clause text must contain, so the test can tell the gate is mentioned. */
  keyword: string;
  decision: GateDecision;
  /** Steps whose text carries the clause. */
  steps: readonly PolicyStep[];
  clause: string;
}

const ALL_STEPS = POLICY_STEPS;

/** Every gate of Kyro (and of the pilot) the policy knows. A new gate not listed here ends in a question. */
export const KNOWN_GATES = {
  execute_task: {
    keyword: 'execute_task',
    decision: 'proceed',
    steps: ['execute'],
    clause:
      'When nextAction is execute_task: implement only the task it routes, run its validations and record evidence with "kyro record-evidence". Do not ask which task to do or whether to continue.',
  },
  review_task: {
    keyword: 'review_task',
    decision: 'proceed',
    steps: ['execute'],
    clause:
      'When nextAction is review_task: review it yourself in this session with "kyro review --verdict pass|fail --yes". The maker and the checker must be different actors: pass --by with a name different from the one used in "kyro record-evidence" (for example --by checker-agent). Never ask the user whether to review.',
  },
  qa_or_close: {
    keyword: 'qa_or_close',
    decision: 'stop',
    steps: ['execute', 'close'],
    clause:
      'When nextAction is qa_or_close: in the execution session stop here and report it; do not run QA and do not close the sprint, because the closing session does it. In the closing session QA is mandatory: always run the kyro-qa skill, never offer "close without QA".',
  },
  close_sprint: {
    keyword: 'close_sprint',
    decision: 'proceed',
    steps: ['close'],
    clause:
      'When nextAction is close_sprint (closing session only): close with "kyro close-sprint --yes" only if QA ended APPROVED or APPROVED WITH NOTES and "kyro analyze" reports no CRITICAL or HIGH finding. Otherwise fix the findings (as new tasks with "kyro add-emergent") or stop and report; never close a partial sprint.',
  },
  await_scope_completion: {
    keyword: 'await_scope_completion',
    decision: 'stop',
    steps: ['close'],
    clause:
      'When Kyro reports await_scope_completion or scope complete: stop and report it. Never run "kyro scope complete" and never pass --accept-open-debt: the orchestrator and the user decide that.',
  },
  clarify: {
    keyword: 'clarify',
    decision: 'ask',
    steps: ALL_STEPS,
    clause:
      'When nextAction is clarify, or any [NEEDS CLARIFICATION] marker is open: ask the user with AskUserQuestion and wait. Never answer it yourself and never continue on an assumption.',
  },
  plan_sprint: {
    keyword: 'plan_sprint',
    decision: 'proceed',
    steps: ['plan'],
    clause:
      'When nextAction is plan_sprint (planning session only): plan the next sprint with the kyro-forge skill and stop once it is planned. Do not execute tasks in the planning session.',
  },
  global_rule: {
    keyword: 'global',
    decision: 'proceed',
    steps: ['execute', 'close'],
    clause:
      'New rules ("kyro rule add") are registered for the scope only, never with --global. When a rule looks worth making global, list it at the end of your final report as a candidate for the user.',
  },
  correctable_debt: {
    keyword: 'correctable debt',
    decision: 'proceed',
    steps: ['close'],
    clause:
      'Correctable debt that needs no new decision: fix it in the closing session and resolve it with "kyro debt resolve".',
  },
  postponed_debt: {
    keyword: 'kyro debt defer',
    decision: 'proceed',
    steps: ['close'],
    clause:
      'Debt that is not correctable without a new decision: postpone it with "kyro debt defer --target <n> --note <reason>" with a concrete reason. Debt is never deleted.',
  },
  close_commit: {
    keyword: 'Conventional Commit',
    decision: 'proceed',
    steps: ['close'],
    clause:
      'Commit only when the sprint is closed, once, with a Conventional Commit message with scope. Do not push: pushing and merging belong to the orchestrator.',
  },
  repair: {
    keyword: 'kyro repair',
    decision: 'stop',
    steps: ALL_STEPS,
    clause:
      'Never run "kyro repair ... apply". If Kyro reports an integrity finding, stop and report it; a preview ("prepare") is fine.',
  },
  scope_complete: {
    keyword: 'kyro scope complete',
    decision: 'stop',
    steps: ['close'],
    clause: 'Never run "kyro scope complete" (see await_scope_completion).',
  },
  accept_open_debt: {
    keyword: '--accept-open-debt',
    decision: 'stop',
    steps: ['close'],
    clause: 'Never pass --accept-open-debt; only the user can accept open debt.',
  },
  kyro_sprint_executor: {
    keyword: 'kyro-sprint-executor',
    decision: 'stop',
    steps: ALL_STEPS,
    clause:
      'Never use the kyro-sprint-executor skill: it is manual-only and its gates are the ones this policy pre-approves. Work through the kyro-forge skill.',
  },
  file_deletion: {
    keyword: 'git rm',
    decision: 'proceed',
    steps: ['execute', 'close'],
    clause:
      'Deleting a file of the repository needs no question: use "git rm <path>" for a tracked file and "git clean -f <path>" for one you created. Never use rm (the panel denies it) and never delete anything outside the worktree.',
  },
  material_decision: {
    keyword: 'material product decision',
    decision: 'ask',
    steps: ALL_STEPS,
    clause:
      'Ask the user with AskUserQuestion only for a material product decision. Do not ask at routine gates (which task, whether to review, whether to continue).',
  },
  cost: {
    keyword: 'what is paid',
    decision: 'ask',
    steps: ALL_STEPS,
    clause:
      'If a task needs anything that can change what is paid (cloud resources, paid services or plans, new instances or disks), ask the user with AskUserQuestion before doing it. Never use sudo, ssh, oci, tailscale or terraform.',
  },
} as const satisfies Record<string, PolicyGate>;

export type KnownGate = keyof typeof KNOWN_GATES;

const GATE_NAMES: readonly string[] = Object.keys(KNOWN_GATES);

/** What to do at a gate; a gate the policy does not know is always a question. */
export function gateDecision(gate: string): GateDecision {
  if (!GATE_NAMES.includes(gate)) return 'ask';
  return (KNOWN_GATES as Record<string, PolicyGate>)[gate]?.decision ?? 'ask';
}

const COMMON_RULES = [
  'Work through the kyro-forge skill and "kyro context-pack --kyro-scope <scope> --json"; follow its nextAction. Never edit sprint.json or any Kyro state by hand.',
  'Record every decision you take on your own (without asking) as an ADR with "kyro adr".',
  'Use absolute paths in commands, no "~", no echo and no redirections: the panel denies those calls.',
];

const STEP_INTRO: Record<PolicyStep, string> = {
  plan: 'This is a planning session.',
  execute: 'This is an execution session: it ends when Kyro routes qa_or_close.',
  close: 'This is a closing session: QA, debt, the commit and "kyro close-sprint".',
};

/** The policy block for one kind of session, ready to append to the first prompt. */
export function buildPolicy(step: PolicyStep): string {
  const clauses = Object.values(KNOWN_GATES as Record<string, PolicyGate>)
    .filter((gate) => gate.steps.includes(step))
    .map((gate) => `- ${gate.clause}`);
  return [
    `Autopilot policy v${String(POLICY_VERSION)} (the user pre-approved the routine Kyro gates; follow it instead of asking):`,
    STEP_INTRO[step],
    ...COMMON_RULES.map((rule) => `- ${rule}`),
    ...clauses,
  ].join('\n');
}
