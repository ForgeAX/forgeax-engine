import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import { imageKindSidecars } from '../lint/grep-image-kind-convergence.mjs';

test('sidecar lint finds nested violations and fails on unavailable roots', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax lint % '));
  try {
    const nested = join(root, 'nested');
    mkdirSync(nested);
    const invalid = join(nested, 'invalid.meta.json');
    writeFileSync(invalid, '{"kind": "image"}');
    writeFileSync(join(root, 'valid.meta.json'), '{"kind":"texture"}');
    writeFileSync(join(root, 'ordinary.json'), '{"kind": "image"}');
    assert.deepEqual(imageKindSidecars([root]), [invalid]);
    assert.throws(() => imageKindSidecars([join(root, 'absent')]), { code: 'ENOENT' });
    rmSync(invalid);
    assert.deepEqual(imageKindSidecars([root]), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const script of [
  'lint/grep-error-hints.mjs',
  'lint/grep-runtime-catalog-routing.mjs',
  'grep/check-pack-schema-dist-fresh.mjs',
  'check-material-contract-inventory.mjs',
]) {
  test(`real source gate resolves repository paths: ${script}`, () => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL(`../${script}`, import.meta.url))],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}

test('material contract inventory reads source and compressed app build outputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax material inventory '));
  try {
    const sidecar = 'apps/example/src/input.wgsl.meta.json';
    const materialPack = 'apps/example/dist/assets/cooked.pack.json';
    for (const directory of [
      'scripts/lib',
      'apps/example/src',
      'apps/example/dist/assets',
      'packages',
    ]) {
      mkdirSync(join(root, directory), { recursive: true });
    }
    const script = join(root, 'scripts/check-material-contract-inventory.mjs');
    copyFileSync(new URL('../check-material-contract-inventory.mjs', import.meta.url), script);
    copyFileSync(
      new URL('../lib/artifact-json.mjs', import.meta.url),
      join(root, 'scripts/lib/artifact-json.mjs'),
    );
    writeFileSync(
      join(root, 'scripts/material-contract-inventory.json'),
      JSON.stringify({ materialSidecars: [sidecar], materialPackages: [materialPack] }),
    );
    writeFileSync(
      join(root, sidecar),
      JSON.stringify({ importSettings: { materialShaderIdentifier: 'fixture' } }),
    );
    writeFileSync(
      join(root, 'apps/example/dist/assets/input.wgsl'),
      '#define_import_path project::fixture\n',
    );
    const pack = {
      kind: 'internal-text-package',
      assets: [
        {
          kind: 'material',
          sourceKey: 'input.wgsl',
          payload: { passes: [{ program: { module: 'project::fixture' } }] },
        },
      ],
    };
    writeFileSync(join(root, materialPack), zstdCompressSync(Buffer.from(JSON.stringify(pack))));

    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const inventory = JSON.parse(result.stdout);
    assert.deepEqual(
      inventory.materialSidecars.map(({ path }) => path),
      [sidecar],
    );
    assert.deepEqual(
      inventory.materialPackages.map(({ path }) => path),
      [materialPack],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
