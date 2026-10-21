import { createWorldContext, FixedTime, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  ANTIALIAS_NONE,
  Camera,
  DirectionalLight,
  DirectionalShadowFilterValue,
  Materials,
  MeshFilter,
  MeshRenderer,
  Skylight,
} from '@forgeax/engine-render';
import { propagateTransforms, scenePlugin, Transform } from '@forgeax/engine-scene';
import { assert, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { createRenderer } from '../createRenderer';
import { testAssets } from './helpers/runtime-assets';
import { renderValue } from './standard-gbuffer-replay.fixture';

const filters = ['pcf1', 'pcf3', 'pcf5', 'pcssHigh'] as const;

export function registerShadowContactCases(scene: 'column' | 'centimeter', mapSize: 1024 | 2048) {
  it.each(
    filters.map((filter) => ({ filter, scene, mapSize })),
  )('keeps $scene $filter/$mapSize shadows attached without shadowing unobstructed ground', async ({
    filter,
    scene,
    mapSize,
  }) => {
    await page.viewport(800, 800);
    const small = scene === 'centimeter';
    const cameraY = small ? 0.22 : 2.5;
    const fov = small ? Math.PI / 2 : Math.PI / 4;
    // An exact unit-depth pose makes the 5 cm caster land on a single depth
    // tie in Chrome/lavapipe. Keep the near-field sweep asymmetric so the
    // oracle exercises camera motion without depending on that raster boundary.
    const cameraPositions = small ? ([1.2, 1.03, 0.8] as const) : ([14, 12, 10] as const);
    // Read back the backing store rather than the clipped iframe viewport. CI's
    // 320x180 outer browser can crop an element screenshot, which would remap
    // the projected receiver samples and turn a valid contact shadow into a
    // false detachment. `toDataURL` preserves the 640px backing image.
    const canvasSize = 640;
    const canvas = document.createElement('canvas');
    canvas.width = canvasSize;
    canvas.height = canvasSize;
    canvas.style.width = `${canvasSize}px`;
    canvas.style.height = `${canvasSize}px`;
    document.body.append(canvas);
    const renderer = (
      await createRenderer(canvas, {}, { shaderManifestUrl: '/shaders/manifest.json' })
    ).unwrap();
    const world = new World();
    const context = await createWorldContext(world, [scenePlugin()]);
    const material = testAssets(world)
      .create(Materials.standard({ baseColor: [0.6, 0.6, 0.6, 1], roughness: 1 }))
      .unwrap();
    const floor = testAssets(world)
      .create(createBoxGeometry(small ? 2 : 12, 0.2, small ? 2 : 12).unwrap())
      .unwrap();
    const column = testAssets(world)
      .create(createBoxGeometry(small ? 0.05 : 1, small ? 0.05 : 3, small ? 0.05 : 1).unwrap())
      .unwrap();
    for (const [mesh, pos] of [
      [floor, [0, -0.1, 0]],
      [column, [0, small ? 0.025 : 1.5, 0]],
    ] as const)
      world
        .spawn(
          { component: Transform, data: { pos } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap();
    const sun = world
      .spawn({
        component: DirectionalLight,
        data: {
          castShadow: true,
          direction: small ? [0.7, -0.65, 0.3] : [0.18, -0.18, 1],
          intensity: 4,
          shadowFilter: DirectionalShadowFilterValue[filter],
          mapSize,
          // Keep the receiver/filter oracle's established world-texel footprint;
          // default cascade distribution is covered by the component contract.
          cascadeCount: small ? 2 : 4,
          splitLambda: 0.75,
          ...(small
            ? {
                normalBias: 0.01,
                depthBias: 0.00001,
                shadowDistance: 35,
              }
            : {}),
        },
      })
      .unwrap();
    world.spawn({ component: Skylight, data: { color: [1, 1, 1], intensity: 0.1 } }).unwrap();
    const camera = world
      .spawn(
        {
          component: Transform,
          data: { pos: [0, cameraY, cameraPositions[0]], quat: [0, 0, 0, 1] },
        },
        {
          component: Camera,
          data: { fov, aspect: 1, near: 0.1, far: 160, antialias: ANTIALIAS_NONE },
        },
      )
      .unwrap();
    const lease = renderValue(renderer.attach(world));
    const capture = async (_label: string) => {
      for (let frame = 0; frame < 3; frame++) {
        world.update(1 / 60).unwrap();
        propagateTransforms(world).unwrap();
        await drawReadyFrame(renderer, {
          leases: [lease],
          camera: { lease },
          environment: { lease },
          fixedStep: world.getResource(FixedTime).tick,
        });
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const dataUrl = canvas.toDataURL('image/png');
      const bytes = Uint8Array.from(atob(dataUrl.split(',', 2)[1] ?? ''), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const output = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = output.getContext('2d');
      assert(ctx);
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      return ctx.getImageData(0, 0, output.width, output.height);
    };
    const projectReceiver = (data: ImageData, x: number, z: number, cameraZ: number) => {
      // Fixed identity camera: project the known y=0 receiver points, not a guessed screen crop.
      const focal = 1 / Math.tan(fov / 2);
      const px = Math.round((0.5 + ((x * focal) / (cameraZ - z)) * 0.5) * data.width);
      const py = Math.round((0.5 + ((cameraY * focal) / (cameraZ - z)) * 0.5) * data.height);
      return { px, py };
    };
    const lumaAt = (data: ImageData, px: number, py: number) => {
      let sum = 0;
      let samples = 0;
      for (let y = py - 1; y <= py + 1; y++)
        for (let xx = px - 1; xx <= px + 1; xx++) {
          if (xx < 0 || y < 0 || xx >= data.width || y >= data.height) continue;
          const i = (y * data.width + xx) * 4;
          sum +=
            ((data.data[i] ?? Number.NaN) +
              (data.data[i + 1] ?? Number.NaN) +
              (data.data[i + 2] ?? Number.NaN)) /
            3;
          samples += 1;
        }
      return samples > 0 ? sum / samples : Number.NaN;
    };
    const luma = (data: ImageData, x: number, z: number, cameraZ: number) => {
      const { px, py } = projectReceiver(data, x, z, cameraZ);
      return lumaAt(data, px, py);
    };
    const contactRatioNear = (
      shadow: ImageData,
      unshadowed: ImageData,
      x: number,
      z: number,
      cameraZ: number,
    ) => {
      const { px, py } = projectReceiver(shadow, x, z, cameraZ);
      const radius = small ? 8 : 2;
      let best = Number.POSITIVE_INFINITY;
      let litSamples = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const lit = lumaAt(unshadowed, px + dx, py + dy);
          if (!(lit > 20)) continue;
          litSamples += 1;
          best = Math.min(best, lumaAt(shadow, px + dx, py + dy) / lit);
        }
      }
      return { ratio: best, litSamples };
    };
    try {
      // Translate the same camera across the first cascade boundary without changing the light.
      for (const cameraZ of cameraPositions) {
        world.set(camera, Transform, { pos: [0, cameraY, cameraZ] }).unwrap();
        world.set(sun, DirectionalLight, { castShadow: true }).unwrap();
        const shadow = await capture(`camera-${cameraZ}-shadow`);
        world.set(sun, DirectionalLight, { castShadow: false }).unwrap();
        const unshadowed = await capture(`camera-${cameraZ}-disabled`);
        // Sample the interior of the caster's projected contact patch. Keeping
        // this point away from the 5 cm box edge avoids a single raster sample
        // deciding the oracle on software and hardware depth backends.
        const contactX = small ? 0.03 : 0.1;
        const contactZ = small ? 0.018 : 0.75;
        const contact = contactRatioNear(shadow, unshadowed, contactX, contactZ, cameraZ);
        const contactRatio = contact.ratio;
        const xs = small
          ? Array.from({ length: 21 }, (_, i) => -0.2 + i * 0.02).filter((x) => Math.abs(x) > 0.1)
          : [-2, -1.5, 1.5, 2];
        const zs = small ? Array.from({ length: 21 }, (_, i) => -0.3 + i * 0.02) : [-3, 0, 3];
        const clearRatios = xs.flatMap((x) =>
          zs.map((z) => luma(shadow, x, z, cameraZ) / luma(unshadowed, x, z, cameraZ)),
        );
        // biome-ignore lint/suspicious/noConsole: numeric evidence distinguishes acne and detachment.
        console.info(
          '[shadow-contact]',
          JSON.stringify({
            scene,
            filter,
            mapSize,
            cameraZ,
            contactRatio,
            contactLitSamples: contact.litSamples,
            minClearRatio: Math.min(...clearRatios),
          }),
        );
        expect(luma(unshadowed, contactX, contactZ, cameraZ)).toBeGreaterThan(20);
        expect(contactRatio).toBeLessThan(small ? 0.9 : 0.8);
        expect(Math.min(...clearRatios)).toBeGreaterThan(0.95);
      }
    } finally {
      await renderer.dispose();
      await context.fiber.dispose();
      canvas.remove();
    }
  }, 120000);
}
