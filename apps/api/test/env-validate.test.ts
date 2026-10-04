import { describe, expect, it } from 'vitest';
import { EnvFileError, parseEnvContent, validateEnvPath } from '../src/env-files/validate.js';
import { ProjectError } from '../src/projects/repo.js';

function errorOf(fn: () => unknown): EnvFileError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EnvFileError);
    return error as EnvFileError;
  }
  throw new Error('expected an EnvFileError');
}

describe('validateEnvPath', () => {
  it.each([
    '.env',
    '.env.local',
    '.env.development',
    '.env.test',
    '.env.staging',
    'backend/.env',
    'be-ventas/.env.local',
  ])('accepts %j', (path) => {
    expect(validateEnvPath(path)).toBe(path);
  });

  it.each([
    '.env.production',
    '.env.PROD',
    '.env.prod.local',
    '.env.example',
    '.env.sample',
    '.env.ejemplo',
    '.env.template',
    '.env.local.EXAMPLE',
    'env',
    '.envrc',
    'x.env',
    '../.env',
    'a/../.env',
    '/abs/.env',
    './.env',
    'a//.env',
    'a\\.env',
    '.git/.env',
    'a/.env/',
    '.env\0',
    '',
    `${'a/'.repeat(100)}.env`,
  ])('rejects %j', (path) => {
    errorOf(() => validateEnvPath(path));
  });

  it('accepts a path of exactly 200 characters', () => {
    const path = `${'a'.repeat(195)}/.env`;
    expect(path).toHaveLength(200);
    expect(validateEnvPath(path)).toBe(path);
  });

  it('is a ProjectError so routes map it to 400', () => {
    expect(errorOf(() => validateEnvPath('../.env'))).toBeInstanceOf(ProjectError);
  });
});

describe('parseEnvContent', () => {
  it('accepts comments, blank lines, CRLF and export, returning unique keys in order', () => {
    const content = [
      '# database',
      'DB_HOST=localhost',
      '',
      '  # indented comment',
      'export API_KEY=abc=def',
      'DB_HOST=override',
      '_PRIVATE=',
      'EMPTY_QUOTED=""',
      '',
    ].join('\r\n');
    expect(parseEnvContent(content)).toEqual(['DB_HOST', 'API_KEY', '_PRIVATE', 'EMPTY_QUOTED']);
  });

  it('accepts LF and an empty file', () => {
    expect(parseEnvContent('A=1\nB=2')).toEqual(['A', 'B']);
    expect(parseEnvContent('')).toEqual([]);
  });

  it('accepts exactly 65536 bytes', () => {
    const content = `A=${'x'.repeat(65536 - 2)}`;
    expect(parseEnvContent(content)).toEqual(['A']);
  });

  it('rejects more than 65536 UTF-8 bytes even when the string is shorter', () => {
    const content = `A=${'ñ'.repeat(32768)}`;
    expect(content.length).toBeLessThan(65536);
    errorOf(() => parseEnvContent(content));
  });

  it('rejects NUL', () => {
    errorOf(() => parseEnvContent('A=1\0'));
  });

  const sentinel = 'S3NT1NEL_VALUE_9f2c';

  it.each([
    ['a line without =', `A=1\n${sentinel}\n`, 2],
    ['a key starting with a digit', `A=1\nB=2\n1${sentinel}=x\n`, 3],
    ['spaces around =', `${sentinel} = value\n`, 1],
    ['a quoted multi-line value', `A="${sentinel}\nsecond line"\n`, 2],
    ['a stray carriage return', `A=${sentinel}\rB=2\n`, 1],
    ['export without a key', `export ${sentinel}\n`, 1],
  ])('rejects %s citing the line number without its text', (_label, content, line) => {
    const error = errorOf(() => parseEnvContent(content));
    expect(error.message).toContain(`Línea ${String(line)}`);
    expect(error.message).not.toContain(sentinel);
  });
});
