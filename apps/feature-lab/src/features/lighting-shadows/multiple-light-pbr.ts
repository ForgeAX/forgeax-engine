import { PointLight, Skylight } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnCamera, spawnGround, spawnMesh, standard } from '../../lab/stage';
import { spawnPointLight } from './support/scene';

const LIGHTS = [
  { pos: [-1.6, 0.8, 0.6], color: [1, 0.1, 0.1] },
  { pos: [0, 0.8, 0.6], color: [0.1, 1, 0.1] },
  { pos: [1.6, 0.8, 0.6], color: [0.1, 0.2, 1] },
] as const;

export default defineFeature({
  title: 'Multiple-light PBR',
  catalog: 'Multiple-light PBR',
  kind: 'visual',
  summary:
    'Three point lights (red, green, blue) plus a white sphere row are extracted into one bounded direct-light set every frame.',
  expect:
    'ON: three overlapping red, green and blue pools on the floor, mixing to yellow/cyan where they meet. OFF: only the red light stays on.',
  setup({ world, app }) {
    spawnGround(world);
    spawnCamera(world, { eye: [0, 3, 5], target: [0, 0.2, 0] });
    world
      .spawn({ component: Skylight, data: { color: [0.5, 0.5, 0.6], intensity: 0.05 } as never })
      .unwrap();
    const white = standard(world, { baseColor: [0.95, 0.95, 0.95, 1], roughness: 0.4 });
    for (let i = 0; i < 3; i++)
      spawnMesh(world, MESH.sphere, white, {
        pos: [-1.6 + i * 1.6, 0.35, -0.4],
        scale: [0.7, 0.7, 0.7],
      });
    const lights = LIGHTS.map((light) => spawnPointLight(world, light.pos, light.color, 10, 5));
    let enabled = true;
    let onSample = app.renderer.inspect().standardLighting;
    return {
      toggle(on) {
        if (!on && enabled) onSample = app.renderer.inspect().standardLighting;
        enabled = on;
        for (const light of lights.slice(1))
          world.set(light, PointLight, { intensity: on ? 10 : 0 } as never);
      },
      checks() {
        // The runner checks after OFF; judge the ON state by the sample taken before the toggle.
        const lighting = enabled ? app.renderer.inspect().standardLighting : onSample;
        return [
          { name: 'standardLighting inspected', ok: lighting !== undefined },
          {
            name: 'three local lights requested',
            ok: lighting?.requested === 3,
            detail: `requested=${lighting?.requested}`,
          },
          {
            name: 'three local lights admitted',
            ok: lighting?.admitted === 3,
            detail: `admitted=${lighting?.admitted}`,
          },
        ];
      },
    };
  },
});
