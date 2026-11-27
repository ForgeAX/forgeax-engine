import { Materials } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import {
  channelMeans,
  coloredPanels,
  percentile,
  SCENE_ENVIRONMENT,
  SCENE_HEIGHT,
  SCENE_ROTATIONS,
  SCENE_WIDTH,
  type SceneImage,
  sceneGi,
  sceneHarness,
  visibleSupport,
} from './gi-scenes.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifest = shaderManifestUrl(await buildEngineShaderManifest());
const COLOR = [0.7, 0.65, 0.08] as const;
const NEXT_ENVIRONMENT = [0.06, 0.12, 0.3] as const;
// This receiver starts mostly beyond the right viewport edge, and becomes
// visible after the camera moves. Its old position genuinely lay offscreen;
// merely moving an already visible object across pixel addresses is not enough.
const newPixels: number[] = [];
for (let y = 0; y < SCENE_HEIGHT; y++)
  for (let x = 0; x < SCENE_WIDTH; x++) {
    const worldX = 0.8 + (((x + 0.5) / SCENE_WIDTH) * 2 - 1) * Math.tan(Math.PI / 6) * 1.5 * 2.875;
    const worldY = 0.35 + (1 - ((y + 0.5) / SCENE_HEIGHT) * 2) * Math.tan(Math.PI / 6) * 2.875;
    const outsidePrevious = worldX > Math.tan(Math.PI / 6) * 1.5 * 2.875;
    if (outsidePrevious && Math.abs(worldX - 2.8) < 0.32 && Math.abs(worldY) < 1.05)
      newPixels.push(y * SCENE_WIDTH + x);
  }
function response(image: SceneImage, environment: readonly number[]) {
  const expected = COLOR.map((v, c) => v * (environment[c] ?? NaN));
  const observed = channelMeans(image, newPixels);
  return {
    visibleSupport: visibleSupport(image),
    expected,
    observed,
    unsupportedFraction:
      newPixels.filter((p) => !((image.support?.[p] ?? NaN) > 0.99)).length / newPixels.length,
    relative: observed.map((v, c) => Math.abs(v - (expected[c] ?? NaN)) / (expected[c] ?? NaN)),
    pixelP95: expected.map((v, c) =>
      percentile(
        newPixels.map((p) => Math.abs((image.rgb[p * 3 + c] ?? NaN) - v) / v),
        0.95,
      ),
    ),
  };
}

for (const mode of ['field', 'screen'] as const) {
  it(`renders newly visible colored receivers and a spectral light step ${mode}`, {
    timeout: 600_000,
  }, async () => {
    const h = await sceneHarness(manifest, `motion-light-${mode}`);
    let failureTarget: { phase: 'motion' | 'light'; frame: number } | undefined;
    try {
      await coloredPanels(h, SCENE_ROTATIONS[0]);
      const material = await h.publish(
        Materials.standard({ baseColor: [...COLOR, 1], roughness: 1, specular: 0 }),
      );
      h.spawn(await h.slab(1, 2.5, 0.25), material, [2.8, 0, -3]);
      h.setGi(sceneGi(mode));
      await h.settle(64);
      await h.image('before');
      h.world.set(h.camera, Transform, { pos: [0.8, 0.35, 0] }).unwrap();
      const motion = [];
      for (let frame = 0; frame < 8; frame++) {
        const image = await h.image(`motion-${frame}`);
        motion.push({ frame, ...response(image, SCENE_ENVIRONMENT) });
      }
      h.setGi(sceneGi(mode, { environment: NEXT_ENVIRONMENT }));
      await h.settle(0);
      const lighting = [];
      for (let frame = 0; frame <= 32; frame++) {
        if ([0, 1, 3, 7, 15, 31, 32].includes(frame)) {
          const image = await h.image(`light-${frame}`);
          lighting.push({ frame, ...response(image, NEXT_ENVIRONMENT) });
        } else await h.draw();
      }
      h.save('result.json', {
        mode,
        newPixels: newPixels.length,
        oracle:
          'Analytic constant environment response on receiver points outside the previous perspective frustum',
        tolerance: {
          firstMotionMean: 0.2,
          firstMotionPixelP95: 0.3,
          settledMean: 0.15,
          settledPixelP95: 0.2,
        },
        motion,
        lighting,
      });
      expect(newPixels.length).toBeGreaterThan(32);
      for (const sample of motion) {
        failureTarget = { phase: 'motion', frame: sample.frame };
        expect(sample.unsupportedFraction).toBe(0);
        expect(sample.visibleSupport.missing).toBe(0);
        for (const v of sample.relative) expect(v).toBeLessThan(0.2);
        for (const v of sample.pixelP95) expect(v).toBeLessThan(0.3);
      }
      for (const sample of lighting) {
        failureTarget = { phase: 'light', frame: sample.frame };
        expect(sample.visibleSupport.missing).toBe(0);
      }
      const last = lighting.at(-1);
      failureTarget = { phase: 'light', frame: 32 };
      expect(last).toBeDefined();
      expect(last?.unsupportedFraction).toBe(0);
      for (const v of last?.relative ?? [NaN]) expect(v).toBeLessThan(0.15);
      for (const v of last?.pixelP95 ?? [NaN]) expect(v).toBeLessThan(0.2);
      expect(h.errors).toEqual([]);
    } catch (error) {
      if (failureTarget) {
        h.world.set(h.camera, Transform, { pos: [0, 0, 0] }).unwrap();
        h.setGi(sceneGi(mode));
        await h.settle(64);
        h.world.set(h.camera, Transform, { pos: [0.8, 0.35, 0] }).unwrap();
        if (failureTarget.phase === 'light') {
          await h.settle(8);
          h.setGi(sceneGi(mode, { environment: NEXT_ENVIRONMENT }));
          await h.settle(0);
        }
        for (let frame = 0; frame < failureTarget.frame; frame++) await h.draw();
        h.save('failure-target.json', {
          ...failureTarget,
          note: 'Reproduced temporal setup; original sequence buffers retained.',
        });
      }
      await h.recordFailure(error);
      throw error;
    } finally {
      await h.dispose();
    }
  });
}
