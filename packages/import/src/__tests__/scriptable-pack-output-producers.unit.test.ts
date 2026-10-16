import { createBoxGeometry } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { AssetGuid as AssetGuidType, MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  materialAssetOutputProducer,
  meshAssetOutputProducer,
} from '../scriptable-pack-output-producers.js';

function guid(value: string): AssetGuidType {
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

const MATERIAL_GUID = guid('019ffa97-3000-7000-8000-000000000001');
const PARENT_GUID = guid('019ffa97-3000-7000-8000-000000000002');
const TEXTURE_GUID = guid('019ffa97-3000-7000-8000-000000000003');
const SAMPLER_GUID = guid('019ffa97-3000-7000-8000-000000000004');

describe('ScriptablePack standard output producers', () => {
  it('packs generated mesh bytes and derives default-material references', async () => {
    const mesh: MeshAsset = {
      ...createBoxGeometry(1, 1, 1).unwrap(),
      materialSlots: [{ slotName: 'Shell', sourceKey: 'shell', defaultMaterial: MATERIAL_GUID }],
    };

    const result = await meshAssetOutputProducer.produce({
      guid: '019ffa97-3000-7000-8000-000000000010',
      sourceKey: 'geometry/shell',
      asset: mesh,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.payload).toBe(mesh);
    expect(result.value.refs).toEqual([
      {
        guid: AssetGuid.format(MATERIAL_GUID),
        sourceField: { fieldName: 'materialSlots', arrayIndex: 0 },
      },
    ]);
    expect(result.value.artifacts.body).toMatchObject({
      mediaType: 'application/x-forgeax-mesh',
      assetCodec: { name: 'mesh-binary', version: '5' },
    });
    expect(result.value.artifacts.body?.bytes.byteLength).toBeGreaterThan(28);
  });

  it.each([
    'baseColorTexture',
    'metallicTexture',
    'roughnessTexture',
    'alphaTexture',
  ])('projects %s GUIDs and coordinates into one deterministic refs graph', async (slot) => {
    const material: MaterialAsset = {
      kind: 'material',
      parent: PARENT_GUID,
      values: {
        [slot]: {
          texture: TEXTURE_GUID,
          sampler: SAMPLER_GUID,
          coordinates: { set: 1, transform: { scale: [2, 2] } },
        },
      },
    };

    const result = await materialAssetOutputProducer.produce({
      guid: AssetGuid.format(MATERIAL_GUID),
      sourceKey: 'material/shell',
      asset: material,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.refs).toEqual([
      { guid: AssetGuid.format(PARENT_GUID), sourceField: { fieldName: 'parent' } },
      {
        guid: AssetGuid.format(TEXTURE_GUID),
        sourceField: { componentName: '<material>', fieldName: slot },
      },
      {
        guid: AssetGuid.format(SAMPLER_GUID),
        sourceField: { componentName: '<material>', fieldName: `${slot}.sampler` },
      },
    ]);
    expect(result.value.payload).toEqual({
      ...material,
      parent: 0,
      values: {
        [slot]: {
          texture: 1,
          sampler: 2,
          coordinates: { set: 1, transform: { scale: [2, 2] } },
        },
      },
    });
    expect(result.value.artifacts).toEqual({});
  });

  it('projects refs while keeping string texture authoring compact', async () => {
    const material: MaterialAsset = {
      kind: 'material',
      parameters: [{ name: 'surface', type: 'texture' }],
      values: { surface: AssetGuid.format(TEXTURE_GUID) },
    };

    const result = await materialAssetOutputProducer.produce({
      guid: AssetGuid.format(MATERIAL_GUID),
      sourceKey: 'material/compact-surface',
      asset: material,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.refs).toEqual([
      {
        guid: AssetGuid.format(TEXTURE_GUID),
        sourceField: { componentName: '<material>', fieldName: 'surface' },
      },
    ]);
    const payload = result.value.payload as { values?: Record<string, unknown> };
    expect(payload.values).toEqual({ surface: { texture: 0 } });
    expect(payload.values?.surface).not.toEqual({
      texture: 0,
      coordinates: { set: 0, transform: { offset: [0, 0], scale: [1, 1], rotation: 0 } },
    });
  });

  it.each([
    'baseColorTexture',
    'metallicTexture',
    'roughnessTexture',
    'alphaTexture',
  ])('projects %s shorthand as a ref when parameters are omitted', async (slot) => {
    const material: MaterialAsset = {
      kind: 'material',
      values: { [slot]: AssetGuid.format(TEXTURE_GUID) },
    };

    const result = await materialAssetOutputProducer.produce({
      guid: AssetGuid.format(MATERIAL_GUID),
      sourceKey: 'material/compact-standard',
      asset: material,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.refs).toEqual([
      {
        guid: AssetGuid.format(TEXTURE_GUID),
        sourceField: { componentName: '<material>', fieldName: slot },
      },
    ]);
    expect((result.value.payload as { values?: Record<string, unknown> }).values).toEqual({
      [slot]: { texture: 0 },
    });
  });

  it('does not misclassify an ordinary string as a texture when parameters are omitted', async () => {
    const material: MaterialAsset = {
      kind: 'material',
      values: { label: 'authoring-note' },
    };

    const result = await materialAssetOutputProducer.produce({
      guid: AssetGuid.format(MATERIAL_GUID),
      sourceKey: 'material/compact-standard-string',
      asset: material,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.refs).toEqual([]);
    expect((result.value.payload as { values?: Record<string, unknown> }).values).toEqual({
      label: 'authoring-note',
    });
  });
});
