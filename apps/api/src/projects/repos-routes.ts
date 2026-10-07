import type { FastifyInstance } from 'fastify';
import type { Project, ProjectRepo } from '@agents-panel/shared';
import { onlyKeys } from '../http/only-keys.js';
import { ProjectConflictError, ProjectNotFoundError, type ProjectRepository } from './repo.js';
import type { ProjectRepoRepository } from './repos-repo.js';
import { detectRepos } from './repos.js';
import { idParams, respond } from './routes.js';

const repoParams = {
  type: 'object',
  required: ['id', 'repoId'],
  properties: {
    id: { type: 'integer', minimum: 1 },
    repoId: { type: 'integer', minimum: 1 },
  },
} as const;

const patchBody = {
  type: 'object',
  required: ['baseBranch'],
  additionalProperties: false,
  properties: { baseBranch: { type: 'string', minLength: 1, maxLength: 200 } },
} as const;

function requireProject(projects: Pick<ProjectRepository, 'findById'>, id: number): Project {
  const project = projects.findById(id);
  if (!project) throw new ProjectNotFoundError(`Project not found: ${String(id)}`);
  return project;
}

/** Repos of a project (root + detected children) and their editable base branch. */
export function registerRepoRoutes(
  app: FastifyInstance,
  deps: {
    projects: Pick<ProjectRepository, 'findById'>;
    repos: ProjectRepoRepository;
  },
): void {
  const { projects, repos } = deps;

  app.get<{ Params: { id: number } }>(
    '/api/projects/:id/repos',
    { schema: { params: idParams } },
    (request, reply) =>
      respond(reply, () => {
        requireProject(projects, request.params.id);
        return Promise.resolve(repos.listByProject(request.params.id));
      }),
  );

  // Reads folder names and runs `git check-ignore`; it never changes a repo.
  app.post<{ Params: { id: number } }>(
    '/api/projects/:id/repos/detect',
    { schema: { params: idParams } },
    (request, reply) =>
      respond(reply, async () => {
        const project = requireProject(projects, request.params.id);
        if (project.status !== 'ready') {
          throw new ProjectConflictError(`El proyecto todavía no está listo: ${project.status}`);
        }
        const children = await detectRepos(project.repoPath);
        return repos.syncDetected(project.id, project.baseBranch, children);
      }),
  );

  app.patch<{ Params: { id: number; repoId: number }; Body: { baseBranch: string } }>(
    '/api/projects/:id/repos/:repoId',
    {
      schema: { params: repoParams, body: patchBody },
      preValidation: onlyKeys(Object.keys(patchBody.properties)),
    },
    (request, reply) =>
      respond(reply, () => {
        requireProject(projects, request.params.id);
        const repo: ProjectRepo | undefined = repos.findById(request.params.repoId);
        if (repo?.projectId !== request.params.id) {
          throw new ProjectNotFoundError(`Repo not found: ${String(request.params.repoId)}`);
        }
        return Promise.resolve(repos.updateBase(repo.id, request.body.baseBranch));
      }),
  );
}
