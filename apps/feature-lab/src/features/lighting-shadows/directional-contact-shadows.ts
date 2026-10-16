import type { CreateAppOptions } from '@forgeax/engine/app';
import { DEFAULT_STANDARD_PROFILE, DirectionalLight, Skylight } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnCamera, spawnGround, spawnMesh, standard } from '../../lab/stage';

const LENGTH = 0.5;

const APP_OPTIONS: CreateAppOptions = {
  standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' },
};

export default defineFeature({
  title: 'Directional contact shadows',
  catalog: 'Directional contact shadows',
  kind: 'visual',
  appOptions: APP_OPTIONS,
  summary: `Deferred path, cascades disabled (castShadow: false). DirectionalLight.contactShadowLength = ${LENGTH} m marches the depth buffer toward a low sun, so every dark band on the floor is contact-shadow evidence.`,
  expect:
    'ON: each small cube has a dark contact-shadow band on the floor on its side away from the sun. OFF: contactShadowLength = 0 and the cubes look pasted onto the floor with no grounding shadow.',
  setup({ world }) {
    spawnGround(world, [0.7, 0.7, 0.7, 1]);
    spawnCamera(world, { eye: [0, 2.4, 3.2], target: [0, 0, 0] });
    world
      .spawn({ component: Skylight, data: { color: [0.4, 0.45, 0.5], intensity: 0.15 } as never })
      .unwrap();
    const sun = world
      .spawn({
        component: DirectionalLight,
        data: {
          direction: [-1, -0.35, 0],
          intensity: 3,
          castShadow: false,
          contactShadowLength: LENGTH,
        } as never,
      })
      .unwrap();
    const mat = standard(world, { baseColor: [0.95, 0.75, 0.2, 1], roughness: 0.8 });
    for (let z = 0; z < 3; z++) {
      for (let x = 0; x < 5; x++) {
        spawnMesh(world, MESH.cube, mat, {
          pos: [-1.6 + x * 0.8, 0.15, -0.8 + z * 0.8],
          scale: [0.3, 0.3, 0.3],
        });
      }
    }
    return {
      toggle(on) {
        world.set(sun, DirectionalLight, { contactShadowLength: on ? LENGTH : 0 } as never);
      },
    };
  },
});
