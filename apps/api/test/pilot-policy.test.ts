import { describe, expect, it } from 'vitest';
import {
  KNOWN_GATES,
  POLICY_STEPS,
  POLICY_VERSION,
  buildPolicy,
  gateDecision,
  type PolicyGate,
} from '../src/pilot/policy.js';

const gates = Object.entries(KNOWN_GATES as Record<string, PolicyGate>);

describe('gates policy', () => {
  it('covers every known gate with a clause and a decision', () => {
    for (const name of [
      'execute_task',
      'review_task',
      'qa_or_close',
      'close_sprint',
      'await_scope_completion',
      'clarify',
      'plan_sprint',
      'global_rule',
      'correctable_debt',
      'postponed_debt',
      'close_commit',
      'repair',
      'scope_complete',
      'accept_open_debt',
      'kyro_sprint_executor',
      'file_deletion',
    ]) {
      expect(Object.keys(KNOWN_GATES)).toContain(name);
    }
    for (const [name, gate] of gates) {
      expect(gate.clause.length, name).toBeGreaterThan(20);
      expect(['proceed', 'stop', 'ask'], name).toContain(gate.decision);
      expect(gate.steps.length, name).toBeGreaterThan(0);
      expect(gate.clause.toLowerCase(), name).toContain(gate.keyword.toLowerCase());
    }
  });

  it('puts the clause of each gate in the text of its steps', () => {
    for (const [name, gate] of gates) {
      for (const step of gate.steps) {
        const text = buildPolicy(step);
        expect(text, `${name} in ${step}`).toContain(gate.clause);
        expect(text.toLowerCase(), `${name} in ${step}`).toContain(gate.keyword.toLowerCase());
      }
      for (const step of POLICY_STEPS.filter((s) => !gate.steps.includes(s))) {
        expect(buildPolicy(step), `${name} not in ${step}`).not.toContain(gate.clause);
      }
    }
  });

  it('answers ask for a gate the policy does not know, never proceed', () => {
    expect(gateDecision('some_new_kyro_gate')).toBe('ask');
    expect(gateDecision('')).toBe('ask');
    expect(gateDecision('toString')).toBe('ask');
    expect(gateDecision('__proto__')).toBe('ask');
    expect(gateDecision('execute_task')).toBe('proceed');
    expect(gateDecision('qa_or_close')).toBe('stop');
    expect(gateDecision('clarify')).toBe('ask');
  });

  it('never mentions kyro-sprint-executor except to forbid it, nor bypassPermissions', () => {
    for (const step of POLICY_STEPS) {
      const text = buildPolicy(step);
      expect(text).not.toMatch(/bypassPermissions/i);
      for (const line of text.split('\n').filter((l) => l.includes('kyro-sprint-executor'))) {
        expect(line).toMatch(/Never use the kyro-sprint-executor/);
      }
    }
  });

  it('orders the execution session to stop at qa_or_close and the closing one to run QA', () => {
    expect(buildPolicy('execute')).toMatch(/qa_or_close: in the execution session stop here/);
    expect(buildPolicy('close')).toMatch(/always run the kyro-qa skill/);
    expect(buildPolicy('close')).toMatch(/APPROVED or APPROVED WITH NOTES/);
    expect(buildPolicy('close')).toMatch(/no CRITICAL or HIGH/);
    expect(buildPolicy('execute')).toMatch(/--by/);
  });

  it('forbids repair apply, scope complete and --accept-open-debt, and pushing', () => {
    const close = buildPolicy('close');
    expect(close).toContain('Never run "kyro repair ... apply"');
    expect(close).toContain('Never run "kyro scope complete"');
    expect(close).toContain('Never pass --accept-open-debt');
    expect(close).toContain('Do not push');
  });

  it('carries the version in every step', () => {
    expect(Number.isInteger(POLICY_VERSION)).toBe(true);
    for (const step of POLICY_STEPS) {
      expect(buildPolicy(step)).toContain(`Autopilot policy v${String(POLICY_VERSION)}`);
    }
  });
});

describe('file deletion', () => {
  it('tells the agent to use git rm instead of asking or running rm', () => {
    expect(gateDecision('file_deletion')).toBe('proceed');
    expect(buildPolicy('execute')).toContain('git rm <path>');
  });
});
