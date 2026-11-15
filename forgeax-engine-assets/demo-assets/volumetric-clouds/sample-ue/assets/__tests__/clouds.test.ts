import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadScriptablePack } from '@forgeax/engine/pack/source-node';
import type { PackCookSource } from '@forgeax/engine/pack/source';
import type { CloudMaterialSource } from '@forgeax/engine/render/authoring';
import type { TextureAsset } from '@forgeax/engine/types';
import { test } from 'vitest';
import { standardUeGuid } from '../identity.ts';
import { textureSources } from '../texture-definitions.ts';

test('cold-builds the UE material with its complete, byte-identical texture closure', async () => {
  const loaded = await loadScriptablePack(fileURLToPath(new URL('../sample-ue-standard.pack.ts', import.meta.url)));
  if (!loaded.ok) throw loaded.error;
  const built = await loaded.value.build({
    packageId: loaded.value.packageId,
    values: {},
    readByGuid: async () => { throw new Error('UE texture Pack must be self-contained'); },
  });
  if (!built.ok) throw built.error;
  assert.deepEqual(Object.keys(built.value).sort(), [
    'material/sample-ue', ...textureSources.map(source => source.key),
  ].sort());
  const material = built.value['material/sample-ue'] as PackCookSource;
  assert.equal(material?.kind, 'cloud-material');
  if (material?.kind !== 'cloud-material') throw new Error('Cloud material missing');
  assert.equal(material.execution, 'cooked');
  const definition = material.source as CloudMaterialSource;
  assert.deepEqual(definition.model, { kind: 'program', source: 'reference-layout.wgsl' });
  for (const source of textureSources) {
    const texture = built.value[source.key] as TextureAsset;
    assert.equal(texture?.kind, 'texture');
    if (texture?.kind !== 'texture') throw new Error(`Missing ${source.key}`);
    assert.equal(texture.format, source.format);
    assert.equal(texture.colorSpace, 'linear');
    assert.deepEqual(texture.shape, {
      viewDimension: source.dimension,
      extent: { width: source.width, height: source.height, ...(source.depth > 1 ? { depth: source.depth } : {}) },
    });
    assert.equal(texture.data.byteLength, source.bytes);
    const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    assert.equal(hash(texture.data), source.sha256);
    const input = await readFile(new URL(`../textures/${source.name}.raw`, import.meta.url));
    assert.equal(hash(input), source.sha256);
    assert.deepEqual(texture.mips, { kind: 'none' });
    assert.equal(definition.parameters[source.parameter]?.default, standardUeGuid(source.key));
  }
});
