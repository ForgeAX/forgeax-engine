import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('material package production dependency', async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL('../../packages/vite-plugin-pack/package.json', import.meta.url),
      'utf8',
    ),
  );

  assert.ok(manifest.dependencies['@forgeax/engine-pack']);
  assert.equal(manifest.dependencies['@forgeax/engine-shader-compiler'], undefined);
  assert.equal(manifest.peerDependencies?.['@forgeax/engine-pack'], undefined);
  assert.equal(manifest.devDependencies?.['@forgeax/engine-pack'], undefined);
});
