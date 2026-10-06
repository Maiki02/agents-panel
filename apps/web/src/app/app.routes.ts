import { inject } from '@angular/core';
import { Router, type CanActivateFn, type Routes } from '@angular/router';
import { authGuard, guestGuard } from './auth/auth.guard';
import { chatsPath } from './projects/last-chat';
import { LastChatStore } from './projects/last-chat.store';

/** /projects/:id and /projects/:id/chats open the last selected chat, or "Nuevo chat". */
const lastChatGuard: CanActivateFn = (route) => {
  const raw = route.pathFromRoot.map((r) => r.params['id'] as string | undefined).find(Boolean);
  const projectId = Number(raw);
  if (!Number.isInteger(projectId) || projectId < 1) return true;
  return inject(Router).parseUrl(chatsPath(projectId, inject(LastChatStore).get(projectId)));
};

export const routes: Routes = [
  {
    path: 'login',
    canActivate: [guestGuard],
    loadComponent: () => import('./auth/login.page').then((m) => m.LoginPage),
  },
  {
    path: '',
    pathMatch: 'full',
    canActivate: [authGuard],
    loadComponent: () => import('./projects/projects.page').then((m) => m.ProjectsPage),
  },
  {
    path: 'projects/:id',
    canActivate: [authGuard],
    loadComponent: () => import('./projects/project-layout').then((m) => m.ProjectLayout),
    children: [
      { path: '', pathMatch: 'full', canActivate: [lastChatGuard], children: [] },
      {
        path: 'chats',
        loadComponent: () => import('./chats/chats-section').then((m) => m.ChatsSection),
        children: [
          { path: '', pathMatch: 'full', canActivate: [lastChatGuard], children: [] },
          {
            path: 'new',
            loadComponent: () => import('./chats/new-chat.page').then((m) => m.NewChatPage),
          },
          {
            path: ':chatId',
            loadComponent: () => import('./chats/chat.page').then((m) => m.ChatPage),
          },
        ],
      },
      { path: 'settings', pathMatch: 'full', redirectTo: 'settings/general' },
      {
        path: 'settings/:tab',
        loadComponent: () => import('./projects/settings.page').then((m) => m.SettingsPage),
      },
    ],
  },
  {
    path: 'accounts',
    canActivate: [authGuard],
    loadComponent: () => import('./accounts/accounts.page').then((m) => m.AccountsPage),
  },
  {
    path: 'versions',
    canActivate: [authGuard],
    loadComponent: () => import('./versions/versions.page').then((m) => m.VersionsPage),
  },
  {
    path: 'settings/notifications',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./notifications/notifications.page').then((m) => m.NotificationsPage),
  },
  {
    path: 'chats/:id',
    canActivate: [authGuard],
    loadComponent: () => import('./chats/chat-redirect.page').then((m) => m.ChatRedirectPage),
  },
  { path: '**', redirectTo: '' },
];
