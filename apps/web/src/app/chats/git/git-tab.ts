import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import type {
  AutopilotStatus,
  ChatKind,
  ChatStatus,
  DiffAgainst,
  ManualStep,
  RepoOpOutcome,
  RepoStatus,
  WorktreeStateId,
} from '@agents-panel/shared';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { ChatsService, apiErrorMessage } from '../chats.service';
import { CommitModal, type CommitChoice } from './commit.modal';
import { DeleteWorkModal } from './delete-work.modal';
import { DiffModal } from './diff.modal';
import { DiscardModal } from './discard.modal';
import { PrModal } from './pr.modal';
import {
  conflictMessage,
  gitBlockedReason,
  outcomeLabel,
  outcomeTone,
  stepButtons,
} from './git-logic';
import { GitService, type GitOpResult } from './git.service';
import { RepoCard, type RepoAction, type RepoResult } from './repo-card';

/**
 * Git tab of a work: a card per repo (root and children) with its state and operations (D19).
 * Buttons are disabled with their reason while the agent runs, the pilot is busy or the work is
 * archived; the API's own 409 is shown as it comes. One operation at a time per work.
 */
@Component({
  selector: 'app-git-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    Badge,
    Button,
    CommitModal,
    DeleteWorkModal,
    DiffModal,
    DiscardModal,
    PrModal,
    RepoCard,
  ],
  template: `
    <section class="my-3 flex flex-col gap-3" aria-label="Git">
      <div class="flex flex-wrap items-center gap-2">
        <button
          appButton
          variant="secondary"
          type="button"
          [disabled]="loading() || running() !== null"
          (click)="reload()"
        >
          Actualizar
        </button>
        <button
          appButton
          variant="secondary"
          type="button"
          [disabled]="blocked() !== null || running() !== null"
          [title]="blocked() ?? ''"
          (click)="reinstall()"
        >
          Reinstalar dependencias
        </button>
        <button
          appButton
          type="button"
          [disabled]="blocked() !== null || running() !== null"
          [title]="blocked() ?? ''"
          (click)="prOpen.set(true)"
        >
          Crear PR
        </button>
        <button
          appButton
          variant="danger"
          type="button"
          [disabled]="blocked() !== null || running() !== null"
          [title]="blocked() ?? ''"
          (click)="deleting.set(true)"
        >
          Borrar trabajo
        </button>
        @if (running(); as op) {
          <span class="text-sm text-muted" role="status">{{ op.label }}…</span>
        }
      </div>
      @if (steps().length > 0) {
        <section
          class="rounded-card border border-border bg-surface p-3"
          aria-label="Pasos del agente"
        >
          <h3 class="mt-0 mb-2 text-base font-semibold">Pasos del agente</h3>
          <div class="flex flex-wrap gap-2">
            @for (item of steps(); track item.step) {
              <button
                appButton
                variant="secondary"
                type="button"
                [disabled]="blocked() !== null || running() !== null"
                [title]="blocked() ?? item.label"
                (click)="runStep(item.step, item.label)"
              >
                {{ item.label }}
              </button>
            }
          </div>
          @if (stepNote(); as note) {
            <p class="mt-2 mb-0 text-sm" role="status">{{ note }}</p>
          }
        </section>
      }
      @if (blocked(); as why) {
        <p class="m-0 text-sm text-warn" role="status">{{ why }}</p>
      }
      @if (error(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }
      @if (reinstallResult(); as r) {
        <div class="rounded-card border border-border bg-surface p-3" role="status">
          <div class="flex items-center gap-2 text-sm">
            <app-badge [tone]="tone(r)">{{ outcomeText(r) }}</app-badge>
            <span>{{
              r.auto ? 'Reinstalación automática (cambió un lockfile)' : 'Reinstalar dependencias'
            }}</span>
          </div>
          @if (r.outcome.output) {
            <pre class="mt-2 mb-0 max-h-48 overflow-auto whitespace-pre-wrap text-xs">{{
              r.outcome.output
            }}</pre>
          }
        </div>
      }
      @if (loading() && repos().length === 0) {
        <p class="hint">Leyendo el estado de git…</p>
      }
      @for (repo of repos(); track repo.path) {
        <app-repo-card
          [repo]="repo"
          [blockedReason]="blocked()"
          [workBusy]="running() !== null"
          [busyAction]="busyFor(repo.path)"
          [result]="results()[repo.path] ?? null"
          (act)="onAction(repo, $event)"
          (askAgent)="askAgent(repo.path, $event)"
        />
      }
      @if (committing(); as repo) {
        <app-commit-modal
          [repo]="repo"
          (confirmed)="commit(repo, $event)"
          (showDiff)="viewing.set({ repo: repo.path, against: 'worktree' })"
          (closed)="committing.set(null)"
        />
      }
      @if (discarding(); as repo) {
        <app-discard-modal
          [chatId]="chatId()"
          [repo]="repo"
          (discarded)="afterDiscard()"
          (closed)="discarding.set(null)"
        />
      }
      @if (viewing(); as view) {
        <app-diff-modal
          [chatId]="chatId()"
          [repo]="view.repo"
          [initial]="view.against"
          (closed)="viewing.set(null)"
        />
      }
      @if (prOpen()) {
        <app-pr-modal
          [chatId]="chatId()"
          [blockedReason]="blocked()"
          (viewChanges)="viewing.set({ repo: $event, against: 'base' })"
          (runMergeDev)="mergeDev()"
          (created)="reload()"
          (closed)="prOpen.set(false)"
        />
      }
      @if (deleting()) {
        <app-delete-work-modal
          [chatId]="chatId()"
          (deleted)="afterDelete()"
          (closed)="deleting.set(false)"
        />
      }
    </section>
  `,
})
export class GitTab {
  private readonly git = inject(GitService);
  private readonly chats = inject(ChatsService);

  readonly chatId = input.required<number>();
  readonly chatStatus = input.required<ChatStatus>();
  readonly workState = input<WorktreeStateId | null | undefined>(null);
  readonly kind = input<ChatKind>('direct');
  /** A message was sent to the agent (a conflict handed over): the page refreshes the chat. */
  readonly messageSent = output();
  /** An agent step started: the page shows the chat, where its turn runs. */
  readonly stepStarted = output();
  /** The work changed state (completed, deleted): the page reads it again. */
  readonly workChanged = output();

  protected readonly repos = signal<RepoStatus[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly results = signal<Record<string, RepoResult>>({});
  protected readonly reinstallResult = signal<{ outcome: RepoOpOutcome; auto: boolean } | null>(
    null,
  );
  protected readonly running = signal<{
    repo: string | null;
    action: RepoAction | null;
    label: string;
  } | null>(null);
  protected readonly committing = signal<RepoStatus | null>(null);
  protected readonly discarding = signal<RepoStatus | null>(null);
  protected readonly viewing = signal<{ repo: string; against: DiffAgainst } | null>(null);
  protected readonly prOpen = signal(false);
  protected readonly deleting = signal(false);
  protected readonly stepNote = signal<string | null>(null);
  /** Steps of this kind of chat; merge-dev lives in the PR dialog, where the project's skill is known. */
  protected readonly steps = computed(() => stepButtons(this.kind(), false));
  private readonly pilotStatus = signal<AutopilotStatus | null>(null);

  protected readonly blocked = computed(() =>
    gitBlockedReason({
      chatStatus: this.chatStatus(),
      workState: this.workState(),
      pilotStatus: this.pilotStatus(),
    }),
  );
  protected readonly tone = (r: { outcome: RepoOpOutcome }) => outcomeTone(r.outcome);
  protected readonly outcomeText = (r: { outcome: RepoOpOutcome }) => outcomeLabel(r.outcome);

  constructor() {
    effect(() => {
      this.chatId();
      this.chatStatus();
      untracked(() => {
        void this.reload();
      });
    });
  }

  protected async reload(): Promise<void> {
    const id = this.chatId();
    this.loading.set(true);
    try {
      const [status, pilot] = await Promise.all([
        this.git.status(id),
        this.chats.autopilot(id).catch(() => null),
      ]);
      if (id !== this.chatId()) return;
      this.repos.set(status.repos);
      this.pilotStatus.set(pilot?.run?.status ?? null);
      this.error.set(null);
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.loading.set(false);
    }
  }

  protected busyFor(repo: string): RepoAction | null {
    const op = this.running();
    return op?.repo === repo ? op.action : null;
  }

  protected onAction(repo: RepoStatus, action: RepoAction | 'diff' | 'discard'): void {
    if (action === 'commit') {
      this.committing.set(repo);
      return;
    }
    if (action === 'discard') {
      this.discarding.set(repo);
      return;
    }
    if (action === 'diff') {
      this.viewing.set({ repo: repo.path, against: 'worktree' });
      return;
    }
    const labels = {
      'pull-base': 'Trayendo la base',
      'pull-branch': 'Trayendo tu rama',
      push: 'Pusheando',
    };
    const run = {
      'pull-base': () => this.git.pullBase(this.chatId(), repo.path),
      'pull-branch': () => this.git.pullBranch(this.chatId(), repo.path),
      push: () => this.git.push(this.chatId(), repo.path),
    }[action];
    void this.operate(repo.path, action, labels[action], run);
  }

  protected commit(repo: RepoStatus, choice: CommitChoice): void {
    this.committing.set(null);
    void this.operate(repo.path, 'commit', 'Commiteando', () =>
      this.git.commit(this.chatId(), { repo: repo.path, ...choice }),
    );
  }

  protected afterDiscard(): void {
    this.discarding.set(null);
    void this.reload();
  }

  /** The work is archived now: the page reads its state and the tab shows it read only. */
  protected afterDelete(): void {
    this.deleting.set(false);
    this.workChanged.emit();
    void this.reload();
  }

  /** The project's own merge-dev, asked for from the PR dialog. */
  protected mergeDev(): void {
    this.prOpen.set(false);
    this.runStep('merge_dev', 'Correr merge-dev');
  }

  /** Launches an agent step, or completes the work; the API explains a 409 (pilot, agent, kind). */
  protected runStep(step: ManualStep, label: string): void {
    void this.operate(null, null, label, async () => {
      const outcome = await this.git.runStep(this.chatId(), step);
      if (outcome.launched !== null) {
        this.stepStarted.emit();
        this.stepNote.set(null);
      } else {
        this.stepNote.set(outcome.output ?? 'Listo.');
        this.workChanged.emit();
      }
      return { repos: [], reinstall: null, warning: null };
    });
  }

  protected reinstall(): void {
    void this.operate(null, null, 'Reinstalando dependencias', async () => {
      const result = await this.git.reinstall(this.chatId());
      const outcome = result.repos[0];
      if (outcome) this.reinstallResult.set({ outcome, auto: false });
      return { ...result, repos: [] };
    });
  }

  protected async askAgent(repo: string, result: RepoResult): Promise<void> {
    const files = result.outcome.conflicts ?? [];
    const operation = result.action === 'pull-base' ? 'base' : 'branch';
    this.error.set(null);
    try {
      await this.chats.send(this.chatId(), conflictMessage(operation, repo, files));
      this.messageSent.emit();
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
    }
  }

  /** Runs one operation: the buttons stay disabled meanwhile, and the card shows its result. */
  private async operate(
    repo: string | null,
    action: RepoAction | null,
    label: string,
    run: () => Promise<GitOpResult>,
  ): Promise<void> {
    if (this.running() !== null) return;
    this.running.set({ repo, action, label });
    this.error.set(null);
    try {
      const result = await run();
      const next = { ...this.results() };
      if (action !== null) {
        for (const outcome of result.repos) next[outcome.path] = { action, outcome };
      }
      if (result.warning && repo !== null) {
        const current = next[repo];
        if (current) {
          next[repo] = {
            ...current,
            outcome: { ...current.outcome, output: `${result.warning}\n${current.outcome.output}` },
          };
        }
      }
      this.results.set(next);
      if (result.reinstall) this.reinstallResult.set({ outcome: result.reinstall, auto: true });
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.running.set(null);
      await this.reload();
    }
  }
}
