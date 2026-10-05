import { execFile } from 'node:child_process';
import type { Project } from '@agents-panel/shared';
import { splitCommand } from './create.js';

/** How much of the output of a validation is kept (the end of it, where the failure is). */
export const VALIDATE_OUTPUT_LIMIT = 8000;
export const DEFAULT_VALIDATE_TIMEOUT_MS = 15 * 60 * 1000;

/** The part of the project the validation needs. */
export type ValidateTarget = Pick<Project, 'validateCommand'>;

export type ValidationResult =
  /** The project has no validate_command: nothing to run, nothing failed. */
  | { status: 'skipped' }
  | { status: 'passed'; command: string; output: string }
  | { status: 'failed'; command: string; output: string; exitCode: number | null }
  | { status: 'timeout'; command: string; output: string };

/** The tail of a long output, so the Timeline event stays small. */
export function trimOutput(text: string, limit = VALIDATE_OUTPUT_LIMIT): string {
  return text.length <= limit ? text : `…${text.slice(text.length - limit)}`;
}

/**
 * Runs the project's validate_command in the worktree, without a shell (the command is split into
 * argv like setup_command). Never throws: the result says whether it passed, failed or timed out.
 */
export function runValidation(
  project: ValidateTarget,
  cwd: string,
  timeoutMs: number = DEFAULT_VALIDATE_TIMEOUT_MS,
): Promise<ValidationResult> {
  const command = project.validateCommand?.trim() ?? '';
  if (command === '') return Promise.resolve({ status: 'skipped' });
  let argv: string[];
  try {
    argv = splitCommand(command);
  } catch (error) {
    return Promise.resolve({
      status: 'failed',
      command,
      output: error instanceof Error ? error.message : 'Invalid validate command',
      exitCode: null,
    });
  }
  const [file, ...args] = argv;
  if (file === undefined) return Promise.resolve({ status: 'skipped' });
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = trimOutput(`${stdout}${stderr}`.trim());
        if (error === null) {
          resolve({ status: 'passed', command, output });
          return;
        }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
        if (failure.killed === true) {
          resolve({ status: 'timeout', command, output });
          return;
        }
        resolve({
          status: 'failed',
          command,
          output: output === '' ? failure.message : output,
          exitCode: typeof failure.code === 'number' ? failure.code : null,
        });
      },
    );
  });
}

/** Payload of the chat event that keeps the (trimmed) output of a validation. */
export function validationEventPayload(result: ValidationResult): Record<string, unknown> {
  return result.status === 'skipped' ? { status: 'skipped' } : { ...result };
}
