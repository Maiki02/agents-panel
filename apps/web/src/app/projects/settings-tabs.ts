import type { TabItem } from '../ui/tabs-logic';

/**
 * The tabs of a project's Configuración. To add one: append it here and add its `@case` in
 * settings.page.ts; the existing tabs are not touched.
 */
export const SETTINGS_TABS: readonly TabItem[] = [
  { id: 'general', label: 'General' },
  { id: 'environment', label: 'Environment' },
  { id: 'repository', label: 'Repositorio' },
  { id: 'permissions', label: 'Permisos' },
];

export function settingsTabPath(projectId: number, tab: string): string {
  return `/projects/${String(projectId)}/settings/${tab}`;
}
