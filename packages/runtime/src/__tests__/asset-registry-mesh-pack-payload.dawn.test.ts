// Malformed source meshes fail before runtime admission; valid source handles
// upload through the real Dawn RHI. Layout comes from attributes, not a fixed stride.
import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { createBoxGeometry, meshAssetContribution } from '@forgeax/engine-geometry';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { _internal_getRawDevice, disposeDevice, rhi } from '@forgeax/engine-rhi-webgpu';
import type { MeshAsset } from '@forgeax/engine-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GpuResidencyCache } from '../../../render/src/device/gpu-residency';

const GUID = '00000000-0000-7000-8000-000000000033';
const dawnReady = globalThis.navigator?.gpu !== undefined;

function sourceRegistry(mesh: MeshAsset): AssetRegistry {
  const registry = new AssetRegistry();
  registry.installDecoder(meshAssetContribution.kind, meshAssetContribution.decoder);
  const sourcePath = 'mesh.pack.ts';
  const packageUrl = 'https://mesh.invalid/mesh.pack.json';
  const publication = createRuntimePackPublication({
    scopeId: 'asset-runtime',
    sourcePath,
    sourceRevision: 'fixture',
    packageUrl,
    pack: { assets: [{ guid: GUID, kind: 'mesh', payload: mesh, refs: [], artifacts: {} }] },
  });
  const body = JSON.stringify(publication.pack, (_key, value) =>
    ArrayBuffer.isView(value) ? Array.from(value as Uint8Array) : value,
  );
  registry.setCatalogSource(
    createCatalogSource({
      entries: [
        { guid: GUID, kind: 'mesh', sourcePath, packageUrl, publication: publication.publication },
      ],
      fetch: async () => new Response(body),
    }),
  );
  return registry;
}

describe.skipIf(!dawnReady)('mesh Pack source admission (Dawn)', () => {
  let device: RhiDevice;

  beforeAll(async () => {
    device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  });

  afterAll(() => disposeDevice(device));

  it.each([
    9, 11,
  ])('rejects %i stored floats inconsistent with authored attributes', async (length) => {
    const registry = sourceRegistry({
      ...createBoxGeometry(1, 1, 1).unwrap(),
      vertices: new Float32Array(length),
    });
    try {
      const loaded = await registry.load(GUID, 'mesh');
      expect(loaded).toMatchObject({
        ok: false,
        error: { code: 'asset-package-invalid', detail: { guid: GUID } },
      });
      if (!loaded.ok) {
        expect(loaded.error.expected).toBeTruthy();
        expect(loaded.error.hint).toBeTruthy();
        if (loaded.error.code === 'asset-package-invalid') {
          expect(loaded.error.detail.reason).toBeTruthy();
        }
      }
      expect(registry.inspect().assets).toEqual([]);
      expect(registry.catalogEntry(GUID)?.kind).toBe('mesh');
    } finally {
      registry.dispose();
    }
  });

  it('failed source admission remains atomic across repeated loads', async () => {
    const registry = sourceRegistry({
      ...createBoxGeometry(1, 1, 1).unwrap(),
      vertices: new Float32Array(9),
    });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        expect((await registry.load(GUID, 'mesh')).ok).toBe(false);
        expect(registry.inspect().assets).toEqual([]);
      }
    } finally {
      registry.dispose();
    }
  });

  it.each([
    'box',
    'position-only',
  ] as const)('loads and uploads a valid %s source mesh', async (shape) => {
    const position = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const source: MeshAsset =
      shape === 'box'
        ? createBoxGeometry(1, 1, 1).unwrap()
        : {
            kind: 'mesh',
            vertices: position,
            attributes: { position },
            materialSlots: [{ slotName: 'Default' }],
            submeshes: [
              {
                indexOffset: 0,
                indexCount: 0,
                vertexCount: 3,
                topology: 'triangle-list',
                materialSlot: 0,
              },
            ],
          };
    const registry = sourceRegistry(source);
    const gpuStore = new GpuResidencyCache();
    const raw = _internal_getRawDevice(device);
    if (raw === undefined) throw new Error('Dawn RHI must expose its native device');
    raw.pushErrorScope('validation');
    try {
      gpuStore.configureGpuDevice(device, undefined, device.caps);
      const handle = (await registry.load(GUID, 'mesh')).unwrap();
      const mesh = runtimeAssets(registry).borrow<MeshAsset>(handle).unwrap();
      expect(mesh.vertices).toEqual(source.vertices);
      expect(gpuStore.ensureResident(handle, mesh).ok).toBe(true);
      await device.queue.onSubmittedWorkDone();
      expect(await raw.popErrorScope()).toBeNull();
      registry.release(handle).unwrap();
    } finally {
      gpuStore.destroyAll();
      registry.dispose();
    }
  });
});
