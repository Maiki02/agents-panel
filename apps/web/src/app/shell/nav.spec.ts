import { describe, expect, it } from 'vitest';
import { APP_TITLE, NAV_ITEMS, activeNavPath, headerTitle, projectSection } from './nav-logic';

describe('side menu', () => {
  it('lists the four sections with their icons', () => {
    expect(NAV_ITEMS.map((item) => [item.label, item.icon])).toEqual([
      ['Proyectos', 'folder'],
      ['Versiones', 'update'],
      ['Cuentas', 'account'],
      ['Notificaciones', 'notifications'],
    ]);
  });

  it('marks Proyectos on the list and inside any project', () => {
    expect(activeNavPath('/')).toBe('/');
    expect(activeNavPath('')).toBe('/');
    expect(activeNavPath('/projects/3/chats/12')).toBe('/');
    expect(activeNavPath('/projects/3/settings/general')).toBe('/');
    expect(activeNavPath('/chats/7')).toBe('/');
  });

  it('marks the other sections by prefix, ignoring query and fragment', () => {
    expect(activeNavPath('/versions')).toBe('/versions');
    expect(activeNavPath('/accounts?x=1')).toBe('/accounts');
    expect(activeNavPath('/settings/notifications#push')).toBe('/settings/notifications');
    expect(activeNavPath('/versionsx')).toBeNull();
    expect(activeNavPath('/login')).toBeNull();
  });
});

describe('header title', () => {
  it('shows the project name inside a project', () => {
    expect(headerTitle('/projects/3/chats/12', 'ventas')).toBe('ventas');
  });

  it('shows the section outside a project, even if a name is still set', () => {
    expect(headerTitle('/versions', 'ventas')).toBe('Versiones');
    expect(headerTitle('/', null)).toBe('Proyectos');
    expect(headerTitle('/settings/notifications', null)).toBe('Notificaciones');
  });

  it('falls back to the section while the project loads and to the app name elsewhere', () => {
    expect(headerTitle('/projects/3/chats', null)).toBe('Proyectos');
    expect(headerTitle('/login', null)).toBe(APP_TITLE);
  });
});

describe('project tabs', () => {
  it('shows Configuración under settings and Chats otherwise', () => {
    expect(projectSection('/projects/3/settings')).toBe('settings');
    expect(projectSection('/projects/3/settings/env?x=1')).toBe('settings');
    expect(projectSection('/projects/3/chats/12')).toBe('chats');
    expect(projectSection('/projects/3')).toBe('chats');
    expect(projectSection('/projects/3/settingsx')).toBe('chats');
  });
});
