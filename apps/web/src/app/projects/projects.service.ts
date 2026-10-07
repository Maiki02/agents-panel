import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type {
  KyroBranchResult,
  KyroInitPushResult,
  ModelSelection,
  Project,
  ProjectPermissions,
  ProjectRepo,
  PullBaseResult,
} from '@agents-panel/shared';
import { firstValueFrom } from 'rxjs';
import { SwrCache } from '../shared/swr-cache';

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
  validateCommand?: string | null;
}

/** `GET /api/projects/:id` and PATCH also offer a setup command while none is saved. */
export type ProjectDetail = Project & { suggestedSetupCommand: string | null };

@Injectable({ providedIn: 'root' })
export class ProjectsService {
  private readonly http = inject(HttpClient);
  private readonly listCache = new SwrCache<Project[]>();

  /** The last list the server sent: paints at once while list() fetches the new one. */
  cachedList(): Project[] | undefined {
    return this.listCache.peek();
  }

  list(): Promise<Project[]> {
    return this.listCache.load(() => firstValueFrom(this.http.get<Project[]>('/api/projects')));
  }

  /** Every action that changes a project (or the list) drops the cached list. */
  private changed<T>(request: Promise<T>): Promise<T> {
    return request.finally(() => {
      this.listCache.invalidate();
    });
  }

  get(id: number): Promise<ProjectDetail> {
    return firstValueFrom(this.http.get<ProjectDetail>(`/api/projects/${String(id)}`));
  }

  add(input: AddProjectInput): Promise<Project> {
    return this.changed(firstValueFrom(this.http.post<Project>('/api/projects', input)));
  }

  patch(id: number, input: PatchProjectInput): Promise<ProjectDetail> {
    return this.changed(
      firstValueFrom(this.http.patch<ProjectDetail>(`/api/projects/${String(id)}`, input)),
    );
  }

  /** Fast-forward only, so it needs no code. */
  pull(id: number): Promise<PullBaseResult> {
    return this.changed(
      firstValueFrom(this.http.post<PullBaseResult>(`/api/projects/${String(id)}/pull`, {})),
    );
  }

  /** Repos of the project (root and detected children) with their editable base branch. */
  repos(id: number): Promise<ProjectRepo[]> {
    return firstValueFrom(this.http.get<ProjectRepo[]>(`/api/projects/${String(id)}/repos`));
  }

  /** Looks for child repos in the base clone and saves what it finds; never changes a repo. */
  detectRepos(id: number): Promise<ProjectRepo[]> {
    return this.changed(
      firstValueFrom(this.http.post<ProjectRepo[]>(`/api/projects/${String(id)}/repos/detect`, {})),
    );
  }

  updateRepoBase(id: number, repoId: number, baseBranch: string): Promise<ProjectRepo> {
    return this.changed(
      firstValueFrom(
        this.http.patch<ProjectRepo>(`/api/projects/${String(id)}/repos/${String(repoId)}`, {
          baseBranch,
        }),
      ),
    );
  }

  initKyro(id: number, code: string): Promise<KyroBranchResult> {
    return this.changed(
      firstValueFrom(
        this.http.post<KyroBranchResult>(`/api/projects/${String(id)}/kyro-init`, { code }),
      ),
    );
  }

  /** Pushes the branch the init left behind (never forced); answers the link that opens its PR. */
  pushKyroInit(id: number): Promise<KyroInitPushResult> {
    return this.changed(
      firstValueFrom(
        this.http.post<KyroInitPushResult>(`/api/projects/${String(id)}/kyro-init/push`, {}),
      ),
    );
  }

  /** Destructive: needs the project's name typed by the user and a fresh TOTP code. */
  remove(id: number, name: string, code: string): Promise<{ cloneRemoved: boolean }> {
    return this.changed(
      firstValueFrom(
        this.http.delete<{ cloneRemoved: boolean }>(`/api/projects/${String(id)}`, {
          body: { name, code },
        }),
      ),
    );
  }

  permissions(id: number): Promise<ProjectPermissions> {
    return firstValueFrom(
      this.http.get<ProjectPermissions>(`/api/projects/${String(id)}/permissions`),
    );
  }

  /** Widens what the agent may run, so it needs a fresh TOTP code. */
  savePermissions(
    id: number,
    input: { commands: string[]; hosts: string[]; totp: string },
  ): Promise<ProjectPermissions> {
    return this.changed(
      firstValueFrom(
        this.http.put<ProjectPermissions>(`/api/projects/${String(id)}/permissions`, input),
      ),
    );
  }

  models(id: number): Promise<ModelSelection> {
    return firstValueFrom(this.http.get<ModelSelection>(`/api/projects/${String(id)}/models`));
  }

  /** The API refuses a provider or model outside the catalog (400) and leaves the project as it was. */
  saveModels(id: number, models: ModelSelection): Promise<ModelSelection> {
    return this.changed(
      firstValueFrom(this.http.put<ModelSelection>(`/api/projects/${String(id)}/models`, models)),
    );
  }

  retry(id: number): Promise<Project> {
    return this.changed(
      firstValueFrom(this.http.post<Project>(`/api/projects/${String(id)}/retry`, {})),
    );
  }
}
