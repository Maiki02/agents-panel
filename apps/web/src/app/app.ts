import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import type { HealthResponse } from '@agents-panel/shared';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main>
      <h1>{{ title() }}</h1>
      <p>API: {{ health()?.status ?? 'unknown' }}</p>
    </main>
  `,
})
export class App {
  protected readonly title = signal('agents-panel');
  protected readonly health = signal<HealthResponse | null>(null);
}
