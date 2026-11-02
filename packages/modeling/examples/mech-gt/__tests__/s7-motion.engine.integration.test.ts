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
import { buildS7, TIMING } from '../s7-motion';

/**
 * C-100 stage S7 on the Engine's own owners: the AssetRegistry instantiates `scene/s7`,
 * Animation binds the joint targets and samples `animation-clip/s7` (the round trip), and
 * Scene propagates the transforms. Every joint, mechanism and drive joint (cylinder barrels
 * and rods, pinions) must land where the modeling kernel puts it, so the linkages the
 * kernel closes stay closed in playback.
 */
describe('C-100 S7 on the Engine: scene instance, animation player, transform propagation', () => {
  it('plays the round-trip clip onto every joint entity', { timeout: 600000 }, async () => {
    const s7 = buildS7('sheet');
    const r = s7.rig;
    const id = PackageId.parse('01900000-0000-7000-8000-0000000c1070');
    if (!id.ok) throw id.error;
    const duration = 2 * TIMING.run + TIMING.hold;
    const out = r.finish({ key: 's7', packageId: id.value, path: s7.roundTrip, duration, frameRate: 30 });
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
    const source = out.value['scene/s7'] as SceneAsset;
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
    const frames = [0, 120, 240, 360, 390, 510, 750];
    for (const frame of frames) {
      const u = frame / 750;
      world.set(player, AnimationPlayer, { times: [u * duration] }).unwrap();
      world.update(0);
      const sampled = r.sample(s7.roundTrip, u);
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
    expect(checked).toBe(frames.length * r.joints.length);
  });
});
