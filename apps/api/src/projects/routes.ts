import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Project } from '@agents-panel/shared';
import { onlyKeys } from '../http/only-keys.js';
import {
  validateModels,
  ProjectConflictError,
  ProjectError,
  ProjectNotFoundError,
  type ProjectRepository,
} from './repo.js';
import { kyroPendingCommit } from './git.js';
import type { ProjectService } from './service.js';

export const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

const addBody = {
  type: 'object',
  required: ['repo'],
  additionalProperties: false,
  properties: {
    repo: { type: 'string', minLength: 1, maxLength: 200 },
    name: { type: 'string', minLength: 1, maxLength: 50 },
    displayName: { type: 'string', maxLength: 100 },
    baseBranch: { type: 'string', minLength: 1, maxLength: 200 },
    setupCommand: { type: 'string', maxLength: 500 },
  },
} as const;

const patchBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    displayName: { type: ['string', 'null'], maxLength: 100 },
    baseBranch: { type: 'string', minLength: 1, maxLength: 200 },
    setupCommand: { type: ['string', 'null'], maxLength: 500 },
    validateCommand: { type: ['string', 'null'], maxLength: 500 },
  },
} as const;

const modelsBody = {
  type: 'object',
  required: ['provider', 'thinker', 'executor'],
  additionalProperties: false,
  properties: {
    provider: { type: 'string', maxLength: 50 },
    thinker: { type: 'string', maxLength: 100 },
    executor: { type: 'string', maxLength: 100 },
  },
} as const;

interface AddBody {
  repo: string;
  name?: string;
  displayName?: string;
  baseBranch?: string;
  setupCommand?: string;
}

interface PatchBody {
  displayName?: string | null;
  baseBranch?: string;
  setupCommand?: string | null;
  validateCommand?: string | null;
}

/** Maps project errors to 400/404/409 for these routes only; anything else stays a 500. */
export async function respond(
  reply: FastifyReply,
  run: () => Promise<unknown>,
): Promise<FastifyReply> {
  try {
    return await run().then((body) => (reply.sent ? reply : reply.send(body)));
  } catch (error) {
    if (error instanceof ProjectNotFoundError)
      return reply.code(404).send({ error: error.message });
    if (error instanceof ProjectConflictError)
      return reply.code(409).send({ error: error.message });
    if (error instanceof ProjectError) return reply.code(400).send({ error: error.message });
    throw error;
  }
}

export function registerProjectRoutes(
  app: FastifyInstance,
  deps: { projects: ProjectRepository; service: ProjectService },
): void {
  const { projects, service } = deps;

  app.get('/api/projects', () => Promise.all(projects.list().map(withKyroState)));

  app.post<{ Body: AddBody }>(
    '/api/projects',
    { schema: { body: addBody }, preValidation: onlyKeys(Object.keys(addBody.properties)) },
    (request, reply) =>
      respond(reply, async () => {
        const project = await service.add(request.body);
        // 201: an existing folder was adopted. 202: the clone keeps running in the background.
        void reply.code(project.status === 'cloning' ? 202 : 201);
        return project;
      }),
  );

  app.get<{ Params: { id: number } }>(
    '/api/projects/:id',
    { schema: { params: idParams } },
    (request, reply) =>
      respond(reply, async () => {
        const project = projects.findById(request.params.id);
        if (!project)
          throw new ProjectNotFoundError(`Project not found: ${String(request.params.id)}`);
        return withSuggestion(service, project);
      }),
  );

  app.patch<{ Params: { id: number }; Body: PatchBody }>(
    '/api/projects/:id',
    {
      schema: { params: idParams, body: patchBody },
      preValidation: onlyKeys(Object.keys(patchBody.properties)),
    },
    (request, reply) =>
      respond(reply, async () =>
        withSuggestion(service, await service.update(request.params.id, request.body)),
      ),
  );

  app.get<{ Params: { id: number } }>(
    '/api/projects/:id/models',
    { schema: { params: idParams } },
    (request, reply) =>
      respond(reply, () => Promise.resolve(requireProject(projects, request.params.id).models)),
  );

  app.put<{
    Params: { id: number };
    Body: { provider: string; thinker: string; executor: string };
  }>(
    '/api/projects/:id/models',
    {
      schema: { params: idParams, body: modelsBody },
      preValidation: onlyKeys(Object.keys(modelsBody.properties)),
    },
    (request, reply) =>
      respond(reply, () => {
        requireProject(projects, request.params.id);
        const { provider, thinker, executor } = request.body;
        // Validated before anything is written: a bad model leaves the project untouched.
        projects.setModels(request.params.id, validateModels(provider, thinker, executor));
        return Promise.resolve(requireProject(projects, request.params.id).models);
      }),
  );

  app.post<{ Params: { id: number } }>(
    '/api/projects/:id/retry',
    { schema: { params: idParams } },
    (request, reply) =>
      respond(reply, async () => {
        const project = await service.retry(request.params.id);
        void reply.code(project.status === 'cloning' ? 202 : 200);
        return project;
      }),
  );
}

function requireProject(projects: ProjectRepository, id: number): Project {
  const project = projects.findById(id);
  if (!project) throw new ProjectNotFoundError(`Project not found: ${String(id)}`);
  return project;
}

/** Adds `kyroPendingCommit` to a project that has Kyro (the only ones that can have it). */
async function withKyroState(project: Project): Promise<Project> {
  if (!project.hasKyro || project.status !== 'ready') return project;
  return { ...project, kyroPendingCommit: await kyroPendingCommit(project.repoPath) };
}

/** `suggestedSetupCommand` is only offered while the project has no explicit setup command. */
async function withSuggestion(
  service: ProjectService,
  project: Project,
): Promise<Project & { suggestedSetupCommand: string | null }> {
  const suggestedSetupCommand =
    project.setupCommand === null && project.status === 'ready'
      ? await service.suggestedSetup(project)
      : null;
  return { ...(await withKyroState(project)), suggestedSetupCommand };
}
