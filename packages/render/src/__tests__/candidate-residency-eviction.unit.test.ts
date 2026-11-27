import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-null';
import type { TextureAsset } from '@forgeax/engine-types';
import { assert, expect, it } from 'vitest';
import { GpuResidencyCache, type PreparedMeshResidency } from '../device/gpu-residency';
import { worldRenderResources } from '../publication/resource-scope';

type Candidate = Pick<PreparedMeshResidency, 'lease' | 'commit' | 'current'>;

it.each([
  'mesh',
  'texture',
] as const)('preserves a same-version %s owner acquired during eviction qualification', async (kind) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const store = new GpuResidencyCache();
  store.configureGpuDevice(device, undefined, device.caps);
  const assets = new AssetRegistry();
  const scope = worldRenderResources(new World({ assets }));
  const mesh = createBoxGeometry(2, 2, 2).unwrap();
  const texture: TextureAsset = {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 4, height: 4 } },
    format: 'rgba8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data: new Uint8Array(64),
  };
  const meshHandle = assets.create(mesh).unwrap();
  const textureHandle = assets.create(texture).unwrap();
  const revision = scope.assetRevision(meshHandle);
  assert(revision !== undefined);
  const make = (canEvict?: () => boolean): Candidate =>
    kind === 'mesh'
      ? store
          .prepareMeshResidency(meshHandle, mesh, revision, scope, undefined, undefined, canEvict)
          .unwrap()
      : store
          .prepareTextureResidencyForGraph(
            textureHandle,
            texture,
            scope,
            undefined,
            undefined,
            canEvict,
          )
          .unwrap();
  const present = () =>
    kind === 'mesh'
      ? store.getMeshGpuHandles(meshHandle, scope) !== undefined
      : store.getTextureGpuView(textureHandle, scope) !== undefined;
  let borrowed: Candidate | undefined;
  const initial = make(() => {
    borrowed = make();
    return true;
  });
  try {
    expect(initial.commit()).toBe(true);
    await initial.lease.release(true);
    expect(borrowed !== undefined).toBe(true);
    expect(borrowed?.current()).toBe(true);
    expect(present()).toBe(true);
    await borrowed?.lease.release(true);
    expect(present()).toBe(false);
  } finally {
    initial.lease.release(false);
    borrowed?.lease.release(false);
    store.destroyAll();
    assets.dispose();
  }
});
