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
    loadComponent: () => import('./projects/project.page').then((m) => m.ProjectPage),
  },
  {
    path: 'versions',
    canActivate: [authGuard],
    loadComponent: () => import('./versions/versions.page').then((m) => m.VersionsPage),
  },
  {
    path: 'chats/:id',
    canActivate: [authGuard],
    loadComponent: () => import('./chats/chat.page').then((m) => m.ChatPage),
  },
  { path: '**', redirectTo: '' },
];
