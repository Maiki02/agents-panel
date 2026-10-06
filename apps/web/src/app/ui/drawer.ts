import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  inject,
  input,
  output,
  untracked,
  viewChild,
} from '@angular/core';
import { Icon } from './icon';
import {
  backdropState,
  closesOnBackdrop,
  closesOnKey,
  nextFocusIndex,
  panelTranslate,
} from './drawer-logic';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Side panel that slides in from the left over a backdrop. It stays in the DOM so the slide can
 * animate both ways; closed, it is `inert` (nothing inside can be focused or clicked). The parent
 * owns `open` and handles `(closed)`: the X, Esc and a click on the backdrop emit it. Focus moves
 * in on open and returns to the previously focused element on close.
 */
@Component({
  selector: 'app-drawer',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'onKey($event)' },
  template: `
    <div
      #backdrop
      role="presentation"
      class="fixed inset-0 z-40 bg-overlay transition-opacity duration-200 motion-reduce:transition-none"
      [class]="backdropClass()"
      (click)="onBackdrop($event)"
    ></div>
    <aside
      #panel
      role="dialog"
      aria-modal="true"
      [attr.aria-label]="heading()"
      [attr.inert]="open() ? null : ''"
      class="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-border bg-surface shadow-modal transition-transform duration-200 ease-out motion-reduce:transition-none"
      [class]="panelClass()"
    >
      <div
        class="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-3"
      >
        <h2 class="m-0 text-base font-semibold">{{ heading() }}</h2>
        <button
          type="button"
          class="inline-flex size-10 items-center justify-center rounded-control text-muted transition-colors hover:bg-surface-raised hover:text-text"
          aria-label="Cerrar"
          (click)="closed.emit()"
        >
          <app-icon name="close" />
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto p-3">
        <ng-content />
      </div>
      <ng-content select="[drawerFooter]" />
    </aside>
  `,
})
export class Drawer {
  readonly open = input.required<boolean>();
  readonly heading = input.required<string>();
  readonly closed = output();

  private readonly document = inject(DOCUMENT);
  private readonly backdrop = viewChild.required<ElementRef<HTMLElement>>('backdrop');
  private readonly panel = viewChild.required<ElementRef<HTMLElement>>('panel');
  private previous: HTMLElement | null = null;
  private wasOpen = false;

  protected backdropClass(): string {
    return backdropState(this.open());
  }

  protected panelClass(): string {
    return panelTranslate(this.open());
  }

  constructor() {
    afterRenderEffect(() => {
      const open = this.open();
      untracked(() => {
        if (open && !this.wasOpen) {
          this.previous = this.document.activeElement as HTMLElement | null;
          const panel = this.panel().nativeElement;
          const preferred = panel.querySelector<HTMLElement>('[data-autofocus]');
          (preferred ?? this.focusable()[0] ?? panel).focus();
        } else if (!open && this.wasOpen) {
          this.previous?.focus();
          this.previous = null;
        }
        this.wasOpen = open;
      });
    });
  }

  protected onBackdrop(event: MouseEvent): void {
    if (closesOnBackdrop(event.target, this.backdrop().nativeElement)) this.closed.emit();
  }

  protected onKey(event: KeyboardEvent): void {
    if (!this.open()) return;
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
    return Array.from(this.panel().nativeElement.querySelectorAll<HTMLElement>(FOCUSABLE));
  }
}
