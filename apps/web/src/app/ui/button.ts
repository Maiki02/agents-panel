import { Directive, computed, input } from '@angular/core';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost-danger' | 'icon';
export type ButtonSize = 'md' | 'sm';

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-control text-sm font-medium transition-colors disabled:cursor-default disabled:opacity-50';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent px-3.5 py-2 text-accent-fg hover:bg-accent-hover',
  secondary: 'border border-border bg-surface px-3.5 py-2 text-text hover:bg-surface-raised',
  danger: 'bg-danger px-3.5 py-2 text-accent-fg hover:opacity-90',
  // Discreet: text only, danger tone, no fill.
  'ghost-danger': 'px-3.5 py-2 text-danger hover:bg-surface-raised',
  icon: 'size-9 text-muted hover:bg-surface-raised hover:text-text',
};

/** Compact padding and text; replaces the padding of the variant (the icon has a fixed size). */
const SMALL = 'px-2.5 py-1 text-xs';

/** Pure so it can be unit tested: the classes of a button variant. */
export function buttonClasses(variant: ButtonVariant, size: ButtonSize = 'md'): string {
  const classes = VARIANTS[variant];
  if (size === 'md' || variant === 'icon') return `${BASE} ${classes}`;
  const withoutPadding = classes
    .split(' ')
    .filter((c) => !/^p[xy]-/.test(c))
    .join(' ');
  return `${BASE.replace('text-sm', '')} ${withoutPadding} ${SMALL}`;
}

/** `<button appButton variant="primary">`: a native button styled with the identity tokens. */
@Directive({
  selector: '[appButton]',
  host: { '[class]': 'classes()' },
})
export class Button {
  readonly variant = input<ButtonVariant>('primary');
  readonly size = input<ButtonSize>('md');
  protected readonly classes = computed(() => buttonClasses(this.variant(), this.size()));
}
