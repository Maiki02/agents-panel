import { CliError, type CliIo } from './commands.js';
import { ProjectError, type ProjectRepository } from '../projects/repo.js';
import type { ProjectService } from '../projects/service.js';

export const PROJECT_USAGE = `  project:add <name> <repoPath> <baseBranch> [setupCommand]  Register a git repo
  project:list                                                List projects`;

/** Returns true when the command was a project command. */
export async function runProjectCommand(
  command: string | undefined,
  args: readonly string[],
  io: CliIo,
  deps: { projects: ProjectRepository; service: ProjectService },
): Promise<boolean> {
  switch (command) {
    case 'project:add': {
      const [name, repoPath, baseBranch, setupCommand] = args;
      if (!name || !repoPath || !baseBranch) {
        throw new CliError('Usage: project:add <name> <repoPath> <baseBranch> [setupCommand]');
      }
      try {
        const project = await deps.service.adopt({ name, repoPath, baseBranch, setupCommand });
        io.print(
          `Project added: ${project.name} (${project.repoPath}, base ${project.baseBranch})`,
        );
      } catch (error) {
        if (error instanceof ProjectError) throw new CliError(error.message);
        throw error;
      }
      return true;
    }
    case 'project:list': {
      for (const p of deps.projects.list()) {
        io.print(
          [String(p.id), p.name, p.displayName ?? '-', p.status, p.repoPath, p.baseBranch].join(
            '\t',
          ),
        );
      }
      return true;
    }
    default:
      return false;
  }
}
