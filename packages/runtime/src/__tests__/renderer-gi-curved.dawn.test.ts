import { Materials } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { sceneSphere } from './gi-scene-curved.fixture';
import {
  channelMeans,
  percentile,
  SCENE_ENVIRONMENT,
  SCENE_HEIGHT,
  SCENE_WIDTH,
  sceneGi,
  sceneHarness,
  visibleSupport,
} from './gi-scenes.fixture';
import { testAssets } from './helpers/runtime-assets';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifest = shaderManifestUrl(await buildEngineShaderManifest());
const color = [0.3, 0.65, 0.12] as const;
const mesh = await sceneSphere();

for (const mode of ['field', 'screen'] as const)
  for (const shape of ['sphere', 'ellipsoid'] as const) {
    it(`preserves colored constant incident radiance on a convex ${shape} ${mode}`, {
      timeout: 600_000,
    }, async () => {
      const h = await sceneHarness(manifest, `curved-${shape}-${mode}`);
      try {
        const handle = testAssets(h.world).create(mesh).unwrap();
        const material = await h.publish(
          Materials.standard({ baseColor: [...color, 1], roughness: 1, specular: 0 }),
        );
        const entity = h.spawn(handle, material, [0, 0, -3]);
        if (shape === 'ellipsoid')
          h.world
            .set(entity, Transform, {
              scale: [1.25, 0.7, 0.8],
              quat: [0, 0, Math.sin(0.3), Math.cos(0.3)],
            })
            .unwrap();
        h.setGi(undefined);
        await h.draw();
        await h.image('direct');
        h.setGi(sceneGi(mode));
        await h.settle(96);
        const image = await h.image('gi');
        // These rays pass through the interior of a radius-0.5 ball contained in
        // both convex shapes. The mask is independent of shading and support.
        const pixels: number[] = [];
        for (let y = 0; y < SCENE_HEIGHT; y++)
          for (let x = 0; x < SCENE_WIDTH; x++) {
            const px = (((x + 0.5) / SCENE_WIDTH) * 2 - 1) * Math.tan(Math.PI / 6) * 1.5 * 3;
            const py = (1 - ((y + 0.5) / SCENE_HEIGHT) * 2) * Math.tan(Math.PI / 6) * 3;
            if (px * px + py * py < 0.45 ** 2) pixels.push(y * SCENE_WIDTH + x);
          }
        const expected = color.map((v, c) => v * (SCENE_ENVIRONMENT[c] ?? NaN));
        const observed = channelMeans(image, pixels);
        const relative = observed.map(
          (v, c) => Math.abs(v - (expected[c] ?? NaN)) / (expected[c] ?? NaN),
        );
        const pixelP95 = expected.map((v, c) =>
          percentile(
            pixels.map((p) => Math.abs((image.rgb[p * 3 + c] ?? NaN) - v) / v),
            0.95,
          ),
        );
        const unsupportedFraction =
          pixels.filter((p) => !((image.support?.[p] ?? NaN) > 0.99)).length / pixels.length;
        h.save('result.json', {
          visibleSupport: visibleSupport(image),
          mode,
          shape,
          pixels: pixels.length,
          expected,
          observed,
          relative,
          pixelP95,
          unsupportedFraction,
          oracle:
            'Isolated convex Lambertian receiver under constant radiance: rho*L, independent of interpolated normals and rigid/nonuniform transforms',
          tolerance: { channelRelative: 0.05, pixelP95: 0.08 },
        });
        expect(unsupportedFraction).toBe(0);
        expect(visibleSupport(image).missing).toBe(0);
        for (const v of relative) expect(v).toBeLessThan(0.05);
        for (const v of pixelP95) expect(v).toBeLessThan(0.08);
        expect(h.errors).toEqual([]);
      } catch (error) {
        await h.recordFailure(error);
        throw error;
      } finally {
        await h.dispose();
      }
    });
  }
