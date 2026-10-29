import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { readDeliverySource } from '../delivery-identity.js';

const exec = promisify(execFile);

it('binds clean, dirty, staged and untracked source bytes without changing the worktree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'delivery-source-'));
  const git = (...args: string[]) => exec('git', ['-C', root, ...args]);
  try {
    expect(await readDeliverySource(root)).toEqual({ kind: 'unversioned' });
    await git('init', '-q');
    expect(await readDeliverySource(root)).toEqual({ kind: 'unversioned' });
    await writeFile(join(root, 'source.ts'), 'export const value=1;');
    await git('add', '.');
    await git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-qm',
      'fixture',
    );
    const clean = await readDeliverySource(root);
    expect(clean).toMatchObject({ kind: 'git', dirty: false });
    await writeFile(join(root, 'source.ts'), 'export const value=2;');
    const dirty = await readDeliverySource(root);
    expect(dirty).toMatchObject({
      kind: 'git',
      dirty: true,
      commit: clean.kind === 'git' ? clean.commit : '',
    });
    expect(dirty).not.toEqual(clean);
    await git('add', '.');
    expect(await readDeliverySource(root)).not.toEqual(clean);
    await writeFile(join(root, 'extra.ts'), 'first');
    const first = await readDeliverySource(root);
    await writeFile(join(root, 'extra.ts'), 'second');
    expect(await readDeliverySource(root)).not.toEqual(first);
    expect((await git('diff', '--cached', '--name-only')).stdout.trim()).toBe('source.ts');
    await writeFile(join(root, '.gitignore'), 'ignored/\n');
    await mkdir(join(root, 'ignored'));
    await writeFile(join(root, 'ignored/source.ts'), 'outside version control');
    expect(await readDeliverySource(join(root, 'ignored'))).toEqual({ kind: 'unversioned' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('distinguishes different dirty bytes inside an initialized submodule', async () => {
  const root = await mkdtemp(join(tmpdir(), 'delivery-module-parent-'));
  const child = await mkdtemp(join(tmpdir(), 'delivery-module-source-'));
  const git = (cwd: string, ...args: string[]) => exec('git', ['-C', cwd, ...args]);
  try {
    await git(child, 'init', '-q');
    await writeFile(join(child, 'source.ts'), 'initial');
    await git(child, 'add', '.');
    await git(
      child,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-qm',
      'fixture',
    );
    await git(root, 'init', '-q');
    await git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'vendor/module');
    await git(
      root,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-qam',
      'module',
    );
    await writeFile(join(root, 'vendor/module/source.ts'), 'dirty first');
    const first = await readDeliverySource(root);
    await writeFile(join(root, 'vendor/module/source.ts'), 'dirty second');
    const second = await readDeliverySource(root);
    expect(first).toMatchObject({ kind: 'git', dirty: true });
    expect(second).toMatchObject({ kind: 'git', dirty: true });
    expect(second).not.toEqual(first);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(child, { recursive: true, force: true });
  }
});
