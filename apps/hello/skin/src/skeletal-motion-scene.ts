import {
  configureRuntimeAssetCatalog,
  runtimeBinding,
} from '@forgeax/apps-shared/asset-runtime-config';
import {
  AnimationPlayer,
  AnimationTargetId,
  bindAnimationTargets,
} from '@forgeax/engine/animation';
import {
  bindSkeletalMotion,
  type SkeletalMotionDefinition,
} from '@forgeax/engine/animation/skeletal-motion';
import { type EntityHandle, FixedTime } from '@forgeax/engine/ecs';
import { createBoxGeometry } from '@forgeax/engine/geometry';
import { quat } from '@forgeax/engine/math';
import {
  Collider,
  ColliderShapeValue,
  type PhysicsWorld,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine/physics';
import { type Context, startPluginAsset } from '@forgeax/engine/plugin';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
} from '@forgeax/engine/render';
import { ChildOf, GlobalTransform, Name, Transform } from '@forgeax/engine/scene';
import { Skin } from '@forgeax/engine/skinning';
import type { AnimationClip, PluginAsset, SceneAsset, SkeletonAsset } from '@forgeax/engine/types';
import { motionGuid } from './skeletal-motion-guids';
import type {} from './skeletal-motion-program';

/** This ordinary authored scene is shared by Host, Engine Worker and native evidence. */
export async function loadSkeletalMotionScene(ctx: Context, aspect: number) {
  const world = ctx.world;
  const assets = ctx.assets;
  if (assets === undefined) throw new Error('skeletal motion requires ordinary assets');
  const registry = assets;
  configureRuntimeAssetCatalog(registry, runtimeBinding);
  const load = async <T>(key: string): Promise<T> =>
    (await assets.loadByGuid<T>(assets.parseGuid(motionGuid(key)))).unwrap();
  const scene = await load<SceneAsset>('scene');
  const definitionAsset = await load<PluginAsset>('motion');
  const skeleton = await load<SkeletonAsset>('skeleton');
  const definition = definitionAsset.config as unknown as SkeletalMotionDefinition;
  const clip = world.allocSharedRef('AnimationClip', await load<AnimationClip>('clip'));
  function instantiateRig() {
    const root = registry.instantiate(world.allocSharedRef('SceneAsset', scene), world).unwrap();
    let player: EntityHandle | undefined, skinEntity: EntityHandle | undefined;
    const joints: EntityHandle[] = [];
    for (const row of world.query({ read: [Name] }).unwrap()) {
      let ancestor = row.entity;
      while (ancestor !== root) {
        const parent = world.get(ancestor, ChildOf);
        if (!parent.ok || parent.value.parent === null) break;
        ancestor = parent.value.parent;
      }
      if (ancestor !== root) continue;
      if (row.get(Name).value === 'Actor') player = row.entity;
      if (world.hasComponent(row.entity, AnimationTargetId)) joints.push(row.entity);
      if (world.hasComponent(row.entity, Skin)) skinEntity = row.entity;
    }
    if (player === undefined || skinEntity === undefined)
      throw new Error('authored player or Skin missing');
    bindAnimationTargets(world, player, joints).unwrap();
    world
      .set(player, AnimationPlayer, { clips: [clip], times: [0], speeds: [1], weights: [1] })
      .unwrap();
    return { root, player, joints, skinEntity };
  }
  const { root, player, joints, skinEntity } = instantiateRig();
  (await startPluginAsset(ctx, motionGuid('motion'))).unwrap();
  let installed: Context['skeletalMotionExample'] | undefined;
  await ctx.inject(['skeletalMotionExample'], (consumer) => {
    installed = consumer.skeletalMotionExample;
  });
  if (installed === undefined) throw new Error('authored skeletal motion service did not activate');
  const controls = installed;
  const physics = world.getResource<PhysicsWorld>('PhysicsWorld');
  const floorEntity = world
    .spawn(
      { component: Transform, data: { pos: [0, -0.25, 0] } },
      { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
      {
        component: Collider,
        data: { shape: ColliderShapeValue.cuboid, halfExtents: [8, 0.25, 8] },
      },
      {
        component: MeshFilter,
        data: {
          assetHandle: world.allocSharedRef('MeshAsset', createBoxGeometry(16, 0.5, 16).unwrap()),
        },
      },
      {
        component: MeshRenderer,
        data: {
          materials: [
            world.allocSharedRef(
              'MaterialAsset',
              Materials.standard({ baseColor: [0.05, 0.07, 0.1, 1], roughness: 0.9 }),
            ),
          ],
        },
      },
    )
    .unwrap();
  const cameraEntity = world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [4, 3, 7],
          quat: quat.fromLookAt(quat.create(), [4, 3, 7], [0, 1.2, 0], [0, 1, 0]),
        },
      },
      {
        component: Camera,
        data: {
          ...perspective({ fov: (40 * Math.PI) / 180, aspect: aspect, near: 0.1, far: 50 }),
          clearColor: [0.018, 0.028, 0.055, 1],
        },
      },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: { direction: [-0.4, -1, -0.5], color: [1, 0.95, 0.85], intensity: 4 },
    })
    .unwrap();
  return {
    root,
    floorEntity,
    cameraEntity,
    player,
    joints,
    skinEntity,
    skeleton,
    definition,
    physics,
    controls,
    /** Scaling proof uses the same authored Scene and saved definition per instance. */
    spawnAdditionalRig(position: readonly [number, number, number]) {
      const rig = instantiateRig();
      world.set(rig.root, Transform, { pos: position }).unwrap();
      const binding = bindSkeletalMotion(world, rig.player, definition).unwrap();
      ctx.effect(() => () => binding.dispose());
      return { ...rig, binding };
    },
    restart() {
      controls.rebind();
      world.set(player as EntityHandle, Transform, { pos: [0, 0, 0] }).unwrap();
      world.set(player as EntityHandle, AnimationPlayer, { times: [0] }).unwrap();
      controls.binding.reset();
    },
    snapshot() {
      const skin = world.get(skinEntity as EntityHandle, Skin).unwrap();
      return {
        tick: world.getResource(FixedTime).tick,
        playerTime: [...world.get(player as EntityHandle, AnimationPlayer).unwrap().times],
        definition,
        status: controls.binding.status,
        steps: controls.binding.fixedSteps,
        springEvidence: controls.binding.springEvidence,
        skin: {
          entity: skinEntity,
          joints: [...skin.joints],
          inverseBind: [...skeleton.inverseBindMatrices],
          meshWorld: [...world.get(skinEntity as EntityHandle, GlobalTransform).unwrap().world],
        },
        poses: Array.from(world.query({ read: [Transform, GlobalTransform] }).unwrap(), (row) => {
          const local = row.get(Transform),
            parent = world.get(row.entity, ChildOf),
            name = world.get(row.entity, Name),
            targetId = world.get(row.entity, AnimationTargetId);
          return {
            entity: row.entity,
            parent: parent.ok ? parent.value.parent : null,
            name: name.ok ? name.value.value : null,
            target: targetId.ok ? targetId.value.value : null,
            local: { pos: [...local.pos], quat: [...local.quat], scale: [...local.scale] },
            world: [...row.get(GlobalTransform).world],
          };
        }),
        bodies: controls.binding.bodyEntities.map((entity) => ({
          entity,
          ...(() => {
            const readMotion = physics.getBodyMotion;
            if (!readMotion) throw new Error('managed body observation unavailable');
            return readMotion.call(physics, entity).unwrap();
          })(),
        })),
        bodyCount: physics.getBodyCount(),
        jointCount: physics.getJointCount?.(),
      };
    },
  };
}
