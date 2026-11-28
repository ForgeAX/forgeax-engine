import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import {
  ANTIALIAS_MSAA,
  ANTIALIAS_NONE,
  ANTIALIAS_TAA,
  ANTIALIAS_TSR,
  Camera,
  DEFAULT_STANDARD_PROFILE,
  DepthOfField,
  DepthOfFieldSideValue,
  Materials,
  MeshFilter,
  MeshRenderer,
  TONEMAP_NONE,
} from '@forgeax/engine-render';
import { renderGraphCompileCount, renderOrderedViewBindCount } from '@forgeax/engine-render-graph';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import {
  createBarrelRendererFixture,
  maxRgbDelta,
  pixelOffset,
  readBarrelPixels,
} from './barrel-distortion-gpu-fixture';
import { createDepthOfFieldScene } from './depth-of-field-scene.fixture';
import { drawPublished } from './draw-published';
import { testAssets } from './helpers/runtime-assets';

it('preserves color through DoF attachment topology changes and component removal', async () => {
  const width = 129;
  const height = 73;
  const fixture = await createBarrelRendererFixture({ width, height });
  const profile = { ...fixture.renderer.inspect().profile, renderPath: 'forward' as const };
  const profileResult = fixture.renderer.setProfile(profile);
  if (!profileResult.ok) throw profileResult.error;
  const world = new World();
  const releaseTransforms = registerPropagateTransforms(world);
  try {
    const material = testAssets(world)
      .create(Materials.unlit([0.8, 0.2, 0.1, 1]))
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0], scale: [100, 100, 1] } },
        {
          component: MeshFilter,
          data: {
            assetHandle: testAssets(world).create(createPrimitiveMesh('cube').unwrap()).unwrap(),
          },
        },
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
      (await drawPublished(fixture.renderer, world)).unwrap();
      await fixture.device.queue.onSubmittedWorkDone();
      return readBarrelPixels(fixture.device, fixture.renderTarget, width, height);
    };
    const constructions = renderGraphCompileCount();
    const direct = renderOrderedViewBindCount();
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
        passCount: side === 'both' ? 6 : 5,
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
    expect(renderOrderedViewBindCount() - direct).toBeGreaterThanOrEqual(6);
    expect(renderGraphCompileCount() - constructions).toBe(renderOrderedViewBindCount() - direct);
  } finally {
    releaseTransforms();
    await fixture.renderer.dispose();
  }
}, 60_000);

it('gathers a foreground circle across a tile boundary into a focal surface', async () => {
  const width = 129;
  const height = 73;
  const fixture = await createBarrelRendererFixture({ width, height });
  const { world, camera } = createDepthOfFieldScene(width, height, ANTIALIAS_NONE, 1);
  const releaseTransforms = registerPropagateTransforms(world);
  try {
    const assets = testAssets(world);
    const mesh = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
    for (const [pos, scale, color] of [
      [
        [0, 0, 0],
        [100, 100, 0.02],
        [0.8, 0.1, 0.02, 1],
      ],
      [
        [-0.083, 0, 3.33],
        [0.0625, 0.35, 0.05],
        [0.02, 0.9, 0.05, 1],
      ],
    ] as const) {
      world
        .spawn(
          { component: Transform, data: { pos, scale } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          {
            component: MeshRenderer,
            data: { materials: [assets.create(Materials.unlit(color)).unwrap()] },
          },
        )
        .unwrap();
    }
    const read = async () => {
      (await drawPublished(fixture.renderer, world)).unwrap();
      return readBarrelPixels(fixture.device, fixture.renderTarget, width, height);
    };
    const sharp = await read();
    // The near strip ends before x=64. The tile on the other side sees only
    // the focused plane in its CoC inputs and needs the source tile's reach.
    const source = pixelOffset(57, 36, width);
    const boundary = pixelOffset(64, 36, width);
    const distant = pixelOffset(112, 36, width);
    expect(sharp[source + 1]).toBeGreaterThan(200);
    expect(sharp[boundary + 1]).toBeLessThan(100);
    world
      .addComponent(camera, {
        component: DepthOfField,
        data: {
          focusDistance: 3.99,
          fStop: 0.7,
          sensorHeight: 0.24,
          maxRadiusPixels: 10,
          blurSide: DepthOfFieldSideValue.near,
        },
      })
      .unwrap();
    const blurred = await read();
    expect(blurred[boundary + 1]).toBeGreaterThan((sharp[boundary + 1] ?? 0) + 4);
    expect(blurred.slice(distant, distant + 4)).toEqual(sharp.slice(distant, distant + 4));
  } finally {
    releaseTransforms();
    await fixture.renderer.dispose();
  }
}, 60_000);

// Reverse-Z clears depth to 0. That cleared background is the far plane, a
// real far-field destination: a defocused far object must spread its circle
// past its silhouette instead of stopping at the depth discontinuity.
it.each([
  { renderPath: 'forward', antialias: ANTIALIAS_NONE, scale: 1, name: 'without AA' },
  { renderPath: 'forward', antialias: ANTIALIAS_MSAA, scale: 1, name: '4x MSAA' },
  ...(['forward', 'deferred'] as const).flatMap((renderPath) => [
    { renderPath, antialias: ANTIALIAS_TAA, scale: 1, name: 'TAA' },
    { renderPath, antialias: ANTIALIAS_TAA, scale: 0.5, name: 'TAAU' },
    { renderPath, antialias: ANTIALIAS_TSR, scale: 0.5, name: 'TSR' },
  ]),
] as const)('spreads a defocused far silhouette before $name ($renderPath)', async ({
  renderPath,
  antialias,
  scale,
}) => {
  const width = 129;
  const height = 73;
  const fixture = await createBarrelRendererFixture({
    width,
    height,
    standardProfile: {
      ...DEFAULT_STANDARD_PROFILE,
      renderPath,
      ambientOcclusion: { enabled: false },
    },
  });
  const { world, camera } = createDepthOfFieldScene(width, height, antialias, scale);
  const releaseTransforms = registerPropagateTransforms(world);
  const totalBefore = renderGraphCompileCount();
  const directBefore = renderOrderedViewBindCount();
  try {
    const read = async () => {
      (await drawPublished(fixture.renderer, world)).unwrap();
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
    const inspection = fixture.renderer.inspect();
    if (antialias === ANTIALIAS_TAA || antialias === ANTIALIAS_TSR) {
      const passes = inspection.perFramePassNames;
      const dof = passes.indexOf('dof-composite');
      const resolve = passes.indexOf(antialias === ANTIALIAS_TSR ? 'tsr-analyze' : 'taa-resolve');
      expect(dof).toBeGreaterThanOrEqual(0);
      expect(resolve).toBeGreaterThan(dof);
    }
    expect(inspection.depthOfField).toMatchObject({
      status: 'active',
      outputExtent: scale < 1 ? { width: 64, height: 32 } : { width, height },
      workExtent: scale < 1 ? { width: 32, height: 16 } : { width: 65, height: 37 },
    });
    expect(blurred[outside]).toBeGreaterThan(10);
    expect(blurred[inside]).toBeGreaterThan(100);

    // The front face is 9.5 m from the camera. After changing focus, its
    // old blur should leave the history while the camera is in motion.
    world.set(camera, DepthOfField, { focusDistance: 9.5 }).unwrap();
    for (let frame = 0; frame < 8; frame++) {
      world.set(camera, Transform, { pos: [frame * 0.015, 0, 4] }).unwrap();
      (await drawPublished(fixture.renderer, world)).unwrap();
    }
    const refocused = await read();
    expect(refocused[outside]).toBeLessThanOrEqual(8);
    expect(refocused[inside]).toBeGreaterThan(100);
    if (antialias === ANTIALIAS_TAA || antialias === ANTIALIAS_TSR) {
      expect(renderOrderedViewBindCount() - directBefore).toBeGreaterThan(0);
      expect(renderGraphCompileCount() - totalBefore).toBe(
        renderOrderedViewBindCount() - directBefore,
      );
    }
  } finally {
    releaseTransforms();
    await fixture.renderer.dispose();
  }
}, 60_000);

// UE runs DiaphragmDOF on the pre-TSR scene color (PostProcessing.cpp), so TSR resolves the blur.
it('blurs before the TSR resolve and keeps the blur through it', async () => {
  const width = 129;
  const height = 73;
  const fixture = await createBarrelRendererFixture({ width, height });
  const world = new World();
  const releaseTransforms = registerPropagateTransforms(world);
  try {
    const material = testAssets(world)
      .create(Materials.unlit([0.8, 0.2, 0.1, 1]))
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, -6], scale: [4, 4, 1] } },
        {
          component: MeshFilter,
          data: {
            assetHandle: testAssets(world).create(createPrimitiveMesh('cube').unwrap()).unwrap(),
          },
        },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: Camera,
          data: {
            fov: Math.PI / 3,
            aspect: width / height,
            near: 0.1,
            far: 100,
            antialias: ANTIALIAS_TSR,
            tonemap: TONEMAP_NONE,
            clearColor: [0, 0, 0, 1],
          },
        },
        {
          component: DepthOfField,
          data: {
            focusDistance: 1,
            fStop: 0.7,
            sensorHeight: 0.24,
            maxRadiusPixels: 10,
            blurSide: DepthOfFieldSideValue.far,
          },
        },
      )
      .unwrap();
    let pixels = new Uint8Array();
    for (let i = 0; i < 6; i++) {
      (await drawPublished(fixture.renderer, world)).unwrap();
      await fixture.device.queue.onSubmittedWorkDone();
      pixels = await readBarrelPixels(fixture.device, fixture.renderTarget, width, height);
    }
    const names = fixture.renderer.inspect().perFramePassNames;
    const focus = names.indexOf('dof-composite');
    const resolve = names.indexOf('tsr-analyze');
    expect(focus).toBeGreaterThan(-1);
    expect(resolve).toBeGreaterThan(focus);
    // The cube spans roughly x 51..77 on the center row; x 80 is cleared background.
    expect(pixels[pixelOffset(80, 36, width)]).toBeGreaterThan(10);
    expect(pixels[pixelOffset(64, 36, width)]).toBeGreaterThan(100);
  } finally {
    releaseTransforms();
    await fixture.renderer.dispose();
  }
}, 60_000);
