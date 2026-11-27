import { Transform } from '@forgeax/engine-scene';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import {
  channelMeans,
  coloredPanels,
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
  for (const levels of [2, 3]) {
    it(`preserves absolute colored furnace energy across clipmap scrolling ${mode}/${levels} levels`, {
      timeout: 600_000,
    }, async () => {
      const h = await sceneHarness(manifest, `clipmap-energy-${mode}-${levels}`);
      let failureX: number | undefined;
      try {
        await coloredPanels(h, SCENE_ROTATIONS[0]);
        h.setGi(sceneGi(mode, { clipLevels: levels }));
        await h.settle(96);
        const poses = [];
        for (const x of [-0.4, 0, 0.6]) {
          h.world.set(h.camera, Transform, { pos: [x, 0, 0] }).unwrap();
          const first = await h.image(`scroll-${x}-first`);
          await h.settle(64);
          const image = await h.image(`scroll-${x}-settled`);
          const panels = PANEL_COLORS.map((color, panel) => {
            const pixels = panelPixels(panel, x);
            const expected = color.map((v, c) => v * (SCENE_ENVIRONMENT[c] ?? NaN));
            const observed = channelMeans(image, pixels);
            return {
              panel,
              expected,
              observed,
              unsupportedFraction:
                pixels.filter((p) => !((image.support?.[p] ?? NaN) > 0.99)).length / pixels.length,
              relative: observed.map(
                (v, c) => Math.abs(v - (expected[c] ?? NaN)) / (expected[c] ?? NaN),
              ),
              pixelP95: expected.map((v, c) =>
                percentile(
                  pixels.map((p) => Math.abs((image.rgb[p * 3 + c] ?? NaN) - v) / v),
                  0.95,
                ),
              ),
              rawDMeanError: SCENE_ENVIRONMENT.map(
                (v, c) =>
                  Math.abs(
                    pixels.reduce((s, p) => s + (image.transport?.[p * 4 + c] ?? NaN), 0) /
                      pixels.length -
                      v,
                  ) / v,
              ),
              rawDP95: SCENE_ENVIRONMENT.map((v, c) =>
                percentile(
                  pixels.map((p) => Math.abs((image.transport?.[p * 4 + c] ?? NaN) - v) / v),
                  0.95,
                ),
              ),
            };
          });
          poses.push({
            x,
            panels,
            firstSupport: visibleSupport(first),
            settledSupport: visibleSupport(image),
            inspection: h.inspection(),
          });
        }
        h.save('result.json', {
          mode,
          levels,
          oracle:
            'Absolute rho * constant radiance; independent of fine/coarse endpoints or another probe field',
          tolerance: { channelRelative: 0.05, pixelP95: 0.08, rawDMean: 0.03, rawDP95: 0.05 },
          poses,
        });
        for (const pose of poses)
          for (const panel of pose.panels) {
            failureX = pose.x;
            expect(pose.firstSupport.missing).toBe(0);
            expect(pose.settledSupport.missing).toBe(0);
            expect(panel.unsupportedFraction).toBe(0);
            for (const v of panel.relative) expect(v).toBeLessThan(0.05);
            for (const v of panel.pixelP95) expect(v).toBeLessThan(0.08);
            for (const v of panel.rawDMeanError) expect(v).toBeLessThan(0.03);
            for (const v of panel.rawDP95) expect(v).toBeLessThan(0.05);
          }
        expect(h.errors).toEqual([]);
      } catch (error) {
        if (failureX !== undefined) {
          h.world.set(h.camera, Transform, { pos: [failureX, 0, 0] }).unwrap();
          await h.settle(64);
          h.save('failure-target.json', {
            x: failureX,
            mode,
            levels,
            note: 'Static failed pose reproduced after the original pose sweep.',
          });
        }
        await h.recordFailure(error);
        throw error;
      } finally {
        await h.dispose();
      }
    });
  }
