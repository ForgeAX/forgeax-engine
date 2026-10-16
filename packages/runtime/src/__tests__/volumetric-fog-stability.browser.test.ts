import { createWorldContext, Time, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  ANTIALIAS_FXAA,
  BLOOM_DISABLED,
  Camera,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
  perspective,
  TONEMAP_NEUTRAL,
  VolumetricFog,
} from '@forgeax/engine-render';
import { propagateTransforms, scenePlugin, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { makeVolumetricDensity } from '../../../../apps/hello/volumetric-fog/src/volumetric-density-importer';
import { createRenderer } from '../createRenderer';

// One device, 128-square output, no external assets or per-frame PNG encoding.
// A real advancing World + FXAA exercises the volume history independently of TAA.
it('stabilizes animated fog through normal ticks and history resets and rejects stale light history', async () => {
  const started = performance.now();
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  document.body.append(canvas);
  const result = await createRenderer(canvas, {}, { shaderManifestUrl: '/shaders/manifest.json' });
  if (!result.ok) throw result.error;
  const renderer = result.value;
  const world = new World();
  const scene = await createWorldContext(world, [scenePlugin()]);
  const data = makeVolumetricDensity({
    format: 'forgeax-volumetric-density',
    width: 128,
    height: 128,
    depth: 128,
    noise: 'improved-perlin',
    scale: 10,
    repeatFactor: 5,
  });
  const density = world.allocSharedRef('TextureAsset', {
    kind: 'texture',
    shape: { viewDimension: '3d', extent: { width: 128, height: 128, depth: 128 } },
    format: 'r8unorm',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data,
  });
  const mesh = world.allocSharedRef('MeshAsset', createBoxGeometry(1, 1, 1).unwrap());
  const material = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({ baseColor: [0, 0, 0, 1], roughness: 1, metallic: 0 }),
  );
  const backdrop = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -10], scale: [20, 20, 1] } },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  const light = world
    .spawn(
      { component: Transform, data: { pos: [0, 1, 0] } },
      { component: PointLight, data: { color: [1, 1, 1], intensity: 3, range: 20 } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 8] } },
      {
        component: Camera,
        data: {
          ...perspective({ fov: Math.PI / 3, aspect: 1, near: 0.1, far: 40 }),
          tonemap: TONEMAP_NEUTRAL,
          antialias: ANTIALIAS_FXAA,
          bloom: BLOOM_DISABLED,
          exposure: 1,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  const fog = world
    .spawn({
      component: VolumetricFog,
      data: {
        light,
        density,
        boundsMin: [-8, -8, -8],
        boundsMax: [8, 8, 6],
        extinction: [0.08, 0.08, 0.08],
        albedo: [1, 1, 1],
        anisotropy: 0,
        maxDistance: 30,
      },
    })
    .unwrap();
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  const errors: string[] = [];
  renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error.code);
  });
  const surface = new OffscreenCanvas(size, size);
  const context = surface.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('fog stability readback unavailable');
  const frame = async (read = false) => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    const drawn = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
    if (!drawn.ok) throw drawn.error;
    if (read) context.drawImage(canvas, 0, 0);
    const completed = await drawn.value.completed;
    if (!completed.ok) throw completed.error;
    if (!read) return new Uint8ClampedArray();
    return context.getImageData(0, 0, size, size).data;
  };
  const difference = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
    let sum = 0;
    // Air ROI away from canvas edges and the punctual light singularity.
    for (let y = 32; y < 96; y += 1)
      for (let x = 16; x < 48; x += 1) {
        sum += Math.abs((a[(y * size + x) * 4] ?? 0) - (b[(y * size + x) * 4] ?? 0)) / 255;
      }
    return sum / (64 * 32);
  };
  const sequence = async (invalidate: boolean) => {
    let previous = await frame(true);
    const differences: number[] = [];
    for (let i = 0; i < 16; i += 1) {
      // Public author edit: negligible optical change, real history reset.
      // History loss must not expose random noise; the light control below rejects black output.
      if (invalidate)
        world.set(fog, VolumetricFog, { maxDistance: 30 + (i % 2) * 0.0001 }).unwrap();
      const current = await frame(true);
      differences.push(difference(previous, current));
      previous = current;
    }
    return {
      meanDelta: differences.reduce((a, b) => a + b) / differences.length,
      pixels: previous,
    };
  };
  try {
    for (let i = 0; i < 32; i += 1) await frame();
    const accumulated = await sequence(false);
    const reset = await sequence(true);
    expect(renderer.inspect().volumetricFog?.resourceFacts?.resolvedPixelCount).toBeGreaterThan(0);
    expect(renderer.inspect().volumetricFog?.status).toBe('available');
    expect(renderer.inspect().temporal.mode).toBe('fxaa');
    expect(world.getResource(Time).elapsed).toBeGreaterThan(1);
    world.set(light, PointLight, { intensity: 0 }).unwrap();
    const unlit = await frame(true);
    const lightSignal = difference(reset.pixels, unlit);
    // biome-ignore lint/suspicious/noConsole: bounded CI pixel and timing evidence
    console.info(
      '[fog-stability]',
      JSON.stringify({
        accumulated: accumulated.meanDelta,
        reset: reset.meanDelta,
        lightSignal,
        durationMs: performance.now() - started,
      }),
    );
    expect(errors).toEqual([]);
    expect(lightSignal).toBeGreaterThan(0.03);
    expect(lightSignal).toBeLessThan(0.8);
    expect(reset.meanDelta).toBeLessThan(0.005);
    expect(
      accumulated.meanDelta,
      JSON.stringify({ normal: accumulated.meanDelta, reset: reset.meanDelta }),
    ).toBeLessThan(0.005);

    // A light edit must reject old scattering immediately (no long-lived ghost).
    expect(difference(unlit, new Uint8ClampedArray(unlit.length))).toBeLessThan(0.005);
  } finally {
    await renderer.dispose();
    world.despawn(fog).unwrap();
    world.despawn(backdrop).unwrap();
    world.sharedRefs.release(mesh).unwrap();
    world.sharedRefs.release(material).unwrap();
    world.sharedRefs.release(density).unwrap();
    await scene.fiber.dispose();
    canvas.remove();
  }
}, 60_000);
