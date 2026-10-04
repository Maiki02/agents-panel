import type { Project, ProjectStatus } from '@agents-panel/shared';
import type { BadgeTone } from '../ui/badge';

/** Name shown in the web: the free-form one when set, the internal kebab-case one otherwise (R9). */
export function projectLabel(project: Pick<Project, 'name' | 'displayName'>): string {
  const display = project.displayName?.trim();
  return display === undefined || display === '' ? project.name : display;
}

const STATUS_LABEL: Record<ProjectStatus, string> = {
  cloning: 'Clonando',
  ready: 'Listo',
  error: 'Error',
};
const STATUS_TONE: Record<ProjectStatus, BadgeTone> = {
  cloning: 'accent',
  ready: 'ok',
  error: 'danger',
};

export function projectStatusLabel(status: ProjectStatus): string {
  return STATUS_LABEL[status];
}

export function projectStatusTone(status: ProjectStatus): BadgeTone {
  return STATUS_TONE[status];
}

/** What a card shows for the repo: the full GitHub URL as a link, or the local path (CLI-added). */
export function repoDisplay(project: Pick<Project, 'repoUrl' | 'repoPath' | 'baseBranch'>): {
  url: string | null;
  text: string;
  branch: string | null;
} {
  return {
    url: project.repoUrl,
    text: project.repoUrl ?? project.repoPath,
    branch: project.baseBranch === '' ? null : project.baseBranch,
  };
}
