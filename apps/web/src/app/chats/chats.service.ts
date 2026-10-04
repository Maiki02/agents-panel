import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Chat, ChatEvent, ChatKind, Project } from '@agents-panel/shared';
import { firstValueFrom } from 'rxjs';

export interface NewChatInput {
  projectId: number;
  kind: ChatKind;
  slug: string;
  prompt: string;
}

/** Turns an API failure into text for the user, keeping the server's own message when it sent one. */
export function apiErrorMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    const body = error.error as { error?: unknown; message?: unknown } | null;
    if (body?.error === 'invalid_totp') {
      return 'Código incorrecto o ya usado. Esperá el próximo código de la app.';
    }
    if (typeof body?.error === 'string') return body.error;
    if (typeof body?.message === 'string') return body.message;
    if (error.status === 0) return 'No se pudo conectar con el servidor.';
    if (error.status === 429) return 'Demasiados intentos, probá de nuevo en un minuto.';
    return `Error ${String(error.status)}`;
  }
  return 'Error inesperado.';
}

@Injectable({ providedIn: 'root' })
export class ChatsService {
  private readonly http = inject(HttpClient);

  projects(): Promise<Project[]> {
    return firstValueFrom(this.http.get<Project[]>('/api/projects'));
  }

  list(projectId?: number): Promise<Chat[]> {
    const params = projectId === undefined ? {} : { projectId: String(projectId) };
    return firstValueFrom(this.http.get<Chat[]>('/api/chats', { params }));
  }

  get(id: number): Promise<Chat> {
    return firstValueFrom(this.http.get<Chat>(`/api/chats/${String(id)}`));
  }

  events(id: number, afterSeq = 0): Promise<ChatEvent[]> {
    return firstValueFrom(
      this.http.get<ChatEvent[]>(`/api/chats/${String(id)}/events`, {
        params: { afterSeq: String(afterSeq) },
      }),
    );
  }

  create(input: NewChatInput): Promise<Chat> {
    return firstValueFrom(this.http.post<Chat>('/api/chats', input));
  }

  send(id: number, text: string): Promise<unknown> {
    return firstValueFrom(this.http.post(`/api/chats/${String(id)}/messages`, { text }));
  }

  cancel(id: number): Promise<unknown> {
    return firstValueFrom(this.http.post(`/api/chats/${String(id)}/cancel`, {}));
  }
}
