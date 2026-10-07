import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  CreatePrRequest,
  DeleteWorkRequest,
  DiffAgainst,
  GitCommitRequest,
  GitDiscardRequest,
  GitRepoRequest,
  RepoOpOutcome,
} from '@agents-panel/shared';
import { onlyKeys } from '../http/only-keys.js';
import { OUTPUT_LIMIT, WorktreeOpsError, type WorktreeOps } from '../worktrees/ops.js';

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
} as const;

/**
 * A repo of the work: '.' for the root or the name of a first-level folder. Never an absolute path
 * or one with `..`: the service still matches it against the repos of the work (404 otherwise).
 */
const repoProperty = {
  type: 'string',
  minLength: 1,
  maxLength: 200,
  pattern: '^(\\.|(?!\\.\\.$)[^/\\\\\\u0000]+)$',
} as const;

const commitBody = {
  type: 'object',
  required: ['repo', 'files', 'message'],
  additionalProperties: false,
  properties: {
    repo: repoProperty,
    files: {
      type: 'array',
      minItems: 1,
      maxItems: 500,
      items: {
        type: 'string',
        minLength: 1,
        maxLength: 1000,
        // Relative to the repo, inside it.
        pattern: '^(?!/)(?!.*(^|/)\\.\\.(/|$))[^\\u0000]+$',
      },
    },
    message: { type: 'string', minLength: 1, maxLength: 5000, pattern: '\\S' },
  },
} as const;

const repoBody = {
  type: 'object',
  additionalProperties: false,
  properties: { repo: repoProperty },
} as const;

const prBody = {
  type: 'object',
  required: ['repos'],
  additionalProperties: false,
  properties: {
    repos: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      items: {
        type: 'object',
        required: ['repo', 'title', 'body'],
        additionalProperties: false,
        properties: {
          repo: repoProperty,
          title: { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' },
          body: { type: 'string', maxLength: 60000 },
        },
      },
    },
  },
} as const;

function clip(text: string): string {
  return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n… (recortado)` : text;
}

function clipOutcome<T extends RepoOpOutcome>(outcome: T): T {
  return { ...outcome, output: clip(outcome.output) };
}

/**
 * Manual git operations of a work (D19, D26). Every route needs a session (and CSRF when it writes)
 * through the global guard; the public allowlist does not change. Errors: 404 work or repo that
 * does not exist, 409 the agent or the pilot could be working, 400 invalid input, 422 git refused
 * (with its trimmed output). A pull that conflicts is aborted and answers 200 with the files.
 */
export function registerChatGitRoutes(app: FastifyInstance, deps: { ops: WorktreeOps }): void {
  const { ops } = deps;

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof WorktreeOpsError) {
      return reply.code(error.status).send({ error: error.message });
    }
    return reply.send(error);
  });

  /** 422 with git's output when any repo was refused; the body keeps the per repo detail. */
  const answer = (
    reply: FastifyReply,
    body: { repos: RepoOpOutcome[]; reinstall?: RepoOpOutcome | null },
  ) => {
    const repos = body.repos.map(clipOutcome);
    const reinstall = body.reinstall ? clipOutcome(body.reinstall) : null;
    const out = { repos, ...(body.reinstall === undefined ? {} : { reinstall }) };
    const failed = [...repos, ...(reinstall ? [reinstall] : [])].find((r) => r.result === 'error');
    return failed ? reply.code(422).send({ error: failed.output, ...out }) : out;
  };

  app.get<{ Params: { id: number } }>(
    '/api/chats/:id/git',
    { schema: { params: idParams } },
    (request) => ops.status(request.params.id),
  );

  app.get<{
    Params: { id: number };
    Querystring: { repo: string; against: DiffAgainst; file?: string };
  }>(
    '/api/chats/:id/git/diff',
    {
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          required: ['repo', 'against'],
          additionalProperties: false,
          properties: {
            repo: repoProperty,
            against: { type: 'string', enum: ['worktree', 'base'] },
            file: {
              type: 'string',
              minLength: 1,
              maxLength: 1000,
              pattern: '^(?!/)(?!.*(^|/)\\.\\.(/|$))[^\\u0000]+$',
            },
          },
        },
      },
    },
    (request) => {
      const { repo, against, file } = request.query;
      return ops.diff(request.params.id, repo, against, file);
    },
  );

  app.post<{ Params: { id: number }; Body: GitCommitRequest }>(
    '/api/chats/:id/git/commit',
    {
      schema: { params: idParams, body: commitBody },
      preValidation: onlyKeys(['repo', 'files', 'message']),
    },
    async (request, reply) => {
      const { repo, files, message } = request.body;
      const outcome = clipOutcome(await ops.commit(request.params.id, repo, files, message));
      return outcome.result === 'error'
        ? reply.code(422).send({ error: outcome.output, ...outcome })
        : outcome;
    },
  );

  app.post<{ Params: { id: number }; Body: GitDiscardRequest }>(
    '/api/chats/:id/git/discard',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['repo', 'files'],
          additionalProperties: false,
          properties: { repo: repoProperty, files: commitBody.properties.files },
        },
      },
      preValidation: onlyKeys(['repo', 'files']),
    },
    async (request, reply) => {
      const outcome = clipOutcome(
        await ops.discard(request.params.id, request.body.repo, request.body.files),
      );
      return outcome.result === 'error'
        ? reply.code(422).send({ error: outcome.output, ...outcome })
        : outcome;
    },
  );

  app.get<{ Params: { id: number } }>(
    '/api/chats/:id/git/pr',
    { schema: { params: idParams } },
    (request) => ops.prPreview(request.params.id),
  );

  app.post<{ Params: { id: number }; Body: CreatePrRequest }>(
    '/api/chats/:id/git/pr',
    { schema: { params: idParams, body: prBody }, preValidation: onlyKeys(['repos']) },
    async (request, reply) => {
      return answer(reply, await ops.createPr(request.params.id, 'user', request.body.repos));
    },
  );

  app.get<{ Params: { id: number } }>(
    '/api/chats/:id/work/delete-preview',
    { schema: { params: idParams } },
    (request) => ops.deletePreview(request.params.id),
  );

  app.post<{ Params: { id: number }; Body: DeleteWorkRequest }>(
    '/api/chats/:id/work/delete',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['deleteRemote'],
          additionalProperties: false,
          properties: { deleteRemote: { type: 'boolean' } },
        },
      },
      preValidation: onlyKeys(['deleteRemote']),
    },
    (request) => ops.deleteWork(request.params.id, request.body.deleteRemote, 'user'),
  );

  const repoRoute = (
    suffix: string,
    run: (
      id: number,
      repo: string | undefined,
    ) => Promise<{ repos: RepoOpOutcome[]; reinstall?: RepoOpOutcome | null }>,
  ) => {
    app.post<{ Params: { id: number }; Body: GitRepoRequest | undefined }>(
      `/api/chats/:id/${suffix}`,
      { schema: { params: idParams, body: repoBody }, preValidation: onlyKeys(['repo']) },
      async (request, reply) => {
        return answer(reply, await run(request.params.id, request.body?.repo));
      },
    );
  };
  repoRoute('git/pull-base', (id, repo) => ops.pullBase(id, repo));
  repoRoute('git/pull-branch', (id, repo) => ops.pullBranch(id, repo));
  repoRoute('git/push', (id, repo) => ops.push(id, repo));

  app.post<{ Params: { id: number } }>(
    '/api/chats/:id/setup',
    { schema: { params: idParams } },
    async (request, reply) => {
      const outcome = clipOutcome(await ops.reinstall(request.params.id));
      return outcome.result === 'error'
        ? reply.code(422).send({ error: outcome.output, ...outcome })
        : outcome;
    },
  );
}
