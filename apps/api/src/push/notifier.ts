import { WORKTREE_STATE_INFO, type ChatEvent, type WorktreeStateId } from '@agents-panel/shared';
import type { ChatEventBus } from '../chats/events.js';
import type { ChatRepository } from '../chats/repo.js';
import type { WorktreeStateRepository } from '../worktrees/state-repo.js';
import type { PushService } from './service.js';

/** The detail of a transition is a few lines at most: a notification is not a log. */
const MAX_BODY = 200;

/**
 * Tells every subscribed device when a work needs the user (it stopped, asks something, waits for
 * an approval) or its PR is ready. It listens to the `state_changed` events the state repository
 * already publishes, so one transition is one notice and a repeated state sends nothing.
 * Sending never throws into the pilot: a failure is logged and dropped.
 */
export class PushNotifier {
  private stop: (() => void) | undefined;

  constructor(
    private readonly deps: {
      bus: ChatEventBus;
      chats: ChatRepository;
      states: WorktreeStateRepository;
      push: PushService;
      log?: (message: string) => void;
    },
  ) {}

  start(): void {
    if (this.stop !== undefined || !this.deps.push.enabled) return;
    this.stop = this.deps.bus.subscribeAll((event) => {
      this.onEvent(event);
    });
  }

  close(): void {
    this.stop?.();
    this.stop = undefined;
  }

  /** Whether a transition into `to` by `actor` is worth waking the user for. */
  static notifies(to: WorktreeStateId, actor: string | null): boolean {
    if (to === 'pr_lista') return true;
    // A pause the user asked for is not news; one the pilot decided on is.
    if (to === 'pausado') return actor === 'pilot';
    return WORKTREE_STATE_INFO[to].who === 'user';
  }

  private onEvent(event: ChatEvent): void {
    if (event.type !== 'state_changed') return;
    const { from, to, reason, actor } = event.payload as {
      from: WorktreeStateId | null;
      to: WorktreeStateId;
      reason: string | null;
      actor: string | null;
    };
    if (from === to || !PushNotifier.notifies(to, actor)) return;
    const chat = this.deps.chats.findById(event.chatId);
    if (chat === undefined) return;
    const detail = reason ?? this.deps.states.get(event.chatId)?.detail ?? null;
    const label = WORKTREE_STATE_INFO[to].label;
    const body = detail === null || detail.trim() === '' ? label : `${label}: ${detail}`;
    const log = this.deps.log ?? (() => undefined);
    this.deps.push
      .broadcast({
        title: `${chat.projectName} · ${chat.title}`,
        body: body.slice(0, MAX_BODY),
        url: `/projects/${String(chat.projectId)}/chats/${String(chat.id)}`,
        tag: `chat-${String(chat.id)}`,
      })
      .catch((error: unknown) => {
        log(`push: ${error instanceof Error ? error.message : 'envío fallido'}`);
      });
  }
}
