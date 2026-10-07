import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject } from '@angular/core';
import { Button } from '../ui/button';
import { CapacityService } from './capacity.service';
import {
  MEASURING_TEXT,
  NO_DATA_TEXT,
  diskSegments,
  formatBytes,
  formatMeasuredAt,
  memorySegments,
  swapText,
} from './capacity-logic';
import type { BarSegment } from './capacity-logic';

const POLL_MS = 3000;

const COLORS: Record<string, string> = {
  projects: 'bg-accent',
  worktrees: 'bg-ok',
  ai: 'bg-accent',
  panel: 'bg-ok',
  other: 'bg-warn',
  available: 'bg-border',
  free: 'bg-border',
};

/** Disk bar and RAM bar at the top of the Proyectos page; reads again every 3 s while shown. */
@Component({
  selector: 'app-capacity-bars',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Button, NgTemplateOutlet],
  template: `
    <section class="card mb-4" aria-label="Capacidad de la VM">
      <div class="flex items-center justify-between gap-3">
        <h3 class="m-0">Disco</h3>
        <div class="flex items-center gap-3">
          @if (measuredAt(); as at) {
            <span class="meta">Medido a las {{ at }}</span>
          }
          @if (service.measuringDisk()) {
            <span class="meta" role="status">{{ measuringText }}</span>
          }
          <button
            appButton
            variant="secondary"
            type="button"
            [disabled]="service.measuringDisk()"
            (click)="recalc()"
          >
            Recalcular
          </button>
        </div>
      </div>
      @switch (service.diskState()) {
        @case ('ready') {
          <ng-container
            [ngTemplateOutlet]="bar"
            [ngTemplateOutletContext]="{ segments: disk(), label: 'Uso del disco' }"
          />
        }
        @case ('measuring') {
          <p class="hint" role="status">{{ measuringText }}</p>
        }
        @default {
          <p class="hint">{{ noData }}</p>
        }
      }

      <h3 class="mb-0 mt-4">RAM</h3>
      @switch (service.memoryState()) {
        @case ('ready') {
          <ng-container
            [ngTemplateOutlet]="bar"
            [ngTemplateOutletContext]="{ segments: ram(), label: 'Uso de la RAM' }"
          />
          <p class="meta">Swap usado: {{ swap() }}</p>
        }
        @case ('measuring') {
          <p class="hint" role="status">{{ measuringText }}</p>
        }
        @default {
          <p class="hint">{{ noData }}</p>
        }
      }
    </section>

    <ng-template #bar let-segments="segments" let-label="label">
      <div
        class="my-2 flex h-3 w-full overflow-hidden rounded-pill border border-border"
        role="img"
        [attr.aria-label]="label"
      >
        @for (s of segments; track s.key) {
          <div [class]="color(s)" [style.width.%]="s.percent"></div>
        }
      </div>
      <ul class="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-sm">
        @for (s of segments; track s.key) {
          <li class="flex items-center gap-1">
            <span class="inline-block h-2 w-2 rounded-pill" [class]="color(s)"></span>
            {{ s.label }}: {{ bytes(s) }} ({{ s.percent }} %)
          </li>
        }
      </ul>
    </ng-template>
  `,
})
export class CapacityBars {
  protected readonly service = inject(CapacityService);
  protected readonly measuringText = MEASURING_TEXT;
  protected readonly noData = NO_DATA_TEXT;

  protected readonly disk = computed(() => diskSegments(this.service.disk()));
  protected readonly ram = computed(() => memorySegments(this.service.memory()));
  protected readonly swap = computed(() => swapText(this.service.memory()));
  protected readonly measuredAt = computed(() =>
    formatMeasuredAt(this.service.disk()?.measuredAt ?? null),
  );

  constructor() {
    void this.service.load();
    const timer = setInterval(() => void this.service.load(), POLL_MS);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(timer);
    });
  }

  protected color(segment: BarSegment): string {
    return COLORS[segment.key] ?? 'bg-border';
  }

  protected bytes(segment: BarSegment): string {
    return formatBytes(segment.bytes);
  }

  protected recalc(): void {
    void this.service.refresh();
  }
}
