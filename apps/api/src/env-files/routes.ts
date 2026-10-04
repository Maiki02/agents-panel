import type { FastifyInstance } from 'fastify';
import type { EnvFileInfo, Project } from '@agents-panel/shared';
import type { ReauthVerifier } from '../auth/reauth.js';
import type { ChatRepository } from '../chats/repo.js';
import { AUTH_RATE_LIMIT } from '../auth/routes.js';
import { onlyKeys } from '../http/only-keys.js';
import {
  ProjectConflictError,
  ProjectNotFoundError,
  type ProjectRepository,
} from '../projects/repo.js';
import { idParams, respond } from '../projects/routes.js';
import { applyEnvFileToWorktrees } from './apply.js';
import type { EnvFileRepository } from './repo.js';
import { parseEnvContent, validateEnvPath } from './validate.js';
import { assertGitIgnored } from './write.js';

/** The JSON escaping of a 64 KB .env can exceed the global 64 KB body limit; parseEnvContent enforces 64 KB. */
const PUT_BODY_LIMIT = 256 * 1024;

const putBody = {
  type: 'object',
  required: ['path', 'content'],
  additionalProperties: false,
  properties: {
    path: { type: 'string' },
    content: { type: 'string' },
    totp: { type: 'string', maxLength: 32 },
    applyToActive: { type: 'boolean' },
  },
} as const;

const deleteBody = {
  type: 'object',
  required: ['path'],
  additionalProperties: false,
  properties: {
    path: { type: 'string' },
    totp: { type: 'string', maxLength: 32 },
  },
} as const;

interface PutBody {
  path: string;
  content: string;
  totp?: string;
  applyToActive?: boolean;
}

interface DeleteBody {
  path: string;
  totp?: string;
}

export interface EnvFileRouteDeps {
  projects: ProjectRepository;
  envFiles: EnvFileRepository;
  reauth: ReauthVerifier;
  chats: ChatRepository;
}

/**
 * Development .env files of a project. Content goes in, never out: responses carry metadata only.
 * Writes need a fresh TOTP, checked before the path or content so a 401 reveals no validation.
 */
export function registerEnvFileRoutes(app: FastifyInstance, deps: EnvFileRouteDeps): void {
  const { projects, envFiles, reauth, chats } = deps;

  function findProject(id: number): Project {
    const project = projects.findById(id);
    if (!project) throw new ProjectNotFoundError(`Project not found: ${String(id)}`);
    return project;
  }

  app.get<{ Params: { id: number } }>(
    '/api/projects/:id/env',
    { schema: { params: idParams } },
    (request, reply) =>
      respond(reply, () => {
        findProject(request.params.id);
        return Promise.resolve(envFiles.list(request.params.id));
      }),
  );

  app.put<{ Params: { id: number }; Body: PutBody }>(
    '/api/projects/:id/env',
    {
      bodyLimit: PUT_BODY_LIMIT,
      config: { rateLimit: AUTH_RATE_LIMIT },
      schema: { params: idParams, body: putBody },
      preValidation: onlyKeys(Object.keys(putBody.properties)),
    },
    (request, reply) =>
      respond(reply, async () => {
        if (!reauth.verify(request, reply, request.body.totp)) return undefined;
        const project = findProject(request.params.id);
        if (project.status !== 'ready')
          throw new ProjectConflictError(`Project is not ready: ${project.name}`);
        const path = validateEnvPath(request.body.path);
        const keyNames = parseEnvContent(request.body.content);
        await assertGitIgnored(project.repoPath, path);

        const result = envFiles.upsert(project.id, path, request.body.content, keyNames);
        const file: EnvFileInfo | undefined = envFiles
          .list(project.id)
          .find((info) => info.path === path);
        void reply.code(result === 'created' ? 201 : 200);
        if (!request.body.applyToActive) return { file };
        // Already saved: whatever happens in the worktrees is reported, never undone.
        const applied = await applyEnvFileToWorktrees(
          chats.list().filter((chat) => chat.projectId === project.id),
          { path, content: request.body.content },
        );
        return { file, applied };
      }),
  );

  app.delete<{ Params: { id: number }; Body: DeleteBody }>(
    '/api/projects/:id/env',
    {
      config: { rateLimit: AUTH_RATE_LIMIT },
      schema: { params: idParams, body: deleteBody },
      preValidation: onlyKeys(Object.keys(deleteBody.properties)),
    },
    (request, reply) =>
      respond(reply, () => {
        if (!reauth.verify(request, reply, request.body.totp)) return Promise.resolve(undefined);
        const project = findProject(request.params.id);
        const path = validateEnvPath(request.body.path);
        if (!envFiles.remove(project.id, path))
          throw new ProjectNotFoundError(`No .env at ${path}`);
        return Promise.resolve({ ok: true });
      }),
  );
}
