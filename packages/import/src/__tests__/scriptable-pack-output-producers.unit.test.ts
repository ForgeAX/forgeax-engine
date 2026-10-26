import { createBoxGeometry, decodeMeshBinary } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { AssetGuid as AssetGuidType, MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  createAssetOutputProducerRegistry,
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
  it.each([
    'target',
    'canvas',
    'external',
  ] as const)('rejects a runtime %s source at the Pack output boundary', async (source) => {
    const result = await materialAssetOutputProducer.produce({
      guid: AssetGuid.format(MATERIAL_GUID),
      sourceKey: 'material/runtime-source',
      asset: {
        kind: 'material',
        parameters: [{ name: 'map', type: 'texture' }],
        values: {
          map: { source: { kind: 'render-texture-source', source, owner: 'runtime-owner', id: 1 } },
        },
      },
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        detail: {
          reason:
            'Pack material textures require source GUIDs; runtime render sources cannot be persisted',
        },
      },
    });
  });

  it('rejects a runtime source in a parameter default before it enters the cook contract', async () => {
    const result = await materialAssetOutputProducer.produce({
      guid: AssetGuid.format(MATERIAL_GUID),
      sourceKey: 'material/runtime-default',
      asset: {
        kind: 'material',
        parameters: [
          {
            name: 'map',
            type: 'texture',
            default: {
              source: {
                kind: 'render-texture-source',
                source: 'canvas',
                owner: 'runtime-owner',
                id: 1,
              },
            },
          },
        ],
      },
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        detail: {
          reason:
            'Pack material textures require source GUIDs; runtime render sources cannot be persisted',
        },
      },
    });
  });

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
    expect(result.value.payload).toEqual({ kind: 'mesh' });
    const body = result.value.artifacts.body;
    if (body === undefined) throw new Error('missing mesh binary');
    expect(decodeMeshBinary(body.bytes, [AssetGuid.format(MATERIAL_GUID)])).toEqual(mesh);
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

  it('names the stale vertices / attribute mismatch instead of [object Object]', async () => {
    const box = createBoxGeometry(1, 1, 1).unwrap();
    const count = (box.attributes.position as Float32Array).length / 3;
    // Colour set on attributes only: the interleaved vertices were never repacked.
    const mesh: MeshAsset = {
      ...box,
      attributes: { ...box.attributes, color: new Float32Array(count * 4).fill(1) },
    };
    const result = await meshAssetOutputProducer.produce({
      guid: '019ffa97-3000-7000-8000-000000000011',
      sourceKey: 'mesh/terrain',
      asset: mesh,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const message = JSON.stringify(result.error.detail);
    expect(message).not.toContain('[object Object]');
    expect(message).toContain('mesh/terrain');
    expect(message).toContain('withVertexColors');
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

it('Tileset Pack outputs retain source GUIDs and reject runtime atlas handles', async () => {
  const producer = createAssetOutputProducerRegistry().get('tileset');
  if (producer === undefined) throw new Error('missing Tileset producer');
  const asset = {
    kind: 'tileset' as const,
    atlases: [TEXTURE_GUID],
    tileWidth: 1,
    tileHeight: 1,
    columns: 1,
    rows: 1,
    regions: [{ x: 0, y: 0, width: 1, height: 1 }],
    tiles: [{ regionIndex: 0 }],
  };
  const input = { guid: AssetGuid.format(MATERIAL_GUID), sourceKey: 'tileset/atlas', asset };
  const result = await producer.produce(input);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.refs[0]?.guid).toBe(AssetGuid.format(TEXTURE_GUID));
  expect(
    await producer.produce({ ...input, asset: { ...asset, atlases: [123 as never] } }),
  ).toMatchObject({
    ok: false,
    error: {
      detail: {
        reason: 'Pack Tileset atlases require source GUIDs; runtime handles cannot be persisted',
      },
    },
  });
});
