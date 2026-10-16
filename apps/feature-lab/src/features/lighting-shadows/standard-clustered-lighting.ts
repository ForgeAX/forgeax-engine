import type { CreateAppOptions } from '@forgeax/engine/app';
import type { EntityHandle } from '@forgeax/engine/ecs';
import { DEFAULT_STANDARD_PROFILE, PointLight, Skylight } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { spawnCamera, spawnGround } from '../../lab/stage';
import { spawnPointLight } from './support/scene';

const GRID = 8;
const COUNT = GRID * GRID;

const APP_OPTIONS: CreateAppOptions = {
  standardProfile: { ...DEFAULT_STANDARD_PROFILE, lightCount: 256 },
};

export default defineFeature({
  title: 'Standard clustered lighting',
  catalog: 'Standard clustered lighting',
  kind: 'visual',
  appOptions: APP_OPTIONS,
  summary: `standardProfile.lightCount = 256 opts into the full Cluster budget; ${COUNT} small colored point lights share one clustered path.`,
  expect: `ON: an ${GRID}x${GRID} grid of small rainbow light pools covers the floor. OFF: every light is at intensity 0 and the floor is dim. Checks: ${COUNT} lights requested and admitted on a compute-storage or cpu-storage transport.`,
  setup({ world, app }) {
    spawnGround(world);
    spawnCamera(world, { eye: [0, 7, 7], target: [0, 0, 0] });
    world
      .spawn({ component: Skylight, data: { color: [0.5, 0.5, 0.6], intensity: 0.04 } as never })
      .unwrap();
    const lights: EntityHandle[] = [];
    for (let z = 0; z < GRID; z++) {
      for (let x = 0; x < GRID; x++) {
        const hue = ((x + z * GRID) / COUNT) * Math.PI * 2;
        const color = [
          0.5 + 0.5 * Math.cos(hue),
          0.5 + 0.5 * Math.cos(hue - 2.1),
          0.5 + 0.5 * Math.cos(hue + 2.1),
        ] as const;
        lights.push(
          spawnPointLight(
            world,
            [(x - (GRID - 1) / 2) * 1.3, 0.35, (z - (GRID - 1) / 2) * 1.3],
            color,
            3,
            1.2,
          ),
        );
      }
    }
    let enabled = true;
    let onSample = app.renderer.inspect().standardLighting;
    return {
      toggle(on) {
        if (!on && enabled) onSample = app.renderer.inspect().standardLighting;
        enabled = on;
        for (const light of lights)
          world.set(light, PointLight, { intensity: on ? 3 : 0 } as never);
      },
      checks() {
        // The runner checks after OFF; judge the ON state by the sample taken before the toggle.
        const lighting = enabled ? app.renderer.inspect().standardLighting : onSample;
        const transport = lighting?.transport;
        return [
          {
            name: 'clustered transport',
            ok: transport === 'compute-storage' || transport === 'cpu-storage',
            detail: `transport=${transport}`,
          },
          {
            name: `${COUNT} lights requested`,
            ok: lighting?.requested === COUNT,
            detail: `requested=${lighting?.requested}`,
          },
          {
            name: `${COUNT} lights admitted`,
            ok: lighting?.admitted === COUNT,
            detail: `admitted=${lighting?.admitted}`,
          },
          {
            name: 'maxLights = 256',
            ok: lighting?.maxLights === 256,
            detail: `maxLights=${lighting?.maxLights}`,
          },
          {
            name: 'clusters occupied',
            ok: (lighting?.occupied ?? 0) > 0,
            detail: `occupied=${lighting?.occupied}`,
          },
        ];
      },
    };
  },
});
