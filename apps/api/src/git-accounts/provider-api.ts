import type { GitProvider } from '@agents-panel/shared';

/** Validates a token against the provider API and returns the username it belongs to. */
export interface GitProviderApi {
  /** Throws GitTokenRejectedError when the provider does not accept the token. */
  fetchUsername(provider: GitProvider, host: string, token: string): Promise<string>;
}

export class GitTokenRejectedError extends Error {}

export const PROVIDER_TIMEOUT_MS = 10_000;

/** Real client: GitHub `GET /user` or GitLab `GET /api/v4/user` with a timeout. Tests inject a fake. */
export class HttpGitProviderApi implements GitProviderApi {
  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs: number = PROVIDER_TIMEOUT_MS,
  ) {}

  async fetchUsername(provider: GitProvider, host: string, token: string): Promise<string> {
    const request =
      provider === 'github'
        ? {
            url: 'https://api.github.com/user',
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github+json',
              'User-Agent': 'agents-panel',
            },
          }
        : {
            url: `https://${host}/api/v4/user`,
            headers: { 'PRIVATE-TOKEN': token, Accept: 'application/json' },
          };
    let response: Response;
    try {
      response = await this.fetchFn(request.url, {
        headers: request.headers,
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new Error(`No se pudo consultar a ${host}`);
    }
    if (response.status === 401 || response.status === 403)
      throw new GitTokenRejectedError(`${host} no aceptó el token`);
    if (!response.ok) throw new Error(`${host} respondió ${String(response.status)}`);
    const body = (await response.json().catch(() => null)) as {
      login?: unknown;
      username?: unknown;
    } | null;
    const name = provider === 'github' ? body?.login : body?.username;
    if (typeof name !== 'string' || name === '')
      throw new Error(`${host} no devolvió el usuario del token`);
    return name;
  }
}
