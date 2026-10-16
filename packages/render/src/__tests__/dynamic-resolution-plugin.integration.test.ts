import { createWorldContext, World } from '@forgeax/engine-ecs';
import { scenePlugin, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import {
  AmbientOcclusion,
  ANTIALIAS_NONE,
  ANTIALIAS_TAA,
  Camera,
  DynamicResolution,
  MotionBlur,
} from '../index';
import { renderComponentsPlugin } from '../plugin';
import { extractCameraSnapshots } from '../render-system-extract';
import { extractFrames } from '../render-system-extract-tail';

describe('DynamicResolution render component registration', () => {
  it('leases Fog vocabulary with the render component plugin', async () => {
    const world = new World();
    const context = await createWorldContext(world, [renderComponentsPlugin()]);
    expect([...world.components.entries()].map(([name]) => name)).toContain('Fog');
    await context.fiber.dispose();
    expect([...world.components.entries()].map(([name]) => name)).not.toContain('Fog');
  });

  it('uses the existing render plugin for add, remove, and extraction retries', async () => {
    const world = new World();
    const context = await createWorldContext(world, [renderComponentsPlugin(), scenePlugin()]);
    const entries = [...world.components.entries()].map(([name]) => name);
    expect(entries).toContain('DynamicResolution');

    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: Camera, data: { antialias: ANTIALIAS_TAA } },
        { component: DynamicResolution, data: { minScale: 0.5, maxScale: 0.5 } },
      )
      .unwrap();
    world.update(1 / 60).unwrap();
    expect(extractCameraSnapshots(world)[0]?.dynamicResolution).toMatchObject({
      minScale: 0.5,
      maxScale: 0.5,
    });
    expect(extractCameraSnapshots(world)[0]?.dynamicResolution?.targetGpuMs).toBeCloseTo(16.67);

    world.removeComponent(entity, DynamicResolution).unwrap();
    expect(extractCameraSnapshots(world)[0]?.dynamicResolution).toBeUndefined();
    expect(extractFrames([world], 0).cameras[0]?.dynamicResolution).toBeUndefined();
    world
      .addComponent(entity, {
        component: DynamicResolution,
        data: { minScale: 0.75, maxScale: 0.75 },
      })
      .unwrap();
    expect(extractCameraSnapshots(world)[0]?.dynamicResolution).toMatchObject({
      minScale: 0.75,
      maxScale: 0.75,
    });
    expect(extractCameraSnapshots(world)[0]?.dynamicResolution?.targetGpuMs).toBeCloseTo(16.67);

    const nonTaa = world.set(entity, Camera, { antialias: ANTIALIAS_NONE });
    expect(nonTaa.ok).toBe(true);
    expect(() => extractCameraSnapshots(world)).toThrowError(
      expect.objectContaining({ code: 'dynamic-resolution-requires-taa' }),
    );

    await context.fiber.dispose();
  });

  it('registers MotionBlur for the shared camera extraction query', async () => {
    const world = new World();
    const context = await createWorldContext(world, [renderComponentsPlugin(), scenePlugin()]);
    expect([...world.components.entries()].map(([name]) => name)).toContain('MotionBlur');

    world
      .spawn(
        { component: Transform, data: {} },
        { component: Camera, data: { antialias: ANTIALIAS_TAA } },
        { component: MotionBlur, data: { shutterAngle: 120, maxRadiusPixels: 12, sampleCount: 6 } },
      )
      .unwrap();
    world.update(1 / 60).unwrap();

    expect(extractCameraSnapshots(world)[0]?.motionBlur).toEqual({
      shutterAngle: 120,
      maxRadiusPixels: 12,
      sampleCount: 6,
      targetFps: 60,
    });
    expect(extractFrames([world], 0).cameras[0]?.motionBlur).toEqual({
      shutterAngle: 120,
      maxRadiusPixels: 12,
      sampleCount: 6,
      targetFps: 60,
    });

    await context.fiber.dispose();
  });

  it('routes invalid MotionBlur data through the structured extraction error', async () => {
    const world = new World();
    const context = await createWorldContext(world, [renderComponentsPlugin(), scenePlugin()]);
    world
      .spawn(
        { component: Transform, data: {} },
        { component: Camera, data: { antialias: ANTIALIAS_TAA } },
        { component: MotionBlur, data: { targetFps: 59.5 } },
      )
      .unwrap();
    world.update(1 / 60).unwrap();

    expect(() => extractCameraSnapshots(world)).toThrowError(
      expect.objectContaining({ code: 'motion-blur-invalid-params' }),
    );
    await context.fiber.dispose();
  });
});

it('leases camera AO vocabulary and removes its extracted demand when toggled off', async () => {
  const world = new World();
  const context = await createWorldContext(world, [renderComponentsPlugin(), scenePlugin()]);
  try {
    expect([...world.components.entries()].map(([name]) => name)).toContain('AmbientOcclusion');
    const camera = world
      .spawn(
        { component: Transform, data: {} },
        { component: Camera, data: {} },
        { component: AmbientOcclusion, data: { directLightingStrength: 0.7 } },
      )
      .unwrap();
    expect(extractCameraSnapshots(world)[0]?.ambientOcclusion?.directLightingStrength).toBeCloseTo(
      0.7,
    );
    world.removeComponent(camera, AmbientOcclusion).unwrap();
    expect(extractCameraSnapshots(world)[0]?.ambientOcclusion).toBeUndefined();
  } finally {
    await context.fiber.dispose();
  }
  expect([...world.components.entries()].map(([name]) => name)).not.toContain('AmbientOcclusion');
});
