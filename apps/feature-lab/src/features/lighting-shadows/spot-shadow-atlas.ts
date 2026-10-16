import { Skylight, SpotLight } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnCamera, spawnGround, spawnMesh, standard } from '../../lab/stage';
import { spawnSpotLight } from './support/scene';

export default defineFeature({
  title: 'Spot shadow atlas',
  catalog: 'Spot shadow atlas',
  kind: 'visual',
  summary:
    'Two spot lights (magenta, cyan) with castShadow render into the separate spot-shadow 2D atlas; a sphere sits in each cone.',
  expect:
    'ON: each colored cone contains a dark round sphere shadow. OFF: castShadow = false on both spots; the cones stay lit but the shadows vanish.',
  setup({ world, app }) {
    spawnGround(world);
    spawnCamera(world, { eye: [0, 4, 5.5], target: [0, 0, 0] });
    world
      .spawn({ component: Skylight, data: { color: [0.5, 0.5, 0.6], intensity: 0.06 } as never })
      .unwrap();
    const white = standard(world, { baseColor: [0.95, 0.95, 0.95, 1] });
    spawnMesh(world, MESH.sphere, white, { pos: [-1.3, 0.9, 0], scale: [0.6, 0.6, 0.6] });
    spawnMesh(world, MESH.sphere, white, { pos: [1.3, 0.9, 0], scale: [0.6, 0.6, 0.6] });
    const spots = [
      spawnSpotLight(world, [-1.8, 4, 0.4], [0.12, -1, -0.1], [1, 0.1, 0.9], { outerConeDeg: 32 }),
      spawnSpotLight(world, [1.8, 4, 0.4], [-0.12, -1, -0.1], [0.1, 0.9, 1], { outerConeDeg: 32 }),
    ];
    let enabled = true;
    let onSample = app.renderer.inspect().standardLighting;
    return {
      toggle(on) {
        if (!on && enabled) onSample = app.renderer.inspect().standardLighting;
        enabled = on;
        for (const spot of spots) world.set(spot, SpotLight, { castShadow: on } as never);
      },
      checks() {
        // The runner checks after OFF; judge the ON state by the sample taken before the toggle.
        const lighting = enabled ? app.renderer.inspect().standardLighting : onSample;
        return [
          {
            name: 'two shadowed spot lights',
            ok: lighting?.shadowed === 2,
            detail: `shadowed=${lighting?.shadowed}`,
          },
        ];
      },
    };
  },
});
