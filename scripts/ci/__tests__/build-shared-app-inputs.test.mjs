import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { decodeCatalogWire } from '@forgeax/engine-pack';
import { readShaderManifestPublication } from '@forgeax/engine-shader';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const script = join(repoRoot, 'scripts', 'ci', 'build-shared-app-inputs.mjs');
const unpackScript = join(repoRoot, 'scripts', 'ci', 'unpack-shared-app-inputs.mjs');

test('shared inputs reuse verified shaders while preserving raw assets and required entries', async () => {
  const output = mkdtempSync(join(tmpdir(), 'forgeax-shared-inputs-'));
  const projection = `${output}-projection`;
  // Shared Vite input paths are relative to the manifest directory's parent.
  const shaders = mkdtempSync(join(repoRoot, 'shared-build-inputs-test-'));
  try {
    const prepared = spawnSync(
      process.execPath,
      [join(repoRoot, 'scripts/build-shared-inputs.mjs'), '--root', repoRoot, '--out', shaders],
      { encoding: 'utf8' },
    );
    assert.equal(prepared.status, 0, prepared.stderr);
    const result = spawnSync(
      process.execPath,
      [
        script,
        '--root',
        repoRoot,
        '--out',
        output,
        '--projection-out',
        projection,
        '--shader-input-manifest',
        join(shaders, 'manifest.json'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const facts = JSON.parse(readFileSync(join(output, 'production-facts.json'), 'utf8'));
    assert.equal(facts.engineCompileCount, 0, 'a verified shader producer must not compile again');
    assert.deepEqual(readdirSync(join(output, 'shaders')), ['manifest.json']);
    assert.deepEqual(readdirSync(join(projection, 'shaders')), ['manifest.json']);
    const catalog = decodeCatalogWire(
      JSON.parse(readFileSync(join(output, 'assets', 'catalog.json'), 'utf8')),
    ).unwrap();
    const shaderManifest = await readShaderManifestPublication(
      JSON.parse(readFileSync(join(output, 'shaders', 'manifest.json'), 'utf8')),
    );
    assert.ok(
      shaderManifest.entries.some((entry) => entry.wgsl.includes('fs_ssao_calc')),
      'shared shader manifest includes the SSAO fullscreen entry used by the browser oracle',
    );
    assert.equal(
      catalog.some((entry) => entry.sourcePath.endsWith('meshes/cube-mesh.stub')),
      false,
      'runtime-generated procedural mesh stubs are not shared Pack inputs',
    );
    const bleep = catalog.find((entry) => entry.sourcePath.endsWith('audio/bleep.mp3'));
    assert.ok(bleep, 'shared catalog includes the raw audio entry');
    const packagePath = bleep.packageUrl?.replace(/^\/+/, '');
    assert.ok(packagePath, 'shared catalog includes the cooked package URL');
    assert.ok(existsSync(join(output, 'assets', 'payload', packagePath)));
    assert.ok(existsSync(join(output, 'assets', 'payload', 'assets')));
    const projectedManifest = JSON.parse(readFileSync(join(projection, 'manifest.json'), 'utf8'));
    assert.deepEqual(projectedManifest.payload, {
      assetCatalog: 'shared-app-inputs/assets/catalog.json',
      engineShaderManifest: 'shared-app-inputs/shaders/manifest.json',
    });
    assert.equal(existsSync(join(projection, 'assets', 'payload')), false);
    assert.ok(existsSync(join(projection, 'assets', 'catalog.json')));
    assert.ok(existsSync(join(projection, 'shaders', 'manifest.json')));
  } finally {
    rmSync(output, { recursive: true, force: true });
    rmSync(projection, { recursive: true, force: true });
    rmSync(shaders, { recursive: true, force: true });
  }
});

test('catalog-only recovery ignores the inherited consumer manifest and omits serialized payload bytes', () => {
  const output = mkdtempSync(join(tmpdir(), 'forgeax-shared-catalog-only-'));
  try {
    const result = spawnSync(
      process.execPath,
      [
        script,
        '--root',
        repoRoot,
        '--out',
        output,
        '--catalog-only',
        '--shader-input-manifest',
        join(output, 'manifest.json'),
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, FORGEAX_SHARED_APP_INPUTS_MANIFEST: join(output, 'manifest.json') },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
    const facts = JSON.parse(readFileSync(join(output, 'production-facts.json'), 'utf8'));
    assert.deepEqual(manifest.payload, {
      assetCatalog: 'shared-app-inputs/assets/catalog.json',
      engineShaderManifest: 'shared-app-inputs/shaders/manifest.json',
    });
    assert.deepEqual(
      readFileSync(join(output, 'compiler', 'wgpu_wasm_bg.wasm')),
      readFileSync(join(repoRoot, 'packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm')),
      'shader output carries the exact producer compiler bytes',
    );
    assert.ok(existsSync(join(output, 'compiler', 'provenance.json')));
    assert.equal(facts.engineCompileCount, 1, 'a missing/cleared input must rebuild from source');
    assert.equal(facts.payloadMode, 'catalog-only');
    assert.equal(facts.payloadEmitCount, 0);
    assert.equal(existsSync(join(output, 'assets', 'payload')), false);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('shared input transfer is a compact tarball and unpacking is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-shared-input-archive-'));
  const source = join(root, 'shared-app-inputs');
  const transfer = join(root, 'shared-app-inputs-transfer');
  try {
    mkdirSync(join(source, 'assets'), { recursive: true });
    mkdirSync(join(source, 'shaders'), { recursive: true });
    mkdirSync(transfer, { recursive: true });
    writeFileSync(join(source, 'manifest.json'), '{"schemaVersion":1}\n');
    writeFileSync(join(source, 'assets', 'catalog.json'), '[]\n');
    writeFileSync(join(source, 'shaders', 'manifest.json'), '{}\n');
    writeFileSync(join(source, 'shaders', 'engine.wgsl'), 'shader\n');
    const archive = join(transfer, 'shared-app-inputs.tar.gz');
    const packed = spawnSync(
      'tar',
      ['-czf', archive, '-C', source, 'assets', 'shaders', 'manifest.json'],
      { encoding: 'utf8' },
    );
    assert.equal(packed.status, 0, packed.stderr);

    const unpacked = spawnSync(process.execPath, [unpackScript, '--root', root], {
      encoding: 'utf8',
    });
    assert.equal(unpacked.status, 0, unpacked.stderr);
    assert.equal(existsSync(archive), false);
    assert.equal(readFileSync(join(source, 'shaders', 'engine.wgsl'), 'utf8'), 'shader\n');
    assert.equal(existsSync(join(source, 'assets', 'payload')), false);

    const second = spawnSync(process.execPath, [unpackScript, '--root', root], {
      encoding: 'utf8',
    });
    assert.equal(second.status, 0, second.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
