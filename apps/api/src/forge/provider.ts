import type { Project } from '@agents-panel/shared';
import type { GitCredentialLookup } from '../git-accounts/credentials.js';
import { allPrsOf, prStateOf, realGh, type PilotGh, type PrState } from '../pilot/github-cli.js';
import type { ProjectRepository } from '../projects/repo.js';
import { GitlabForge, type FetchLike } from './gitlab-api.js';

/** Everything the panel asks a git host about PRs / MRs; the provider is chosen per project. */
export interface ForgeProvider extends PilotGh {
  /** URLs of every PR/MR of the branch, open, merged or closed. */
  allPrsOf(cwd: string, head: string): Promise<string[]>;
  /** State of one PR/MR by its URL; rejects a URL that is not one of this provider's. */
  prStateOf(cwd: string, url: string): Promise<PrState>;
}

/** GitHub through `gh` (with the project's `GH_TOKEN` when it has an account). */
export const githubForge: ForgeProvider = {
  ...realGh,
  allPrsOf,
  prStateOf,
};

/** Picks the provider of a project. Tests inject a fake one; nothing there calls a host. */
export interface ForgeResolver {
  forProject(projectId: number): ForgeProvider;
}

export interface ForgeRegistryDeps {
  projects: Pick<ProjectRepository, 'findById'>;
  credentials: Pick<GitCredentialLookup, 'forProject'>;
  fetch?: FetchLike;
}

/** The real resolver: GitHub projects use `gh`, GitLab ones the REST API with the account's token. */
export class ForgeRegistry implements ForgeResolver {
  constructor(private readonly deps: ForgeRegistryDeps) {}

  forProject(projectId: number): ForgeProvider {
    const project = this.deps.projects.findById(projectId);
    if (project?.gitProvider !== 'gitlab') return githubForge;
    return this.gitlabOf(project);
  }

  private gitlabOf(project: Project): ForgeProvider {
    const repoUrl = project.repoUrl;
    if (repoUrl === null)
      throw new Error(`El proyecto ${project.name} no tiene repositorio remoto`);
    const url = new URL(repoUrl);
    const projectPath = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
    return new GitlabForge(
      {
        host: url.host,
        projectPath,
        token: () => {
          const credential = this.deps.credentials.forProject(project.id);
          if (!credential) {
            throw new Error(`El proyecto ${project.name} no tiene una cuenta de GitLab con token`);
          }
          return credential.token;
        },
      },
      this.deps.fetch,
    );
  }
}

/** The provider of a project: the resolver's, or GitHub when there is none. */
export function forgeOf(resolver: ForgeResolver | undefined, projectId: number): ForgeProvider {
  return resolver?.forProject(projectId) ?? githubForge;
}
