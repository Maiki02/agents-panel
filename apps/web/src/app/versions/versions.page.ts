import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import type { MaintenanceRun } from '@agents-panel/shared';
import { apiErrorMessage } from '../chats/chats.service';
import { TotpModal } from '../shared/totp-modal';
import { latestLabel, runLabel } from './version-label';
import { VersionsService, type VersionsResponse } from './versions.service';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Icon } from '../ui/icon';
import type { BadgeTone } from '../ui/badge';

const POLL_MS = 3000;
const RUN_STATUS: Record<MaintenanceRun['status'], string> = {
  running: 'En curso',
  ok: 'Listo',
  error: 'Error',
};

@Component({
  selector: 'app-versions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, TotpModal, Button, Badge, Icon],
  template: `
    <h2>Versiones</h2>
    @if (error(); as message) {
      <p class="error" role="alert">{{ message }}</p>
    }
    <section class="card">
      @if (info(); as kyro) {
        <div class="flex items-start justify-between gap-3">
          <div>
            <h3>Kyro</h3>
            <p class="m-0">
              Instalada: <strong>{{ kyro.installed ?? 'desconocida' }}</strong> ·
              {{ latest(kyro.installed, kyro.latest) }}
            </p>
            @if (kyro.updateRunning) {
              <p class="hint" role="status">
                Actualizando… no arrancan sesiones nuevas hasta que termine.
              </p>
            }
          </div>
          <button
            appButton
            variant="icon"
            type="button"
            aria-label="Actualizar Kyro"
            title="Actualizar Kyro"
            [disabled]="kyro.updateRunning || busy()"
            (click)="openModal()"
          >
            <app-icon name="refresh" [spin]="kyro.updateRunning" />
          </button>
        </div>
        @if (asking()) {
          <app-totp-modal
            heading="Actualizar Kyro"
            submitLabel="Actualizar"
            [busy]="busy()"
            [error]="totpError()"
            (submitted)="update($event)"
            (closed)="asking.set(false)"
          />
        }
      } @else {
        <h3>Kyro</h3>
      }
    </section>

    <section class="card">
      <h3>Historial</h3>
      @for (run of runs(); track run.id) {
        <details class="run">
          <summary>
            {{ run.startedAt | date: 'short' }} · {{ runText(run) }} ·
            <app-badge [tone]="tone(run)">{{ statusText(run) }}</app-badge>
          </summary>
          @if (run.skipped.length > 0) {
            <p class="hint" role="status">
              No se actualizó el workspace de
              {{ run.skipped.length === 1 ? 'este proyecto' : 'estos proyectos' }}
              porque tienen cambios locales fuera de .agents/kyro/:
              @for (root of run.skipped; track root) {
                <code class="block">{{ root }}</code>
              }
              Commiteá o descartá esos cambios y volvé a actualizar.
            </p>
          }
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
  protected readonly totpError = signal<string | null>(null);
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

  protected tone(run: MaintenanceRun): BadgeTone {
    return run.status === 'ok' ? 'ok' : run.status === 'error' ? 'danger' : 'accent';
  }

  protected openModal(): void {
    this.totpError.set(null);
    this.asking.set(true);
  }

  protected async update(code: string): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.totpError.set(null);
    try {
      await this.service.update(code);
      this.asking.set(false);
    } catch (cause) {
      // Shown inside the modal, which stays open: a wrong code (401) or the 409 with the number
      // of running sessions. Neither leaves the page.
      this.totpError.set(apiErrorMessage(cause));
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
