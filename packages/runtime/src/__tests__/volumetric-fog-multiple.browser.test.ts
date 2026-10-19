import { createWorldContext, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  VolumetricFog,
  VolumetricFogSamplingValue,
} from '@forgeax/engine-render';
import { propagateTransforms, scenePlugin, Transform } from '@forgeax/engine-scene';
import type { TextureAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { page } from 'vitest/browser';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { createRenderer } from '../createRenderer';

it('renders overlapping local fog, independently removes owners, and retires the collection', async () => {
  const lightweight = import.meta.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1';
  const retirementCycles = lightweight ? 3 : 12;
  const retirementFrames = lightweight ? 8 : 25;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  canvas.style.cssText = 'width:128px;height:128px';
  document.body.append(canvas);
  const renderer = (
    await createRenderer(canvas, {}, { shaderManifestUrl: '/shaders/manifest.json' })
  ).unwrap();
  const errors: unknown[] = [];
  const off = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const world = new World();
  const scene = await createWorldContext(world, [scenePlugin()]);
  try {
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3.4] } },
        {
          component: Camera,
          data: {
            fov: 0.9,
            aspect: 1,
            near: 0.03,
            far: 20,
            tonemap: 1,
            clearColor: [0.12, 0.12, 0.12, 1],
          },
        },
      )
      .unwrap();
    const light = world
      .spawn({
        component: DirectionalLight,
        data: {
          castShadow: true,
          mapSize: testQuality.shadowMapSize,
          cascadeCount: testQuality.cascadeCount,
          direction: [0, -1, -1],
          intensity: 1,
        },
      })
      .unwrap();
    const size = 32;
    const data = new Uint8Array(size ** 3);
    for (let z = 0; z < size; z++)
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const radius = Math.hypot(
            ((x + 0.5) / size) * 2 - 1,
            ((y + 0.5) / size) * 2 - 1,
            ((z + 0.5) / size) * 2 - 1,
          );
          data[(z * size + y) * size + x] = Math.round(255 * Math.max(0, 1 - radius) ** 0.6);
        }
    const texture: TextureAsset = {
      kind: 'texture',
      shape: { viewDimension: '3d', extent: { width: size, height: size, depth: size } },
      format: 'r8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data,
    };
    const density = world.allocSharedRef('TextureAsset', texture);
    const coloredBytes = new Uint8Array(data.length * 4);
    for (let index = 0; index < data.length; index++) {
      const value = data[index] ?? 0;
      coloredBytes.set([Math.round(value / 4), Math.round(value / 2), value, value], index * 4);
    }
    const coloredDensity = world.allocSharedRef('TextureAsset', {
      ...texture,
      format: 'rgba8unorm',
      data: coloredBytes,
    } satisfies TextureAsset);
    const spawn = (x: number, emission: readonly number[], extinction = 2, colored = false) =>
      world
        .spawn({
          component: VolumetricFog,
          data: {
            light,
            density: colored ? coloredDensity : density,
            sampling: colored
              ? VolumetricFogSamplingValue.densityAlbedo
              : VolumetricFogSamplingValue.density,
            boundsMin: [x - 0.9, -0.9, -0.6],
            boundsMax: [x + 0.9, 0.9, 1.2],
            extinction: [extinction, extinction, extinction],
            albedo: [0.25, 0.25, 0.25],
            emission,
            maxDistance: 20,
          },
        })
        .unwrap();
    const left = spawn(-0.4, [0.8, 0.08, 0.01]);
    const right = spawn(0.4, [0.01, 0.1, 0.8], 2, true);
    const additional = Array.from({ length: 7 }, (_, index) =>
      spawn((index - 3) * 0.175, [0.04, 0.12, 0.02], 0.15, index % 2 === 0),
    );
    const mesh = world.allocSharedRef('MeshAsset', createBoxGeometry(0.12, 1.7, 0.15).unwrap());
    const material = world.allocSharedRef('MaterialAsset', Materials.unlit([0.8, 0.8, 0.8, 1]));
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 1.3] } },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    const lease = attached.value;
    const draw = async () => {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      const drawn = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
      if (!drawn.ok) throw drawn.error;
      const completed = await drawn.value.completed;
      if (!completed.ok) throw completed.error;
    };
    for (let index = 0; index < 12; index++) await draw();
    expect(renderer.inspect().volumetricFog?.ownerCount).toBe(9);
    const nine = await page
      .elementLocator(canvas)
      .screenshot({ path: 'volume-multiple-nine.png', base64: true });
    for (const owner of additional) world.despawn(owner).unwrap();
    for (let index = 0; index < 12; index++) await draw();
    expect(renderer.inspect().volumetricFog).toMatchObject({
      status: 'available',
      ownerCount: 2,
      passCount: 4,
    });
    const both = await page
      .elementLocator(canvas)
      .screenshot({ path: 'volume-multiple-both.png', base64: true });
    expect(both).not.toEqual(nine);
    world.despawn(right).unwrap();
    for (let index = 0; index < 12; index++) await draw();
    expect(renderer.inspect().volumetricFog?.ownerCount).toBe(1);
    const one = await page
      .elementLocator(canvas)
      .screenshot({ path: 'volume-multiple-one.png', base64: true });
    expect(one).not.toEqual(both);
    world.despawn(left).unwrap();
    await draw();
    expect(renderer.inspect().volumetricFog).toMatchObject({ status: 'off', ownerCount: 0 });
    const clear = await page
      .elementLocator(canvas)
      .screenshot({ path: 'volume-multiple-clear.png', base64: true });
    expect(clear).not.toEqual(one);
    for (let index = 0; index < retirementCycles; index++) {
      const a = spawn(-0.4, [0.8, 0.08, 0.01]);
      const b = spawn(0.4, [0.01, 0.1, 0.8], 2, true);
      for (let frame = 0; frame < retirementFrames; frame++) await draw();
      expect(renderer.inspect().volumetricFog?.ownerCount).toBe(2);
      world.despawn(a).unwrap();
      world.despawn(b).unwrap();
      await draw();
      expect(renderer.inspect().volumetricFog).toMatchObject({
        status: 'off',
        ownerCount: 0,
        memoryBytes: 0,
      });
    }
    expect(errors).toEqual([]);
  } finally {
    off();
    await renderer.dispose();
    await scene.fiber.dispose();
    canvas.remove();
  }
}, 600_000);
