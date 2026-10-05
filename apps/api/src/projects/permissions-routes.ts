import type { FastifyInstance } from 'fastify';
import type { ProjectPermissions } from '@agents-panel/shared';
import {
  ALLOWED_BASH_COMMANDS,
  CURL_BASE_HOSTS,
  NEVER_ENABLED_COMMANDS,
  PIPE_FILTERS,
  PermissionConfigError,
  READ_COMMANDS,
  validateProjectPermissions,
} from '../agent/permissions.js';
import type { ReauthVerifier } from '../auth/reauth.js';
import { AUTH_RATE_LIMIT } from '../auth/routes.js';
import { onlyKeys } from '../http/only-keys.js';
import { suggestPermissions } from './permission-suggestions.js';
import { ProjectError, ProjectNotFoundError, type ProjectRepository } from './repo.js';
import { idParams, respond } from './routes.js';

const putBody = {
  type: 'object',
  required: ['commands', 'hosts'],
  additionalProperties: false,
  properties: {
    commands: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 100 } },
    hosts: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 300 } },
    totp: { type: 'string', maxLength: 32 },
  },
} as const;

export interface PermissionRouteDeps {
  projects: ProjectRepository;
  reauth: ReauthVerifier;
}

/**
 * Bash commands and curl hosts a project adds to the base. Widening what the agent can run needs a
 * fresh TOTP (checked before the content, so a 401 reveals nothing about validation).
 */
export function registerPermissionRoutes(app: FastifyInstance, deps: PermissionRouteDeps): void {
  const { projects, reauth } = deps;

  function describe(id: number): ProjectPermissions {
    const project = projects.findById(id);
    if (!project) throw new ProjectNotFoundError(`Project not found: ${String(id)}`);
    const extras = projects.getBashExtras(id);
    return {
      base: [...ALLOWED_BASH_COMMANDS, ...READ_COMMANDS, ...PIPE_FILTERS],
      curlBaseHosts: [...CURL_BASE_HOSTS],
      commands: [...extras.commands],
      hosts: [...extras.hosts],
      fixedDenied: [...NEVER_ENABLED_COMMANDS],
      suggestions: suggestPermissions(project.repoPath, extras),
    };
  }

  app.get<{ Params: { id: number } }>(
    '/api/projects/:id/permissions',
    { schema: { params: idParams } },
    (request, reply) => respond(reply, () => Promise.resolve(describe(request.params.id))),
  );

  app.put<{ Params: { id: number }; Body: { commands: string[]; hosts: string[]; totp?: string } }>(
    '/api/projects/:id/permissions',
    {
      config: { rateLimit: AUTH_RATE_LIMIT },
      schema: { params: idParams, body: putBody },
      preValidation: onlyKeys(Object.keys(putBody.properties)),
    },
    (request, reply) =>
      respond(reply, () => {
        if (!reauth.verify(request, reply, request.body.totp)) return Promise.resolve(undefined);
        describe(request.params.id);
        try {
          projects.setBashExtras(
            request.params.id,
            validateProjectPermissions({
              commands: request.body.commands,
              hosts: request.body.hosts,
            }),
          );
        } catch (error) {
          if (error instanceof PermissionConfigError) {
            // respond() answers a ProjectError with 400.
            throw new ProjectError(error.message);
          }
          throw error;
        }
        return Promise.resolve(describe(request.params.id));
      }),
  );
}
