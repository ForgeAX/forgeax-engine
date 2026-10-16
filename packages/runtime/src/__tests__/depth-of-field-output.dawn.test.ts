import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  ANTIALIAS_NONE,
  Camera,
  DepthOfField,
  DepthOfFieldSideValue,
  Materials,
  MeshFilter,
  MeshRenderer,
  TONEMAP_NONE,
} from '@forgeax/engine-render';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import {
  createBarrelRendererFixture,
  maxRgbDelta,
  pixelOffset,
  readBarrelPixels,
} from './barrel-distortion-gpu-fixture';
import { drawPublished } from './draw-published';

it('preserves color through DoF attachment topology changes and component removal', async () => {
  const width = 129;
  const height = 73;
  const fixture = await createBarrelRendererFixture({ width, height });
  const world = new World();
  const releaseTransforms = registerPropagateTransforms(world);
  try {
    const material = world.allocSharedRef('MaterialAsset', Materials.unlit([0.8, 0.2, 0.1, 1]));
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0], scale: [100, 100, 1] } },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: Camera,
          data: {
            fov: Math.PI / 3,
            aspect: width / height,
            near: 0.1,
            far: 100,
            antialias: ANTIALIAS_NONE,
            tonemap: TONEMAP_NONE,
            clearColor: [0, 0, 0, 1],
          },
        },
      )
      .unwrap();
    const read = async () => {
      drawPublished(fixture.renderer, world).unwrap();
      await fixture.device.queue.onSubmittedWorkDone();
      return readBarrelPixels(fixture.device, fixture.renderTarget, width, height);
    };
    const baseline = await read();
    const center = pixelOffset(64, 36, width);
    expect(baseline[center]).toBeGreaterThan(100);
    expect(baseline[center]).toBeGreaterThan(baseline[center + 1] ?? 0);
    world
      .addComponent(camera, { component: DepthOfField, data: { fStop: 1.4, maxRadiusPixels: 10 } })
      .unwrap();
    for (const side of ['near', 'both', 'far', 'near'] as const) {
      world
        .set(camera, DepthOfField, {
          blurSide: DepthOfFieldSideValue[side],
          focusDistance: side === 'far' ? 1 : 8,
        })
        .unwrap();
      const pixels = await read();
      expect(maxRgbDelta(baseline, pixels)).toBeLessThanOrEqual(1);
      const inspection = fixture.renderer.inspect();
      expect(inspection.depthOfField).toMatchObject({
        status: 'active',
        passCount: side === 'both' ? 7 : 5,
        workExtent: { width: 65, height: 37 },
      });
      const passes = inspection.output.graphPassNames.filter((name) => name.startsWith('dof-'));
      expect(passes).toContain(`dof-gather-${side}`);
      expect(passes).not.toContain('dof-fill-background');
      if (side !== 'both')
        expect(passes).not.toContain(`dof-prefilter-${side === 'near' ? 'far' : 'near'}`);
    }
    world.removeComponent(camera, DepthOfField).unwrap();
    expect(maxRgbDelta(baseline, await read())).toBe(0);
    expect(fixture.renderer.inspect().depthOfField).toMatchObject({ status: 'off', passCount: 0 });
  } finally {
    releaseTransforms();
    await fixture.renderer.dispose();
  }
}, 60_000);

// Reverse-Z clears depth to 0. That cleared background is the far plane, a
// real far-field destination: a defocused far object must spread its circle
// past its silhouette instead of stopping at the depth discontinuity.
it('spreads a defocused far silhouette over the cleared background', async () => {
  const width = 129;
  const height = 73;
  const fixture = await createBarrelRendererFixture({ width, height });
  const world = new World();
  const releaseTransforms = registerPropagateTransforms(world);
  try {
    const material = world.allocSharedRef(
      'MaterialAsset',
      Materials.unlit([0.8, 0.2, 0.1, 1], { castShadow: false }),
    );
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, -6], scale: [4, 4, 1] } },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: Camera,
          data: {
            fov: Math.PI / 3,
            aspect: width / height,
            near: 0.1,
            far: 100,
            antialias: ANTIALIAS_NONE,
            tonemap: TONEMAP_NONE,
            clearColor: [0, 0, 0, 1],
          },
        },
      )
      .unwrap();
    const read = async () => {
      drawPublished(fixture.renderer, world).unwrap();
      await fixture.device.queue.onSubmittedWorkDone();
      return readBarrelPixels(fixture.device, fixture.renderTarget, width, height);
    };
    // The cube spans roughly x 51..77 on the center row; x 80 is background.
    const outside = pixelOffset(80, 36, width);
    const inside = pixelOffset(64, 36, width);
    const sharp = await read();
    expect(sharp[inside]).toBeGreaterThan(100);
    expect(sharp[outside]).toBe(0);
    world
      .addComponent(camera, {
        component: DepthOfField,
        data: {
          focusDistance: 1,
          fStop: 0.7,
          sensorHeight: 0.24,
          maxRadiusPixels: 10,
          blurSide: DepthOfFieldSideValue.far,
        },
      })
      .unwrap();
    await read();
    const blurred = await read();
    expect(fixture.renderer.inspect().depthOfField).toMatchObject({ status: 'active' });
    expect(blurred[outside]).toBeGreaterThan(10);
    expect(blurred[inside]).toBeGreaterThan(100);
  } finally {
    releaseTransforms();
    await fixture.renderer.dispose();
  }
}, 60_000);
