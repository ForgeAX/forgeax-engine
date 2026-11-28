import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  ANTIALIAS_TAA,
  Camera,
  Materials,
  MeshFilter,
  MeshRenderer,
  ScreenSpaceReflection,
  Skylight,
  TONEMAP_LINEAR,
} from '@forgeax/engine-render';
import { renderGraphCompileCount, renderOrderedViewBindCount } from '@forgeax/engine-render-graph';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import {
  countRgbDifferences,
  createBarrelRendererFixture,
  readBarrelPixels,
} from './barrel-distortion-gpu-fixture';
import { testAssets } from './helpers/runtime-assets';

it('runs Forward and Deferred screen reflections without rebuilding the graph during view edits', {
  timeout: 90_000,
}, async () => {
  const width = 97;
  const height = 65;
  const identity = 'fixture:ordered-ssr';
  const fixture = await createBarrelRendererFixture({
    width,
    height,
    ssrIdentity: {
      sourceHead: identity,
      sourceTree: identity,
      lockSha256: identity,
      buildSha256: identity,
    },
  });
  const { renderer, device } = fixture;
  const world = new World();
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  try {
    const source = renderer.attach(world).unwrap();
    const assets = testAssets(world);
    const floor = assets
      .create(
        Materials.standard({ baseColor: [0.08, 0.08, 0.08, 1], metallic: 1, roughness: 0.08 }),
      )
      .unwrap();
    const pillar = assets
      .create(
        Materials.standard({
          baseColor: [0.8, 0.05, 0.02, 1],
          emissive: [1, 0.04, 0.01],
          emissiveIntensity: 3,
          roughness: 0.6,
        }),
      )
      .unwrap();
    for (const [size, pos, material] of [
      [[12, 0.1, 12], [0, -0.05, -2], floor],
      [[1, 2, 1], [0, 1, -2], pillar],
    ] as const) {
      const mesh = assets.create(createBoxGeometry(...size).unwrap()).unwrap();
      world
        .spawn(
          { component: Transform, data: { pos } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap();
    }
    world.spawn({ component: Skylight, data: { intensity: 0.1 } }).unwrap();
    const camera = world
      .spawn(
        {
          component: Transform,
          data: { pos: [0, 1.2, 5], quat: [Math.sin(-0.1), 0, 0, Math.cos(-0.1)] },
        },
        {
          component: Camera,
          data: {
            near: 0.1,
            far: 30,
            fov: Math.PI / 3,
            aspect: width / height,
            tonemap: TONEMAP_LINEAR,
            antialias: 0,
            clearColor: [0.002, 0.002, 0.002, 1],
          },
        },
      )
      .unwrap();
    const draw = async () => {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      const receipt = await drawReadyFrame(renderer, { source, geometryLane: 'direct' });
      expect(receipt.presentation).toBe('ready');
      expect(errors).toEqual([]);
      return receipt;
    };
    const pixels = () => readBarrelPixels(device, fixture.renderTarget, width, height);
    const original = renderer.inspect().profile;
    for (const renderPath of ['forward', 'deferred'] as const) {
      renderer
        .setProfile({ ...original, renderPath, ambientOcclusion: { enabled: false } })
        .unwrap();
      world.set(camera, Camera, { antialias: 0 }).unwrap();
      world.set(camera, Transform, { pos: [0, 1.2, 5] }).unwrap();
      await draw();
      const baseline = await pixels();
      const compile = renderGraphCompileCount();
      const bind = renderOrderedViewBindCount();
      world
        .addComponent(camera, {
          component: ScreenSpaceReflection,
          data: { maxDistance: 12, thickness: 0.2, maxRoughness: 0.65 },
        })
        .unwrap();
      await draw();
      const reflective = await draw();
      expect(renderer.inspect({ fields: ['ssr'] }).ssr.status).toBe('admitted');
      expect(renderOrderedViewBindCount() - bind).toBeGreaterThan(0);
      expect(renderGraphCompileCount() - compile).toBe(renderOrderedViewBindCount() - bind);
      expect(countRgbDifferences(baseline, await pixels()), renderPath).toBeGreaterThan(20);
      const steadyBind = renderOrderedViewBindCount();
      for (const x of [0.05, 0.12, 0.2]) {
        world.set(camera, Transform, { pos: [x, 1.2, 5] }).unwrap();
        world.set(camera, ScreenSpaceReflection, { thickness: 0.2 + x }).unwrap();
        expect((await draw()).graphGeneration).toBe(reflective.graphGeneration);
      }
      expect(renderOrderedViewBindCount()).toBe(steadyBind);

      world.set(camera, Camera, { antialias: ANTIALIAS_TAA }).unwrap();
      await draw();
      const temporal = await draw();
      expect(renderer.inspect({ fields: ['ssr'] }).ssr.status).toBe('admitted');
      world.set(camera, Transform, { pos: [0.3, 1.2, 5] }).unwrap();
      expect((await draw()).graphGeneration).toBe(temporal.graphGeneration);

      fixture.canvas.width = width + 14;
      fixture.canvas.height = height + 8;
      const resized = await draw();
      expect(resized.graphGeneration).not.toBe(temporal.graphGeneration);
      expect(fixture.renderTarget.width).toBe(width + 14);
      expect(fixture.renderTarget.height).toBe(height + 8);
      expect((await draw()).graphGeneration).toBe(resized.graphGeneration);
      fixture.canvas.width = width;
      fixture.canvas.height = height;

      world.removeComponent(camera, ScreenSpaceReflection).unwrap();
      world.set(camera, Camera, { antialias: 0 }).unwrap();
      world.set(camera, Transform, { pos: [0, 1.2, 5] }).unwrap();
      await draw();
      expect(renderer.inspect({ fields: ['ssr'] }).ssr.status).toBe('not-requested');
      expect(countRgbDifferences(baseline, await pixels())).toBe(0);
      expect(renderGraphCompileCount() - compile).toBe(renderOrderedViewBindCount() - bind);
    }
  } finally {
    unsubscribe();
    renderer.dispose();
    device.destroy();
  }
});
