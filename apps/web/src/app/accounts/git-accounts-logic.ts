import type { GitAccount, GitProvider, NewGitAccount, Project } from '@agents-panel/shared';

export const DEFAULT_GITLAB_HOST = 'gitlab.com';

export const GIT_PROVIDER_LABEL: Record<GitProvider, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
};

/** Label of the row that stands for the global `gh` login of the VM (no linked account). */
export const PRIMARY_GIT_ACCOUNT_LABEL = 'Principal (login de la VM)';

/** Host a new account of that provider starts with. */
export function defaultHost(provider: GitProvider): string {
  return provider === 'gitlab' ? DEFAULT_GITLAB_HOST : 'github.com';
}

/** "Nombre (usuario@host)": what a selector shows for an account. */
export function gitAccountLabel(account: Pick<GitAccount, 'name' | 'username' | 'host'>): string {
  return `${account.name} (${account.username}@${account.host})`;
}

/** Hosts of the linked GitLab accounts: the self-hosted ones a project URL may use. */
export function gitlabHosts(accounts: readonly GitAccount[]): string[] {
  return [
    ...new Set(
      accounts.filter((account) => account.provider === 'gitlab').map((account) => account.host),
    ),
  ];
}

/** Host of a project's repo: from its URL; a project added by path counts as github.com. */
export function projectHost(project: Pick<Project, 'repoUrl'>): string {
  if (project.repoUrl === null) return 'github.com';
  try {
    return new URL(project.repoUrl).hostname.toLowerCase();
  } catch {
    return 'github.com';
  }
}

/** Accounts a project of that provider and host can use. */
export function accountsFor(
  accounts: readonly GitAccount[],
  provider: GitProvider,
  host: string,
): GitAccount[] {
  const wanted = host.trim().toLowerCase();
  return accounts.filter(
    (account) => account.provider === provider && account.host.toLowerCase() === wanted,
  );
}

/** GitLab has no global login: a project of GitLab needs an account of its host. */
export function accountRequired(provider: GitProvider): boolean {
  return provider === 'gitlab';
}

/** Why the new-project form cannot be sent for the account choice; null when it can. */
export function accountProblem(
  provider: GitProvider,
  available: readonly GitAccount[],
  selected: number | null,
  host: string,
): string | null {
  if (!accountRequired(provider)) return null;
  if (available.length === 0) {
    return `No hay una cuenta de GitLab vinculada para ${host}: vinculala en Cuentas.`;
  }
  return selected === null || !available.some((account) => account.id === selected)
    ? 'Elegí la cuenta de GitLab con la que se clona.'
    : null;
}

/** The account the selector starts with: the only one, when there is exactly one. */
export function defaultAccountId(available: readonly GitAccount[]): number | null {
  return available.length === 1 ? (available[0]?.id ?? null) : null;
}

export interface LinkInput {
  busy: boolean;
  provider: GitProvider;
  name: string;
  host: string;
  token: string;
}

/** The link form can go on to the TOTP step when everything is filled and nothing is in flight. */
export function canLinkAccount(input: LinkInput): boolean {
  return (
    !input.busy &&
    input.name.trim() !== '' &&
    input.token.trim() !== '' &&
    (input.provider === 'github' || input.host.trim() !== '')
  );
}

/** Body of the link request: GitHub never sends a host. The token is trimmed; it is never kept. */
export function newAccountBody(input: LinkInput, totp: string): NewGitAccount {
  return {
    provider: input.provider,
    name: input.name.trim(),
    ...(input.provider === 'gitlab' ? { host: input.host.trim().toLowerCase() } : {}),
    token: input.token.trim(),
    totp,
  };
}

/** Projects that act as this account. */
export function projectsUsing(
  account: Pick<GitAccount, 'id'>,
  projects: readonly Pick<Project, 'name' | 'displayName' | 'gitAccountId'>[],
): string[] {
  return projects
    .filter((project) => project.gitAccountId === account.id)
    .map((project) => {
      const display = project.displayName?.trim();
      return display === undefined || display === '' ? project.name : display;
    });
}

/** Text of the confirmation before unlinking; names the projects that use the account. */
export function unlinkWarning(account: Pick<GitAccount, 'name'>, using: readonly string[]): string {
  const base = `¿Desvincular la cuenta "${account.name}"? El token guardado se borra del panel.`;
  if (using.length === 0) return base;
  return `${base} La usan ${String(using.length)} proyecto(s): ${using.join(', ')}. El panel no la desvincula mientras la use alguno: cambiales la cuenta en Configuración → General primero.`;
}
