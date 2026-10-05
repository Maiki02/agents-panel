/**
 * Spike H2 (scope autopiloto-kyro, sprint 1, T1.3).
 *
 * Confirms that ONE real Agent SDK session, started with the same first prompt the panel uses for a
 * scope chat (buildInitialPrompt: "read the kyro-forge skill") plus a draft gates policy, executes
 * the planned task of a throwaway scope, records evidence and review through the Kyro CLI and stops
 * at qa_or_close without asking the user to confirm anything. It records every question the agent
 * asked anyway, every tool call the panel policy denied, and the final `kyro context-pack` route.
 *
 * Run (from apps/api): npx tsx scripts/spike-forge-policy.ts [--model <id>] [--keep] [--no-policy]
 *
 * Safety: everything happens in a temp git repo (removed at the end unless --keep); this repo is
 * never touched. Permissions are the panel's own (acceptEdits + decide() allowlist); there is no
 * bypassPermissions and kyro-sprint-executor is not used.
 *
 * RESULT: see docs/plan.md, etapa 4, "Spike H2".
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  query,
  type HookCallback,
  type PermissionResult,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { ALLOWED_TOOLS, decide } from '../src/agent/permissions.js';
import { buildInitialPrompt } from '../src/chats/service.js';

const { values } = parseArgs({
  options: {
    model: { type: 'string' },
    keep: { type: 'boolean', default: false },
    'no-policy': { type: 'boolean', default: false },
  },
});

/** Draft of the gates policy the panel will inject in every session (R16). Tested text. */
const POLICY_DRAFT = `
Autopilot policy (the user pre-approved the routine Kyro gates; follow it instead of asking):
- Work only on the next task that "kyro context-pack --kyro-scope <scope> --json" routes. Follow its nextAction.
- Execute the task, run its validations, record evidence with "kyro record-evidence" and review with "kyro review" through the CLI. Never edit sprint.json or any Kyro state by hand.
- Do NOT ask the user for confirmation at routine gates. Do not ask which task to do, whether to review, or whether to continue.
- When nextAction is qa_or_close: stop here and report it. Do not close the sprint and do not run QA in this session.
- Ask the user (AskUserQuestion) only for a material product decision, a cost, or when Kyro reports clarify or a blocker you cannot resolve. Never guess on those.
- Do not commit and do not push. Never use sudo, ssh, oci, tailscale or terraform.
`.trim();

const SCOPE = 'demo-h2';

function kyro(cwd: string, args: string[]): string {
  return execFileSync('kyro', args, { cwd, encoding: 'utf8' });
}

function setupRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'spike-forge-'));
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['config', 'user.name', 'spike'], { cwd });
  execFileSync('git', ['config', 'user.email', 'spike@example.com'], { cwd });
  mkdirSync(join(cwd, '.agents', 'kyro', 'scopes'), { recursive: true });
  writeFileSync(
    join(cwd, '.agents', 'kyro', 'project.json'),
    JSON.stringify({ schemaVersion: 4, artifactRoot: '.agents/kyro/scopes' }, null, 2),
  );
  writeFileSync(
    join(cwd, '.agents', 'kyro', 'local.json'),
    JSON.stringify({ schemaVersion: 4, activeScope: SCOPE }, null, 2),
  );
  writeFileSync(
    join(cwd, 'init.json'),
    JSON.stringify({
      scope: SCOPE,
      title: 'Spike H2',
      objective: 'Throwaway scope: create hola.txt.',
      successCriteria: ['hola.txt exists'],
      spec: {
        requirements: [
          {
            id: 'R1',
            statement: 'hola.txt exists with the word hola',
            priority: 'must',
            rationale: 'spike',
          },
        ],
        nonGoals: ['anything else'],
        openQuestions: [],
      },
      roadmap: {
        plannedSprintCount: 1,
        sizingRationale: 'one trivial sprint',
        sprints: [{ n: 1, slug: 'hola', title: 'Hola' }],
      },
    }),
  );
  kyro(cwd, ['plan', '--from', 'init.json', '--kyro-scope', SCOPE]);
  writeFileSync(
    join(cwd, 'sprint.json'),
    JSON.stringify({
      sprint: { n: 1, slug: 'hola', title: 'Hola', objective: 'Create hola.txt.' },
      phases: [
        {
          id: 'P1',
          title: 'Fase',
          objective: 'Create the file',
          tasks: [
            {
              id: 'T1.1',
              title: 'Create hola.txt',
              description:
                'Create hola.txt at the repo root containing exactly the word hola and a newline.',
              files_to_touch: ['hola.txt'],
              context: 'Trivial task for a spike.',
              acceptance_criteria: ['hola.txt exists and contains hola'],
              depends_on: [],
              scenario_refs: [],
            },
          ],
        },
      ],
      definitionOfDone: ['T1.1 has a pass verdict'],
      scenarios: [],
    }),
  );
  kyro(cwd, ['plan', '--from', 'sprint.json', '--kyro-scope', SCOPE]);
  rmSync(join(cwd, 'init.json'));
  rmSync(join(cwd, 'sprint.json'));
  return cwd;
}

const cwd = setupRepo();
const kyroDirBefore = kyro(cwd, ['context-pack', '--kyro-scope', SCOPE, '--json']);
console.log(`[repo temporal] ${cwd}`);
console.log(
  `[route inicial] ${(JSON.parse(kyroDirBefore) as { data: { nextAction: string } }).data.nextAction}`,
);

const asked: string[] = [];
const denied: string[] = [];
const tools: string[] = [];
let initModel = '';
let finalText = '';

// Same policy as the panel, plus AskUserQuestion routed to canUseTool so we can see who asks.
const policy = (toolName: string, input: Record<string, unknown>) => {
  if (toolName === 'AskUserQuestion') return { behavior: 'allow' as const };
  const verdict = decide({ cwd }, toolName, input);
  if (verdict.behavior === 'deny') denied.push(`${toolName}: ${verdict.message}`);
  return verdict;
};

const preToolUse: HookCallback = (input) => {
  if (input.hook_event_name !== 'PreToolUse') return Promise.resolve({});
  const toolInput =
    typeof input.tool_input === 'object' && input.tool_input !== null
      ? (input.tool_input as Record<string, unknown>)
      : {};
  const decision = policy(input.tool_name, toolInput);
  if (decision.behavior === 'allow') return Promise.resolve({});
  return Promise.resolve({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: decision.message,
    },
  });
};

const request = `Execute the active sprint of scope ${SCOPE}.`;
const base = buildInitialPrompt('scope', request);
const prompt = values['no-policy'] ? base : `${base}\n\n${POLICY_DRAFT}`;

try {
  const stream = query({
    prompt,
    options: {
      cwd,
      settingSources: ['project', 'user'],
      permissionMode: 'acceptEdits',
      allowedTools: ALLOWED_TOOLS,
      maxTurns: 60,
      ...(values.model ? { model: values.model } : {}),
      hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
      canUseTool: (toolName, input): Promise<PermissionResult> => {
        if (toolName === 'AskUserQuestion') {
          asked.push(JSON.stringify(input));
          console.log('\n[el agente PREGUNTÓ]', JSON.stringify(input));
          // Answer so the run can finish; what matters is that it asked.
          return Promise.resolve({
            behavior: 'deny',
            message: 'spike: no user available; follow the policy',
          });
        }
        const verdict = policy(toolName, input);
        return Promise.resolve(
          verdict.behavior === 'allow'
            ? { behavior: 'allow' }
            : { behavior: 'deny', message: verdict.message },
        );
      },
    },
  });

  for await (const message of stream as AsyncIterable<SDKMessage>) {
    if (message.type === 'system' && message.subtype === 'init') {
      initModel = message.model;
      console.log(`[system:init] model=${initModel}`);
    } else if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') {
          finalText = block.text;
          console.log('[agente]', block.text.slice(0, 400));
        } else if (block.type === 'tool_use') {
          const summary = JSON.stringify(block.input).slice(0, 140);
          tools.push(`${block.name} ${summary}`);
          console.log(`[tool] ${block.name} ${summary}`);
        }
      }
    } else if (message.type === 'result') {
      console.log(`[result] subtype=${message.subtype} turns=${String(message.num_turns)}`);
    }
  }

  const after = JSON.parse(kyro(cwd, ['context-pack', '--kyro-scope', SCOPE, '--json'])) as {
    data: { nextAction: string; nextTaskId: string | null; handoffNote: string };
  };
  const hola = execFileSync('cat', ['hola.txt'], { cwd, encoding: 'utf8' }).trim();
  const reached =
    after.data.nextAction === 'qa_or_close' || after.data.nextAction === 'close_sprint';

  console.log('\n--- resumen ---');
  console.log(`política inyectada: ${values['no-policy'] ? 'NO' : 'SÍ'}`);
  console.log(`modelo: ${initModel}`);
  console.log(`preguntas del agente: ${String(asked.length)}`);
  for (const q of asked) console.log(`  - ${q.slice(0, 300)}`);
  console.log(`llamadas denegadas por la política del panel: ${String(denied.length)}`);
  for (const d of denied) console.log(`  - ${d.slice(0, 200)}`);
  console.log(`herramientas usadas: ${String(tools.length)}`);
  console.log(`hola.txt: ${hola}`);
  console.log(`context-pack final: nextAction=${after.data.nextAction}`);
  console.log(`texto final: ${finalText.slice(0, 300).replace(/\n/g, ' ')}`);
  process.exitCode = reached && asked.length === 0 ? 0 : 1;
} finally {
  if (values.keep) console.log(`[repo conservado] ${cwd}`);
  else rmSync(cwd, { recursive: true, force: true });
}
