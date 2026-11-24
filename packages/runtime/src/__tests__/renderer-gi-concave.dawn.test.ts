import { Materials } from '@forgeax/engine-render';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { type Point3, polygonFormFactor, quadraturePolygon } from './gi-scene-area.fixture';
import {
  aperturePolygon,
  CONCAVE_BARS,
  CONCAVE_SOURCE,
  concaveFrame,
} from './gi-scene-concave.fixture';
import { sceneValue } from './gi-scene-value.fixture';
import {
  averageFrames,
  channelMeans,
  percentile,
  SCENE_HEIGHT,
  SCENE_WIDTH,
  sceneGi,
  sceneHarness,
  visibleSupport,
} from './gi-scenes.fixture';
import { testAssets } from './helpers/runtime-assets';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifest = shaderManifestUrl(await buildEngineShaderManifest());
const mesh = await concaveFrame();
const receivers: { pixel: number; point: Point3 }[] = [];
for (let y = 0; y < SCENE_HEIGHT; y++)
  for (let x = 0; x < SCENE_WIDTH; x++) {
    const wx =
      (((((x + 0.5) / SCENE_WIDTH) * 2 - 1) * Math.tan(Math.PI / 6) * SCENE_WIDTH) / SCENE_HEIGHT) *
      2.875;
    const wy = (1 - ((y + 0.5) / SCENE_HEIGHT) * 2) * Math.tan(Math.PI / 6) * 2.875;
    if (Math.abs(wx) < 0.65 && Math.abs(wy) < 0.65)
      receivers.push({ pixel: y * SCENE_WIDTH + x, point: [wx, wy, -2.875] });
  }
const oracle = receivers.map((r) => {
  const polygon = aperturePolygon(r.point);
  return {
    ...r,
    polygon,
    coarse: quadraturePolygon(r.point, [0, 0, 1], polygon, 32),
    fine: quadraturePolygon(r.point, [0, 0, 1], polygon, 64),
    exact: polygonFormFactor(r.point, [0, 0, 1], polygon),
  };
});

for (const mode of ['field', 'screen'] as const) {
  it(`preserves source visibility through the real hole of one concave mesh ${mode}`, {
    timeout: 600_000,
  }, async () => {
    const h = await sceneHarness(manifest, `concave-hole-${mode}`);
    try {
      h.spawn(await h.slab(6, 6, 0.25), h.white, [0, 0, -3]);
      const black = await h.publish(
        Materials.standard({ baseColor: [0, 0, 0, 1], roughness: 1, specular: 0 }),
      );
      h.spawn(testAssets(h.world).create(mesh).unwrap(), black, [0, 0, 0]);
      const source = await h.publish(
        Materials.standard({
          baseColor: [0, 0, 0, 1],
          roughness: 1,
          specular: 0,
          emissive: [...CONCAVE_SOURCE.radiance],
          emissiveIntensity: 1,
        }),
      );
      h.spawn(await h.slab(4, 4, 0.25), source, [0, 0, 0.775]);
      const gi = sceneGi(mode, {
        environment: [0, 0, 0],
        raysPerProbe: 256,
        probeSpacing: 0.5,
        probeBudget: 4096,
      });
      h.setGi({
        ...gi,
        field: {
          ...gi.field,
          region: {
            ...gi.field.region,
            maxFieldBytes: 4 * 1024 * 1024,
            grid: {
              ...gi.field.region.grid,
              origin: [-4, -4, -4] as const,
              dimensions: [33, 33, 25] as const,
              spacing: 0.25,
            },
          },
        },
      });
      await h.settle(96);
      const image = await averageFrames(h, 'gi', 8),
        pixels = receivers.map((r) => r.pixel);
      const rgb = new Float32Array(image.rgb.length).fill(NaN);
      for (const r of oracle)
        for (let c = 0; c < 3; c++)
          rgb[r.pixel * 3 + c] = r.exact * sceneValue(CONCAVE_SOURCE.radiance[c]);
      h.save('reference.f32', new Uint8Array(rgb.buffer));
      h.save('reference-quadrature.json', oracle);
      const truth = { rgb, width: image.width, height: image.height },
        expected = channelMeans(truth, pixels),
        observed = channelMeans(image, pixels);
      const relative = observed.map(
        (v, c) => Math.abs(v - sceneValue(expected[c])) / sceneValue(expected[c]),
      );
      const pixelP95 = expected.map((mean, c) =>
        percentile(
          pixels.map(
            (p) => Math.abs(sceneValue(image.rgb[p * 3 + c]) - sceneValue(rgb[p * 3 + c])) / mean,
          ),
          0.95,
        ),
      );
      const quadratureP95 = percentile(
        oracle.map((r) => Math.abs(r.coarse - r.fine) / r.fine),
        0.95,
      );
      const quadratureMaxError = Math.max(
        ...oracle.map((r) => Math.abs(r.fine - r.exact) / r.exact),
      );
      h.save('result.json', {
        mode,
        concaveInstances: 1,
        bars: CONCAVE_BARS,
        source: CONCAVE_SOURCE,
        pixels: pixels.length,
        expected,
        observed,
        relative,
        pixelP95,
        quadratureP95,
        quadratureMaxError,
        visibleSupport: visibleSupport(image),
        oracle:
          'Project both aperture depth planes onto the finite emitter, integrate the exact visible rectangle by its edge-angle form factor, and independently cross-check every receiver by smooth 32x32/64x64 area quadrature. One concave MeshAsset supplies the frame triangles, actual Cards and Mesh SDF. Black blocker/source reflectance excludes secondary-bounce ambiguity.',
        tolerance: { channelRelative: 0.15, pixelP95: 0.25, quadratureMaximumRelative: 0.0001 },
      });
      expect(quadratureMaxError).toBeLessThan(0.0001);
      for (const v of relative) expect(v).toBeLessThan(0.15);
      for (const v of pixelP95) expect(v).toBeLessThan(0.25);
      expect(visibleSupport(image).missing).toBe(0);
      expect(h.errors).toEqual([]);
      if (process.env.FORGEAX_GI_CAPTURE_ACCEPTANCE === '1')
        await h.captureAcceptance(mode === 'screen' ? 'angularMeasure' : undefined);
    } catch (error) {
      await h.recordFailure(error);
      throw error;
    } finally {
      await h.dispose();
    }
  });
}
