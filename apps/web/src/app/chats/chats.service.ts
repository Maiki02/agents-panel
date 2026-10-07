import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type {
  AutopilotInfo,
  Chat,
  ChatEvent,
  ChatEventWindow,
  ChatKind,
  IdeaAction,
  IdeaDocument,
  PendingQuestion,
  Project,
  QuestionAnswer,
  WorktreeState,
  WorktreeTransition,
} from '@agents-panel/shared';
import { firstValueFrom } from 'rxjs';
import { SwrCache } from '../shared/swr-cache';
import { FEED_WINDOW_TAIL } from './feed-window-logic';

export interface NewChatInput {
  projectId: number;
  kind: ChatKind;
  slug: string;
  prompt: string;
  /** Only a scope or work: the pilot starts with it. */
  autopilot?: boolean;
  /** Only the roles that differ from the project's models. */
  models?: { thinker?: string; executor?: string };
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

function listKey(projectId: number | undefined): string {
  return projectId === undefined ? '' : String(projectId);
}

@Injectable({ providedIn: 'root' })
export class ChatsService {
  private readonly http = inject(HttpClient);
  private readonly listCache = new SwrCache<Chat[]>();

  projects(): Promise<Project[]> {
    return firstValueFrom(this.http.get<Project[]>('/api/projects'));
  }

  /** The last list of a project's chats: paints at once while list() fetches the new one. */
  cachedList(projectId?: number): Chat[] | undefined {
    return this.listCache.peek(listKey(projectId));
  }

  list(projectId?: number): Promise<Chat[]> {
    const params = projectId === undefined ? {} : { projectId: String(projectId) };
    return this.listCache.load(
      () => firstValueFrom(this.http.get<Chat[]>('/api/chats', { params })),
      listKey(projectId),
    );
  }

  /** Every action that changes a chat drops the cached lists. */
  private changed<T>(request: Promise<T>): Promise<T> {
    return request.finally(() => {
      this.listCache.invalidate();
    });
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

  /** The last `tail` agent messages, or the ones right before `beforeSeq`. */
  eventsWindow(id: number, beforeSeq?: number): Promise<ChatEventWindow> {
    const params: Record<string, string> = { tail: String(FEED_WINDOW_TAIL) };
    if (beforeSeq !== undefined) params['beforeSeq'] = String(beforeSeq);
    return firstValueFrom(
      this.http.get<ChatEventWindow>(`/api/chats/${String(id)}/events`, { params }),
    );
  }

  create(input: NewChatInput): Promise<Chat> {
    return this.changed(firstValueFrom(this.http.post<Chat>('/api/chats', input)));
  }

  send(id: number, text: string): Promise<unknown> {
    return this.changed(
      firstValueFrom(this.http.post(`/api/chats/${String(id)}/messages`, { text })),
    );
  }

  /** Answers a question the agent is waiting on; 409 when it was already answered or cancelled. */
  answerQuestion(
    chatId: number,
    questionId: number,
    body: { answer: QuestionAnswer },
  ): Promise<PendingQuestion> {
    return this.changed(
      firstValueFrom(
        this.http.post<PendingQuestion>(
          `/api/chats/${String(chatId)}/questions/${String(questionId)}/answer`,
          body,
        ),
      ),
    );
  }

  /** The plan an idea wrote, for its approval card. */
  idea(id: number): Promise<IdeaDocument> {
    return firstValueFrom(this.http.get<IdeaDocument>(`/api/chats/${String(id)}/idea`));
  }

  /** The decision about the plan: approve it as a scope or a work, or ask for changes. */
  ideaAction(id: number, body: { action: IdeaAction; text?: string }): Promise<unknown> {
    return this.changed(firstValueFrom(this.http.post(`/api/chats/${String(id)}/idea`, body)));
  }

  timeline(id: number): Promise<WorktreeTransition[]> {
    return firstValueFrom(this.http.get<WorktreeTransition[]>(`/api/chats/${String(id)}/timeline`));
  }

  /** The fine state of a scope, work or idea; null while it has none. */
  state(id: number): Promise<WorktreeState | null> {
    return firstValueFrom(this.http.get<WorktreeState | null>(`/api/chats/${String(id)}/state`));
  }

  autopilot(id: number): Promise<AutopilotInfo> {
    return firstValueFrom(this.http.get<AutopilotInfo>(`/api/chats/${String(id)}/autopilot`));
  }

  /** PRs of the work: the ones the pilot kept or, for a finished work, the ones GitHub has. */
  prs(id: number): Promise<{ urls: string[] }> {
    return firstValueFrom(this.http.get<{ urls: string[] }>(`/api/chats/${String(id)}/pr`));
  }

  /** Switch the pilot on or off, pause or resume it; 409 with a readable reason when it does not apply. */
  autopilotAction(id: number, action: 'on' | 'off' | 'pause' | 'resume'): Promise<AutopilotInfo> {
    return this.changed(
      firstValueFrom(
        this.http.post<AutopilotInfo>(`/api/chats/${String(id)}/autopilot`, { action }),
      ),
    );
  }

  /** The user's explicit OK to complete a scope with its debt still open. */
  acceptDebt(id: number, reason: string): Promise<unknown> {
    return this.changed(
      firstValueFrom(
        this.http.post(`/api/chats/${String(id)}/autopilot`, { action: 'accept_debt', reason }),
      ),
    );
  }

  cancel(id: number): Promise<unknown> {
    return this.changed(firstValueFrom(this.http.post(`/api/chats/${String(id)}/cancel`, {})));
  }
}
