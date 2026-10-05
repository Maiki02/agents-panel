import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import type { Chat, ChatEvent, QuestionAnswer } from '@agents-panel/shared';
import { ChatStreamService, type StreamHandle } from './chat-stream.service';
import { ChatsService, apiErrorMessage } from './chats.service';
import { endsTurn, pendingQuestionIds, toViewItems, type ViewItem } from './event-view';
import { QuestionCard } from './question-card';
import { DebtApprovalCard } from './debt-approval.card';
import { IdeaApprovalCard } from './idea-approval.card';
import {
  approvalCard,
  debtFromTimeline,
  movesState,
  prLinks,
  type DebtView,
} from './approval-logic';
import { chatBadge } from './status';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';

@Component({
  selector: 'app-chat',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Button, Badge, QuestionCard, IdeaApprovalCard, DebtApprovalCard],
  template: `
    @if (chat(); as c) {
      <header class="chat-head">
        <h1>{{ c.title }}</h1>
        <app-badge [tone]="badge().tone">{{ badge().label }}</app-badge>
        @if (c.status === 'running') {
          <button appButton variant="danger" type="button" (click)="cancel()">Cancelar</button>
        }
      </header>
      <p class="hint">{{ c.projectName }} · {{ c.branch }}</p>
      @if (c.status === 'interrupted') {
        <p class="banner">
          La sesión se interrumpió (el servidor se reinició). Mandá un mensaje para retomarla.
        </p>
      }
      @if (!connected() && c.status === 'running') {
        <p class="hint">Reconectando…</p>
      }
      @switch (card()) {
        @case ('idea') {
          <app-idea-approval-card [chatId]="c.id" (decided)="refreshAfterDecision()" />
        }
        @case ('debt') {
          <app-debt-approval-card
            [chatId]="c.id"
            [debt]="debt()"
            (accepted)="refreshAfterDecision()"
          />
        }
        @case ('pr') {
          <section class="card approval" aria-label="Pull request">
            <h2>La PR está lista para revisar</h2>
            @for (url of prUrls(); track url) {
              <p>
                <a [href]="url" target="_blank" rel="noopener noreferrer">{{ url }}</a>
              </p>
            } @empty {
              <p class="hint">Todavía no hay un link de la PR para mostrar.</p>
            }
          </section>
        }
      }
    }
    @if (error(); as message) {
      <p class="error" role="alert">{{ message }}</p>
    }

    <section class="feed" aria-live="polite">
      @for (item of items(); track $index) {
        @switch (item.kind) {
          @case ('user') {
            <div class="msg user">{{ item.text }}</div>
          }
          @case ('assistant') {
            <div class="msg assistant">{{ item.text }}</div>
          }
          @case ('tool') {
            <details class="msg tool">
              <summary>Herramienta: {{ item.name }}</summary>
              <pre>{{ item.input }}</pre>
            </details>
          }
          @case ('tool_result') {
            <details class="msg tool" [class.bad]="item.isError">
              <summary>{{ item.isError ? 'Resultado con error' : 'Resultado' }}</summary>
              <pre>{{ item.text }}</pre>
            </details>
          }
          @case ('denied') {
            <div class="msg denied" role="alert">
              Permiso denegado: <strong>{{ item.tool }}</strong> — {{ item.reason }}
            </div>
          }
          @case ('result') {
            <div class="msg result" [class.bad]="!item.ok">
              {{ item.ok ? 'Terminó' : 'Terminó con error' }}{{ item.text ? ': ' + item.text : '' }}
            </div>
          }
          @case ('question') {
            @if (pending().includes(item.questionId)) {
              <app-question-card
                [questions]="item.questions"
                [busy]="submitted().includes(item.questionId)"
                (answered)="answer(item.questionId, $event)"
              />
            } @else {
              <div class="msg assistant">
                @for (q of item.questions; track q.question) {
                  <div>{{ q.question }}</div>
                }
              </div>
            }
          }
          @case ('answer') {
            <div class="msg user">
              @for (line of item.lines; track line.question) {
                <div>{{ line.answer }}</div>
              }
            </div>
          }
          @case ('question_cancelled') {
            <div class="msg log">La pregunta se canceló sin respuesta.</div>
          }
          @case ('error') {
            <div class="msg denied" role="alert">Error: {{ item.text }}</div>
          }
          @case ('log') {
            <pre class="msg log">{{ item.text }}</pre>
          }
        }
      }
      <div #bottom></div>
    </section>

    @if (chat(); as c) {
      <form class="composer" (submit)="send($event)">
        <label for="message">Mensaje</label>
        <textarea
          id="message"
          rows="3"
          [disabled]="c.status === 'running'"
          [value]="draft()"
          (input)="draft.set(text($event))"
        ></textarea>
        <button
          appButton
          type="submit"
          [disabled]="c.status === 'running' || draft().trim() === '' || sending()"
        >
          Enviar
        </button>
      </form>
    }
  `,
})
export class ChatPage {
  private readonly service = inject(ChatsService);
  private readonly stream = inject(ChatStreamService);
  private readonly bottom = viewChild<ElementRef<HTMLElement>>('bottom');

  /** Route param `:chatId` (bound by withComponentInputBinding); switching chats reuses the page. */
  readonly chatId = input.required<string>();
  private current = 0;
  private generation = 0;
  private lastSeq = 0;
  private handle: StreamHandle | undefined;

  protected readonly chat = signal<Chat | null>(null);
  protected readonly items = signal<ViewItem[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly connected = signal(true);
  protected readonly draft = signal('');
  protected readonly sending = signal(false);
  /** Questions whose answer was sent and is not confirmed by the stream yet. */
  protected readonly submitted = signal<number[]>([]);
  protected readonly pending = computed(() => pendingQuestionIds(this.items()));
  /** Debt the pilot stopped for and the PRs it opened: read when the card needs them. */
  protected readonly debt = signal<DebtView[]>([]);
  protected readonly prUrls = signal<string[]>([]);
  protected readonly card = computed(() => {
    const chat = this.chat();
    return chat ? approvalCard(chat.kind, chat.workState) : null;
  });
  protected readonly badge = computed(() => {
    const status = this.chat()?.status ?? 'idle';
    return chatBadge(status, this.pending().length > 0);
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.handle?.close();
    });
    effect(() => {
      this.items();
      this.bottom()?.nativeElement.scrollIntoView({ block: 'end' });
    });
    effect(() => {
      void this.restart(Number(this.chatId()));
    });
  }

  protected text(event: Event): string {
    return (event.target as HTMLTextAreaElement).value;
  }

  /** Drops everything of the previous chat and loads the new one; stale answers are ignored. */
  private async restart(id: number): Promise<void> {
    this.handle?.close();
    this.handle = undefined;
    const generation = ++this.generation;
    this.current = id;
    this.lastSeq = 0;
    this.chat.set(null);
    this.items.set([]);
    this.error.set(null);
    this.connected.set(true);
    this.draft.set('');
    this.submitted.set([]);
    this.debt.set([]);
    this.prUrls.set([]);
    if (!Number.isInteger(id) || id < 1) {
      this.error.set('Chat no encontrado.');
      return;
    }
    try {
      const chat = await this.service.get(id);
      const events = await this.service.events(id);
      if (generation !== this.generation) return;
      this.chat.set(chat);
      this.ingest(events);
      void this.refreshWorkState();
    } catch (cause) {
      if (generation === this.generation) this.error.set(apiErrorMessage(cause));
      return;
    }
    this.handle = this.stream.open(id, this.lastSeq, {
      onEvent: (event) => {
        this.ingest([event]);
      },
      onConnection: (connected) => {
        this.connected.set(connected);
      },
    });
  }

  /** Adds events once each, in order; events already shown (seq <= lastSeq) are dropped. */
  private ingest(events: ChatEvent[]): void {
    const fresh = events.filter((event) => event.seq > this.lastSeq);
    if (fresh.length === 0) return;
    this.lastSeq = Math.max(this.lastSeq, ...fresh.map((event) => event.seq));
    this.items.update((current) => [...current, ...fresh.flatMap(toViewItems)]);
    if (fresh.some((event) => event.type === 'user_prompt')) this.setStatus('running');
    if (fresh.some(endsTurn)) void this.refreshStatus();
    if (fresh.some((event) => movesState(event.type))) void this.refreshWorkState();
  }

  private setStatus(status: Chat['status']): void {
    this.chat.update((c) => (c ? { ...c, status } : c));
  }

  /** The pilot or the agent moved the work: read its state and what the cards show. */
  protected async refreshWorkState(): Promise<void> {
    const id = this.current;
    try {
      const fresh = await this.service.get(id);
      if (id !== this.current) return;
      this.chat.update((c) =>
        c ? { ...c, workState: fresh.workState ?? null, kind: fresh.kind } : c,
      );
      const card = approvalCard(fresh.kind, fresh.workState);
      if (card === 'debt') this.debt.set(debtFromTimeline(await this.service.timeline(id)));
      if (card === 'pr') {
        const info = await this.service.autopilot(id);
        this.prUrls.set(prLinks(info.run?.prUrls ?? []));
      }
    } catch {
      // The state is a view: the next event reads it again.
    }
  }

  /** A decision about the plan or the debt went through: the work changed state and may be a new kind. */
  protected async refreshAfterDecision(): Promise<void> {
    await this.refreshStatus();
    await this.refreshWorkState();
  }

  /** The server updates the status right after the last event of a turn; read it back. */
  private async refreshStatus(): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const fresh = await this.service.get(this.current);
        this.chat.set(fresh);
        if (fresh.status !== 'running') return;
      } catch {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  protected async send(event: Event): Promise<void> {
    event.preventDefault();
    const text = this.draft().trim();
    if (text === '' || this.sending()) return;
    this.sending.set(true);
    this.error.set(null);
    try {
      await this.service.send(this.current, text);
      this.draft.set('');
      this.setStatus('running');
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.sending.set(false);
    }
  }

  protected async answer(questionId: number, body: { answer: QuestionAnswer }): Promise<void> {
    if (this.submitted().includes(questionId)) return;
    this.submitted.update((ids) => [...ids, questionId]);
    this.error.set(null);
    try {
      await this.service.answerQuestion(this.current, questionId, body);
    } catch (cause) {
      this.submitted.update((ids) => ids.filter((id) => id !== questionId));
      this.error.set(apiErrorMessage(cause));
    }
  }

  protected async cancel(): Promise<void> {
    try {
      await this.service.cancel(this.current);
      void this.refreshStatus();
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
    }
  }
}
