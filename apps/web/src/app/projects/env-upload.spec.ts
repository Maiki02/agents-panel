import { describe, expect, it } from 'vitest';
import { EnvSendError, envPathProblem, envSizeProblem, trySend, type EnvDraft } from './env-upload';

describe('envPathProblem', () => {
  it.each(['.env', '.env.local', '.env.staging', 'backend/.env', 'be-ventas/.env.local'])(
    'accepts %s',
    (path) => {
      expect(envPathProblem(path)).toBeNull();
    },
  );

  it.each([
    '.env.production',
    '.env.PROD',
    '.env.example',
    '.env.sample',
    '.env.template',
    '.envrc',
    'env',
    'backend/config.json',
    '',
  ])('rejects %j', (path) => {
    expect(envPathProblem(path)).not.toBeNull();
  });
});

describe('envSizeProblem', () => {
  it('accepts up to 64 KB and flags more', () => {
    expect(envSizeProblem('A=1\n'.repeat(100))).toBeNull();
    expect(envSizeProblem('x'.repeat(64 * 1024 + 1))).not.toBeNull();
  });
});

describe('trySend', () => {
  const draft: EnvDraft = { path: '.env', content: 'SECRET=hunter2', applyToActive: true };

  it('hands the content to send and returns a draft without it on success', async () => {
    let received = '';
    const out = await trySend(draft, (d) => {
      received = d.content;
      return Promise.resolve('ok');
    });
    expect(received).toBe('SECRET=hunter2');
    expect(out.draft).toEqual({ path: '.env', content: '', applyToActive: true });
    expect(JSON.stringify(out)).not.toContain('hunter2');
  });

  it.each([400, 401])('drops the content when the server answers %i', async (status) => {
    const failure = trySend(draft, () => Promise.reject(new Error(String(status))));
    await expect(failure).rejects.toBeInstanceOf(EnvSendError);
    const error = (await failure.catch((e: unknown) => e)) as EnvSendError;
    expect(error.draft.content).toBe('');
    expect(error.draft.path).toBe('.env');
  });
});
