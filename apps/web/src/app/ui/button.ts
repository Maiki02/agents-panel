import { Directive, computed, input } from '@angular/core';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'icon';

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-control text-sm font-medium transition-colors disabled:cursor-default disabled:opacity-50';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent px-3.5 py-2 text-accent-fg hover:bg-accent-hover',
  secondary: 'border border-border bg-surface px-3.5 py-2 text-text hover:bg-surface-raised',
  danger: 'bg-danger px-3.5 py-2 text-accent-fg hover:opacity-90',
  icon: 'size-9 text-muted hover:bg-surface-raised hover:text-text',
};

/** Pure so it can be unit tested: the classes of a button variant. */
export function buttonClasses(variant: ButtonVariant): string {
  return `${BASE} ${VARIANTS[variant]}`;
}

/** `<button appButton variant="primary">`: a native button styled with the identity tokens. */
@Directive({
  selector: '[appButton]',
  host: { '[class]': 'classes()' },
})
export class Button {
  readonly variant = input<ButtonVariant>('primary');
  protected readonly classes = computed(() => buttonClasses(this.variant()));
}
