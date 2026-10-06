import type {
  AutopilotAction,
  AutopilotRun,
  AutopilotStatus,
  ChatKind,
  WorktreeStateId,
} from '@agents-panel/shared';
import type { BadgeTone } from '../ui/badge';

/** An action of the pilot bar: why it is disabled (null when it can be sent). */
export interface PilotActionState {
  disabled: boolean;
  reason: string | null;
}

export type PilotControl = Extract<AutopilotAction, 'on' | 'off' | 'pause' | 'resume'>;
export type PilotControls = Record<PilotControl, PilotActionState>;

const ok: PilotActionState = { disabled: false, reason: null };
const no = (reason: string): PilotActionState => ({ disabled: true, reason });

function allBut(reason: string): PilotControls {
  const blocked = no(reason);
  return { on: blocked, off: blocked, pause: blocked, resume: blocked };
}

/** The work is completed and its PR is ready (or merged): nothing left to pilot. */
function prIsReady(run: AutopilotRun | null, state: WorktreeStateId | null | undefined): boolean {
  return run?.phase === 'merge' && (state === 'pr_lista' || state === 'mergeada');
}

/**
 * Which buttons of the pilot bar can be pressed, mirroring what the API accepts (so a refused
 * click is the exception): `on` for a work without pilot or with it off, `pause` while it runs,
 * `resume` while paused or stopped, `off` unless it is already off or finished.
 */
export function pilotControls(input: {
  kind: ChatKind;
  run: AutopilotRun | null;
  workState?: WorktreeStateId | null;
}): PilotControls {
  const { kind, run, workState } = input;
  if (kind === 'direct') return allBut('Un pedido directo no tiene piloto.');
  if (kind === 'idea') return allBut('Una idea no tiene piloto hasta que se aprueba su plan.');
  if (run === null || run.status === 'off') {
    return {
      on: prIsReady(run, workState) ? no('La PR ya está lista: no queda nada que pilotear.') : ok,
      off: no('El piloto ya está apagado.'),
      pause: no('El piloto está apagado.'),
      resume: no('El piloto está apagado: encendelo.'),
    };
  }
  switch (run.status) {
    case 'active':
    case 'queued':
    case 'waiting_quota':
      return {
        on: no('El piloto ya está encendido.'),
        off: ok,
        pause: ok,
        resume: no('El piloto no está pausado.'),
      };
    case 'paused':
      return {
        on: no('El piloto ya está encendido (en pausa).'),
        off: ok,
        pause: no('El piloto ya está en pausa.'),
        resume: ok,
      };
    case 'stopped':
      return {
        on: no('El piloto ya está encendido: está frenado, mirá el motivo.'),
        off: ok,
        pause: no('El piloto está frenado: resolvé el motivo y reanudalo.'),
        resume: ok,
      };
    case 'finished':
      return allBut('El piloto ya terminó este trabajo.');
  }
}

const STATUS: Record<AutopilotStatus, { label: string; tone: BadgeTone }> = {
  active: { label: 'Piloto activo', tone: 'accent' },
  queued: { label: 'Piloto en cola', tone: 'neutral' },
  waiting_quota: { label: 'Piloto esperando cupo', tone: 'neutral' },
  // The user has to act (resume, or fix the reason): amber like the rest of the web.
  paused: { label: 'Piloto en pausa', tone: 'warn' },
  stopped: { label: 'Piloto frenado', tone: 'warn' },
  off: { label: 'Piloto apagado', tone: 'neutral' },
  finished: { label: 'Piloto terminó', tone: 'ok' },
};

export interface PilotStatusView {
  label: string;
  tone: BadgeTone;
  /** "Sesiones del sprint 2/6" while a sprint is in progress; null otherwise. */
  sessions: string | null;
  /** Why it stopped, shown next to a stopped pilot. */
  stopReason: string | null;
}

/** What the bar says about the run; no run means the pilot is off. */
export function pilotStatus(
  run: AutopilotRun | null,
  maxSessionsPerSprint: number,
): PilotStatusView {
  const entry = run === null ? STATUS.off : STATUS[run.status];
  const counting =
    run !== null && run.sessionsInSprint > 0 && run.status !== 'off' && run.status !== 'finished';
  return {
    label: entry.label,
    tone: entry.tone,
    sessions: counting
      ? `Sesiones del sprint ${String(run.sessionsInSprint)}/${String(maxSessionsPerSprint)}`
      : null,
    stopReason: run?.status === 'stopped' ? run.stopReason : null,
  };
}

export const PILOT_LABEL: Record<PilotControl, string> = {
  on: 'Encender piloto',
  off: 'Apagar piloto',
  pause: 'Pausar',
  resume: 'Reanudar',
};
