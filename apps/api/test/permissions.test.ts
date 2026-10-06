import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ALLOWED_TOOLS,
  COMMAND_RUNNERS,
  FIXED_DENIED_COMMANDS,
  PermissionConfigError,
  checkBash,
  decide,
  validateProjectPermissions,
  type BashExtras,
} from '../src/agent/permissions.js';

const cwd = '/tmp/wt/a';
const extras = (partial: Partial<BashExtras> = {}): BashExtras => ({
  commands: [],
  hosts: [],
  ...partial,
});
const verdict = (command: string, e: BashExtras = extras()) => checkBash(command, cwd, e).behavior;

describe('curl in restricted mode', () => {
  it('allows GET and HEAD to localhost and to a host of the policy', () => {
    expect(verdict('curl http://localhost:3000/health')).toBe('allow');
    expect(verdict('curl -s -S http://127.0.0.1:8080/api/x')).toBe('allow');
    expect(verdict('curl -sS --max-time 5 https://localhost/x')).toBe('allow');
    expect(verdict('curl -I http://localhost')).toBe('allow');
    expect(verdict('curl https://api.example.com/v1', extras({ hosts: ['api.example.com'] }))).toBe(
      'allow',
    );
    expect(verdict('curl http://localhost:3000/x | head -5')).toBe('allow');
  });

  it('denies a host that is not listed, also with look-alike hosts', () => {
    expect(verdict('curl https://api.example.com/v1')).toBe('deny');
    const e = extras({ hosts: ['api.example.com'] });
    expect(verdict('curl https://api.example.com.evil.io/v1', e)).toBe('deny');
    expect(verdict('curl https://evil.io/api.example.com', e)).toBe('deny');
    expect(verdict('curl http://localhost.evil.io/', e)).toBe('deny');
    expect(verdict('curl http://[::1]:3000/', e)).toBe('deny');
  });

  it.each([
    'curl -L http://localhost',
    'curl --location http://localhost',
    'curl -d x=1 http://localhost',
    'curl --data x=1 http://localhost',
    'curl --data-binary x http://localhost',
    'curl --data-raw x http://localhost',
    'curl --json x http://localhost',
    'curl -F a=b http://localhost',
    'curl --form a=b http://localhost',
    'curl -T file http://localhost',
    'curl --upload-file f http://localhost',
    'curl -X POST http://localhost',
    'curl -XPOST http://localhost',
    'curl --request POST http://localhost',
    'curl -o out http://localhost',
    'curl -O http://localhost/f',
    'curl --output out http://localhost',
    'curl -K cfg http://localhost',
    'curl --config cfg http://localhost',
    'curl -sLo out http://localhost',
    'curl -d @file http://localhost',
    'curl http://user:pass@localhost/',
    'curl http://localhost@evil.io/',
    'curl --unknown-flag http://localhost',
    'curl -H "X: y" http://localhost',
  ])('denies %s', (command) => {
    expect(verdict(command)).toBe('deny');
  });

  it('denies non-http schemes, missing URLs, variables and chained extras', () => {
    expect(verdict('curl file:///etc/passwd')).toBe('deny');
    expect(verdict('curl ftp://localhost/x')).toBe('deny');
    expect(verdict('curl localhost:3000')).toBe('deny');
    expect(verdict('curl')).toBe('deny');
    expect(verdict('curl -s')).toBe('deny');
    expect(verdict('curl http://$HOST/')).toBe('deny');
    expect(verdict('curl http://localhost && curl https://evil.io')).toBe('deny');
    expect(verdict('curl --max-time abc http://localhost')).toBe('deny');
  });

  it('is never in the auto-approved tools and works through decide()', () => {
    expect(ALLOWED_TOOLS.join(' ')).not.toContain('curl');
    expect(decide({ cwd }, 'Bash', { command: 'curl http://localhost:4000' }).behavior).toBe(
      'allow',
    );
    expect(
      decide({ cwd }, 'Bash', { command: 'curl -X DELETE http://localhost:4000' }).behavior,
    ).toBe('deny');
  });
});

describe('fixed denied commands', () => {
  it.each(FIXED_DENIED_COMMANDS)('denies %s even when the project lists it', (name) => {
    expect(verdict(`${name} --help`)).toBe('deny');
    expect(verdict(`git status && ${name} x`, extras({ commands: [name] }))).toBe('deny');
    expect(verdict(`git log | ${name}`, extras({ commands: [name] }))).toBe('deny');
  });

  it.each(COMMAND_RUNNERS)(
    'denies the command runner %s even when the project lists it',
    (name) => {
      const stored = extras({ commands: [name] });
      expect(verdict(`${name} sudo id`, stored)).toBe('deny');
      expect(verdict(`git ls-files | ${name} ssh`, stored)).toBe('deny');
    },
  );

  it('closes the wrapper paths to the fixed list', () => {
    const stored = extras({ commands: ['env', 'xargs', 'bash'] });
    expect(verdict('env sudo id', stored)).toBe('deny');
    expect(verdict('bash -c tailscale', stored)).toBe('deny');
    expect(verdict('git ls-files | xargs ssh', stored)).toBe('deny');
  });

  it('says the command is never allowed', () => {
    const result = checkBash('oci compute instance list', cwd, extras({ commands: ['oci'] }));
    expect(result).toMatchObject({ behavior: 'deny' });
    expect(result.behavior === 'deny' && result.message).toContain('never allowed');
  });
});

describe('project Bash commands', () => {
  it('allows a configured command and denies it without the configuration', () => {
    expect(verdict('uv run pytest', extras({ commands: ['uv'] }))).toBe('allow');
    expect(verdict('uv run pytest')).toBe('deny');
    expect(verdict('uv run pytest && rm -rf /x', extras({ commands: ['uv'] }))).toBe('deny');
  });

  it('keeps the base unchanged', () => {
    for (const command of [
      'git status',
      'gh pr list',
      'npm test',
      'go test ./...',
      'kyro status',
    ]) {
      expect(verdict(command)).toBe('allow');
    }
    expect(verdict('python x.py')).toBe('deny');
    expect(verdict('ls', extras())).toBe('allow');
  });
});

describe('validateProjectPermissions', () => {
  it('accepts simple names and hosts and normalizes them', () => {
    expect(
      validateProjectPermissions({
        commands: ['uv', 'pytest', 'uv', 'python3.12', 'cargo-nextest'],
        hosts: ['API.Example.com', 'localhost', 'api.example.com'],
      }),
    ).toEqual({
      commands: ['uv', 'pytest', 'python3.12', 'cargo-nextest'],
      hosts: ['api.example.com', 'localhost'],
    });
  });

  it.each([
    '/usr/bin/uv',
    './uv',
    '../uv',
    'uv run',
    'uv;rm',
    'uv|cat',
    'uv&',
    '$(id)',
    '`id`',
    'uv>x',
    '',
    '-rf',
    'a'.repeat(51),
  ])('rejects the command name %j', (name) => {
    expect(() => validateProjectPermissions({ commands: [name], hosts: [] })).toThrow(
      PermissionConfigError,
    );
  });

  it('rejects base commands and fixed denied ones', () => {
    for (const name of [
      'git',
      'npm',
      'kyro',
      'ls',
      'cat',
      'head',
      'curl',
      'cd',
      'sudo',
      'ssh',
      'oci',
      'env',
      'xargs',
      'bash',
      'sh',
      'nohup',
    ]) {
      expect(() => validateProjectPermissions({ commands: [name], hosts: [] }), name).toThrow(
        PermissionConfigError,
      );
    }
  });

  it.each([
    'http://example.com',
    'example.com/path',
    'example.com:8080',
    'exa mple.com',
    '-bad.com',
    'bad-.com',
    '..',
    '',
    'a@b.com',
    '*.example.com',
    '[::1]',
  ])('rejects the host %j', (host) => {
    expect(() => validateProjectPermissions({ commands: [], hosts: [host] })).toThrow(
      PermissionConfigError,
    );
  });

  it('limits how many entries a project can add', () => {
    const many = Array.from({ length: 51 }, (_, i) => `tool${String(i)}`);
    expect(() => validateProjectPermissions({ commands: many, hosts: [] })).toThrow(
      PermissionConfigError,
    );
  });
});

describe('arguments of the base commands that run other commands', () => {
  it.each([
    'npm exec -c tailscale',
    'npm x sudo',
    'npm explore x -- ssh',
    'npm edit x',
    'npm --prefix . exec sudo',
    'npm --script-shell=/bin/sh test',
    'npm test --script-shell /bin/sh',
    'npm config set script-shell /bin/sh',
    'git -c core.sshCommand=ssh push',
    'git -ccore.sshCommand=ssh push',
    'git --config-env=a=b status',
    'git --exec-path=/tmp status',
    'git -C . -c core.pager=sudo log',
    "git config alias.x '!sudo'",
    'git config core.sshCommand ssh',
    'git config --add core.hooksPath /tmp',
    'git config --get --add core.editor vi',
    'git config user.name x',
    'git push --receive-pack=ssh origin',
    'git fetch --upload-pack=ssh origin',
    'git fetch ext::sh',
    'git rebase -x sudo main',
    'git submodule foreach sudo id',
    'git bisect run sudo',
    'git filter-branch --tree-filter x',
    'go generate ./...',
    'go -C . generate ./...',
    'go build -toolexec=ssh ./...',
    'go test -exec ssh ./...',
    'go vet -vettool=/tmp/x ./...',
    'go env -w GOFLAGS=-toolexec=ssh',
    'GIT_SSH_COMMAND=ssh git push',
    'GOFLAGS=-toolexec=ssh go build',
  ])('denies %j', (command) => {
    expect(verdict(command)).toBe('deny');
  });

  it('explains the denial so the agent can adapt', () => {
    const result = checkBash('npm exec -c tailscale', cwd, extras());
    expect(result).toMatchObject({ behavior: 'deny' });
    expect(JSON.stringify(result)).toContain('npm run, test or ci');
  });

  it.each([
    'npm ci',
    'npm install',
    'npm test',
    'npm test -- exec',
    'npm run build',
    'npm run build --workspace apps/api',
    'git status',
    'git diff --stat',
    'git log --oneline -5',
    'git add -A',
    'git commit -m x',
    'git push',
    'git push -u origin feat/x',
    'git pull --no-rebase origin main',
    'git fetch origin',
    'git checkout -b x',
    'git switch main',
    'git branch -a',
    'git worktree list',
    'git -C apps/api status',
    'git rebase main',
    'git config --get user.name',
    'git config --list',
    'git config -l',
    'go build ./...',
    'go test ./...',
    'go vet ./...',
    'go run .',
    'go env GOPATH',
    'gh pr create --fill',
    'kyro status',
  ])('keeps allowing %j', (command) => {
    expect(verdict(command)).toBe('allow');
  });

  it('applies the rules to every stage of a chain', () => {
    expect(verdict('git status && npm exec sudo')).toBe('deny');
    expect(verdict('git status | head -3')).toBe('allow');
  });
});

describe('rm with a validated path (debt-5)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function worktree() {
    const base = mkdtempSync(join(tmpdir(), 'panel-rm-'));
    dirs.push(base);
    const wt = join(base, 'wt');
    const outside = join(base, 'outside');
    mkdirSync(join(wt, 'carpeta'), { recursive: true });
    mkdirSync(join(wt, '.git', 'hooks'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, 'x'), 'x');
    symlinkSync(outside, join(wt, 'link-afuera'));
    return { wt, outside };
  }
  const run = (wt: string, command: string) => checkBash(command, wt).behavior;

  it('allows files, several operands and folders inside the worktree', () => {
    const { wt } = worktree();
    for (const command of [
      'rm archivo.txt',
      'rm -f a b',
      'rm -r carpeta/',
      'rm -rf carpeta',
      'rm -R carpeta',
      'rm -fr carpeta',
      'rm -- -raro.txt',
      `rm ${wt}/archivo.txt`,
      'rm link-afuera',
      'git status && rm a.txt',
    ]) {
      expect(run(wt, command), command).toBe('allow');
    }
  });

  it('denies the worktree root, .git, ~, / and anything outside', () => {
    const { wt, outside } = worktree();
    for (const command of [
      'rm -rf ~',
      'rm -rf /',
      'rm ../x',
      'rm -r .',
      'rm -r ./',
      'rm -r carpeta/..',
      `rm -r ${wt}`,
      'rm -r .git',
      'rm -r .git/hooks',
      'rm .git/config',
      'rm $HOME/x',
      'rm *',
      'rm carpeta/*',
      'rm {a,b}',
      `rm ${outside}/x`,
      'rm link-afuera/x',
      'rm -r link-afuera/',
      'rm link-afuera/../x',
      'rm --no-preserve-root /',
      'rm --recursive carpeta',
      'rm -i a',
      'rm -d carpeta',
      'rm',
      'rm -rf',
      'rm "a/../../x"',
      "rm 'a'/x",
      'cd / && rm etc/x',
      'cd .. ; rm x',
      'rm a $(echo b)',
      'rm a > /dev/null && rm /etc/x',
    ]) {
      expect(run(wt, command), command).toBe('deny');
    }
  });

  it('denies rm hidden behind a wrapper', () => {
    const { wt } = worktree();
    for (const command of [
      'env rm x',
      'xargs rm',
      'nohup rm x',
      'timeout 1 rm x',
      "sh -c 'rm x'",
      'bash -c "rm x"',
      'echo x | xargs rm',
      '/bin/rm x',
    ]) {
      expect(run(wt, command), command).toBe('deny');
    }
  });

  it('still allows npm test, git push and go test, and a project cannot add rm', () => {
    const { wt } = worktree();
    for (const command of [
      'npm test',
      'git push origin feat',
      'go test ./...',
      'rm a && npm test',
    ]) {
      expect(run(wt, command), command).toBe('allow');
    }
    expect(() => validateProjectPermissions({ commands: ['rm'], hosts: [] })).toThrow(
      PermissionConfigError,
    );
    // Without a worktree there is nothing to validate against.
    expect(checkBash('rm x').behavior).toBe('deny');
    expect(checkBash('rm x', wt, extras({ commands: ['rm'] })).behavior).toBe('allow');
    expect(checkBash('rm /etc/x', wt, extras({ commands: ['rm'] })).behavior).toBe('deny');
  });
});
