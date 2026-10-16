import {
  BLOOM_DISABLED,
  BLOOM_ENABLED,
  Camera,
  TONEMAP_REINHARD_EXTENDED,
} from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

export default defineFeature({
  title: 'Bloom',
  catalog: 'Bloom',
  kind: 'visual',
  summary:
    'Camera.bloom spreads HDR pixels above bloomThreshold into a soft glow on the Standard post chain.',
  expect:
    'ON: a wide orange halo surrounds the emissive sphere. OFF: the sphere has a hard edge and the background stays dark.',
  setup({ world }) {
    const { camera } = spawnStage(world, {
      data: {
        tonemap: TONEMAP_REINHARD_EXTENDED,
        bloom: BLOOM_ENABLED,
        bloomThreshold: 1,
        bloomIntensity: 1.5,
      },
    });
    const glow = standard(world, {
      baseColor: [1, 0.8, 0.5, 1],
      emissive: [1, 0.6, 0.2],
      emissiveIntensity: 6,
    });
    spawnMesh(world, MESH.sphere, glow, { pos: [0, 0.8, 0], scale: [0.8, 0.8, 0.8] });
    return {
      toggle(on) {
        world.set(camera, Camera, { bloom: on ? BLOOM_ENABLED : BLOOM_DISABLED } as never);
      },
    };
  },
});
