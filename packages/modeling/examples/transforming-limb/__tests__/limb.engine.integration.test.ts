import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  AnimationPlayer,
  AnimationTargetId,
  animationPlugin,
  bindAnimationTargets,
} from '@forgeax/engine-animation';
import { createWorldContext, ENTITY_NULL_RAW, type EntityHandle, World } from '@forgeax/engine-ecs';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { renderComponentsPlugin, SceneInstance } from '@forgeax/engine-render';
import { GlobalTransform, Name, scenePlugin } from '@forgeax/engine-scene';
import type { AnimationClip, MeshAsset, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { buildLimb, limbPath, limbRig } from '../limb';

/**
 * The exported rig runs on the Engine's own owners: the AssetRegistry instantiates
 * `scene/limb`, Animation binds the joint targets and samples `animation-clip/limb`, and
 * Scene propagates the joint transforms. Every joint must land where the modeling
 * kernel's forward kinematics puts it.
 */
describe('C-107 on the Engine: scene instance, animation player, transform propagation', () => {
  it('plays the transformation clip onto the joint entities', { timeout: 120000 }, async () => {
    const m = buildLimb();
    const r = limbRig(m);
    const id = PackageId.parse('01900000-0000-7000-8000-0000000c0107');
    if (!id.ok) throw id.error;
    const duration = 6;
    const out = r.finish({ key: 'limb', packageId: id.value, path: limbPath(), duration, frameRate: 30 });
    if (!out.ok) throw out.error;

    const world = new World({ assets: new AssetRegistry() });
    await createWorldContext(world, [renderComponentsPlugin(), scenePlugin(), animationPlugin()]);
    const registry = world.assets as AssetRegistry;
    // Code-created assets keep native handles: map each output GUID to its handle.
    const handles = new Map<string, unknown>();
    for (const [key, asset] of Object.entries(out.value)) {
      if (asset.kind !== 'mesh' && asset.kind !== 'animation-clip') continue;
      const handle = registry.create(asset as MeshAsset | AnimationClip);
      if (!handle.ok) throw handle.error;
      handles.set(AssetGuid.format(AssetGuid.derive(id.value, key)), handle.value);
    }
    const source = out.value['scene/limb'] as SceneAsset;
    const scene: SceneAsset = {
      ...source,
      entities: Object.fromEntries(
        Object.entries(source.entities).map(([key, entity]) => {
          const components: Record<string, unknown> = { ...entity.components };
          const filter = components.MeshFilter as { assetHandle: string } | undefined;
          if (filter !== undefined) components.MeshFilter = { assetHandle: handles.get(filter.assetHandle) };
          const player = components.AnimationPlayer as { clips: string[] } | undefined;
          if (player !== undefined) {
            components.AnimationPlayer = { ...player, clips: player.clips.map((g) => handles.get(g)) };
          }
          // Mesh renderers need a GPU; the transform hierarchy is what this test reads.
          delete components.MeshRenderer;
          return [key, { ...entity, components }];
        }),
      ),
    } as SceneAsset;
    const sceneHandle = registry.create(scene);
    if (!sceneHandle.ok) throw sceneHandle.error;
    const root = registry.instantiate(sceneHandle.value, world);
    if (!root.ok) throw root.error;
    const instance = world.get(root.value, SceneInstance).unwrap();
    const spawned = [...instance.mapping].filter((e) => e !== ENTITY_NULL_RAW).map((e) => e as EntityHandle);
    const player = spawned.find((e) => world.hasComponent(e, AnimationPlayer)) as EntityHandle;
    expect(player).toBeDefined();
    const targets = spawned.filter((e) => world.hasComponent(e, AnimationTargetId));
    expect(targets).toHaveLength(r.joints.length);
    expect(bindAnimationTargets(world, player, targets).ok).toBe(true);
    const byName = new Map(targets.map((e) => [world.get(e, Name).unwrap().value, e]));

    let checked = 0;
    for (const frame of [0, 36, 63, 108, 144, 180]) {
      const u = frame / 180;
      world.set(player, AnimationPlayer, { times: [u * duration] }).unwrap();
      world.update(0);
      const sampled = r.sample(limbPath(), u);
      if (!sampled.ok) throw sampled.error;
      const posed = r.pose(sampled.value);
      if (!posed.ok) throw posed.error;
      for (const joint of posed.value.joints) {
        const entity = byName.get(joint.name) as EntityHandle;
        const engine = world.get(entity, GlobalTransform).unwrap().world;
        const w = joint.world;
        // Kernel affines are row-major 3x4; Engine matrices are column-major 4x4.
        for (let row = 0; row < 3; row++) {
          for (let col = 0; col < 4; col++) {
            expect(engine[col * 4 + row]).toBeCloseTo(w[row * 4 + col] as number, 4);
          }
        }
        checked++;
      }
    }
    expect(checked).toBe(6 * r.joints.length);
  });
});
