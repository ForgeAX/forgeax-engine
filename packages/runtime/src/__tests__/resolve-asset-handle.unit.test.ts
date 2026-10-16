// M7 w55 / M8 w59: resolveAssetHandle two-tier dispatch unit test.
//
// D-15 two-tier asset resolution: resolveAssetHandle(world, handle) dispatches
// by slot range — builtin slots (< BUILTIN_BASE) resolve through
// BuiltinAssetRegistry.resolve (process-static, no World needed); user-tier
// slots (>= BUILTIN_BASE) resolve through world.sharedRefs (minted via
// world.allocSharedRef). The AssetRegistry holds no handle->payload map.

import { BUILTIN_CUBE, HANDLE_CUBE, resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import type { MeshAsset } from '@forgeax/engine-types';
import { BUILTIN_BASE } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

function mesh(): MeshAsset {
  return {
    kind: 'mesh',
    vertices: new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1]),
    indices: new Uint16Array([0]),
    attributes: {},
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 1,
        vertexCount: 12,
        topology: 'triangle-list' as const,
      },
    ],
  } as unknown as MeshAsset;
}

describe('resolveAssetHandle two-tier slot-range dispatch (AC-31)', () => {
  it('builtin slot (< BUILTIN_BASE): resolves through BuiltinAssetRegistry', () => {
    // HANDLE_CUBE has slot=1 < BUILTIN_BASE=1024.
    // Builtins are process-static — the World is unused for this path.
    const world = new World();
    const res = resolveAssetHandle(world, HANDLE_CUBE);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe(BUILTIN_CUBE);
  });

  it('user-tier slot (>= BUILTIN_BASE): resolves through world.sharedRefs', () => {
    // User-tier payloads live in the per-World SharedRefStore, minted via
    // world.allocSharedRef. resolveAssetHandle routes user-tier slots there.
    const world = new World();
    const payload = mesh();
    const handle = world.allocSharedRef('MeshAsset', payload);
    expect(handle).toBeGreaterThanOrEqual(BUILTIN_BASE);
    const res = resolveAssetHandle<MeshAsset>(world, handle);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe(payload);
  });

  it('user-tier handle not in this World returns asset-not-found', () => {
    // A handle minted in a DIFFERENT world is absent from this world's
    // SharedRefStore — resolveAssetHandle must return err(asset-not-found).
    const world = new World();
    const foreign = new World();
    const foreignHandle = foreign.allocSharedRef('MeshAsset', mesh());
    const res = resolveAssetHandle(world, foreignHandle);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('asset-not-found');
  });
});
