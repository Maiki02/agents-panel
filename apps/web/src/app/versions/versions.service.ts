import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { KyroVersionInfo, MaintenanceRun, PanelDeployInfo } from '@agents-panel/shared';
import { firstValueFrom } from 'rxjs';
import { SwrCache } from '../shared/swr-cache';

export interface VersionsResponse {
  kyro: KyroVersionInfo & { updateRunning: boolean };
  panel: PanelDeployInfo;
}

@Injectable({ providedIn: 'root' })
export class VersionsService {
  private readonly http = inject(HttpClient);
  private readonly versionsCache = new SwrCache<VersionsResponse>();
  private readonly runsCache = new SwrCache<MaintenanceRun[]>();

  /** The last answers, to paint at once while get() and runs() fetch the new ones. */
  cachedVersions(): VersionsResponse | undefined {
    return this.versionsCache.peek();
  }

  cachedRuns(): MaintenanceRun[] | undefined {
    return this.runsCache.peek();
  }

  get(): Promise<VersionsResponse> {
    return this.versionsCache.load(() =>
      firstValueFrom(this.http.get<VersionsResponse>('/api/versions')),
    );
  }

  /** An update or a deploy changes both answers. */
  private changed<T>(request: Promise<T>): Promise<T> {
    return request.finally(() => {
      this.versionsCache.invalidate();
      this.runsCache.invalidate();
    });
  }

  /** Needs a fresh TOTP code (`code`); answers 202 with the run id. */
  update(code: string): Promise<{ runId: number }> {
    return this.changed(
      firstValueFrom(this.http.post<{ runId: number }>('/api/versions/kyro/update', { code })),
    );
  }

  /** Deploys the panel (main + build + restart); needs a fresh TOTP code, answers 202. */
  deploy(code: string): Promise<{ runId: number }> {
    return this.changed(
      firstValueFrom(this.http.post<{ runId: number }>('/api/versions/panel/deploy', { code })),
    );
  }

  runs(): Promise<MaintenanceRun[]> {
    return this.runsCache.load(() =>
      firstValueFrom(this.http.get<MaintenanceRun[]>('/api/maintenance-runs')),
    );
  }
}
