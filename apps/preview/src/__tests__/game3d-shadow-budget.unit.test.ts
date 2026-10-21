import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import type { SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { Camera } from '../../../../packages/render/src/components/camera';
import { DirectionalLight } from '../../../../packages/render/src/components/directional-light';
import { prepareExtractContext } from '../../../../packages/render/src/render-system-extract';
import { extractFrame } from '../../../../packages/render/src/render-system-extract-tail';

const { default: scenePack } = await import(
  new URL('../../../../templates/game-3d/assets/scene.pack.ts', import.meta.url).href
);

// Exercise the authored template and native default expansion, without the CI
// smoke's reduced shadow settings. A kilometer-scale default can still render
// a non-flat frame while losing the starter's contact shadows.
describe('Game 3D shadow coverage budget', () => {
  it.each([
    16 / 9,
    9 / 16,
    21 / 9,
  ])('retains centimeter-scale near shadows at aspect %s', async (aspect) => {
    const built = await scenePack.build(undefined as never);
    if (!built.ok) throw built.error;
    const scene = built.value['scene/showcase'] as SceneAsset;
    const sun = scene.entities.sun?.components.DirectionalLight;
    const camera = scene.entities.camera?.components.Camera;
    const cameraTransform = scene.entities.camera?.components.Transform;
    expect(sun).toBeDefined();
    expect(camera).toBeDefined();
    const world = new World();
    world.spawn({ component: DirectionalLight, data: { direction: [0, -1, 0], ...sun } });
    world.spawn(
      { component: Transform, data: { ...cameraTransform } },
      { component: Camera, data: { ...camera, aspect } },
    );
    const { lights } = extractFrame(world, prepareExtractContext(world));
    expect(lights.cascadeCount).toBe(3);
    expect(lights.shadowMapSize).toBe(2048);
    const splits = lights.splitPlanes;
    expect(splits).toBeDefined();
    // At least two near-cascade texels across a 4 cm contact detail.
    expect(splits?.[1]).toBeLessThanOrEqual(0.02);
    // Cover the 28 m square ground's diagonal plus the 6.5 m camera orbit.
    expect(splits?.[8]).toBeGreaterThanOrEqual(Math.hypot(28, 28) + 6.5);
  });
});
