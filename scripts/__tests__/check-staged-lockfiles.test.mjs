import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve(import.meta.dirname, '..', 'check-staged-lockfiles.mjs');
const repos = [];

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function makeRepo() {
  const cwd = mkdtempSync(join(tmpdir(), 'check-staged-lockfiles-'));
  repos.push(cwd);
  git(cwd, ['init', '-q', '-b', 'main']);
  git(cwd, ['config', 'user.email', 'test@example.com']);
  git(cwd, ['config', 'user.name', 'test']);
  git(cwd, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(cwd, 'pnpm-lock.yaml'), 'pnpm-a\n');
  writeFileSync(join(cwd, 'bun.lock'), 'bun-a\n');
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      packageManager: 'pnpm@11.7.0',
      dependencies: { example: '1.0.0' },
    }),
  );
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-q', '-m', 'base']);
  return cwd;
}

function run(cwd) {
  return spawnSync(process.execPath, [script], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

afterEach(() => {
  while (repos.length > 0) rmSync(repos.pop(), { recursive: true, force: true });
});

describe('check-staged-lockfiles merge-parent closure', () => {
  it('accepts pnpm lock regeneration for a package-manager-only version update', () => {
    const cwd = makeRepo();
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        packageManager: 'pnpm@12.10.1',
        dependencies: { example: '1.0.0' },
      }),
    );
    writeFileSync(join(cwd, 'pnpm-lock.yaml'), 'pnpm-b\n');
    git(cwd, ['add', 'package.json', 'pnpm-lock.yaml']);

    const result = run(cwd);
    expect(result.status).toBe(0);
  });

  it('still requires both locks when a pnpm version update changes dependencies', () => {
    const cwd = makeRepo();
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        packageManager: 'pnpm@12.10.1',
        dependencies: { example: '2.0.0' },
      }),
    );
    writeFileSync(join(cwd, 'pnpm-lock.yaml'), 'pnpm-b\n');
    git(cwd, ['add', 'package.json', 'pnpm-lock.yaml']);

    const result = run(cwd);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bun.lock is NOT');
  });

  it('rejects a normal commit that stages only bun.lock', () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, 'bun.lock'), 'bun-b\n');
    git(cwd, ['add', 'bun.lock']);

    const result = run(cwd);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('pnpm-lock.yaml is NOT');
  });

  it('accepts a staged missing lock that closes the immediate parent delta', () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, 'pnpm-lock.yaml'), 'pnpm-b\n');
    git(cwd, ['add', 'pnpm-lock.yaml']);
    git(cwd, ['commit', '-q', '-m', 'incomplete pnpm lock change']);
    writeFileSync(join(cwd, 'bun.lock'), 'bun-b\n');
    git(cwd, ['add', 'bun.lock']);

    const result = run(cwd);
    expect(result.status).toBe(0);
  });

  it('rejects a lock supplement after a non-lock immediate parent commit', () => {
    const cwd = makeRepo();
    writeFileSync(join(cwd, 'pnpm-lock.yaml'), 'pnpm-b\n');
    git(cwd, ['add', 'pnpm-lock.yaml']);
    git(cwd, ['commit', '-q', '-m', 'incomplete pnpm lock change']);
    writeFileSync(join(cwd, 'note.txt'), 'unrelated\n');
    git(cwd, ['add', 'note.txt']);
    git(cwd, ['commit', '-q', '-m', 'unrelated change']);
    writeFileSync(join(cwd, 'bun.lock'), 'bun-b\n');
    git(cwd, ['add', 'bun.lock']);

    const result = run(cwd);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('pnpm-lock.yaml is NOT');
  });

  it('accepts a merge whose two lockfiles are covered across both parents', () => {
    const cwd = makeRepo();
    git(cwd, ['switch', '-q', '-c', 'other']);
    writeFileSync(join(cwd, 'pnpm-lock.yaml'), 'pnpm-c\n');
    writeFileSync(join(cwd, 'bun.lock'), 'bun-d\n');
    git(cwd, ['add', '.']);
    git(cwd, ['commit', '-q', '-m', 'other lock closure']);
    git(cwd, ['switch', '-q', '-c', 'ours', 'main']);
    writeFileSync(join(cwd, 'bun.lock'), 'bun-b\n');
    git(cwd, ['add', 'bun.lock']);
    git(cwd, ['commit', '-q', '-m', 'ours lock change']);

    const merge = spawnSync('git', ['merge', '--no-commit', '--no-ff', 'other'], {
      cwd,
      encoding: 'utf8',
    });
    expect(merge.status).not.toBe(0);
    writeFileSync(join(cwd, 'pnpm-lock.yaml'), 'pnpm-a\n');
    writeFileSync(join(cwd, 'bun.lock'), 'bun-e\n');
    git(cwd, ['add', 'pnpm-lock.yaml', 'bun.lock']);

    expect(git(cwd, ['diff', '--cached', '--name-only']).trim()).toBe('bun.lock');
    const result = run(cwd);
    expect(result.status).toBe(0);
  });

  it('still rejects a merge where the other lockfile is unchanged by both parents', () => {
    const cwd = makeRepo();
    git(cwd, ['switch', '-q', '-c', 'other']);
    writeFileSync(join(cwd, 'note.txt'), 'other change\n');
    git(cwd, ['add', 'note.txt']);
    git(cwd, ['commit', '-q', '-m', 'other non-lock change']);
    git(cwd, ['switch', '-q', '-c', 'ours', 'main']);
    writeFileSync(join(cwd, 'bun.lock'), 'bun-b\n');
    git(cwd, ['add', 'bun.lock']);
    git(cwd, ['commit', '-q', '-m', 'ours lock change']);
    git(cwd, ['merge', '--no-commit', '--no-ff', 'other']);
    writeFileSync(join(cwd, 'bun.lock'), 'bun-c\n');
    git(cwd, ['add', 'bun.lock']);

    const result = run(cwd);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('pnpm-lock.yaml is NOT');
  });
});
