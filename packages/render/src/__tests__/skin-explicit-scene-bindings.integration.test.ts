import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { ChildOf, Children, Name, Transform, worldDespawnScene } from '@forgeax/engine-scene';
import type { ShaderRegistry } from '@forgeax/engine-shader';
import {
  Skin,
  SkinAssetUnresolvedError,
  SkinJointPathUnresolvedError,
} from '@forgeax/engine-skinning';
import type { SceneAsset, SceneEntity, SkeletonAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { SceneInstance } from '../components/scene-instance';
import { postSpawnResolveJoints } from '../scene-instances/post-spawn-resolve-joints';

const skeletonGuid = '01a11254-2400-7000-9000-000000000001';
const skinGuid = '01a11254-2400-7000-9000-000000000002';

describe('ordinary Scene explicit Skin bindings', () => {
  it.each([
    ['anchor', false],
    ['anchor', true],
    ['flat', false],
    ['flat', true],
  ] as const)('preserves canonical automatic Skin failure and rollback: %s / metadata=%s', (mode, withSkinAsset) => {
    const world = new World();
    for (const component of [ChildOf, Children, Name, Transform, Skin, SceneInstance])
      world.components.register(component).unwrap();
    const registry = new AssetRegistry(
      {} as ShaderRegistry,
      undefined,
      undefined,
      postSpawnResolveJoints,
    );
    const inverseBindMatrices = new Float32Array(16);
    for (const diagonal of [0, 5, 10, 15]) inverseBindMatrices[diagonal] = 1;
    registry
      .catalog(skeletonGuid, {
        kind: 'skeleton',
        jointCount: 1,
        inverseBindMatrices,
      } satisfies SkeletonAsset)
      .unwrap();
    if (withSkinAsset)
      registry
        .catalog(skinGuid, { kind: 'skin', skeletonGuid, jointPaths: ['missing-joint'] })
        .unwrap();
    const handle = world.allocSharedRef<'SceneAsset', SceneAsset>('SceneAsset', {
      kind: 'scene',
      entities: {
        surface: { components: { Transform: {}, Skin: { skeleton: skeletonGuid, joints: [] } } },
      },
    });
    const before = world.sharedRefs._liveCount();
    const result =
      mode === 'anchor'
        ? registry.instantiate(handle, world)
        : registry.instantiateFlat(handle, world);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected automatic joint binding to fail');
    expect(result.error).toBeInstanceOf(
      withSkinAsset ? SkinJointPathUnresolvedError : SkinAssetUnresolvedError,
    );
    expect(result.error.code).toBe(
      withSkinAsset ? 'skin-joint-path-unresolved' : 'skin-asset-unresolved',
    );
    expect(result.unwrapOr('fallback')).toBe('fallback');
    try {
      result.unwrap();
      throw new Error('expected original structured error');
    } catch (failure) {
      expect(failure).toBe(result.error);
    }
    expect(world.inspect().entityCount).toBe(0);
    expect(world.sharedRefs._liveCount()).toBe(before);
    world.sharedRefs.release(handle).unwrap();
    expect(world.sharedRefs._liveCount()).toBe(0);
    registry.invalidateAll();
  });

  it.each([
    false,
    true,
  ])('retains distinct authored chains with optional SkinAsset=%s', (withSkinAsset) => {
    const world = new World();
    for (const component of [ChildOf, Children, Name, Transform, Skin, SceneInstance])
      world.components.register(component).unwrap();
    const registry = new AssetRegistry(
      {} as ShaderRegistry,
      undefined,
      undefined,
      postSpawnResolveJoints,
    );
    const inverseBindMatrices = new Float32Array(32);
    for (let joint = 0; joint < 2; joint++)
      for (const diagonal of [0, 5, 10, 15]) inverseBindMatrices[joint * 16 + diagonal] = 1;
    registry
      .catalog(skeletonGuid, {
        kind: 'skeleton',
        jointCount: 2,
        inverseBindMatrices,
      } satisfies SkeletonAsset)
      .unwrap();
    if (withSkinAsset)
      registry
        .catalog(skinGuid, {
          kind: 'skin',
          skeletonGuid,
          jointPaths: ['joint-0', 'joint-1'],
        })
        .unwrap();
    const entities: Record<string, SceneEntity> = {};
    for (const actor of ['a', 'b']) {
      entities[actor] = { components: { Transform: {}, Name: { value: actor } } };
      entities[`${actor}/root`] = {
        components: {
          Transform: {},
          Name: { value: 'joint-0' },
          ChildOf: { parent: actor },
        },
      };
      entities[`${actor}/tip`] = {
        components: {
          Transform: { pos: [0, 1, 0] },
          Name: { value: 'joint-1' },
          ChildOf: { parent: `${actor}/root` },
        },
      };
      entities[`${actor}/surface`] = {
        components: {
          Transform: {},
          Name: { value: `${actor}-surface` },
          ChildOf: { parent: actor },
          Skin: { skeleton: skeletonGuid, joints: [`${actor}/root`, `${actor}/tip`] },
        },
      };
    }
    const scene = world.allocSharedRef<'SceneAsset', SceneAsset>('SceneAsset', {
      kind: 'scene',
      entities,
    });
    const baseline = world.sharedRefs._liveCount();
    const root = registry.instantiate(scene, world).unwrap();
    try {
      const surfaces = Array.from(world.query({ read: [Skin, Name] }).unwrap(), (row) => ({
        name: row.get(Name).value,
        joints: Array.from(row.get(Skin).joints),
      }));
      expect(surfaces).toHaveLength(2);
      const used = new Set<number>();
      for (const surface of surfaces) {
        const actor = surface.name.split('-')[0];
        const joints = surface.joints;
        expect(joints).toHaveLength(2);
        const first = joints[0];
        const second = joints[1];
        if (first === undefined || second === undefined)
          throw new Error('expected complete Skin chain');
        const actorEntity = world.get(first as EntityHandle, ChildOf).unwrap().parent;
        if (actorEntity === null) throw new Error('expected Skin actor parent');
        expect(world.get(actorEntity, Name).unwrap().value).toBe(actor);
        expect(world.get(second as EntityHandle, ChildOf).unwrap().parent).toBe(first);
        for (const joint of joints) {
          expect(used.has(joint)).toBe(false);
          used.add(joint);
        }
      }
    } finally {
      worldDespawnScene(world, root).unwrap();
      expect(world.inspect().entityCount).toBe(0);
      expect(world.sharedRefs._liveCount()).toBe(baseline);
      world.sharedRefs.release(scene).unwrap();
    }
  });
});
