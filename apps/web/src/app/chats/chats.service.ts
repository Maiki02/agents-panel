import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type {
  AutopilotInfo,
  Chat,
  ChatEvent,
  ChatKind,
  IdeaAction,
  IdeaDocument,
  PendingQuestion,
  Project,
  QuestionAnswer,
  WorktreeTransition,
} from '@agents-panel/shared';
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

/** True for a 401 `invalid_totp`: a wrong or reused code; the session is fine and nothing was done. */
export function isInvalidTotp(error: unknown): boolean {
  if (!(error instanceof HttpErrorResponse) || error.status !== 401) return false;
  return (error.error as { error?: unknown } | null)?.error === 'invalid_totp';
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

  /** Answers a question the agent is waiting on; 409 when it was already answered or cancelled. */
  answerQuestion(
    chatId: number,
    questionId: number,
    body: { answer: QuestionAnswer },
  ): Promise<PendingQuestion> {
    return firstValueFrom(
      this.http.post<PendingQuestion>(
        `/api/chats/${String(chatId)}/questions/${String(questionId)}/answer`,
        body,
      ),
    );
  }

  /** The plan an idea wrote, for its approval card. */
  idea(id: number): Promise<IdeaDocument> {
    return firstValueFrom(this.http.get<IdeaDocument>(`/api/chats/${String(id)}/idea`));
  }

  /** The decision about the plan: approve it as a scope or a work, or ask for changes. */
  ideaAction(id: number, body: { action: IdeaAction; text?: string }): Promise<unknown> {
    return firstValueFrom(this.http.post(`/api/chats/${String(id)}/idea`, body));
  }

  timeline(id: number): Promise<WorktreeTransition[]> {
    return firstValueFrom(this.http.get<WorktreeTransition[]>(`/api/chats/${String(id)}/timeline`));
  }

  autopilot(id: number): Promise<AutopilotInfo> {
    return firstValueFrom(this.http.get<AutopilotInfo>(`/api/chats/${String(id)}/autopilot`));
  }

  /** The user's explicit OK to complete a scope with its debt still open. */
  acceptDebt(id: number, reason: string): Promise<unknown> {
    return firstValueFrom(
      this.http.post(`/api/chats/${String(id)}/autopilot`, { action: 'accept_debt', reason }),
    );
  }

  cancel(id: number): Promise<unknown> {
    return firstValueFrom(this.http.post(`/api/chats/${String(id)}/cancel`, {}));
  }
}
