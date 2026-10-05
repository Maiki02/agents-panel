import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeSecrets, scanSecrets, scanWorktreeSecrets } from '../src/pilot/secrets.js';
import { makeGitRepo } from './helpers.js';

// Fake values with the right format, built by concatenation so the repo scan does not flag this file.
const GH = 'gh' + 'p_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const PAT = 'github' + '_pat_' + '11ABCDEFG0abcdefghijklmnopqrstuvwxyz';
const ANT = 'sk' + '-ant-' + 'api03-abcdefghijklmnopqrstuvwxyz0123';
const AWS = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP';
const SLACK = 'xo' + 'xb-' + '1234567890-abcdefghij';
const PEM = '-----BEGIN ' + 'RSA PRIVATE KEY-----';

const added = (file: string, ...lines: string[]) =>
  [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${file}`,
    '@@ -0,0 +1 @@',
    ...lines.map((l) => `+${l}`),
  ].join('\n');

describe('scanSecrets', () => {
  it('flags a .env, a .pem, a private key in a .ts and a ghp_ token', () => {
    const diff = [
      added('apps/api/.env', 'PORT=3000'),
      added('certs/server.pem', 'x'),
      added('src/a.ts', `const k = \`${PEM}\`;`),
      added('src/b.ts', `const t = '${GH}';`),
    ].join('\n');
    expect(scanSecrets(diff)).toEqual([
      { file: 'apps/api/.env', kind: 'env_file' },
      { file: 'certs/server.pem', kind: 'key_file' },
      { file: 'src/a.ts', kind: 'private_key' },
      { file: 'src/b.ts', kind: 'github_token' },
    ]);
  });

  it.each([
    ['github_pat', PAT, 'github_token'],
    ['anthropic', ANT, 'anthropic_key'],
    ['aws', AWS, 'aws_access_key'],
    ['slack', SLACK, 'slack_token'],
  ])('detects a %s token in an added line', (_name, value, kind) => {
    expect(scanSecrets(added('src/x.ts', `const v = '${value}';`))).toEqual([
      { file: 'src/x.ts', kind },
    ]);
  });

  it('detects the secret file names: .env.*, *.key, id_rsa*, id_ed25519*, credentials.json', () => {
    const files = [
      '.env.local',
      'a/b.key',
      'id_rsa',
      'id_rsa.pub.bak',
      'id_ed25519',
      'x/credentials.json',
    ];
    const kinds = scanSecrets(files.map((f) => added(f, 'x')).join('\n')).map((f) => f.file);
    expect(kinds.sort()).toEqual([...files].sort());
  });

  it('does not flag .env.example, deleted lines or deleted files', () => {
    const removed = [
      'diff --git a/src/old.ts b/src/old.ts',
      '--- a/src/old.ts',
      '+++ b/src/old.ts',
      '@@ -1 +0,0 @@',
      `-const t = '${GH}';`,
    ].join('\n');
    const deletedFile = [
      'diff --git a/.env b/.env',
      'deleted file mode 100644',
      '--- a/.env',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-PORT=3000',
    ].join('\n');
    expect(scanSecrets(added('.env.example', 'PORT=3000', `K=${'x'.repeat(10)}`))).toEqual([]);
    expect(scanSecrets(removed)).toEqual([]);
    expect(scanSecrets(deletedFile)).toEqual([]);
  });

  it('never puts the secret value in the result or in the description of the stop', () => {
    const diff = [
      added('a.ts', `t='${GH}'`),
      added('b.ts', `t='${ANT}'`),
      added('.env', `K=${AWS}`),
    ].join('\n');
    const findings = scanSecrets(diff);
    const text = JSON.stringify(findings) + describeSecrets(findings);
    for (const value of [GH, ANT, AWS]) expect(text).not.toContain(value);
    expect(describeSecrets(findings)).toContain('a.ts (token de GitHub)');
  });

  it('ignores ordinary code that only mentions the prefixes', () => {
    expect(
      scanSecrets(added('src/doc.ts', '// tokens start with ghp_ or sk-ant-', "const a = 'AKIA';")),
    ).toEqual([]);
  });
});

describe('scanWorktreeSecrets', () => {
  const git = (repo: string, ...args: string[]) =>
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      encoding: 'utf8',
    });

  it('looks at what the branch added over the base, what is pending and untracked files', async () => {
    const repo = makeGitRepo();
    git(repo, 'checkout', '-q', '-b', 'feature/x');
    writeFileSync(join(repo, 'committed.ts'), `const t = '${GH}';\n`);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'feat');
    writeFileSync(join(repo, 'README.md'), `# test\n${ANT}\n`);
    mkdirSync(join(repo, 'cfg'));
    writeFileSync(join(repo, 'cfg/.env'), 'PORT=1\n');
    expect(await scanWorktreeSecrets(repo, 'main')).toEqual([
      { file: 'README.md', kind: 'anthropic_key' },
      { file: 'cfg/.env', kind: 'env_file' },
      { file: 'committed.ts', kind: 'github_token' },
    ]);
  });

  it('finds nothing in a clean branch', async () => {
    const repo = makeGitRepo();
    git(repo, 'checkout', '-q', '-b', 'feature/y');
    expect(await scanWorktreeSecrets(repo, 'main')).toEqual([]);
  });
});
