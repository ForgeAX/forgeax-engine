// M8 w58 (round 5 D-18): atomic read+write flip integration TDD.
//
// D-18 atomic cut: the M8 milestone flips read-side (material-walk source,
// loadByGuid public return) and write-side (user-tier mint) together in one
// breaking PR. This file asserts the three end-to-end contracts that go GREEN
// only after w59 (runtime atomic flip) + w60 (AssetRegistry public delete) +
// w61-w65 (the ~120-file sweep) co-land:
//
//   (1) material-walk over world.sharedRefs payloads -- a material payload
//       whose `parent` is a user-tier handle walks the parent chain by
//       resolving each ancestor via world.sharedRefs.resolve (no by-handle
//       AssetRegistry Map lookup). D-15 point 5.
//   (2) loadByGuid(GUID) returns the asset PAYLOAD (not a Handle) -- the
//       AssetRegistry holds no World so it cannot mint a column handle (D-17).
//   (3) mint+resolve consistency -- world.allocSharedRef(tag, payload) lands
//       the payload in a user-tier slot (>= BUILTIN_BASE) and
//       world.sharedRefs.resolve(handle) === payload; AssetRegistry no longer
//       holds a parallel handle->payload Map (w31 AC-25 gate; this file is the
//       positive end-to-end shape).
//
// TDD: RED before the M8 impl (w59) + delete (w60) land; GREEN once they +
// the sweep batches co-land. M8 is the ATOMIC milestone -- this test is not
// green-keepable in isolation.

import { AssetRegistry, walkMaterialPassesOverSharedRefs } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import type { MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { BUILTIN_BASE } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

function mesh(): MeshAsset {
  return {
    kind: 'mesh',
    vertices: new Float32Array(12 * 3),
    indices: new Uint16Array([0, 1, 2]),
    attributes: {},
    materialSlots: [{ slotName: 'Default' }],
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 3,
        vertexCount: 36,
        materialSlot: 0,
        topology: 'triangle-list',
      },
    ],
  } as unknown as MeshAsset;
}

describe('M8 mint+resolve consistency (AC-24 positive end-to-end)', () => {
  it('world.allocSharedRef lands payload in a user-tier slot resolvable by world.sharedRefs', () => {
    const world = new World();
    const payload = mesh();
    const handle = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', payload);
    expect(handle).toBeGreaterThanOrEqual(BUILTIN_BASE);
    const res = world.sharedRefs.resolve<'MeshAsset', MeshAsset>(handle);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe(payload);
  });
});

describe('M8 material-walk: handle root via sharedRefs, parent chain via catalogue GUID (D-19)', () => {
  it('resolves the parent chain by following material.parent GUID through the AssetRegistry catalogue', () => {
    const world = new World();
    const reg = new AssetRegistry(makeMockShaderRegistry());
    // Parent material: catalogued by GUID, declares the base pass + a base param.
    const parentGuidStr = '22222222-2222-5222-8222-222222222222';
    const parentGuid = reg.parseGuid(parentGuidStr);
    const parentPayload: MaterialAsset = {
      kind: 'material',
      passes: [{ name: 'forward', program: { module: 'forgeax_material::unlit' } }],
      values: { baseColor: [0.2, 0.4, 0.6] },
    } as unknown as MaterialAsset;
    reg.catalog(parentGuid, parentPayload);
    // Child material: no passes (inherits parent), parent stored as a GUID
    // (D-19 embedded ref). The child gets a user-tier column handle.
    const childPayload: MaterialAsset = {
      kind: 'material',
      values: { metallic: 1 },
      parent: parentGuid,
    } as unknown as MaterialAsset;
    const childHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
      'MaterialAsset',
      childPayload,
    );

    const walk = walkMaterialPassesOverSharedRefs(world, childHandle, reg);
    expect(walk.ok).toBe(true);
    if (!walk.ok) return;
    // Passes inherited from parent (W-5 full inheritance).
    expect(walk.value.passes.length).toBe(1);
    expect(walk.value.passes[0]?.program.module).toBe('forgeax_material::unlit');
    // values shallow-merged: parent baseColor + child metallic (W-4).
    expect(walk.value.values.metallic).toBe(1);
    expect(walk.value.values.baseColor).toEqual([0.2, 0.4, 0.6]);
  });
});

describe('M8 loadByGuid returns payload, not a Handle (D-17)', () => {
  it('dev/fallback loadByGuid resolves to the registered payload object', async () => {
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const payload = mesh();
    // After the M8 cut AssetRegistry catalogues GUID->payload; loadByGuid
    // returns the PAYLOAD (assignable to MeshAsset, not Handle<...>).
    const guid = '11111111-1111-5111-8111-111111111111';
    reg.catalog(guid, payload);
    const res = await reg.loadByGuid<MeshAsset>(reg.parseGuid(guid));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The returned value is the payload object itself (kind === 'mesh'),
    // never a numeric Handle.
    expect(typeof res.value).toBe('object');
    expect((res.value as MeshAsset).kind).toBe('mesh');
    expect(res.value).toBe(payload);
  });
});
