import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { analyticUniformCloudRef, bandCloudRef, bandWideInstanceRef, cloudGuid, referenceCloudRef } from '@forgeax-assets/volumetric-clouds/references';
import generatedCloudPack from '../nubis/generated-clouds.pack.ts';
import { standardUeCloudRef, standardUeGuid } from '@forgeax-assets/ue-volumetric-clouds/references';

const root = new URL('../', import.meta.url);

test('mounts imported UE assets and supplies Generated Clouds once using the shared package identity', () => {
  const project = JSON.parse(readFileSync(new URL('../forge.json', root), 'utf8'));
  const manifest = JSON.parse(readFileSync(new URL('../package.json', root), 'utf8'));
  for (const name of ['@forgeax-assets/volumetric-clouds', '@forgeax-assets/ue-volumetric-clouds']) {
    assert.match(manifest.dependencies[name], /^file:\.\.\/\.\.\/forgeax-engine-assets\/demo-assets\/volumetric-clouds/);
  }
  assert.equal(existsSync(new URL('clouds/', root)), false);
  assert.ok(project.assetLibraries.includes('@forgeax-assets/ue-volumetric-clouds'));
  assert.ok(!project.assetLibraries.includes('@forgeax-assets/volumetric-clouds'));
  assert.equal(AssetGuid.format(AssetGuid.derive(generatedCloudPack.packageId, 'material/reference-layout')), referenceCloudRef.$asset);
});

test('keeps the original demo references on the shared packages original GUIDs', () => {
  assert.deepEqual(referenceCloudRef, { $asset: cloudGuid('material/reference-layout') });
  assert.deepEqual(analyticUniformCloudRef, { $asset: cloudGuid('material/analytic-uniform') });
  assert.deepEqual(bandCloudRef, { $asset: cloudGuid('material/cloud-band') });
  assert.deepEqual(bandWideInstanceRef, { $asset: cloudGuid('instance/cloud-band-wide') });
  assert.deepEqual(standardUeCloudRef, { $asset: standardUeGuid('material/sample-ue') });
});
