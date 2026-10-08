import type { Routes } from '@angular/router';
import { authGuard, guestGuard } from './auth/auth.guard';

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
      { path: '', pathMatch: 'full', redirectTo: 'chats' },
      {
        path: 'chats',
        children: [
          {
            // The grid; chats/new is the same grid with the "Nuevo chat" dialog open.
            path: '',
            loadComponent: () => import('./chats/chats-section').then((m) => m.ChatsSection),
            children: [{ path: 'new', children: [] }],
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
