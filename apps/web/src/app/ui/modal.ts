import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import { Icon } from './icon';
import { closesOnBackdrop, closesOnKey, nextFocusIndex } from './modal-logic';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The app's only dialog container. The parent renders it with `@if` and handles `(closed)`:
 * the X button, Esc and a click on the backdrop all emit it. Focus moves in on open and returns
 * to the previously focused element on close.
 */
@Component({
  selector: 'app-modal',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'onKey($event)' },
  template: `
    <div
      #backdrop
      role="presentation"
      class="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4"
      (click)="onBackdrop($event)"
    >
      <div
        #dialog
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="heading()"
        class="w-full max-w-md rounded-card border border-border bg-surface p-5 shadow-modal"
      >
        <div class="mb-3 flex items-center justify-between gap-3">
          <h2 class="m-0 text-lg font-semibold">{{ heading() }}</h2>
          <button
            type="button"
            class="inline-flex size-9 items-center justify-center rounded-control text-muted transition-colors hover:bg-surface-raised hover:text-text"
            aria-label="Cerrar"
            (click)="closed.emit()"
          >
            <app-icon name="close" />
          </button>
        </div>
        <ng-content />
      </div>
    </div>
  `,
})
export class Modal {
  readonly heading = input.required<string>();
  readonly closed = output();

  private readonly document = inject(DOCUMENT);
  private readonly backdrop = viewChild.required<ElementRef<HTMLElement>>('backdrop');
  private readonly dialog = viewChild.required<ElementRef<HTMLElement>>('dialog');
  private readonly previous = this.document.activeElement as HTMLElement | null;

  constructor() {
    afterNextRender(() => {
      const preferred = this.dialog().nativeElement.querySelector<HTMLElement>('[data-autofocus]');
      (preferred ?? this.focusable()[0] ?? this.dialog().nativeElement).focus();
    });
    inject(DestroyRef).onDestroy(() => {
      this.previous?.focus();
    });
  }

  protected onBackdrop(event: MouseEvent): void {
    if (closesOnBackdrop(event.target, this.backdrop().nativeElement)) this.closed.emit();
  }

  protected onKey(event: KeyboardEvent): void {
    if (closesOnKey(event.key)) {
      event.preventDefault();
      this.closed.emit();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = this.focusable();
    if (items.length === 0) return;
    const current = items.indexOf(this.document.activeElement as HTMLElement);
    event.preventDefault();
    items[nextFocusIndex(items.length, current, event.shiftKey)]?.focus();
  }

  private focusable(): HTMLElement[] {
    return Array.from(this.dialog().nativeElement.querySelectorAll<HTMLElement>(FOCUSABLE));
  }
}
