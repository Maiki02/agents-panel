import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { EnvApplyResult, EnvFileInfo } from '@agents-panel/shared';
import { firstValueFrom } from 'rxjs';

export interface PutEnvInput {
  path: string;
  content: string;
  totp: string;
  applyToActive?: boolean;
}

export interface PutEnvResult {
  file: EnvFileInfo;
  applied?: EnvApplyResult[];
}

/** A project's development .env files. The API never returns their content (write-only). */
@Injectable({ providedIn: 'root' })
export class EnvFilesService {
  private readonly http = inject(HttpClient);

  list(projectId: number): Promise<EnvFileInfo[]> {
    return firstValueFrom(this.http.get<EnvFileInfo[]>(this.url(projectId)));
  }

  put(projectId: number, input: PutEnvInput): Promise<PutEnvResult> {
    return firstValueFrom(this.http.put<PutEnvResult>(this.url(projectId), input));
  }

  remove(projectId: number, path: string, totp: string): Promise<unknown> {
    return firstValueFrom(this.http.delete(this.url(projectId), { body: { path, totp } }));
  }

  private url(projectId: number): string {
    return `/api/projects/${String(projectId)}/env`;
  }
}
