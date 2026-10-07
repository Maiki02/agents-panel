import type { IconName } from '../ui/icon';

/** Pure helpers behind the side menu and the header title. No Angular, no globals. */
export interface NavItem {
  readonly path: string;
  readonly label: string;
  readonly icon: IconName;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { path: '/', label: 'Proyectos', icon: 'folder' },
  { path: '/versions', label: 'Versiones', icon: 'update' },
  { path: '/accounts', label: 'Cuentas', icon: 'account' },
  { path: '/settings/notifications', label: 'Notificaciones', icon: 'notifications' },
];

export const APP_TITLE = 'Panel de agentes';

function pathOf(url: string): string {
  const path = url.split(/[?#]/, 1)[0] ?? '';
  return path === '' ? '/' : path;
}

/**
 * The menu option the URL belongs to: Proyectos for the list and for anything inside a project
 * (and the old /chats/:id redirect); the others by prefix. `null` when none applies (login).
 */
export function activeNavPath(url: string): string | null {
  const path = pathOf(url);
  if (path === '/' || path.startsWith('/projects/') || path.startsWith('/chats/')) return '/';
  const item = NAV_ITEMS.find(
    (candidate) =>
      candidate.path !== '/' && (path === candidate.path || path.startsWith(`${candidate.path}/`)),
  );
  return item?.path ?? null;
}

/** Header title: the open project's name when there is one, else the section, else the app. */
export function headerTitle(url: string, projectName: string | null): string {
  if (projectName !== null && pathOf(url).startsWith('/projects/')) return projectName;
  const active = activeNavPath(url);
  return NAV_ITEMS.find((item) => item.path === active)?.label ?? APP_TITLE;
}

export type ProjectSection = 'chats' | 'settings';

/** Which project tab the URL shows: Configuración under /settings, Chats otherwise. */
export function projectSection(url: string): ProjectSection {
  return /^\/projects\/[^/]+\/settings(?:\/|$)/.test(pathOf(url)) ? 'settings' : 'chats';
}
