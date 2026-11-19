import type { AgentSession, AutopilotStep, SessionUsage } from '@agents-panel/shared';
import { sessionLabel } from './phase-logic';

const STEP_LABEL: Record<AutopilotStep, string> = {
  init: 'Inicio',
  plan: 'Plan',
  execute: 'Ejecución',
  fix: 'Arreglo',
  close: 'Cierre',
  merge: 'Merge',
  merge_dev: 'Merge a dev',
  manual: 'Manual',
};

export interface UsageRow {
  id: number;
  /** Pilot step of the session (`Manual` for the ones started by hand). */
  step: string;
  /** Role and model of the session. */
  session: string | null;
  /** Null when the session ended without a result message. */
  usage: SessionUsage | null;
}

/** Sessions of the chat, newest first. */
export function usageRows(sessions: readonly AgentSession[]): UsageRow[] {
  return sessions
    .map((s) => ({
      id: s.id,
      step: STEP_LABEL[s.step],
      session: sessionLabel(s.role, s.model),
      usage: s.usage,
    }))
    .reverse();
}

/** 1234 -> "1.234"; fixed locale so the panel reads the same everywhere. */
export function formatTokens(tokens: number): string {
  return tokens.toLocaleString('es-AR');
}

/** Dollars with two decimals, or four for a cost under one cent so it does not read as zero. */
export function formatCost(usd: number): string {
  const digits = usd > 0 && usd < 0.01 ? 4 : 2;
  return `US$ ${usd.toLocaleString('es-AR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
