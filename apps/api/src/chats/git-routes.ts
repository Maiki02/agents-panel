import type { FastifyInstance, FastifyReply } from 'fastify';
import type { GitCommitRequest, GitRepoRequest, RepoOpOutcome } from '@agents-panel/shared';
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
