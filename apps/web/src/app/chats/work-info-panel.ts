import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import type { Chat, WorktreeState } from '@agents-panel/shared';
import { Badge, type BadgeTone } from '../ui/badge';
import { AutopilotBar } from './autopilot-bar';
import { currentTaskView } from './phase-logic';
import { PhaseStepper } from './phase-stepper';

/** Same breakpoint as Tailwind's `lg`: from here the panel is a fixed column next to the chat. */
const WIDE_QUERY = '(min-width: 1024px)';

/**
 * Lines of the current task card: the id on top when there is one; without an id (the Plan phase)
 * the activity is the main line and nothing repeats below it.
 */
export function taskLines(task: { id: string | null; activity: string }): {
  title: string | null;
  activity: string;
} {
  return { title: task.id, activity: task.activity };
}

/**
 * Information of the worktree next to the chat: branch and state, current task, phases, pilot and
 * models. From `lg` it is a column with its own scroll; below, a collapsible summary on top whose
 * folded part keeps the branch, the state and the current task. A direct request has only the
 * branch section. Display only: the pilot bar is the one piece that acts, through its own routes.
 */
@Component({
  selector: 'app-work-info-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, Badge, AutopilotBar, PhaseStepper],
  host: { class: 'block lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain' },
  template: `
    <ng-template #branchSection>
      <div class="flex min-w-0 flex-col gap-1" data-testid="info-branch">
        <div class="flex items-center gap-2">
          <h1 class="m-0 min-w-0 truncate text-lg" [attr.title]="chat().slug">{{ chat().slug }}</h1>
          <app-badge class="shrink-0" [tone]="badge().tone">{{ badge().label }}</app-badge>
        </div>
        <p class="hint m-0 truncate" [attr.title]="place()">{{ place() }}</p>
      </div>
    </ng-template>

    <ng-template #taskSection>
      @if (task(); as t) {
        <section
          class="rounded-card border bg-surface-raised px-3 py-2"
          [class]="t.tone === 'neutral' ? 'border-accent' : 'border-border'"
          aria-label="Tarea actual"
          data-testid="info-task"
        >
          <p class="m-0 flex items-baseline gap-2 text-xs text-muted">
            <span>Tarea actual</span>
            @if (t.progress; as progress) {
              <span class="ml-auto">{{ progress }}</span>
            }
          </p>
          @let lines = taskLines(t);
          @if (lines.title; as title) {
            <p class="m-0 mt-0.5 font-medium">{{ title }}</p>
          }
          <p
            class="m-0 text-sm"
            [class.mt-0.5]="lines.title === null"
            [class.font-medium]="lines.title === null"
            [class.text-warn]="t.tone === 'warn'"
            [class.text-danger]="t.tone === 'danger'"
          >
            {{ lines.activity }}
          </p>
          @if (t.sprint; as sprint) {
            <p class="m-0 text-xs text-muted">{{ sprint }}</p>
          }
        </section>
      }
    </ng-template>

    <ng-template #restSection>
      @if (hasWork()) {
        <section aria-label="Fases">
          <app-phase-stepper [state]="state()" [vertical]="true" [showDetails]="false" />
        </section>
        <app-autopilot-bar
          [chatId]="chat().id"
          [kind]="chat().kind"
          [workState]="chat().workState ?? null"
          (changed)="pilotChanged.emit()"
        />
        <p class="hint m-0" data-testid="chat-models">
          Pensante: {{ chat().models.thinker }} · Ejecutor: {{ chat().models.executor }}
        </p>
      }
    </ng-template>

    <aside aria-label="Información del trabajo" class="flex flex-col gap-3">
      @if (wide()) {
        <ng-container [ngTemplateOutlet]="branchSection" />
        <ng-container [ngTemplateOutlet]="taskSection" />
        <ng-container [ngTemplateOutlet]="restSection" />
      } @else {
        <details class="info-fold rounded-card border border-border bg-surface">
          <summary class="flex cursor-pointer flex-col gap-2 px-3 py-2">
            <ng-container [ngTemplateOutlet]="branchSection" />
            <ng-container [ngTemplateOutlet]="taskSection" />
          </summary>
          @if (hasWork()) {
            <div class="flex flex-col gap-3 border-t border-border px-3 py-2">
              <ng-container [ngTemplateOutlet]="restSection" />
            </div>
          }
        </details>
      }
    </aside>
  `,
})
export class WorkInfoPanel {
  readonly chat = input.required<Chat>();
  readonly state = input<WorktreeState | null>(null);
  readonly badge = input.required<{ tone: BadgeTone; label: string }>();
  /** A pilot action went through: the page reads the state again. */
  readonly pilotChanged = output();

  protected readonly hasWork = computed(() => this.chat().kind !== 'direct');
  protected readonly place = computed(() => `${this.chat().projectName} · ${this.chat().branch}`);
  protected readonly task = computed(() => currentTaskView(this.state()));
  protected readonly wide = signal(false);
  protected readonly taskLines = taskLines;

  constructor() {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia(WIDE_QUERY);
    this.wide.set(query.matches);
    const onChange = (event: MediaQueryListEvent): void => {
      this.wide.set(event.matches);
    };
    query.addEventListener('change', onChange);
    inject(DestroyRef).onDestroy(() => {
      query.removeEventListener('change', onChange);
    });
  }
}
