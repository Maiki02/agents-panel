import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { WorktreeState } from '@agents-panel/shared';
import { stepperView } from './phase-logic';

/**
 * Phases of a work from the idea to the PR with the current one marked, plus sprint, task and the
 * session's role and model when the state brings them. Display only: it never decides anything.
 */
@Component({
  selector: 'app-phase-stepper',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav aria-label="Fases del trabajo">
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
    </nav>
    @if (details().length > 0) {
      <p class="m-0 mt-1 text-xs text-muted">{{ details().join(' · ') }}</p>
    }
  `,
})
export class PhaseStepper {
  readonly state = input<WorktreeState | null>(null);

  protected readonly view = computed(() => stepperView(this.state()));
  protected readonly details = computed(() => {
    const { sprint, task, session } = this.view();
    return [sprint, task, session].filter((part): part is string => part !== null);
  });
}
