import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { SDK_RESOURCE_ALLOWLIST } from '../../forgeax/sdk-lib.mjs';
import { reusableSharedShader, sharedShaderReceipt } from '../../lib/shared-build-cache.mjs';
import {
  engineWithoutViewBuildEnvironment,
  prepareEngineWithoutViewContent,
} from '../engine-without-view-source.mjs';

test('admits the bounded CI cold compiler pool and preserves explicit requests', () => {
  const heavy = { cpus: 8, memoryBytes: 16_000_000_000 };
  assert.equal(
    engineWithoutViewBuildEnvironment({ CI: 'true' }, heavy).FORGEAX_SHADER_COMPILE_WORKERS,
    '4',
  );
  assert.equal(
    engineWithoutViewBuildEnvironment({ CI: 'true', FORGEAX_SHADER_COMPILE_WORKERS: '2' }, heavy)
      .FORGEAX_SHADER_COMPILE_WORKERS,
    '2',
  );
  assert.equal(engineWithoutViewBuildEnvironment({}, heavy).FORGEAX_SHADER_COMPILE_WORKERS, '2');
  assert.equal(
    engineWithoutViewBuildEnvironment({ CI: 'true' }, { cpus: 2, memoryBytes: 8_000_000_000 })
      .FORGEAX_SHADER_COMPILE_WORKERS,
    '1',
  );
});

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
    assert.equal(existsSync(resolve(sourceRoot, '.forgeax-public-distribution')), true);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

test('stages a disposable shared shader cache candidate for fingerprinted reuse', async () => {
  const repositoryRoot = resolve(import.meta.dirname, '../../..');
  const sourceRoot = await mkdtemp(resolve(tmpdir(), 'engine-without-view-'));
  const artifactRoot = await mkdtemp(resolve(tmpdir(), 'shared-input-artifact-'));
  const sharedInputsRoot = resolve(artifactRoot, 'shared-app-inputs');
  const shaderManifest = '{"shader":"candidate"}\n';
  const inputFingerprint = `sha256:${'a'.repeat(64)}`;
  const sharedManifest = {
    schemaVersion: 1,
    producer: 'shared-app-inputs',
    shaderBuild: null,
    inventory: ['shared-app-inputs/assets/catalog.json', 'shared-app-inputs/shaders/manifest.json'],
    payload: {
      assetCatalog: 'shared-app-inputs/assets/catalog.json',
      engineShaderManifest: 'shared-app-inputs/shaders/manifest.json',
    },
  };
  try {
    await mkdir(resolve(sharedInputsRoot, 'assets'), { recursive: true });
    await mkdir(resolve(sharedInputsRoot, 'shaders'), { recursive: true });
    await writeFile(resolve(sharedInputsRoot, 'assets/catalog.json'), '{}\n');
    await writeFile(resolve(sharedInputsRoot, 'shaders/manifest.json'), shaderManifest);
    sharedManifest.shaderBuild = sharedShaderReceipt(
      artifactRoot,
      resolve(sharedInputsRoot, 'shaders/manifest.json'),
      inputFingerprint,
    );
    await writeFile(resolve(sharedInputsRoot, 'manifest.json'), JSON.stringify(sharedManifest));

    await prepareEngineWithoutViewContent({
      repositoryRoot,
      sourceRoot,
      sharedInputsRoot,
    });

    assert.deepEqual(
      JSON.parse(await readFile(resolve(sourceRoot, 'shared-app-inputs/manifest.json'), 'utf8')),
      sharedManifest,
    );
    assert.equal(
      await readFile(resolve(sourceRoot, 'shared-app-inputs/shaders/manifest.json'), 'utf8'),
      shaderManifest,
    );
    assert.equal(lstatSync(resolve(sourceRoot, 'shared-build-inputs')).isSymbolicLink(), true);
    assert.equal(readlinkSync(resolve(sourceRoot, 'shared-build-inputs')), 'shared-app-inputs');
    const cacheManifest = resolve(sourceRoot, 'shared-build-inputs/manifest.json');
    assert.equal(
      reusableSharedShader(sourceRoot, cacheManifest, inputFingerprint),
      resolve(sourceRoot, 'shared-app-inputs/shaders/manifest.json'),
    );
    assert.equal(reusableSharedShader(sourceRoot, cacheManifest, `sha256:${'c'.repeat(64)}`), null);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
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
