import type { ChatKind, Project } from '@agents-panel/shared';
import type { NewChatInput } from './chats.service';

export interface KindOption {
  kind: ChatKind;
  label: string;
  /** What the kind does, shown under the select. */
  description: string;
}

const KYRO_KINDS: readonly KindOption[] = [
  {
    kind: 'work',
    label: 'Work (cambio chico)',
    description: 'Un fix, un ajuste de doc o una pantalla: Kyro planifica y ejecuta el cambio.',
  },
  {
    kind: 'scope',
    label: 'Scope (etapa grande)',
    description: 'Una etapa grande del plan, en sprints: planificación, ejecución, QA y cierre.',
  },
  {
    kind: 'idea',
    label: 'Idea (todavía sin plan)',
    description:
      'Madurás una idea con el agente. Cuando el plan está escrito lo aprobás como scope o como work y el piloto sigue solo hasta la PR.',
  },
];

const DIRECT_KIND: KindOption = {
  kind: 'direct',
  label: 'Pedido directo (sin Kyro)',
  description: 'El agente recibe tu pedido tal cual, sin el flujo de Kyro.',
};

/** What a kind does, for the text under the select. */
export function kindDescription(kind: ChatKind): string {
  return [...KYRO_KINDS, DIRECT_KIND].find((option) => option.kind === kind)?.description ?? '';
}

/** Scope, work and idea run on Kyro, so a project without it only offers the direct request (R32). */
export function availableKinds(project: Pick<Project, 'hasKyro'>): KindOption[] {
  return project.hasKyro ? [...KYRO_KINDS, DIRECT_KIND] : [DIRECT_KIND];
}

/** Work when the project has Kyro, the direct request otherwise. */
export function defaultKind(project: Pick<Project, 'hasKyro'>): ChatKind {
  return project.hasKyro ? 'work' : 'direct';
}

/** The chosen kind if the project offers it, else the default (e.g. after Kyro disappears). */
export function effectiveKind(project: Pick<Project, 'hasKyro'>, chosen: ChatKind): ChatKind {
  return availableKinds(project).some((option) => option.kind === chosen)
    ? chosen
    : defaultKind(project);
}

/**
 * What the form sends to create a chat. It never carries an autopilot switch: an idea turns the
 * pilot on when its plan is approved, and a scope or work is switched on from its own page.
 */
export function newChatInput(
  project: Pick<Project, 'id' | 'hasKyro'>,
  chosen: ChatKind,
  slug: string,
  prompt: string,
): NewChatInput {
  return {
    projectId: project.id,
    kind: effectiveKind(project, chosen),
    slug,
    prompt: prompt.trim(),
  };
}

export function parseKind(value: string): ChatKind {
  return value === 'scope' || value === 'direct' || value === 'idea' ? value : 'work';
}
