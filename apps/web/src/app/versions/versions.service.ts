import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { KyroVersionInfo, MaintenanceRun, PanelDeployInfo } from '@agents-panel/shared';
import { firstValueFrom } from 'rxjs';

export interface VersionsResponse {
  kyro: KyroVersionInfo & { updateRunning: boolean };
  panel: PanelDeployInfo;
}

@Injectable({ providedIn: 'root' })
export class VersionsService {
  private readonly http = inject(HttpClient);

  get(): Promise<VersionsResponse> {
    return firstValueFrom(this.http.get<VersionsResponse>('/api/versions'));
  }

  /** Needs a fresh TOTP code (`code`); answers 202 with the run id. */
  update(code: string): Promise<{ runId: number }> {
    return firstValueFrom(this.http.post<{ runId: number }>('/api/versions/kyro/update', { code }));
  }

  /** Deploys the panel (main + build + restart); needs a fresh TOTP code, answers 202. */
  deploy(code: string): Promise<{ runId: number }> {
    return firstValueFrom(
      this.http.post<{ runId: number }>('/api/versions/panel/deploy', { code }),
    );
  }

  runs(): Promise<MaintenanceRun[]> {
    return firstValueFrom(this.http.get<MaintenanceRun[]>('/api/maintenance-runs'));
  }
}
