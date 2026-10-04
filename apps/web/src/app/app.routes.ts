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
    loadComponent: () => import('./chats/chat-list.page').then((m) => m.ChatListPage),
  },
  {
    path: 'chats/:id',
    canActivate: [authGuard],
    loadComponent: () => import('./chats/chat.page').then((m) => m.ChatPage),
  },
  { path: '**', redirectTo: '' },
];
