import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { analyticUniformCloudRef, bandCloudRef, bandWideInstanceRef, cloudGuid, referenceCloudRef } from '@forgeax-assets/volumetric-clouds/references';
import { standardUeCloudRef, standardUeGuid } from '@forgeax-assets/ue-volumetric-clouds/references';

const root = new URL('../', import.meta.url);

test('mounts both shared cloud libraries without embedding their authoring payloads', () => {
  const project = JSON.parse(readFileSync(new URL('../forge.json', root), 'utf8'));
  const manifest = JSON.parse(readFileSync(new URL('../package.json', root), 'utf8'));
  for (const name of ['@forgeax-assets/volumetric-clouds', '@forgeax-assets/ue-volumetric-clouds']) {
    assert.ok(project.assetLibraries.includes(name));
    assert.match(manifest.dependencies[name], /^file:\.\.\/\.\.\/forgeax-engine-assets\/demo-assets\/volumetric-clouds/);
  }
  assert.equal(existsSync(new URL('clouds/', root)), false);
  const files = readdirSync(root, { recursive: true }).map(String);
  assert.deepEqual(files.filter(file => /\.(raw|wgsl)$/.test(file)), []);
});

test('keeps every demo material reference on the shared packages original GUIDs', () => {
  assert.deepEqual(referenceCloudRef, { $asset: cloudGuid('material/reference-layout') });
  assert.deepEqual(analyticUniformCloudRef, { $asset: cloudGuid('material/analytic-uniform') });
  assert.deepEqual(bandCloudRef, { $asset: cloudGuid('material/cloud-band') });
  assert.deepEqual(bandWideInstanceRef, { $asset: cloudGuid('instance/cloud-band-wide') });
  assert.deepEqual(standardUeCloudRef, { $asset: standardUeGuid('material/sample-ue') });
});
