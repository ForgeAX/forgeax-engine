// post-spawn-resolve-joints.unit.test.ts — tweak-20260611 M5 / D-7 (subtree-scope).
//
// Coverage:
//   - single-instance resolver: existing behavior (joints wire correctly).
//   - multi-instance resolver: three spawns of the same SceneAsset must each
//     wire to their own subtree's joint entities (NOT entity ids of instance 0).
//   - missing joint inside subtree: structured error 'skin-joint-path-unresolved'.

import { World } from '@forgeax/engine-ecs';
import { ChildOf, Name } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import type { SkinAsset } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { postSpawnResolveJoints } from '../../../../render/src/scene-instances/post-spawn-resolve-joints';

/**
 * Build a 3-joint linear chain `Root -> Spine -> Hip` rooted at a fresh entity,
 * with shared Name strings across spawns. Returns the spawnRoot + the three
 * descendant entities for assertion. The Skin component is attached to the
 * spawn root with a synthetic skeleton handle (the resolver's resolveSkinAsset
 * is wired to return a fixed SkinAsset for any handle in this test).
 */
function spawnFoxLikeChain(world: World, skeletonHandle: number) {
  const root = world.spawn({ component: Name, data: { value: 'Root' } }).unwrap();
  const spine = world.spawn({ component: Name, data: { value: 'Spine' } }).unwrap();
  const hip = world.spawn({ component: Name, data: { value: 'Hip' } }).unwrap();

  // ChildOf is the writable edge; ECS materializes its Children target.
  world.addComponent(spine, { component: ChildOf, data: { parent: root } }).unwrap();
  world.addComponent(hip, { component: ChildOf, data: { parent: spine } }).unwrap();

  // Skin lives on the root; resolver gets `skeleton` field as a number handle.
  world
    .addComponent(root, {
      component: Skin,
      // biome-ignore lint/suspicious/noExplicitAny: test fixture stamps a synthetic skeleton handle for resolver isolation; the resolver is mocked.
      data: { skeleton: skeletonHandle as any, joints: new Uint32Array() },
    })
    .unwrap();

  return { root, spine, hip };
}

describe('postSpawnResolveJoints — single instance', () => {
  it('wires Skin.joints[] to subtree entities for one spawn', () => {
    const world = new World();
    const skinAsset: SkinAsset = {
      kind: 'skin',
      skeletonGuid: '00000000-0000-0000-0000-000000000001',
      jointPaths: ['Root', 'Spine', 'Hip'],
    };

    const { root, spine, hip } = spawnFoxLikeChain(world, 1);

    const result = postSpawnResolveJoints(world, { resolveSkinAsset: () => skinAsset }, root);

    expect(result.ok).toBe(true);
    const got = world.get(root, Skin);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const joints = Array.from(got.value.joints as ArrayLike<number>);
    expect(joints).toEqual([root, spine, hip]);
  });
});

describe('postSpawnResolveJoints — multi instance (D-7 subtree-scope)', () => {
  it('three spawns each wire to their own subtree entities — not instance-0', () => {
    const world = new World();
    const skinAsset: SkinAsset = {
      kind: 'skin',
      skeletonGuid: '00000000-0000-0000-0000-000000000001',
      jointPaths: ['Root', 'Spine', 'Hip'],
    };

    // Three independent spawns — same Name strings collide across instances.
    const a = spawnFoxLikeChain(world, 1);
    const b = spawnFoxLikeChain(world, 1);
    const c = spawnFoxLikeChain(world, 1);

    // Resolve each spawn independently.
    expect(postSpawnResolveJoints(world, { resolveSkinAsset: () => skinAsset }, a.root).ok).toBe(
      true,
    );
    expect(postSpawnResolveJoints(world, { resolveSkinAsset: () => skinAsset }, b.root).ok).toBe(
      true,
    );
    expect(postSpawnResolveJoints(world, { resolveSkinAsset: () => skinAsset }, c.root).ok).toBe(
      true,
    );

    const ja = Array.from(
      (world.get(a.root, Skin) as { ok: true; value: { joints: ArrayLike<number> } }).value.joints,
    );
    const jb = Array.from(
      (world.get(b.root, Skin) as { ok: true; value: { joints: ArrayLike<number> } }).value.joints,
    );
    const jc = Array.from(
      (world.get(c.root, Skin) as { ok: true; value: { joints: ArrayLike<number> } }).value.joints,
    );

    // AC-09: the three spawns' joint entity arrays must be pairwise distinct.
    expect(ja).toEqual([a.root, a.spine, a.hip]);
    expect(jb).toEqual([b.root, b.spine, b.hip]);
    expect(jc).toEqual([c.root, c.spine, c.hip]);
    expect(ja).not.toEqual(jb);
    expect(jb).not.toEqual(jc);
    expect(ja).not.toEqual(jc);
  });

  it('does not wire across spawn roots — instance 1 is untouched after instance 0 resolves', () => {
    const world = new World();
    const skinAsset: SkinAsset = {
      kind: 'skin',
      skeletonGuid: '00000000-0000-0000-0000-000000000001',
      jointPaths: ['Root', 'Spine', 'Hip'],
    };
    const a = spawnFoxLikeChain(world, 1);
    const b = spawnFoxLikeChain(world, 1);

    // Resolve only a; b should remain joints=[] (resolver was not invoked for b).
    postSpawnResolveJoints(world, { resolveSkinAsset: () => skinAsset }, a.root);

    const jb = Array.from(
      (world.get(b.root, Skin) as { ok: true; value: { joints: ArrayLike<number> } }).value.joints,
    );
    expect(jb).toEqual([]);
  });
});

describe('postSpawnResolveJoints — error path', () => {
  it('returns skin-joint-path-unresolved when leaf name not present in subtree', () => {
    const world = new World();
    const skinAsset: SkinAsset = {
      kind: 'skin',
      skeletonGuid: '00000000-0000-0000-0000-000000000001',
      // Each entry is a slash-separated path; leaf name is the last segment
      // and the resolver matches on it. 'NoSuchBone' does not exist in the
      // subtree we built, so the resolver fails on this path.
      jointPaths: ['Root/Spine/NoSuchBone'],
    };

    const { root } = spawnFoxLikeChain(world, 1);

    const result = postSpawnResolveJoints(world, { resolveSkinAsset: () => skinAsset }, root);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('skin-joint-path-unresolved');
    if (result.error.code !== 'skin-joint-path-unresolved') return;
    expect(result.error.detail.path).toEqual(['Root', 'Spine', 'NoSuchBone']);
    expect(result.error.detail.failedAtIndex).toBe(2);
  });

  it('warns on same-name sibling within a single subtree (D-6a still active)', () => {
    const world = new World();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // Two siblings both named 'Bone' under one root.
    const root = world.spawn({ component: Name, data: { value: 'Root' } }).unwrap();
    const bone1 = world.spawn({ component: Name, data: { value: 'Bone' } }).unwrap();
    const bone2 = world.spawn({ component: Name, data: { value: 'Bone' } }).unwrap();
    world.addComponent(bone1, { component: ChildOf, data: { parent: root } }).unwrap();
    world.addComponent(bone2, { component: ChildOf, data: { parent: root } }).unwrap();
    world
      .addComponent(root, {
        component: Skin,
        // biome-ignore lint/suspicious/noExplicitAny: test fixture stamps a synthetic skeleton handle for resolver isolation; the resolver is mocked.
        data: { skeleton: 1 as any, joints: new Uint32Array() },
      })
      .unwrap();

    const skinAsset: SkinAsset = {
      kind: 'skin',
      skeletonGuid: '00000000-0000-0000-0000-000000000001',
      jointPaths: ['Bone'],
    };
    postSpawnResolveJoints(world, { resolveSkinAsset: () => skinAsset }, root);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/same-name sibling.*Bone.*matches 2/);
    warnSpy.mockRestore();
  });
});
