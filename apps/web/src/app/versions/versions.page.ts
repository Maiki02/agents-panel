import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import type { MaintenanceRun } from '@agents-panel/shared';
import { apiErrorMessage } from '../chats/chats.service';
import { TotpDialog } from '../shared/totp-dialog';
import { latestLabel, runLabel } from './version-label';
import { VersionsService, type VersionsResponse } from './versions.service';

const POLL_MS = 3000;
const RUN_STATUS: Record<MaintenanceRun['status'], string> = {
  running: 'En curso',
  ok: 'Listo',
  error: 'Error',
};

@Component({
  selector: 'app-versions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, TotpDialog],
  template: `
    <h2>Versiones</h2>
    @if (error(); as message) {
      <p class="error" role="alert">{{ message }}</p>
    }
    <section class="card">
      <h3>Kyro</h3>
      @if (info(); as kyro) {
        <p>
          Instalada: <strong>{{ kyro.installed ?? 'desconocida' }}</strong> ·
          {{ latest(kyro.installed, kyro.latest) }}
        </p>
        @if (kyro.updateRunning) {
          <p class="hint" role="status">
            Actualizando… no arrancan sesiones nuevas hasta que termine.
          </p>
        }
        @if (asking()) {
          <app-totp-dialog
            submitLabel="Actualizar"
            [busy]="busy()"
            (submitted)="update($event)"
            (cancelled)="asking.set(false)"
          />
        } @else {
          <button
            type="button"
            [disabled]="kyro.updateRunning || busy()"
            (click)="asking.set(true)"
          >
            Actualizar
          </button>
        }
      }
    </section>

    <section class="card">
      <h3>Historial</h3>
      @for (run of runs(); track run.id) {
        <details class="run">
          <summary>
            {{ run.startedAt | date: 'short' }} · {{ runText(run) }} ·
            <span class="badge" [class]="'badge ' + badge(run)">{{ statusText(run) }}</span>
          </summary>
          @if (run.output) {
            <pre>{{ run.output }}</pre>
          } @else {
            <p class="hint">Sin salida todavía.</p>
          }
        </details>
      } @empty {
        <p class="hint">Todavía no hay actualizaciones.</p>
      }
    </section>
  `,
})
export class VersionsPage {
  private readonly service = inject(VersionsService);

  protected readonly info = signal<VersionsResponse['kyro'] | null>(null);
  protected readonly runs = signal<MaintenanceRun[]>([]);
  protected readonly asking = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.stopPolling();
    });
    void this.refresh();
  }

  protected latest(installed: string | null, latest: string | null): string {
    return latestLabel(installed, latest);
  }

  protected runText(run: MaintenanceRun): string {
    return runLabel(run);
  }

  protected statusText(run: MaintenanceRun): string {
    return RUN_STATUS[run.status];
  }

  protected badge(run: MaintenanceRun): string {
    return run.status === 'ok' ? 'idle' : run.status === 'error' ? 'error' : 'running';
  }

  protected async update(code: string): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.service.update(code);
      this.asking.set(false);
    } catch (cause) {
      // 409 (sessions running) carries its own message with the count; 401 keeps the page.
      this.error.set(apiErrorMessage(cause));
      this.asking.set(false);
    } finally {
      this.busy.set(false);
    }
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      const [versions, runs] = await Promise.all([this.service.get(), this.service.runs()]);
      this.info.set(versions.kyro);
      this.runs.set(runs);
      if (versions.kyro.updateRunning) {
        this.timer ??= setInterval(() => void this.refresh(), POLL_MS);
      } else {
        this.stopPolling();
      }
    } catch (cause) {
      this.error.set(apiErrorMessage(cause));
      this.stopPolling();
    }
  }

  private stopPolling(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
