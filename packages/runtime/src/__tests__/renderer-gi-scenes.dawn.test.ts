import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import {
  channelMeans,
  coloredPanels,
  difference,
  PANEL_COLORS,
  panelPixels,
  percentile,
  SCENE_ENVIRONMENT,
  SCENE_ROTATIONS,
  sceneGi,
  sceneHarness,
  visibleSupport,
} from './gi-scenes.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifest = shaderManifestUrl(await buildEngineShaderManifest());

for (const mode of ['field', 'screen'] as const)
  for (const rotation of SCENE_ROTATIONS) {
    it(`renders analytic colored panels ${mode}/${rotation.name} without channel or rotation bias`, {
      timeout: 600_000,
    }, async () => {
      const h = await sceneHarness(manifest, `panels-${mode}-${rotation.name}`);
      try {
        await coloredPanels(h, rotation);
        h.setGi(undefined);
        for (let frame = 0; frame < 4; frame++) await h.draw();
        const direct = await h.image('direct');
        h.setGi(sceneGi(mode));
        await h.settle(64);
        const lit = await h.image('gi');
        const delta = difference(lit, direct);
        h.save('indirect.f32', new Uint8Array(delta.rgb.buffer));
        const comparisons = PANEL_COLORS.map((color, panel) => {
          const pixels = panelPixels(panel);
          const expected = color.map((v, c) => v * (SCENE_ENVIRONMENT[c] ?? NaN));
          const observed = channelMeans(delta, pixels);
          const relative = observed.map(
            (v, c) => Math.abs(v - (expected[c] ?? NaN)) / (expected[c] ?? NaN),
          );
          const pixelP95 = expected.map((v, c) =>
            percentile(
              pixels.map((p) => Math.abs((delta.rgb[p * 3 + c] ?? NaN) - v) / v),
              0.95,
            ),
          );
          const unsupportedFraction =
            pixels.filter((p) => !((lit.support?.[p] ?? NaN) > 0.99)).length / pixels.length;
          const rawDMeanError = SCENE_ENVIRONMENT.map(
            (v, c) =>
              Math.abs(
                pixels.reduce((s, p) => s + (lit.transport?.[p * 4 + c] ?? NaN), 0) /
                  pixels.length -
                  v,
              ) / v,
          );
          const rawDP95 = SCENE_ENVIRONMENT.map((v, c) =>
            percentile(
              pixels.map((p) => Math.abs((lit.transport?.[p * 4 + c] ?? NaN) - v) / v),
              0.95,
            ),
          );
          return {
            panel,
            pixels: pixels.length,
            expected,
            observed,
            relative,
            pixelP95,
            unsupportedFraction,
            rawDMeanError,
            rawDP95,
          };
        });
        h.save('result.json', {
          visibleSupport: visibleSupport(lit),
          oracle:
            'Lambertian response rho * constant incoming radiance; independent of SDF/cards/probes',
          tolerance: { channelRelative: 0.05, pixelP95: 0.08, rawDMean: 0.03, rawDP95: 0.05 },
          mode,
          rotation,
          comparisons,
        });
        // Fix the band before seeing results. Check EVERY channel of EVERY panel;
        // cancellation between colors, pixels or panels cannot pass a mean-only gate.
        for (const comparison of comparisons)
          for (const error of comparison.relative) expect(error).toBeLessThan(0.05);
        for (const comparison of comparisons)
          for (const error of comparison.pixelP95) expect(error).toBeLessThan(0.08);
        for (const comparison of comparisons)
          for (const error of comparison.rawDMeanError) expect(error).toBeLessThan(0.03);
        for (const comparison of comparisons)
          for (const error of comparison.rawDP95) expect(error).toBeLessThan(0.05);
        for (const comparison of comparisons) expect(comparison.unsupportedFraction).toBe(0);
        expect(visibleSupport(lit).missing).toBe(0);
        expect(Array.from(delta.rgb).every(Number.isFinite)).toBe(true);
        expect(h.errors).toEqual([]);
      } catch (error) {
        await h.recordFailure(error);
        throw error;
      } finally {
        await h.dispose();
      }
    });
  }
