/**
 * Gates policy the panel injects in every pilot session (R16). Kyro is not modified (`kyro update`
 * overwrites its runtime), so the routine gates are pre-approved by text. The agent text is in
 * English, like the tested draft of spike H2 in docs/plan.md; messages for the user are Spanish.
 */

/** Bump it when any clause changes: every pilot session records the version it ran with. */
export const POLICY_VERSION = 4;

/**
 * The kinds of session the pilot opens: planning, execution of a sprint, and closing it; plus the
 * maturing of an idea (kyro-idea), which the user starts and the pilot does not drive, and the
 * merge sessions (conflicts after bringing the base, or the project's own merge-dev skill).
 */
export type PolicyStep = 'plan' | 'execute' | 'close' | 'idea' | 'merge' | 'merge_dev';
export const POLICY_STEPS: readonly PolicyStep[] = [
  'plan',
  'execute',
  'close',
  'idea',
  'merge',
  'merge_dev',
];

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
      'When nextAction is qa_or_close: in the execution session stop here and report it; do not run QA and do not close the sprint, because the closing session does it. In the closing session QA is mandatory: always run the kyro-qa skill, never offer "close without QA". Before "kyro close-sprint" write the QA report to <worktree>/.agents/kyro/qa/<scope>/sprint-<n>.md (n is the sprint number; create the folder if needed) with the exact first line "Verdict: <VERDICT>" (APPROVED, APPROVED WITH NOTES, CHANGES REQUIRED or REJECTED) followed by the report. The panel reads that file and stops the work if it is missing or not an approval.',
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
    steps: ['plan', 'execute', 'close'],
    clause:
      'When Kyro asks whether a rule or learning is for the scope only or also global (for every scope of the project), never stop to ask: take the option Kyro recommends, and scope only if it does not recommend one. Register it with "kyro rule add" (with --global only when that is the recommended option). Record each one as an ADR with "kyro adr", and end your final report with a section "Reglas agregadas" that lists every rule you registered: its text and whether it is scope or global.',
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
      'Deleting a file of the repository needs no question: use "git rm <path>" for a tracked file. For one you created (not versioned) use "git clean -f <path>" or "rm <path>": the panel only accepts rm with the options -f, -r, -R and --, and with every path inside the worktree, never the worktree itself, never .git, and without globs, "~", variables, ".." or substitutions. Never delete anything outside the worktree.',
  },
  idea_confirmation: {
    keyword: 'docType',
    decision: 'proceed',
    steps: ['idea'],
    clause:
      'The kyro-idea skill asks to confirm the docType and the path it inferred: that confirmation is routine, so confirm it yourself and write the document without asking. Ask with AskUserQuestion only for a material gap of the idea itself. Do not create a scope or a work (the panel does it when the user approves the plan) and end the turn once the document is written and verified.',
  },
  merge_conflicts: {
    keyword: 'conflict',
    decision: 'ask',
    steps: ['merge', 'merge_dev'],
    clause:
      'Resolve the merge conflicts that are mechanical (lockfiles, imports, docs, formatting) yourself, then "git add" the files and finish with "git commit --no-edit". If a hunk has business logic from both sides, show both sides to the user with AskUserQuestion and wait for the answer; never pick one on your own.',
  },
  merge_forbidden: {
    keyword: 'git merge --abort',
    decision: 'stop',
    steps: ['merge', 'merge_dev'],
    clause:
      'Never run "git merge --abort", "git rebase", "git reset --hard" or anything with --force or --force-with-lease, and never merge or close a pull request: the user reviews and merges it.',
  },
  merge_no_push: {
    keyword: 'git push',
    decision: 'stop',
    steps: ['merge'],
    clause:
      'Never run "git push": the panel pushes the branch and opens the pull request once the conflicts are resolved.',
  },
  merge_dev_flow: {
    keyword: 'merge-dev',
    decision: 'proceed',
    steps: ['merge_dev'],
    clause:
      'Follow the merge-dev skill of this project for the work below: it brings the base in, resolves what is mechanical, validates and opens the pull request. Push only the branch of the work (never the base, never forced) and stop once its pull requests are open.',
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

const IDEA_RULES = [
  'Work through the kyro-idea skill. Never edit Kyro state by hand.',
  'Use absolute paths in commands, no "~", no echo and no redirections: the panel denies those calls.',
];

const MERGE_RULES = [
  'Work only on the merge that is in progress in this worktree. Never edit Kyro state by hand.',
  'Use absolute paths in commands, no "~", no echo and no redirections: the panel denies those calls.',
];

const COMMON_RULES = [
  'Work through the kyro-forge skill and "kyro context-pack --kyro-scope <scope> --json"; follow its nextAction. Never edit sprint.json or any Kyro state by hand.',
  'Record every decision you take on your own (without asking) as an ADR with "kyro adr".',
  'Use absolute paths in commands, no "~", no echo and no redirections: the panel denies those calls.',
];

const STEP_INTRO: Record<PolicyStep, string> = {
  plan: 'This is a planning session.',
  execute: 'This is an execution session: it ends when Kyro routes qa_or_close.',
  close: 'This is a closing session: QA, debt, the commit and "kyro close-sprint".',
  merge_dev:
    "This is a merge session driven by the project's merge-dev skill: it ends when the branch is pushed and the pull requests are open.",
  merge:
    'This is a merge session: it resolves the conflicts of bringing the base branch into this one and ends there.',
  idea: 'This is an idea session: it matures the request into a pre-scope document and ends there.',
};

/** The policy block for one kind of session, ready to append to the first prompt. */
export function buildPolicy(step: PolicyStep): string {
  const clauses = Object.values(KNOWN_GATES as Record<string, PolicyGate>)
    .filter((gate) => gate.steps.includes(step))
    .map((gate) => `- ${gate.clause}`);
  return [
    `Autopilot policy v${String(POLICY_VERSION)} (the user pre-approved the routine Kyro gates; follow it instead of asking):`,
    STEP_INTRO[step],
    ...(step === 'idea'
      ? IDEA_RULES
      : step === 'merge' || step === 'merge_dev'
        ? MERGE_RULES
        : COMMON_RULES
    ).map((rule) => `- ${rule}`),
    ...clauses,
  ].join('\n');
}
