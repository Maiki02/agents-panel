import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { WorktreeState } from '@agents-panel/shared';
import { currentTaskView, stepperView } from './phase-logic';

/** Task id and activity on one line ("W5 · Escribiendo código"); null without task activity. */
export function taskDetail(task: { id: string | null; activity: string } | null): string | null {
  if (task === null) return null;
  return task.id === null ? task.activity : `${task.id} · ${task.activity}`;
}

/**
 * Phases of a work from the idea to the PR with the current one marked, plus sprint, task and the
 * session's role and model when the state brings them. Vertical mode draws a timeline (dots joined
 * by a line, check on done phases, the task activity under the current one); horizontal mode keeps
 * pills with chevrons. Display only: it never decides anything.
 */
@Component({
  selector: 'app-phase-stepper',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav aria-label="Fases del trabajo">
      @if (vertical()) {
        <ol class="m-0 flex list-none flex-col p-0 text-sm" data-testid="phase-timeline">
          @for (step of view().steps; track step.id; let last = $last) {
            <li
              class="relative flex gap-2"
              [class.pb-3]="!last"
              [attr.aria-current]="step.status === 'current' ? 'step' : null"
              [attr.data-status]="step.status"
            >
              @if (!last) {
                <span
                  class="absolute bottom-0 left-2 top-5 w-px -translate-x-1/2"
                  [class]="step.status === 'done' ? 'bg-ok' : 'bg-border'"
                  aria-hidden="true"
                ></span>
              }
              <span
                class="z-10 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px] leading-none"
                [class]="
                  step.status === 'current'
                    ? 'border-accent bg-accent text-accent-fg'
                    : step.status === 'done'
                      ? 'border-ok bg-ok text-accent-fg'
                      : 'border-border bg-surface text-muted'
                "
                aria-hidden="true"
              >
                @if (step.status === 'done') {
                  ✓
                }
              </span>
              <span class="flex min-w-0 flex-col">
                <span
                  [class]="
                    step.status === 'current'
                      ? 'font-medium'
                      : step.status === 'done'
                        ? ''
                        : 'text-muted'
                  "
                >
                  {{ step.label }}
                </span>
                @if (step.status === 'current' && currentDetail(); as detail) {
                  <span class="text-xs text-accent" data-testid="phase-current-detail">{{
                    detail
                  }}</span>
                }
              </span>
            </li>
          }
        </ol>
      } @else {
        <ol class="m-0 flex list-none flex-wrap gap-x-1 gap-y-1 p-0 text-sm">
          @for (step of view().steps; track step.id; let last = $last) {
            <li
              class="flex items-center gap-1"
              [attr.aria-current]="step.status === 'current' ? 'step' : null"
            >
              <span
                class="rounded-pill border px-2 py-px text-xs"
                [class]="
                  step.status === 'current'
                    ? 'border-accent bg-accent font-medium text-accent-fg'
                    : step.status === 'done'
                      ? 'border-ok text-ok'
                      : 'border-border text-muted'
                "
              >
                {{ step.label }}
              </span>
              @if (!last) {
                <span class="text-muted" aria-hidden="true">›</span>
              }
            </li>
          }
        </ol>
      }
    </nav>
    @if (showDetails() && details().length > 0) {
      <p class="m-0 mt-1 text-xs text-muted">{{ details().join(' · ') }}</p>
    }
  `,
})
export class PhaseStepper {
  readonly state = input<WorktreeState | null>(null);
  /** Timeline, one phase per line (the info panel); horizontal with chevrons by default. */
  readonly vertical = input(false);
  /** Sprint, task and session line under the phases; the info panel shows them in its own sections. */
  readonly showDetails = input(true);

  protected readonly view = computed(() => stepperView(this.state()));
  /** What the task is doing, shown under the current phase in the timeline. */
  protected readonly currentDetail = computed(() => taskDetail(currentTaskView(this.state())));
  protected readonly details = computed(() => {
    const { sprint, task, session } = this.view();
    return [sprint, task, session].filter((part): part is string => part !== null);
  });
}
