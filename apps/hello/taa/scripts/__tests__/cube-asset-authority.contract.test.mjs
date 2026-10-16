import { decodeCatalogWire } from '@forgeax/engine-pack';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourcePath = resolve(appRoot, 'src/main.ts');
const cubePath = resolve(appRoot, 'assets/auto-exposure-positive-lut.cube');
const metaPath = `${cubePath}.meta.json`;
const packIndexPath = resolve(appRoot, 'dist/pack-index.json');

function cubeRows(source) {
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, '').trim())
    .filter((line) => line.length > 0 && line.split(/\s+/).length === 3)
    .map((line) => line.split(/\s+/).map(Number));
}

test('positive LUT is an ordinary Catalogued 3D TextureAsset, not inline data', () => {
  const source = readFileSync(sourcePath, 'utf8');
  assert.doesNotMatch(source, /makeIdentityLut|fixture-texture-3d-lut-v1/);
  assert.match(source, /loadByGuid\s*<\s*TextureAsset\s*>/);
  assert.ok(existsSync(cubePath), 'the .cube source must be present');
  assert.ok(existsSync(metaPath), 'the .cube CookReceipt sidecar must be present');

  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  assert.equal(meta.kind, 'external-asset-package');
  assert.equal(meta.importer, 'image');
  const subAsset = meta.subAssets?.[0];
  assert.equal(subAsset?.kind, 'texture');
  assert.equal(subAsset?.sourceIndex, 0);
  assert.match(subAsset?.guid ?? '', /^[0-9a-f-]{36}$/i);
  assert.match(subAsset?.sourceKey ?? '', /auto-exposure-positive-lut/);

  const cube = readFileSync(cubePath, 'utf8');
  assert.match(cube, /^LUT_3D_SIZE\s+(16|32|64)$/m);
  assert.match(cube, /^DOMAIN_MIN\s+-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?$/m);
  assert.match(cube, /^DOMAIN_MAX\s+-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?$/m);
  const size = Number(cube.match(/^LUT_3D_SIZE\s+(\d+)$/m)?.[1]);
  const rows = cubeRows(cube);
  assert.equal(rows.length, size ** 3);
  assert.ok(rows.every((row) => row.length === 3 && row.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)));

  assert.ok(existsSync(packIndexPath), 'build must emit the authoritative pack-index');
  const entries = decodeCatalogWire(JSON.parse(readFileSync(packIndexPath, 'utf8'))).unwrap();
  const row = entries?.find((entry) =>
    typeof entry?.sourcePath === 'string' && entry.sourcePath.endsWith('auto-exposure-positive-lut.cube'),
  );
  assert.ok(row, 'the built Catalog must contain the .cube row');
  assert.equal(row.kind, 'texture');
  assert.equal(row.sourceKey, subAsset.sourceKey);
  assert.equal(row.publication?.generation, 1);
  assert.equal(row.publication?.receipt?.sourcePath, row.sourcePath);
  assert.equal(row.publication?.receipt?.outputDigest, row.publication?.digest);
  assert.match(row.guid ?? '', /^[0-9a-f-]{36}$/i);
  assert.match(row.sourceKey ?? '', /auto-exposure-positive-lut/);
  const packageName = `${row.guid}.pack.json`;
  assert.ok(
    existsSync(resolve(appRoot, 'dist/assets', packageName)),
    'the Catalog row must resolve to its canonical cooked package',
  );
  const cooked = JSON.parse(readFileSync(resolve(appRoot, 'dist/assets', packageName), 'utf8'));
  const payload = cooked.assets?.[0]?.payload;
  assert.equal(payload?.shape?.viewDimension, '3d');
  assert.equal(payload?.format, 'rgba16float');
  assert.equal(payload?.colorSpace, 'linear');
  assert.equal(cooked.generation, 1);
  assert.ok(typeof cooked.digest === 'string');
  assert.ok(typeof cooked.assets?.[0]?.artifacts?.body?.path === 'string');
});

test('authoritative fixture falsifiers remain rejected by the contract', () => {
  const source = readFileSync(sourcePath, 'utf8');
  assert.doesNotMatch(source, /TextureAsset\s*\{[\s\S]*viewDimension:\s*['"]2d['"]/);
  assert.doesNotMatch(source, /sourceKey\s*:\s*['"]fixture-texture-3d-lut-v1['"]/);
  assert.doesNotMatch(source, /makeIdentityLut\s*\(/);
});
