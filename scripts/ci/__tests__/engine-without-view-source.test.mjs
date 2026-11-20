import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { SDK_RESOURCE_ALLOWLIST } from '../../forgeax/sdk-lib.mjs';
import { prepareEngineWithoutViewContent } from '../engine-without-view-source.mjs';

test('retains ordinary Content sources in a Git projection without private Assets or View', async () => {
  const repositoryRoot = resolve(import.meta.dirname, '../../..');
  const sourceRoot = await mkdtemp(resolve(tmpdir(), 'engine-without-view-'));
  try {
    const tracked = spawnSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'packages/content'],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
      },
    );
    assert.equal(tracked.status, 0, tracked.stderr);
    const files = tracked.stdout
      .split('\0')
      .filter((file) => file && existsSync(resolve(repositoryRoot, file)));
    assert.ok(files.includes('packages/content/assets/checker.pack.ts'));
    assert.ok(files.includes('packages/content/assets/water/materials.pack.ts'));
    assert.ok(files.includes('packages/content/assets/water/texture-pixels.ts'));
    assert.ok(files.includes('packages/content/assets/water/impulse-noise.pack.ts'));
    assert.ok(files.includes('packages/content/assets/water/volume-noise.pack.ts'));
    assert.equal(
      files.some((file) => /\.(?:png|jpe?g)$/i.test(file)),
      false,
    );
    assert.equal(
      SDK_RESOURCE_ALLOWLIST.some(({ package: name }) => name === '@forgeax/engine-content'),
      false,
    );
    for (const file of files) {
      const target = resolve(sourceRoot, file);
      await mkdir(dirname(target), { recursive: true });
      await cp(resolve(repositoryRoot, file), target);
    }
    await prepareEngineWithoutViewContent({ repositoryRoot, sourceRoot });
    for (const file of files) {
      assert.deepEqual(
        await readFile(resolve(sourceRoot, file)),
        await readFile(resolve(repositoryRoot, file)),
        file,
      );
    }
    assert.equal(existsSync(resolve(sourceRoot, 'forgeax-engine-assets')), false);
    assert.equal(existsSync(resolve(sourceRoot, 'tools/view')), false);
    assert.equal(existsSync(resolve(sourceRoot, 'shared-build-inputs')), false);
    assert.equal(existsSync(resolve(sourceRoot, '.forgeax-public-distribution')), true);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

test('resource preparation preserves projected Content sources and excludes unlisted files', async () => {
  const repositoryRoot = await mkdtemp(resolve(tmpdir(), 'engine-without-view-inputs-'));
  const sourceRoot = await mkdtemp(resolve(tmpdir(), 'engine-without-view-'));
  try {
    const originalRoot = resolve(import.meta.dirname, '../../..');
    for (const entry of SDK_RESOURCE_ALLOWLIST)
      await cp(resolve(originalRoot, entry.sourceRoot), resolve(repositoryRoot, entry.sourceRoot), {
        recursive: true,
      });
    const contentPath = 'packages/content/assets/checker.pack.ts';
    await mkdir(dirname(resolve(repositoryRoot, contentPath)), { recursive: true });
    await mkdir(dirname(resolve(sourceRoot, contentPath)), { recursive: true });
    await writeFile(resolve(repositoryRoot, contentPath), 'unprojected working source\n');
    await writeFile(resolve(sourceRoot, contentPath), 'projected source\n');
    const unlisted = 'packages/content/assets/unlisted.png';
    await writeFile(resolve(repositoryRoot, unlisted), 'unlisted resource');
    await prepareEngineWithoutViewContent({ repositoryRoot, sourceRoot });
    assert.equal(await readFile(resolve(sourceRoot, contentPath), 'utf8'), 'projected source\n');
    assert.equal(existsSync(resolve(sourceRoot, unlisted)), false);
    assert.equal(existsSync(resolve(sourceRoot, '.forgeax-public-distribution')), true);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
  }
});
