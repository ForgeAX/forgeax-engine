import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { ImporterRegistry, type RunImportMeta, runImport } from '@forgeax/engine-import';
import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { fbxImporter } from '../fbx-importer.js';
import { initFbxWasm, parseFbx } from '../index.js';

const MESH_GUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sourceUrl = new URL(
  '../../../../apps/hello/format-tier1/fixtures/multi-target-morph.fbx',
  import.meta.url,
);

async function readFixture(url: URL): Promise<Uint8Array> {
  const nodeFs = (await import('node:' + 'fs/promises')) as unknown as {
    readonly readFile: (path: URL) => Promise<Uint8Array>;
  };
  return new Uint8Array(await nodeFs.readFile(url));
}

function meta(): RunImportMeta {
  return {
    importer: 'fbx',
    source: 'apps/hello/format-tier1/fixtures/multi-target-morph.fbx',
    subAssets: [
      { guid: MESH_GUID, sourceIndex: 0, sourceKey: 'fbx:mesh:MorphTriangle', kind: 'mesh' },
    ],
  };
}

describe('real FBX BlendShape import through ufbx WASM', () => {
  it('keeps source target order, authored weights, and target lengths', async () => {
    const bytes = await readFixture(sourceUrl);
    await initFbxWasm();
    const raw = JSON.parse(parseFbx(bytes)) as {
      readonly meshes: readonly {
        readonly morphTargets?: readonly { readonly position?: readonly number[] }[];
        readonly morphWeights?: readonly number[];
      }[];
    };
    expect(raw.meshes).toHaveLength(1);
    expect(raw.meshes[0]?.morphTargets).toHaveLength(2);
    expect(raw.meshes[0]?.morphTargets?.[0]?.position).toEqual([0, 0, 0, 0.25, 0, 0, 0, 0.5, 0]);
    expect(raw.meshes[0]?.morphTargets?.[1]?.position).toEqual([0, 0, -0.25, 0, 0, 0, 0, 0, 0]);
    expect(raw.meshes[0]?.morphWeights).toEqual([0.25, 0.5]);

    const registry = new ImporterRegistry();
    registry.register(fbxImporter);
    const fs = { readSource: async () => ({ ok: true as const, value: bytes }) };
    const result = await runImport(meta(), registry, fs);
    expect(result.ok).toBe(true);
    if (!result.ok || 'skipped' in result.value) throw new Error('expected FBX DDC pack');
    const entry = result.value.pack.assets.find((asset) => asset.guid === MESH_GUID);
    expect(entry?.kind).toBe('mesh');
    const payload = entry?.payload as {
      readonly vertices: readonly number[];
      readonly morphTargets?: readonly { readonly position?: readonly number[] }[];
      readonly morphWeights?: readonly number[];
    };
    expect(payload.morphTargets).toHaveLength(2);
    expect(payload.morphTargets?.map((target) => target.position?.length)).toEqual([9, 9]);
    expect(payload.morphWeights).toEqual([0.25, 0.5]);
    expect(payload.vertices.length).toBe(3 * 12);

    const runtime = new AssetRegistry({} as never);
    const parsedMesh = runtime.parseAssetPayload('mesh', entry?.payload ?? {});
    expect(parsedMesh).toMatchObject({ kind: 'mesh' });
    expect(runtime.catalog(MESH_GUID, parsedMesh as never).ok).toBe(true);
    const loaded = await runtime.loadByGuid<MeshAsset>(runtime.parseGuid(MESH_GUID));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.kind).toBe('mesh');
    expect(Array.from(loaded.value.morphWeights ?? [])).toEqual([0.25, 0.5]);
    expect(loaded.value.morphTargets).toHaveLength(2);
  });

  it('records that this real fixture has no imported animation clip', async () => {
    const bytes = await readFixture(sourceUrl);
    await initFbxWasm();
    const registry = new ImporterRegistry();
    registry.register(fbxImporter);
    const fs = { readSource: async () => ({ ok: true as const, value: bytes }) };
    const result = await runImport(meta(), registry, fs);
    expect(result.ok).toBe(true);
    if (!result.ok || 'skipped' in result.value) return;
    expect(
      result.value.pack.assets.filter((asset) => asset.kind === 'animation-clip'),
    ).toHaveLength(0);
  });
});
