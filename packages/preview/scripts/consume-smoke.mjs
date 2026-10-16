import assert from 'node:assert/strict';
import materialPlugin from '../dist/material.mjs';
import meshPlugin from '../dist/mesh.mjs';
import texturePlugin from '../dist/texture.mjs';
import vfxPlugin from '../dist/vfx.mjs';

for (const [kind, plugin] of Object.entries({ material: materialPlugin, mesh: meshPlugin, vfx: vfxPlugin, texture: texturePlugin })) {
  assert.equal(plugin.plugin.name, `forgeax-preview-${kind}`);
  assert.equal(plugin.tools.length, 1);
  assert.equal(plugin.tools[0].descriptor.id, `asset.${kind}.preview`);
  assert.equal(plugin.tools[0].descriptor.realm, 'host');
}
console.log('[preview] native plugin tool consumer smoke: PASS');
