import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import type { PrPreview, PrRepoOutcome } from '@agents-panel/shared';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Modal } from '../../ui/modal';
import { apiErrorMessage } from '../chats.service';
import { outcomeLabel, outcomeTone, prOutcomeText, repoTitle } from './git-logic';
import { GitService } from './git.service';

interface Draft {
  title: string;
  body: string;
}

/**
 * Create the PR of every repo with commits outside its base (D25): prefilled title and body, both
 * editable, and the link of a PR that already exists. In a project with its own merge-dev the main
 * button is "Correr merge-dev"; the plain PR stays as the secondary one.
 */
@Component({
  selector: 'app-pr-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Badge, Button, Modal],
  template: `
    <app-modal heading="Crear PR" [wide]="true" (closed)="closed.emit()">
      @if (error(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }
      @if (loading()) {
        <p class="hint">Leyendo los commits del trabajo…</p>
      } @else if (preview(); as p) {
        @if (p.repos.length === 0) {
          <p class="hint">Ningún repo tiene commits fuera de su base: no hay nada para abrir.</p>
        }
        @for (repo of p.repos; track repo.path) {
          <section
            class="mb-3 rounded-card border border-border p-3"
            [attr.aria-label]="'PR de ' + name(repo.path)"
          >
            <div class="mb-2 flex flex-wrap items-center gap-2 text-sm">
              <strong>{{ name(repo.path) }}</strong>
              <span class="text-muted">
                {{ repo.branch }} → {{ repo.baseBranch }} · {{ repo.commits }}
                {{ repo.commits === 1 ? 'commit' : 'commits' }}
              </span>
              <button
                appButton
                variant="secondary"
                type="button"
                (click)="viewChanges.emit(repo.path)"
              >
                Ver cambios
              </button>
            </div>
            @if (repo.openPrUrl; as url) {
              <p class="mt-0 mb-2 text-sm">
                Ya hay una PR abierta:
                <a [href]="url" target="_blank" rel="noopener noreferrer">{{ url }}</a>
                (el push la actualiza).
              </p>
            }
            <label class="mb-2 flex flex-col gap-1 text-sm font-medium">
              Título
              <input
                class="rounded-control border border-border bg-surface px-2 py-1 font-normal"
                [value]="draft(repo.path).title"
                (input)="edit(repo.path, 'title', $event)"
              />
            </label>
            <label class="flex flex-col gap-1 text-sm font-medium">
              Descripción
              <textarea
                rows="6"
                class="rounded-control border border-border bg-surface px-2 py-1 font-normal"
                [value]="draft(repo.path).body"
                (input)="edit(repo.path, 'body', $event)"
              ></textarea>
            </label>
            @if (outcomeOf(repo.path); as o) {
              <div class="mt-2 flex flex-wrap items-center gap-2 text-sm" role="status">
                <app-badge [tone]="tone(o)">{{ label(o) }}</app-badge>
                <span>{{ text(o) }}</span>
                @if (o.url; as url) {
                  <a [href]="url" target="_blank" rel="noopener noreferrer">{{ url }}</a>
                }
              </div>
              @if (o.result === 'error' && o.output && !o.secrets?.length) {
                <pre class="mt-1 mb-0 max-h-32 overflow-auto whitespace-pre-wrap text-xs">{{
                  o.output
                }}</pre>
              }
            }
          </section>
        }
        @if (blockedReason(); as why) {
          <p class="text-sm text-warn" role="status">{{ why }}</p>
        }
        <div class="flex flex-wrap justify-end gap-2">
          <button appButton variant="secondary" type="button" (click)="closed.emit()">
            Cerrar
          </button>
          @if (p.hasMergeDev) {
            <button
              appButton
              variant="secondary"
              type="button"
              [disabled]="busy() || blockedReason() !== null || p.repos.length === 0"
              (click)="create()"
            >
              Crear PR
            </button>
            <button
              appButton
              type="button"
              [disabled]="busy() || blockedReason() !== null"
              [title]="blockedReason() ?? ''"
              (click)="runMergeDev.emit()"
            >
              Correr merge-dev
            </button>
          } @else {
            <button
              appButton
              type="button"
              [disabled]="busy() || blockedReason() !== null || p.repos.length === 0"
              [title]="blockedReason() ?? ''"
              (click)="create()"
            >
              {{ busy() ? 'Creando…' : 'Crear PR' }}
            </button>
          }
        </div>
      }
    </app-modal>
  `,
})
export class PrModal {
  private readonly git = inject(GitService);

  readonly chatId = input.required<number>();
  /** Why the buttons are disabled (agent running, pilot busy, archived); null when they work. */
  readonly blockedReason = input<string | null>(null);
  readonly viewChanges = output<string>();
  /** The project's own merge-dev was asked for: the tab launches the step. */
  readonly runMergeDev = output();
  /** At least one PR was created or updated: the tab reloads. */
  readonly created = output();
  readonly closed = output();

  protected readonly preview = signal<PrPreview | null>(null);
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  private readonly drafts = signal<Record<string, Draft>>({});
  private readonly outcomes = signal<Record<string, PrRepoOutcome>>({});

  protected readonly tone = outcomeTone;
  protected readonly label = outcomeLabel;
  protected readonly text = prOutcomeText;
  protected readonly name = repoTitle;
  protected readonly hasRepos = computed(() => (this.preview()?.repos.length ?? 0) > 0);

  constructor() {
    void this.load();
  }

  protected draft(path: string): Draft {
    return this.drafts()[path] ?? { title: '', body: '' };
  }

  protected outcomeOf(path: string): PrRepoOutcome | null {
    return this.outcomes()[path] ?? null;
  }

  protected edit(path: string, field: keyof Draft, event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
    this.drafts.update((all) => ({ ...all, [path]: { ...this.draft(path), [field]: value } }));
  }

  private async load(): Promise<void> {
    try {
      const preview = await this.git.prPreview(this.chatId());
      this.preview.set(preview);
      this.drafts.set(
        Object.fromEntries(preview.repos.map((r) => [r.path, { title: r.title, body: r.body }])),
      );
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.loading.set(false);
    }
  }

  protected async create(): Promise<void> {
    const preview = this.preview();
    if (!preview || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const outcomes = await this.git.createPr(
        this.chatId(),
        preview.repos.map((r) => ({ repo: r.path, ...this.draft(r.path) })),
      );
      this.outcomes.set(Object.fromEntries(outcomes.map((o) => [o.path, o])));
      if (outcomes.some((o) => o.result === 'ok')) this.created.emit();
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
    } finally {
      this.busy.set(false);
    }
  }
}
