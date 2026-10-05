import type { ChatKind, Project } from '@agents-panel/shared';

export interface KindOption {
  kind: ChatKind;
  label: string;
}

const KYRO_KINDS: readonly KindOption[] = [
  { kind: 'work', label: 'Work (cambio chico)' },
  { kind: 'scope', label: 'Scope (etapa grande)' },
];

const DIRECT_KIND: KindOption = { kind: 'direct', label: 'Pedido directo (sin Kyro)' };

/** Scope and work run on Kyro, so a project without it only offers the direct request (R32). */
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

export function parseKind(value: string): ChatKind {
  return value === 'scope' || value === 'direct' ? value : 'work';
}
