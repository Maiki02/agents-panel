import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Project } from '@agents-panel/shared';
import { firstValueFrom } from 'rxjs';

export interface AddProjectInput {
  repo: string;
  name?: string;
  displayName?: string;
  baseBranch?: string;
  setupCommand?: string;
}

export interface PatchProjectInput {
  displayName?: string | null;
  baseBranch?: string;
  setupCommand?: string | null;
}

/** `GET /api/projects/:id` and PATCH also offer a setup command while none is saved. */
export type ProjectDetail = Project & { suggestedSetupCommand: string | null };

@Injectable({ providedIn: 'root' })
export class ProjectsService {
  private readonly http = inject(HttpClient);

  list(): Promise<Project[]> {
    return firstValueFrom(this.http.get<Project[]>('/api/projects'));
  }

  get(id: number): Promise<ProjectDetail> {
    return firstValueFrom(this.http.get<ProjectDetail>(`/api/projects/${String(id)}`));
  }

  add(input: AddProjectInput): Promise<Project> {
    return firstValueFrom(this.http.post<Project>('/api/projects', input));
  }

  patch(id: number, input: PatchProjectInput): Promise<ProjectDetail> {
    return firstValueFrom(this.http.patch<ProjectDetail>(`/api/projects/${String(id)}`, input));
  }

  retry(id: number): Promise<Project> {
    return firstValueFrom(this.http.post<Project>(`/api/projects/${String(id)}/retry`, {}));
  }
}
