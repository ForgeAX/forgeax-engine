import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('format-tier1 browser producer owns one canonical entry and refuses unsupported cells', async () => {
  const [packageJson, html, source, viteConfig, sidecar] = await Promise.all([
    readFile(resolve(appRoot, 'package.json'), 'utf8').then(JSON.parse),
    readFile(resolve(appRoot, 'index.html'), 'utf8'),
    readFile(resolve(appRoot, 'src/main.ts'), 'utf8'),
    readFile(resolve(appRoot, 'vite.config.ts'), 'utf8'),
    readFile(resolve(appRoot, 'fixtures/animated-morph-cube.gltf.meta.json'), 'utf8').then(JSON.parse),
  ]);
  assert.equal(packageJson.name, '@forgeax/hello-format-tier1');
  assert.match(packageJson.scripts.dev, /vite/);
  assert.match(html, /src="\/src\/main\.ts"/);
  for (const marker of ['Meshopt', 'ETC1S', 'UASTC LDR', 'UASTC HDR', 'Raw Basis', 'Static target A', 'Animation t=1', 'Zero-weight reset']) {
    assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(source, /parseGltf/);
  assert.match(source, /meshIrToMeshAsset/);
  assert.match(source, /loadByGuid/);
  assert.match(source, /loadCanonicalMorph\(assets: RuntimeAssetRegistry\)/);
  assert.match(source, /configureRuntimeAssetCatalog\(\s*assets,\s*createStandaloneRuntimeAssetBinding\('format-tier1'\)/);
  assert.match(source, /assets\.loadByGuid<AnimationClip>/);
  assert.match(source, /baseWeights: loaded\.value\.morphWeights/);
  assert.match(source, /weights: canonical\.baseWeights\.slice\(\)/);
  assert.match(source, /MeshFilter/);
  assert.match(source, /MeshRenderer/);
  assert.doesNotMatch(source, /function meshForWeights/);
  assert.match(viteConfig, /pluginPack/);
  assert.match(viteConfig, /gltfImporter/);
  assert.match(viteConfig, /createStandaloneRuntimeAssetBinding\('format-tier1'\)/);
  assert.equal(sidecar.subAssets.find((asset) => asset.kind === 'mesh')?.guid, '11111111-1111-4111-8111-111111111111');
  assert.equal(sidecar.subAssets.find((asset) => asset.kind === 'animation-clip')?.guid, '44444444-4444-4444-8444-444444444444');
  assert.doesNotMatch(source, /createBuiltinMorphFeature/);
  assert.match(source, /constructRuntimeRendererHost/);
  assert.match(source, /MorphWeights/);
  assert.match(source, /Standard CPU deformation lane/);
  assert.match(source, /renderer\.draw/);
  assert.doesNotMatch(source, /renderMorphSvg/);
  assert.match(source, /status-blocked/);
});
