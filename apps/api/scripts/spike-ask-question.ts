/**
 * Spike H1 (scope autopiloto-kyro, sprint 1, T1.1).
 *
 * Confirms two things against a real Agent SDK session, run on the VM with the subscription login:
 *   1. The agent can ask with AskUserQuestion and the answer returns to the SAME session through
 *      `updatedInput` of canUseTool (method "updatedInput"), or, as fallback, by denying the call
 *      with the message "el usuario respondió: …" (method "deny").
 *   2. `query({ options: { model } })` changes the session model, read from the system:init message.
 *
 * Run (from apps/api):
 *   node --experimental-strip-types scripts/spike-ask-question.ts [--method updatedInput|deny] [--model <id>] [--answer <label|text>]
 *   (or: npx tsx scripts/spike-ask-question.ts ...)
 *
 * Safety: cwd is a fresh temp directory (removed at the end), settingSources is empty, the only tool
 * allowed is AskUserQuestion and permissionMode is never bypassPermissions.
 *
 * RESULT (05/10/2026, SDK 0.3.289, VM vm-ia):
 *   - Method chosen: "updatedInput". PreToolUse returns {} for AskUserQuestion (it does not deny),
 *     canUseTool waits for the answer and returns
 *     { behavior: 'allow', updatedInput: { ...input, answers: { [questionText]: answerString } } }.
 *     The agent continued in the same session with the answer ("RESPUESTA_RECIBIDA: Azul").
 *   - Fallback "deny" with message "el usuario respondió: …" also works, but updatedInput is the
 *     native path (the tool result carries the answers), so it is the one T2.2 uses.
 *   - `model` in query() is respected: system:init reported claude-opus-5-5 and claude-sonnet-5-5
 *     as requested (default with no model: claude-sonnet-5-5).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  query,
  type HookCallback,
  type PermissionResult,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';

const { values } = parseArgs({
  options: {
    method: { type: 'string', default: 'updatedInput' },
    model: { type: 'string' },
    answer: { type: 'string', default: 'Azul' },
  },
});

const method = values.method;
if (method !== 'updatedInput' && method !== 'deny') {
  console.error('--method must be "updatedInput" or "deny"');
  process.exit(2);
}
const answer = values.answer;

interface AskInput {
  questions: { question: string }[];
}

const PROMPT =
  'Usá la herramienta AskUserQuestion una sola vez para preguntarme cuál es mi color favorito, ' +
  'con las opciones "Rojo" y "Azul". Cuando tengas la respuesta, respondé exactamente ' +
  '"RESPUESTA_RECIBIDA: <lo que te respondí>" y nada más. No uses otras herramientas.';

// PreToolUse runs before canUseTool; it must let AskUserQuestion through so canUseTool receives it.
const preToolUse: HookCallback = (input) => {
  if (input.hook_event_name !== 'PreToolUse') return Promise.resolve({});
  if (input.tool_name === 'AskUserQuestion') return Promise.resolve({});
  return Promise.resolve({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'spike: only AskUserQuestion is allowed',
    },
  });
};

const sandbox = await mkdtemp(join(tmpdir(), 'spike-ask-'));
let initModel = '';
let finalText = '';
let askedCount = 0;

try {
  const stream = query({
    prompt: PROMPT,
    options: {
      cwd: sandbox,
      settingSources: [],
      permissionMode: 'default',
      allowedTools: [],
      maxTurns: 4,
      ...(values.model ? { model: values.model } : {}),
      hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
      canUseTool: (toolName, input): Promise<PermissionResult> => {
        if (toolName !== 'AskUserQuestion') {
          return Promise.resolve({ behavior: 'deny', message: 'spike: tool not allowed' });
        }
        askedCount += 1;
        const asked = (input as unknown as AskInput).questions;
        console.log('\n[pregunta recibida]', JSON.stringify(input, null, 2));
        // The panel would wait here, with no timeout, until the user answers from the web.
        console.log(`[respuesta devuelta] método=${method} respuesta="${answer}"`);
        if (method === 'deny') {
          return Promise.resolve({
            behavior: 'deny',
            message: `el usuario respondió: ${answer}`,
          });
        }
        const answers = Object.fromEntries(asked.map((q) => [q.question, answer]));
        return Promise.resolve({ behavior: 'allow', updatedInput: { ...input, answers } });
      },
    },
  });

  for await (const message of stream as AsyncIterable<SDKMessage>) {
    if (message.type === 'system' && message.subtype === 'init') {
      initModel = message.model;
      console.log(`[system:init] model=${initModel} session_id=${message.session_id}`);
    } else if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') {
          finalText = block.text;
          console.log('[agente]', block.text);
        }
      }
    } else if (message.type === 'result') {
      console.log(`[result] subtype=${message.subtype}`);
    }
  }
} finally {
  await rm(sandbox, { recursive: true, force: true });
}

const continued = finalText.includes(answer);
console.log('\n--- resumen ---');
console.log(`método: ${method}`);
console.log(`preguntas recibidas: ${String(askedCount)}`);
console.log(`modelo en system:init: ${initModel} (pedido: ${values.model ?? 'por defecto'})`);
console.log(`el agente continuó con la respuesta: ${continued ? 'SÍ' : 'NO'}`);
process.exit(askedCount > 0 && continued ? 0 : 1);
