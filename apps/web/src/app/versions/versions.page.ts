import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import type { MaintenanceRun, PanelDeployInfo } from '@agents-panel/shared';
import { apiErrorMessage } from '../chats/chats.service';
import { TotpModal } from '../shared/totp-modal';
import { behindLabel, deployPhase, latestLabel, runLabel, type DeployPhase } from './version-label';
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

    <section class="card" aria-label="Panel">
      <div class="flex items-start justify-between gap-3">
        <div>
          <h3>Panel</h3>
          @if (panel(); as p) {
            <p class="m-0">
              Commit: <strong>{{ p.commit ?? 'desconocido' }}</strong> · {{ behind(p.behind) }}
            </p>
            @if (p.unavailableReason) {
              <p class="hint">{{ p.unavailableReason }}</p>
            }
          }
          @switch (deploy()) {
            @case ('running') {
              <p class="hint" role="status">
                Desplegando… no arrancan sesiones nuevas hasta que termine.
              </p>
            }
            @case ('restarting') {
              <p class="hint" role="status">Reiniciando el panel…</p>
            }
            @case ('done') {
              <p class="hint" role="status">
                Listo: el panel ya corre el commit nuevo.
                <button appButton type="button" (click)="reload()">Refrescar la página</button>
              </p>
            }
          }
        </div>
        <button
          appButton
          variant="icon"
          type="button"
          aria-label="Desplegar el panel"
          [title]="
            panel()?.unavailableReason ?? 'Desplegar el panel (trae main, compila y reinicia)'
          "
          [disabled]="!canDeploy()"
          (click)="openDeploy()"
        >
          <app-icon name="refresh" [spin]="deploy() === 'running' || deploy() === 'restarting'" />
        </button>
      </div>
      @if (askingDeploy()) {
        <app-totp-modal
          heading="Desplegar el panel"
          submitLabel="Desplegar"
          [busy]="busy()"
          [error]="totpError()"
          (submitted)="startDeploy($event)"
          (closed)="askingDeploy.set(false)"
        />
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
  protected readonly panel = signal<PanelDeployInfo | null>(null);
  protected readonly runs = signal<MaintenanceRun[]>([]);
  protected readonly askingDeploy = signal(false);
  /** Where the deploy started from this page is; null when none is being followed. */
  protected readonly deploy = signal<DeployPhase | null>(null);
  /** Commit the server ran when the deploy started: another one means the restart is over. */
  private deployFrom: string | null = null;
  protected readonly canDeploy = computed(() => {
    const p = this.panel();
    const phase = this.deploy();
    return (
      p !== null &&
      // Without the running commit the page could not tell when the restart is over.
      p.commit !== null &&
      p.unavailableReason === null &&
      !p.deployRunning &&
      !this.info()?.updateRunning &&
      phase !== 'running' &&
      phase !== 'restarting' &&
      !this.busy()
    );
  });
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

  protected behind(behind: number | null): string {
    return behindLabel(behind);
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

  protected openDeploy(): void {
    this.totpError.set(null);
    this.askingDeploy.set(true);
  }

  protected async startDeploy(code: string): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.totpError.set(null);
    try {
      this.deployFrom = this.panel()?.commit ?? null;
      await this.service.deploy(code);
      this.askingDeploy.set(false);
      this.deploy.set('running');
    } catch (cause) {
      // 401 (wrong code) or 409 (sessions, a pilot in its merge, another run): inside the modal.
      this.totpError.set(apiErrorMessage(cause));
    } finally {
      this.busy.set(false);
    }
    await this.refresh();
  }

  protected reload(): void {
    location.reload();
  }

  private async refresh(): Promise<void> {
    try {
      const [versions, runs] = await Promise.all([this.service.get(), this.service.runs()]);
      this.info.set(versions.kyro);
      this.panel.set(versions.panel);
      this.runs.set(runs);
      this.error.set(null);
      this.follow(versions.panel, runs);
      if (versions.kyro.updateRunning || versions.panel.deployRunning || this.following()) {
        this.timer ??= setInterval(() => void this.refresh(), POLL_MS);
      } else {
        this.stopPolling();
      }
    } catch (cause) {
      // While the panel restarts after a deploy the server does not answer: keep asking.
      if (this.following()) {
        this.deploy.set('restarting');
        return;
      }
      this.error.set(apiErrorMessage(cause));
      this.stopPolling();
    }
  }

  private following(): boolean {
    const phase = this.deploy();
    return phase === 'running' || phase === 'restarting';
  }

  private follow(panel: PanelDeployInfo, runs: MaintenanceRun[]): void {
    if (!this.following()) return;
    const last = runs.find((run) => run.kind === 'panel-deploy');
    const phase = deployPhase(this.deployFrom, panel, last);
    // Finished without a restart (up to date or failed): the history shows how it went.
    this.deploy.set(phase === 'finished' ? null : phase);
  }

  private stopPolling(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
