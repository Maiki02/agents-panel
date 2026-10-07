import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type {
  CommitOutcome,
  CreatePrRepoRequest,
  DeleteWorkOutcome,
  DeletePreview,
  DiffAgainst,
  GitCommitRequest,
  ManualStep,
  PrPreview,
  PrRepoOutcome,
  RepoDiff,
  RepoOpOutcome,
  StepOutcome,
  WorktreeStatus,
} from '@agents-panel/shared';
import { firstValueFrom } from 'rxjs';
import { outcomesOf } from './git-logic';

/** What an operation answered: per repo, plus the automatic reinstall when a lockfile changed. */
export interface GitOpResult {
  repos: RepoOpOutcome[];
  reinstall: RepoOpOutcome | null;
  warning: string | null;
}

/**
 * Client of the git routes of a work. A 422 (git refused) still carries the per repo detail, so it
 * is returned as a result instead of thrown; any other failure (409 with its reason, 404) throws.
 */
@Injectable({ providedIn: 'root' })
export class GitService {
  private readonly http = inject(HttpClient);

  status(chatId: number): Promise<WorktreeStatus> {
    return firstValueFrom(this.http.get<WorktreeStatus>(`/api/chats/${String(chatId)}/git`));
  }

  commit(chatId: number, body: GitCommitRequest): Promise<GitOpResult> {
    return this.run(this.http.post(`/api/chats/${String(chatId)}/git/commit`, body));
  }

  pullBase(chatId: number, repo: string): Promise<GitOpResult> {
    return this.run(this.http.post(`/api/chats/${String(chatId)}/git/pull-base`, { repo }));
  }

  pullBranch(chatId: number, repo: string): Promise<GitOpResult> {
    return this.run(this.http.post(`/api/chats/${String(chatId)}/git/pull-branch`, { repo }));
  }

  push(chatId: number, repo: string): Promise<GitOpResult> {
    return this.run(this.http.post(`/api/chats/${String(chatId)}/git/push`, { repo }));
  }

  reinstall(chatId: number): Promise<GitOpResult> {
    return this.run(this.http.post(`/api/chats/${String(chatId)}/setup`, {}));
  }

  /** Read-only diff of a repo; with `file` only that file, whole (the "ver más" of a cut patch). */
  diff(chatId: number, repo: string, against: DiffAgainst, file?: string): Promise<RepoDiff> {
    const params: Record<string, string> = { repo, against };
    if (file !== undefined) params['file'] = file;
    return firstValueFrom(
      this.http.get<RepoDiff>(`/api/chats/${String(chatId)}/git/diff`, { params }),
    );
  }

  /** Discards the uncommitted changes of the chosen files; a 400 comes as the error to show. */
  discard(chatId: number, repo: string, files: string[]): Promise<GitOpResult> {
    return this.run(this.http.post(`/api/chats/${String(chatId)}/git/discard`, { repo, files }));
  }

  prPreview(chatId: number): Promise<PrPreview> {
    return firstValueFrom(this.http.get<PrPreview>(`/api/chats/${String(chatId)}/git/pr`));
  }

  /** Push and PR per repo; a 422 (a repo stopped, e.g. by a secret) still carries every outcome. */
  async createPr(chatId: number, repos: CreatePrRepoRequest[]): Promise<PrRepoOutcome[]> {
    const result = await this.run(this.http.post(`/api/chats/${String(chatId)}/git/pr`, { repos }));
    return result.repos;
  }

  /** Launches an agent step (or completes the work); 409 carries the reason it does not apply. */
  runStep(chatId: number, step: ManualStep): Promise<StepOutcome> {
    return firstValueFrom(
      this.http.post<StepOutcome>(`/api/chats/${String(chatId)}/steps`, { step }),
    );
  }

  deletePreview(chatId: number): Promise<DeletePreview> {
    return firstValueFrom(
      this.http.get<DeletePreview>(`/api/chats/${String(chatId)}/work/delete-preview`),
    );
  }

  deleteWork(chatId: number, deleteRemote: boolean): Promise<DeleteWorkOutcome> {
    return firstValueFrom(
      this.http.post<DeleteWorkOutcome>(`/api/chats/${String(chatId)}/work/delete`, {
        deleteRemote,
      }),
    );
  }

  private async run(request: ReturnType<HttpClient['post']>): Promise<GitOpResult> {
    try {
      return toResult(await firstValueFrom(request));
    } catch (cause) {
      if (cause instanceof HttpErrorResponse && cause.status === 422) {
        const result = toResult(cause.error);
        if (result.repos.length > 0 || result.reinstall) return result;
      }
      throw cause;
    }
  }
}

function toResult(body: unknown): GitOpResult {
  const record = (typeof body === 'object' && body !== null ? body : {}) as {
    reinstall?: RepoOpOutcome | null;
    warning?: CommitOutcome['warning'];
  };
  const repos = outcomesOf(body);
  // A reinstall answers as a single outcome (path "."), not as a list: it is the result itself.
  return {
    repos,
    reinstall: record.reinstall ?? null,
    warning: record.warning ?? null,
  };
}
