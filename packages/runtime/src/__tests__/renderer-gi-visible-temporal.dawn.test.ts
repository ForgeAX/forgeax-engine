import { Materials } from '@forgeax/engine-render';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { assert, expect, it } from 'vitest';
import { boxFormFactor, quadratureBox } from './gi-scene-area.fixture';
import { sceneSphere } from './gi-scene-curved.fixture';
import {
  DIRECTIONAL_ALBEDO,
  DIRECTIONAL_SOURCES,
  directionalGi,
  directionalSources,
  ellipsoidReference,
  poseDirectionalReceiver,
} from './gi-scene-directional.fixture';
import {
  coloredPanels,
  difference,
  PANEL_COLORS,
  panelPixels,
  SCENE_ENVIRONMENT,
  SCENE_ROTATIONS,
  type SceneHarness,
  type SceneImage,
  sceneGi,
  sceneHarness,
} from './gi-scenes.fixture';
import {
  collectVisibleTemporalFrames,
  prepareVisibleColdScene,
} from './gi-visible-temporal-capture.fixture';
import {
  regroupVisibleFrames,
  visibleAdjacentChanges,
  visibleFrameMetrics,
} from './gi-visible-temporal-metrics.fixture';
import { testAssets } from './helpers/runtime-assets';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const enabled = process.env.FORGEAX_GI_VISIBLE_TEMPORAL === '1';
// The external preparation gate must establish an exact packaged-input hit before this test runs.
const manifest = enabled ? shaderManifestUrl(await buildEngineShaderManifest()) : undefined;

function assessSequence(
  h: SceneHarness,
  frames: readonly SceneImage[],
  reference: ArrayLike<number>,
  pixels: readonly number[],
  thresholds: { mean: number; p95: number },
  prefix = '',
) {
  const individual = frames.map((frame) =>
    visibleFrameMetrics(frame, reference, pixels, thresholds),
  );
  const windows = Array.from({ length: 4 }, (_, window) => {
    const image = regroupVisibleFrames(frames.slice(window * 8, (window + 1) * 8));
    h.save(`${prefix}window-${window}.f32`, new Uint8Array(image.rgb.buffer));
    return visibleFrameMetrics(image, reference, pixels, thresholds);
  });
  const score = (index: number) =>
    Math.max(
      ...(individual[index]?.relative ?? [NaN]).map((x) => x / thresholds.mean),
      ...(individual[index]?.pixelP95 ?? [NaN]).map((x) => x / thresholds.p95),
      individual[index]?.missing ? Number.POSITIVE_INFINITY : 0,
    );
  let worst = 0;
  for (let frame = 1; frame < frames.length; frame++)
    if (score(frame) > score(worst)) worst = frame;
  return {
    individual,
    windows,
    adjacent: visibleAdjacentChanges(frames, pixels),
    actualSceneImageOrdinals: { first: 0, worst, last: 31 },
    thresholds,
    limits:
      'New individual-frame coverage; reconstructed four original eight-frame windows. Adjacent changes are diagnostics without a new arbitrary temporal tolerance.',
  };
}

async function disposeWithErrors(h: SceneHarness) {
  try {
    await h.dispose();
  } finally {
    expect.soft(h.errors).toEqual([]);
  }
}

it.runIf(enabled)(
  'retains 32 completed fixed-camera directional ellipsoid field frames',
  {
    timeout: 600_000,
  },
  async () => {
    assert(manifest);
    assert(process.env.FORGEAX_WEBGPU_NODE === 'wgpu-native');
    const h = await sceneHarness(manifest, 'temporal-directional-ellipsoid-field', {
      softwareField: true,
    });
    try {
      const mesh = await sceneSphere();
      const handle = testAssets(h.world).create(mesh).unwrap();
      const material = await h.publish(
        Materials.standard({
          baseColor: [...DIRECTIONAL_ALBEDO, 1],
          roughness: 1,
          specular: 0,
        }),
      );
      const entity = h.spawn(handle, material, [0, 0, -3]);
      poseDirectionalReceiver(h, entity, 'ellipsoid');
      await directionalSources(h);
      const reference = ellipsoidReference('ellipsoid');
      const pixels = reference.receivers.map((receiver) => receiver.pixel);
      h.save('reference.f32', new Uint8Array(reference.rgb.buffer));
      h.save('reference-receivers.json', reference.receivers);
      const quadratureMaxError = Math.max(
        ...reference.receivers.flatMap((receiver) =>
          DIRECTIONAL_SOURCES.map((source) =>
            Math.abs(
              boxFormFactor(receiver.point, receiver.normal, source) -
                quadratureBox(receiver.point, receiver.normal, source, 64),
            ),
          ),
        ),
      );
      h.setGi(undefined);
      await h.draw();
      await prepareVisibleColdScene(h);
      const direct = await h.image('direct');
      const gi = directionalGi('field');
      h.setGi({ ...gi, field: { ...gi.field, hardwareRayTracing: false } });
      await h.settle(96);
      // No extra image draw between the original settle and constituent frame zero.
      const frames = await collectVisibleTemporalFrames(h, { probeState: true });
      const assessment = assessSequence(h, frames, reference.rgb, pixels, { mean: 0.1, p95: 0.2 });
      h.save('visible-temporal-assessment.json', {
        ...assessment,
        quadratureMaxError,
        engine: process.env.FORGEAX_GI_SCENE_ENGINE,
      });
      expect(pixels.length).toBeGreaterThan(100);
      expect(quadratureMaxError).toBeLessThan(2e-5);
      for (let c = 0; c < 3; c++)
        expect(
          pixels.reduce((sum, p) => sum + (direct.rgb[p * 3 + c] ?? NaN), 0) / pixels.length,
        ).toBeLessThan(1e-5);
      expect(
        assessment.individual.flatMap((frame, index) => (frame.passed ? [] : [index])),
        'Individual completed-frame failures',
      ).toEqual([]);
      expect(
        assessment.windows.flatMap((window, index) => (window.passed ? [] : [index])),
        'Original eight-frame window failures',
      ).toEqual([]);
      expect(h.errors).toEqual([]);
    } catch (error) {
      h.save('failure.json', {
        error: String(error),
        inspection: h.renderer.inspect(),
        errors: h.errors,
      });
      throw error;
    } finally {
      await disposeWithErrors(h);
    }
  },
);

it.runIf(enabled)(
  'retains 32 completed fixed-camera panel field DC control frames',
  {
    timeout: 600_000,
  },
  async () => {
    assert(manifest);
    const h = await sceneHarness(manifest, 'temporal-panels-field-axis');
    try {
      const rotation = SCENE_ROTATIONS[0];
      assert(rotation);
      await coloredPanels(h, rotation);
      h.setGi(undefined);
      for (let frame = 0; frame < 4; frame++) await h.draw();
      await prepareVisibleColdScene(h);
      const direct = await h.image('direct');
      h.setGi(sceneGi('field'));
      await h.settle(64);
      const frames = await collectVisibleTemporalFrames(h);
      const indirect = frames.map((frame) => difference(frame, direct));
      const reference = new Float64Array(direct.rgb.length);
      const comparisons = PANEL_COLORS.map((color, panel) => {
        const pixels = panelPixels(panel);
        for (const p of pixels)
          for (let c = 0; c < 3; c++)
            reference[p * 3 + c] = (color[c] ?? NaN) * (SCENE_ENVIRONMENT[c] ?? NaN);
        const assessment = assessSequence(
          h,
          indirect,
          reference,
          pixels,
          { mean: 0.05, p95: 0.08 },
          `panel-${panel}-`,
        );
        const transport = frames.map((frame) => {
          const mean = SCENE_ENVIRONMENT.map(
            (expected, c) =>
              Math.abs(
                pixels.reduce((sum, p) => sum + (frame.transport?.[p * 4 + c] ?? NaN), 0) /
                  pixels.length -
                  expected,
              ) / expected,
          );
          const p95 = SCENE_ENVIRONMENT.map((expected, c) => {
            const values = pixels
              .map((p) => Math.abs((frame.transport?.[p * 4 + c] ?? NaN) - expected) / expected)
              .sort((a, b) => a - b);
            return values[Math.floor((values.length - 1) * 0.95)] ?? NaN;
          });
          const unsupportedFraction =
            pixels.filter((p) => !((frame.support?.[p] ?? NaN) > 0.99)).length / pixels.length;
          return {
            mean,
            p95,
            unsupportedFraction,
            passed:
              mean.every((x) => x < 0.03) &&
              p95.every((x) => x < 0.05) &&
              unsupportedFraction === 0,
          };
        });
        return { panel, ...assessment, transport };
      });
      h.save('visible-temporal-assessment.json', {
        comparisons,
        originalCoverage:
          'Original panel gate retained one image after 64 settle; this adds 32 individual completed frames.',
      });
      for (const comparison of comparisons) {
        expect(
          comparison.individual.every((frame) => frame.passed),
          `panel ${comparison.panel}:individual`,
        ).toBe(true);
        expect(
          comparison.windows.every((window) => window.passed),
          `panel ${comparison.panel}:windows`,
        ).toBe(true);
        expect(
          comparison.transport.every((frame) => frame.passed),
          `panel ${comparison.panel}:production D`,
        ).toBe(true);
      }
      expect(h.errors).toEqual([]);
    } catch (error) {
      h.save('failure.json', {
        error: String(error),
        inspection: h.renderer.inspect(),
        errors: h.errors,
      });
      throw error;
    } finally {
      await disposeWithErrors(h);
    }
  },
);
