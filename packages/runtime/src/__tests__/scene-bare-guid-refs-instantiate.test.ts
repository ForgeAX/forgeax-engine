// scene-bare-guid-refs-instantiate.test — regression for the prod Play
// instantiate crash (feedback 2026-06-23, root cause corrected 2026-06-24).
//
// Reproduces the production on-disk pack shape that in-process / unit tests
// never exercised: a catalogued scene envelope whose `refs[]` are *bare GUID
// edges* (`sceneEntityId` / `sourceField` stripped at the w7 D-10
// serialization boundary), with multiple entities referencing the same mesh
// GUID through `MeshFilter.assetHandle`.
//
// Before the fix, `_resolveSceneGuids` took Branch A (envelope.refs.length>0)
// but `continue`-skipped every bare edge (no sceneEntityId/sourceField) →
// `resolvedMap` stayed empty → the entity-walk fallback (only reachable on the
// `else` / no-refs branch) never ran → the GUID *string* passed through to
// spawn. There `col.view[row] = (guidString as number)` coerced to 0 and
// `retainSharedScalarHandle(guidString)` skipped the `< BUILTIN_BASE` guard
// (NaN compare is false) → `SharedRefStore.retain` routed `shared-ref-released`
// to the World error handler, and the field read back as the sentinel 0 (the
// per-frame `asset-not-registered` flood in the studio report).
//
// The fix falls through to the entity-walk fallback whenever the structured
// edges resolved nothing, so GUID strings resolve to live user-tier handles
// before spawn.

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { MeshFilter, SceneInstance } from '@forgeax/engine-render';
import type { LocalEntityId, MeshAsset, SceneAsset, SceneEntity } from '@forgeax/engine-types';
import { BUILTIN_BASE } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';
import { registerSceneComponents } from './helpers/register-scene-components';

function localId(n: number): LocalEntityId {
  return n as LocalEntityId;
}

function cubeMesh(): MeshAsset {
  const res = createBoxGeometry(1, 1, 1);
  if (!res.ok) throw new Error('createBoxGeometry(1,1,1) failed');
  return res.value;
}

// Two distinct mesh GUIDs referenced from N entities each — mirrors the studio
// report where engine builtin cube/sphere were among the unresolved handles.
const MESH_GUID_A = '00d274da-e863-41d8-bafe-10b97d1468d4';
const MESH_GUID_B = '95730fd2-1111-4222-8333-444455556666';

describe('regression — prod bare-GUID scene envelope.refs resolve before retain', () => {
  it('instantiate resolves bare-GUID MeshFilter.assetHandle across N entities (no shared-ref-released)', () => {
    const reg = new AssetRegistry(makeMockShaderRegistry());
    const world = new World();
    registerSceneComponents(world, [MeshFilter]);

    // Catalogue the two mesh payloads (as loadByGuid would on the prod path).
    const guidA = AssetGuid.parse(MESH_GUID_A);
    const guidB = AssetGuid.parse(MESH_GUID_B);
    if (!guidA.ok || !guidB.ok) throw new Error('GUID parse failed');
    expect(reg.catalog(guidA.value, cubeMesh()).ok).toBe(true);
    expect(reg.catalog(guidB.value, cubeMesh()).ok).toBe(true);

    // Build a scene whose entities reference the meshes by GUID *string* —
    // exactly the post-parseScenePayload intermediate state. Several entities
    // share each GUID to exercise the dedup (one allocSharedRef per GUID).
    const entities: SceneEntity[] = [];
    for (let i = 0; i < 4; i++) {
      entities.push({
        localId: localId(i),
        components: {
          MeshFilter: { assetHandle: i % 2 === 0 ? MESH_GUID_A : MESH_GUID_B },
        },
      } as unknown as SceneEntity);
    }
    const scene: SceneAsset = { kind: 'scene', entities };

    // Catalogue the scene as an envelope carrying BARE-GUID refs[] — no
    // sceneEntityId / sourceField (the prod serialization shape). This forces
    // Branch A of _resolveSceneGuids while leaving every edge unresolvable.
    const SCENE_GUID = 'c1111111-2222-4333-8444-555566667777';
    const sceneGuid = AssetGuid.parse(SCENE_GUID);
    if (!sceneGuid.ok) throw new Error('scene GUID parse failed');
    expect(
      reg.catalog(sceneGuid.value, scene, [{ guid: MESH_GUID_A }, { guid: MESH_GUID_B }]).ok,
    ).toBe(true);

    // Mint the scene handle and instantiate through the public sugar entry.
    const sceneHandle = world.allocSharedRef('SceneAsset', scene);
    const res = reg.instantiate<SceneAsset>(sceneHandle, world);

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Every spawned member's MeshFilter.assetHandle is a resolved
    //     user-tier slot (>= BUILTIN_BASE) — not the sentinel 0 a coerced GUID
    //     string would leave behind.
    const inst = world.get(res.value, SceneInstance);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;
    let seen = 0;
    for (let i = 0; i < 4; i++) {
      const member = inst.value.mapping[i] as unknown as number;
      const mf = world.get(member as never, MeshFilter);
      expect(mf.ok).toBe(true);
      if (!mf.ok) continue;
      const handle = mf.value.assetHandle as unknown as number;
      expect(typeof handle).toBe('number');
      expect(handle).toBeGreaterThanOrEqual(BUILTIN_BASE);
      seen++;
    }
    expect(seen).toBe(4);

    // Dedup: the two distinct GUIDs mint exactly two user-tier handles,
    //     shared across the four members (one allocSharedRef per unique GUID).
    const handles = new Set<number>();
    for (let i = 0; i < 4; i++) {
      const member = inst.value.mapping[i] as unknown as number;
      const mf = world.get(member as never, MeshFilter);
      if (mf.ok) handles.add(mf.value.assetHandle as unknown as number);
    }
    expect(handles.size).toBe(2);
  });
});
