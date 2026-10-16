import type { EntityHandle } from '@forgeax/engine/ecs';
import { createSphereGeometry } from '@forgeax/engine/geometry';
import { MorphWeights } from '@forgeax/engine/scene';
import type { MeshAsset } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';
import { spawnMesh, spawnStage, standard } from '../../lab/stage';

function withMorph(base: MeshAsset): MeshAsset {
  const source =
    base.attributes.position instanceof Float32Array
      ? base.attributes.position
      : new Float32Array();
  const stretch = new Float32Array(source.length);
  const lift = new Float32Array(source.length);
  for (let i = 0; i < source.length; i += 3) {
    stretch[i] = (source[i] ?? 0) * 1.6;
    lift[i + 1] = Math.max(0, source[i + 1] ?? 0) * 1.2;
  }
  return {
    ...base,
    aabb: new Float32Array([-1.3, -0.5, -0.5, 1.3, 1.1, 0.5]),
    morphTargets: [{ position: stretch }, { position: lift }],
    morphWeights: new Float32Array([0, 0]),
  };
}

export default defineFeature({
  title: 'Morph target GPU deformation',
  catalog: 'Morph/BlendShape GPU deformation',
  kind: 'visual',
  summary:
    'A MeshAsset with morphTargets plus a MorphWeights component is deformed on the GPU (compute + storage buffer) before raster; up to eight targets per mesh.',
  expect:
    'ON: weights [1, 1] - the green sphere is stretched into a wide egg with a raised top. OFF: weights [0, 0] - a plain round sphere.',
  setup({ world, hud }) {
    spawnStage(world, { eye: [0, 1.4, 5], target: [0, 0.8, 0] });
    const sphere = createSphereGeometry(0.5, 32, 24);
    if (!sphere.ok) {
      hud.status(`sphere failed: ${sphere.error.code}`);
      return {};
    }
    const mesh = world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', withMorph(sphere.value));
    const entity: EntityHandle = spawnMesh(
      world,
      mesh,
      standard(world, { baseColor: [0.2, 1, 0.35, 1], roughness: 0.4 }),
      { pos: [0, 0.8, 0] },
      { component: MorphWeights, data: { weights: new Float32Array([1, 1]) } },
    );
    return {
      toggle(on) {
        world.set(entity, MorphWeights, {
          weights: new Float32Array(on ? [1, 1] : [0, 0]),
        } as never);
      },
    };
  },
});
