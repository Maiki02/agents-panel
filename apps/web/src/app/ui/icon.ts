import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import accountCircle from '@material-symbols/svg-400/outlined/account_circle.svg';
import add from '@material-symbols/svg-400/outlined/add.svg';
import chat from '@material-symbols/svg-400/outlined/chat.svg';
import close from '@material-symbols/svg-400/outlined/close.svg';
import folder from '@material-symbols/svg-400/outlined/folder.svg';
import forum from '@material-symbols/svg-400/outlined/forum.svg';
import logout from '@material-symbols/svg-400/outlined/logout.svg';
import menu from '@material-symbols/svg-400/outlined/menu.svg';
import notifications from '@material-symbols/svg-400/outlined/notifications.svg';
import refresh from '@material-symbols/svg-400/outlined/refresh.svg';
import settings from '@material-symbols/svg-400/outlined/settings.svg';
import update from '@material-symbols/svg-400/outlined/update.svg';
import { MATERIAL_VIEW_BOX, svgPathData } from './icon-logic';

/**
 * Google Material Symbols (Outlined, weight 400) from the `@material-symbols/svg-400` package.
 * Only the icons imported here end up in the bundle (the build loads `.svg` as text). To add
 * one: import its file from the package and add it to ICON_SVGS.
 */
const ICON_SVGS = {
  account: accountCircle,
  chat,
  chats: forum,
  close,
  folder,
  logout,
  menu,
  notifications,
  plus: add,
  refresh,
  settings,
  update,
} as const;

export type IconName = keyof typeof ICON_SVGS;

const ICON_PATHS = Object.fromEntries(
  Object.entries(ICON_SVGS).map(([name, svg]) => [name, svgPathData(svg)]),
) as Record<IconName, string>;

@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex shrink-0', 'aria-hidden': 'true' },
  template: `
    <svg class="size-5" [class.animate-spin]="spin()" [attr.viewBox]="viewBox" fill="currentColor">
      <path [attr.d]="path()" />
    </svg>
  `,
})
export class Icon {
  readonly name = input.required<IconName>();
  /** Rotates the icon (for example a refresh while an action is running). */
  readonly spin = input(false);

  protected readonly viewBox = MATERIAL_VIEW_BOX;

  protected path(): string {
    return ICON_PATHS[this.name()];
  }
}
