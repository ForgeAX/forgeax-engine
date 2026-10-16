import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  branchFor,
  directoryFor,
  parseWorktreeOptions,
  submoduleReference,
  submoduleStatusProblems,
  submoduleUpdateArgs,
} from '../worktree.ts';

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim();
}

describe('worktree option parsing', () => {
  it('uses a safe codex branch and worktree directory', () => {
    expect(branchFor('feature/render-grid')).toBe('codex/feature/render-grid');
    expect(directoryFor('feature/render-grid')).toBe('feature-render-grid');
  });

  it('accepts the complete bootstrap flags', () => {
    expect(
      parseWorktreeOptions(['codex/demo', '--from', 'origin/main', '--jobs', '3', '--fast']),
    ).toEqual({
      name: 'codex/demo',
      from: 'origin/main',
      jobs: 3,
      dryRun: false,
      noSetup: true,
      keepOnFailure: false,
    });
  });

  it('supports a non-mutating plan and failure retention', () => {
    expect(parseWorktreeOptions(['demo', '--dry-run', '--keep-on-failure'])).toMatchObject({
      name: 'demo',
      dryRun: true,
      keepOnFailure: true,
    });
  });

  it('rejects traversal and unbounded submodule jobs', () => {
    expect(() => parseWorktreeOptions(['../outside'])).toThrow(/git-safe name/);
    expect(() => parseWorktreeOptions(['demo', '--jobs', '9'])).toThrow(/1 to 8/);
  });
});

describe('worktree bootstrap plans', () => {
  it('bounds recursive shallow submodule work', () => {
    expect(submoduleUpdateArgs(4)).toEqual([
      'submodule',
      'update',
      '--init',
      '--recursive',
      '--depth',
      '1',
      '--jobs',
      '4',
    ]);
    expect(submoduleUpdateArgs(4, '/tmp/assets-reference')).toContain('--reference');
  });

  it('omits a shallow assets checkout as the submodule reference', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'forgeax-worktree-reference-')));
    const source = join(root, 'source');
    const commonRoot = join(root, 'common');
    const assetsRoot = join(commonRoot, 'forgeax-engine-assets');
    mkdirSync(source, { recursive: true });
    mkdirSync(commonRoot, { recursive: true });
    try {
      git(['init', '--quiet'], source);
      writeFileSync(join(source, 'README.md'), 'reference fixture\n');
      git(['add', 'README.md'], source);
      git(
        [
          '-c',
          'user.name=ForgeaX Test',
          '-c',
          'user.email=forgeax-test@example.invalid',
          'commit',
          '--quiet',
          '-m',
          'fixture',
        ],
        source,
      );
      git(['clone', '--quiet', '--depth', '1', `file://${source}`, assetsRoot], commonRoot);

      expect(submoduleReference(commonRoot)).toBeUndefined();

      git(['fetch', '--quiet', '--unshallow'], assetsRoot);
      expect(submoduleReference(commonRoot)).toBe(assetsRoot);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports unresolved or detached submodules', () => {
    expect(
      submoduleStatusProblems(
        '-abcdef0123456789 forgeax-engine-assets\n+1234567890abcdef other-sub',
      ),
    ).toEqual(['forgeax-engine-assets', 'other-sub']);
    expect(submoduleStatusProblems(' abcdef0123456789 forgeax-engine-assets')).toEqual([]);
  });
});
