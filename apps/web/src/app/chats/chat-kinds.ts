import { MODEL_CATALOG, type ChatKind, type Project } from '@agents-panel/shared';
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

/** Whether the pilot switch of the form applies to a kind; when it does not, the reason is shown. */
export function pilotSwitch(kind: ChatKind): { available: boolean; reason: string | null } {
  if (kind === 'scope' || kind === 'work') return { available: true, reason: null };
  if (kind === 'idea') {
    return { available: false, reason: 'La idea enciende el piloto sola cuando aprobás su plan.' };
  }
  return { available: false, reason: 'Un pedido directo no tiene piloto.' };
}

/** Models the form can offer for the project's provider. */
export function modelOptions(
  project: Pick<Project, 'models'>,
): { id: string; byDefault: { thinker: boolean; executor: boolean } }[] {
  return MODEL_CATALOG[project.models.provider].map((id) => ({
    id,
    byDefault: {
      thinker: id === project.models.thinker,
      executor: id === project.models.executor,
    },
  }));
}

/** Label of a model in a select: the project's own is marked as the default. */
export function modelLabel(id: string, isDefault: boolean): string {
  return isDefault ? `${id} (por defecto)` : id;
}

/** The roles the user changed from the project's models; nothing when they did not touch them. */
export function modelOverrides(
  project: Pick<Project, 'models'>,
  chosen: { thinker: string; executor: string },
): { thinker?: string; executor?: string } {
  return {
    ...(chosen.thinker !== project.models.thinker ? { thinker: chosen.thinker } : {}),
    ...(chosen.executor !== project.models.executor ? { executor: chosen.executor } : {}),
  };
}

/** What the form decided besides the request: the pilot and the models, both optional. */
export interface NewChatChoices {
  autopilot?: boolean;
  models?: { thinker: string; executor: string };
}

/**
 * What the form sends to create a chat. `autopilot: true` only goes with a scope or work (an idea
 * turns the pilot on when its plan is approved; a direct request has none) and `models` only with
 * the roles the user changed, so a project's default keeps applying when nothing was touched.
 */
export function newChatInput(
  project: Pick<Project, 'id' | 'hasKyro'> & Partial<Pick<Project, 'models'>>,
  chosen: ChatKind,
  slug: string,
  prompt: string,
  choices: NewChatChoices = {},
): NewChatInput {
  const kind = effectiveKind(project, chosen);
  const overrides =
    choices.models !== undefined && project.models !== undefined
      ? modelOverrides({ models: project.models }, choices.models)
      : {};
  return {
    projectId: project.id,
    kind,
    slug,
    prompt: prompt.trim(),
    ...(choices.autopilot === true && pilotSwitch(kind).available ? { autopilot: true } : {}),
    ...(Object.keys(overrides).length > 0 ? { models: overrides } : {}),
  };
}

export function parseKind(value: string): ChatKind {
  return value === 'scope' || value === 'direct' || value === 'idea' ? value : 'work';
}
