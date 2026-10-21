import {
  decodeMeshBinary,
  distanceFieldMeshDigest,
  meshCardSidednessDigest,
  normalizeMeshPayload,
  packMeshBin,
} from '@forgeax/engine-geometry';
import { ImporterRegistry, type RunImportOk, runImport } from '@forgeax/engine-import';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { describe, expect, it } from 'vitest';
import {
  importedMesh,
  importedSource,
} from '../../../import/src/__tests__/fixtures/runtime-import';
import { gltfImporter } from '../gltf-importer';

const GUIDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('missing expected mesh product');
  return value;
}

async function produce(meshCards: unknown, shift = 0) {
  const positions = new Float32Array([
    0,
    0,
    shift,
    2,
    0,
    shift,
    0,
    2,
    shift,
    0,
    0,
    shift + 2,
    2,
    0,
    shift + 2,
    0,
    2,
    shift + 2,
  ]);
  const source = new TextEncoder().encode(
    JSON.stringify({
      asset: { version: '2.0' },
      extensionsUsed: ['MSFT_lod'],
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, extensions: { MSFT_lod: { ids: [1] } } }, { mesh: 1 }],
      meshes: [
        {
          name: 'mixed',
          primitives: [
            { attributes: { POSITION: 0 }, material: 0 },
            { attributes: { POSITION: 1 }, material: 1 },
          ],
        },
        { name: 'lower', primitives: [{ attributes: { POSITION: 0 }, material: 0 }] },
      ],
      materials: [{ name: 'opaque' }, { name: 'sheet', doubleSided: true, alphaMode: 'MASK' }],
      buffers: [
        {
          byteLength: positions.byteLength,
          uri: `data:application/octet-stream;base64,${Buffer.from(positions.buffer).toString('base64')}`,
        },
      ],
      bufferViews: [{ buffer: 0, byteLength: positions.byteLength }],
      accessors: [0, 36].map((byteOffset) => ({
        bufferView: 0,
        byteOffset,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
      })),
    }),
  );
  const registry = new ImporterRegistry();
  registry.register(gltfImporter);
  return runImport(
    {
      importer: 'gltf',
      source: 'cards.gltf',
      importSettings: { meshCards },
      subAssets: GUIDS.map((guid, sourceIndex) => ({
        guid,
        sourceIndex,
        sourceKey: `mesh:${sourceIndex}`,
        kind: 'mesh',
      })),
    },
    registry,
    { readSource: async () => ({ ok: true as const, value: source }) },
  );
}

describe('mesh-owned card publication', () => {
  it('preserves a whole-mesh layout and LOD GUIDs through import, mesh-bin, JSON and runtime lookup', async () => {
    const result = await produce({ resolution: 8, maxCards: 8 });
    if (!result.ok) throw result.error;
    if ('skipped' in result.value) throw new Error('expected mesh products');
    expect(result.value.pack.assets.map((asset) => asset.guid)).toEqual(GUIDS);
    const { assets: runtime } = importedSource(result.value.pack);
    for (const row of result.value.pack.assets) {
      const bytes = row.artifacts.body?.bytes;
      expect(bytes).toBeInstanceOf(Uint8Array);
      const geometry = required(decodeMeshBinary(required(bytes), row.refs));
      expect(row.payload).toEqual({ kind: 'mesh' });
      const json = required(
        normalizeMeshPayload(
          JSON.parse(
            JSON.stringify(
              {
                ...geometry,
                lods: geometry.lods?.map((lod) => ({
                  ...lod,
                  mesh: AssetGuid.format(lod.mesh as never),
                })),
              },
              (_key, value) =>
                ArrayBuffer.isView(value) ? Array.from(value as Uint8Array) : value,
            ),
          ),
          row.refs,
        ),
      );
      const handle = (await runtime.load(row.guid, 'mesh')).unwrap();
      const loaded = runtime.read(handle).unwrap();
      expect(loaded.kind).toBe('mesh');
      expect(geometry.submeshes).toEqual(loaded.submeshes);
      expect(json.submeshes).toEqual(loaded.submeshes);
      const layout = required(loaded.cardLayout);
      expect(layout.cards.length).toBeGreaterThan(0);
      expect(geometry.cardLayout).toEqual(layout);
      expect(json.cardLayout).toEqual(layout);
      const indices =
        loaded.indices ??
        Uint32Array.from(
          { length: (loaded.attributes.position as Float32Array).length / 3 },
          (_, i) => i,
        );
      expect(layout.meshDigest).toBe(
        await distanceFieldMeshDigest(loaded.attributes.position as Float32Array, indices),
      );
      if (row.guid === GUIDS[0]) {
        expect(layout.sidednessDigest).toBe(await meshCardSidednessDigest(new Uint8Array([0, 1])));
        expect(loaded.submeshes.map((section) => section.materialSlot)).toEqual([0, 1]);
        expect(loaded.lods).toHaveLength(1);
      }
      const invalid = {
        ...geometry,
        cardLayout: { ...layout, cards: [{ ...required(layout.cards[0]), depth: -1 }] },
      };
      expect(packMeshBin(invalid, row.guid, row.refs).ok).toBe(false);
      expect(normalizeMeshPayload(invalid, row.refs)).toBeUndefined();
      expect(runtime.replace(handle, invalid).ok).toBe(false);
    }
  });

  it('keeps omission explicit and recooked geometry/settings in product digests', async () => {
    const outputs: Exclude<RunImportOk, { readonly skipped: 'shader' }>[] = [];
    for (const [settings, shift] of [
      [false, 0],
      [{ resolution: 8, maxCards: 8 }, 0],
      [{ resolution: 16, maxCards: 8 }, 0],
      [{ resolution: 8, maxCards: 8 }, 1],
    ] as const) {
      const result = await produce(settings, shift);
      if (!result.ok) throw result.error;
      if ('skipped' in result.value) throw new Error('expected mesh products');
      outputs.push(result.value);
    }
    const omitted = importedMesh(required(required(outputs[0]).pack.assets[0]));
    expect(omitted.cardLayout).toBeUndefined();
    expect(
      new Set(outputs.map((output) => required(output.cookProducts[0]).receipt.outputDigest)).size,
    ).toBe(4);
    const layoutAt = (index: number) => {
      const mesh = importedMesh(required(required(outputs[index]).pack.assets[0]));
      return required(mesh.cardLayout);
    };
    const original = layoutAt(1),
      changed = layoutAt(3);
    expect(changed.meshDigest).not.toBe(original.meshDigest);
    expect(changed.bounds.min[2]).toBe(original.bounds.min[2] + 1);
  });

  it('rejects invalid settings without publishing a partial mesh product', async () => {
    for (const settings of [true, null, { maxCards: 0 }, { resolution: 100 }, { surprise: 1 }]) {
      expect(await produce(settings)).toMatchObject({
        ok: false,
        error: { code: 'import-internal-error' },
      });
    }
  });
});
