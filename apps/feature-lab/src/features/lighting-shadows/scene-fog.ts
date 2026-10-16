import { Fog } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

const FOG = { color: [0.85, 0.35, 0.95], density: 0.18, heightFalloff: 0, maxOpacity: 1 } as const;

export default defineFeature({
  title: 'Scene Fog',
  catalog: 'Scene Fog',
  kind: 'visual',
  summary:
    'One Fog entity per World applies exponential distance fog (optionally height-falling) in the main lighting pass. Here it is dense and magenta so the falloff is obvious.',
  expect:
    'ON: the row of cubes fades into magenta haze with distance; far cubes are almost invisible. OFF: the Fog entity is despawned and every cube is crisp.',
  setup({ world }) {
    spawnStage(world, { eye: [0, 1.2, 4], target: [0, 0.6, -6] });
    const mat = standard(world, { baseColor: [0.1, 0.8, 0.3, 1] });
    for (let i = 0; i < 8; i++) {
      spawnMesh(world, MESH.cube, mat, {
        pos: [i % 2 === 0 ? -1 : 1, 0.5, -i * 2],
        scale: [1, 1, 1],
      });
    }
    let fog = world.spawn({ component: Fog, data: FOG as never }).unwrap();
    return {
      toggle(on) {
        if (on) fog = world.spawn({ component: Fog, data: FOG as never }).unwrap();
        else world.despawn(fog).unwrap();
      },
    };
  },
});
