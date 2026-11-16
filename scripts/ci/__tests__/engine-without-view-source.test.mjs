import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { prepareWaterContent } from '../../../packages/content/scripts/prepare-water-content.mjs';
import { SDK_RESOURCE_ALLOWLIST } from '../../forgeax/sdk-lib.mjs';
import { prepareEngineWithoutViewContent } from '../engine-without-view-source.mjs';

test('retains the sealed Water closure in a tracked source projection without private Assets or View', async () => {
  const repositoryRoot = resolve(import.meta.dirname, '../../..');
  const sourceRoot = await mkdtemp(resolve(tmpdir(), 'engine-without-view-'));
  try {
    const tracked = spawnSync('git', ['ls-files', '-z', '--', 'packages/content'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    assert.equal(tracked.status, 0, tracked.stderr);
    for (const file of tracked.stdout.split('\0').filter(Boolean)) {
      const target = resolve(sourceRoot, file);
      await mkdir(dirname(target), { recursive: true });
      await cp(resolve(repositoryRoot, file), target);
    }
    await assert.rejects(prepareWaterContent({ repositoryRoot: sourceRoot }), { code: 'ENOENT' });
    await prepareEngineWithoutViewContent({ repositoryRoot, sourceRoot });
    const prepared = await prepareWaterContent({ repositoryRoot: sourceRoot });
    const closure = SDK_RESOURCE_ALLOWLIST.find(({ id }) => id === 'content-water');
    assert.ok(closure);
    const provenance = JSON.parse(
      await readFile(resolve(sourceRoot, closure.sourceRoot, 'provenance.json'), 'utf8'),
    );
    assert.equal(prepared.length, 8);
    assert.deepEqual(
      prepared,
      provenance.files.map(({ file, sha256 }) => ({ file, sha256 })),
    );
    for (const file of closure.files) {
      const original = await readFile(resolve(repositoryRoot, closure.sourceRoot, file));
      const sealed = await readFile(resolve(sourceRoot, closure.sourceRoot, file));
      assert.deepEqual(sealed, original, file);
    }
    for (const { file, sha256 } of prepared) {
      const sealed = await readFile(resolve(sourceRoot, closure.sourceRoot, file));
      assert.equal(createHash('sha256').update(sealed).digest('hex'), sha256, file);
    }
    assert.equal(existsSync(resolve(sourceRoot, 'forgeax-engine-assets')), false);
    assert.equal(existsSync(resolve(sourceRoot, 'tools/view')), false);
    assert.equal(existsSync(resolve(sourceRoot, '.forgeax-public-distribution')), true);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

test('rejects changed sealed Water bytes before selecting public source mode', async () => {
  const repositoryRoot = await mkdtemp(resolve(tmpdir(), 'engine-without-view-inputs-'));
  const sourceRoot = await mkdtemp(resolve(tmpdir(), 'engine-without-view-'));
  try {
    const originalRoot = resolve(import.meta.dirname, '../../..');
    for (const entry of SDK_RESOURCE_ALLOWLIST)
      await cp(resolve(originalRoot, entry.sourceRoot), resolve(repositoryRoot, entry.sourceRoot), {
        recursive: true,
      });
    const waterRoot = resolve(repositoryRoot, 'packages/content/assets/water');
    const provenance = JSON.parse(await readFile(resolve(waterRoot, 'provenance.json'), 'utf8'));
    const file = provenance.files[0].file;
    await writeFile(resolve(waterRoot, file), 'invalid sealed source');
    await assert.rejects(
      prepareEngineWithoutViewContent({ repositoryRoot, sourceRoot }),
      /water-content-source-digest:/,
    );
    assert.equal(existsSync(resolve(sourceRoot, '.forgeax-public-distribution')), false);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
  }
});
