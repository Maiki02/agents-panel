import type { Project } from '@agents-panel/shared';

/** Name shown in the web: the free-form one when set, the internal kebab-case one otherwise (R9). */
export function projectLabel(project: Pick<Project, 'name' | 'displayName'>): string {
  const display = project.displayName?.trim();
  return display === undefined || display === '' ? project.name : display;
}
