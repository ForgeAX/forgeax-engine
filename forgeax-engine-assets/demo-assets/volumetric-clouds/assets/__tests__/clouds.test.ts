import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { loadScriptablePack } from '@forgeax/engine/pack/source-node';
import cloudPack from '../clouds.pack.ts';
import { referenceTexture, type CloudTextureValues } from '../reference-textures.ts';
import { periodicPerlin, periodicWorley } from '../texture-noise.ts';

const defaults = Object.fromEntries(cloudPack.parameters.map((parameter) => [parameter.name, parameter.default])) as unknown as CloudTextureValues;
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

test('cold-generates the complete library closure and native sky Scene', async () => {
  const loaded = await loadScriptablePack(fileURLToPath(new URL('../clouds.pack.ts', import.meta.url)));
  assert.equal(loaded.ok, true);
  if (!loaded.ok) throw loaded.error;
  const definition = loaded.value;
  const built = await definition.build({
    packageId: definition.packageId,
    values: { ...defaults, resolution: 'preview' },
    readByGuid: async () => { throw new Error('Cloud generation must be self-contained'); },
  });
  if (!built.ok) throw built.error;
  assert.equal(Object.keys(built.value).length, 11);
  const sky = built.value['scene/sky'];
  assert.equal(sky?.kind, 'scene');
  if (sky?.kind !== 'scene') throw new Error('Sky Scene missing');
  assert.equal(sky.entities.atmosphere?.components.Atmosphere?.backgroundOnly, false);
  assert.equal(sky.entities.clouds?.components.VolumetricCloudLayer?.material,
    '4c77c4c0-ef1e-515d-9da9-aec256aca42d');
  for (const name of ['layout-pattern', 'layout-mask', 'height-profile', 'body-noise']) {
    assert.equal(built.value[`texture/${name}`]?.kind, 'texture');
  }
});

test('reproduces volume bytes by seed and changes them with a different seed', () => {
  const values: CloudTextureValues = { ...defaults, resolution: 'preview' };
  const first = referenceTexture('body', values);
  assert.equal(hash(first.data), hash(referenceTexture('body', values).data));
  assert.notEqual(hash(first.data), hash(referenceTexture('body', { ...values, seed: values.seed + 1 }).data));
});

test('tiles both noise fields across positive and negative coordinates', () => {
  for (const factory of [periodicPerlin, periodicWorley]) {
    const sample = factory(defaults.seed, 7);
    assert.ok(Math.abs(sample(-0.2, 0.3, 0.7) - sample(0.8, 0.3, 0.7)) < 1e-10);
  }
});
