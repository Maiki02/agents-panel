import type { GitAccount, GitProvider } from '@agents-panel/shared';
import { GitTokenRejectedError, type GitProviderApi } from './provider-api.js';
import { GitAccountNotFoundError, type GitAccountRepository } from './repo.js';

/** Bad input (host, name, token): maps to 400. */
export class GitAccountValidationError extends Error {}

const NAME_RE = /^[\w .@-]{1,64}$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const MAX_TOKEN = 512;

/**
 * Normalizes a host to lowercase `name.tld`: https only, no port, path, query or credentials.
 * GitHub is always github.com.
 */
export function normalizeHost(provider: GitProvider, raw: string | undefined): string {
  if (provider === 'github') {
    if (raw !== undefined && raw.trim() !== '') {
      const host = normalizeHost('gitlab', raw);
      if (host !== 'github.com')
        throw new GitAccountValidationError('GitHub solo admite el host github.com');
    }
    return 'github.com';
  }
  const text = (raw ?? '').trim();
  if (text === '') throw new GitAccountValidationError('Falta el host de GitLab');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new GitAccountValidationError(`Host inválido: ${text}`);
  }
  if (url.protocol !== 'https:') throw new GitAccountValidationError('El host debe ser https');
  if (url.port !== '') throw new GitAccountValidationError('El host no puede llevar puerto');
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '')
    throw new GitAccountValidationError('El host no puede llevar credenciales ni parámetros');
  if (url.pathname !== '' && url.pathname !== '/')
    throw new GitAccountValidationError('El host no puede llevar path');
  const host = url.hostname.toLowerCase();
  if (!HOST_RE.test(host)) throw new GitAccountValidationError(`Host inválido: ${text}`);
  return host;
}

function checkName(name: string): string {
  const trimmed = name.trim();
  if (!NAME_RE.test(trimmed)) throw new GitAccountValidationError('Nombre de cuenta inválido');
  return trimmed;
}

function checkToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed === '' || trimmed.length > MAX_TOKEN || /\s/.test(trimmed))
    throw new GitAccountValidationError('Token inválido');
  return trimmed;
}

export class GitAccountService {
  constructor(
    private readonly repo: GitAccountRepository,
    private readonly api: GitProviderApi,
  ) {}

  list(): GitAccount[] {
    return this.repo.list();
  }

  async create(input: {
    provider: GitProvider;
    name: string;
    host?: string;
    token: string;
  }): Promise<GitAccount> {
    const name = checkName(input.name);
    const host = normalizeHost(input.provider, input.host);
    const token = checkToken(input.token);
    const username = await this.validate(input.provider, host, token);
    return this.repo.create({ provider: input.provider, name, host, username, token });
  }

  rename(id: number, name: string): GitAccount {
    return this.repo.rename(id, checkName(name));
  }

  async replaceToken(id: number, token: string): Promise<GitAccount> {
    const account = this.repo.findById(id);
    if (!account) throw new GitAccountNotFoundError(`Cuenta de git no encontrada: ${String(id)}`);
    const clean = checkToken(token);
    const username = await this.validate(account.provider, account.host, clean);
    return this.repo.replaceToken(id, username, clean);
  }

  remove(id: number): void {
    this.repo.remove(id);
  }

  private async validate(provider: GitProvider, host: string, token: string): Promise<string> {
    try {
      return await this.api.fetchUsername(provider, host, token);
    } catch (error) {
      if (error instanceof GitTokenRejectedError)
        throw new GitAccountValidationError(error.message);
      throw new GitAccountValidationError(
        error instanceof Error ? error.message : 'No se pudo validar el token',
      );
    }
  }
}
