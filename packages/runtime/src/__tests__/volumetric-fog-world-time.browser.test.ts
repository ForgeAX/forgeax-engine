import { createWorldContext, Time, World } from '@forgeax/engine-ecs';
import {
  ANTIALIAS_NONE,
  BLOOM_DISABLED,
  CAMERA_EXPOSURE_MODE_MANUAL,
  Camera,
  DirectionalLight,
  VolumetricFog,
} from '@forgeax/engine-render';
import { scenePlugin } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { createWave1RenderingRecipe } from '../../../../scripts/dev-verify/wave1-rendering/recipe';
import { createRenderer } from '../createRenderer';
import {
  attachRenderer,
  captureFrame,
  createCanvas,
  createDensity,
  DAYLIGHT,
  FOG_ROI,
  type FrameSample,
  MAX_PAUSED_FOG_MEAN_LUMA_DELTA,
  pixelDelta,
  roiMeanAbsoluteLumaDelta,
  roiStats,
  submitFrame,
} from './solar-atmosphere-calibration.fixture';

const MAX_EQUAL_TIME_FOG_MEAN_LUMA_DELTA = 1;
const MAX_EQUAL_TIME_FOG_PIXEL_LUMA_DELTA = 2;
const MIN_TIME_SENSITIVITY_FOG_PIXEL_MARGIN = 0.25;
const TIME_SENSITIVITY_STEPS = 30;

it('replays volumetric output at equal World time across render schedules', async () => {
  const denseCanvas = createCanvas();
  const sparseCanvas = createCanvas();
  const createFixture = async (canvas: HTMLCanvasElement) => {
    const rendererResult = await createRenderer(
      canvas,
      {},
      { shaderManifestUrl: '/shaders/manifest.json' },
    );
    if (!rendererResult.ok) throw rendererResult.error;
    const renderer = rendererResult.value;
    const world = new World();
    const scene = await createWorldContext(world, [scenePlugin()]);
    const recipe = createWave1RenderingRecipe(world, { aspect: 1, includeAtmosphere: false });
    recipe.destroy(recipe.entities.screen);
    recipe.destroy(recipe.entities.localLight);
    recipe.destroy(recipe.entities.skylight);
    recipe.destroy(recipe.entities.roof);
    world
      .set(recipe.entities.camera, Camera, {
        exposureMode: CAMERA_EXPOSURE_MODE_MANUAL,
        exposure: 1,
        bloom: BLOOM_DISABLED,
        antialias: ANTIALIAS_NONE,
      })
      .unwrap();
    world.set(recipe.entities.sun, DirectionalLight, { direction: DAYLIGHT }).unwrap();
    const density = world.allocSharedRef('TextureAsset', createDensity());
    const fog = world
      .spawn({
        component: VolumetricFog,
        data: {
          light: recipe.entities.sun,
          density,
          boundsMin: [-8, -4, -2] as const,
          boundsMax: [8, 4, 6] as const,
          extinction: [0.28, 0.28, 0.28] as const,
          albedo: [0.8, 0.8, 0.8] as const,
          emission: [0, 0, 0] as const,
          anisotropy: 0,
          maxDistance: 30,
        },
      })
      .unwrap();
    const lease = attachRenderer(renderer, world);
    return { canvas, density, fog, lease, recipe, renderer, scene, world };
  };

  const dense = await createFixture(denseCanvas);
  const sparse = await createFixture(sparseCanvas);
  try {
    const replay = async (
      fixture: Awaited<ReturnType<typeof createFixture>>,
      steps: readonly (number | undefined)[],
      label: string,
    ): Promise<{ readonly final: FrameSample; readonly previous: FrameSample }> => {
      for (let index = 0; index < steps.length; index += 1) {
        const delta = steps[index];
        if (delta !== undefined) fixture.world.update(delta).unwrap();
        await submitFrame(fixture.world, fixture.renderer, fixture.lease);
      }
      let previous: FrameSample | undefined;
      let settled: FrameSample | undefined;
      for (let index = 0; index < 8; index += 1) {
        if (index < 6) {
          await submitFrame(fixture.world, fixture.renderer, fixture.lease);
          continue;
        }
        previous = settled;
        settled = await captureFrame(
          fixture.world,
          fixture.renderer,
          fixture.lease,
          fixture.canvas,
          `${label}-settle-${index}`,
        );
      }
      if (settled === undefined || previous === undefined) {
        throw new Error('equal-time replay produced no settled frame pair');
      }
      return { final: settled, previous };
    };

    const denseReplay = await replay(
      dense,
      [1 / 60, 1 / 60, 1 / 60, 1 / 60, 1 / 60, 1 / 60],
      'equal-time-dense',
    );
    const sparseReplay = await replay(
      sparse,
      [1 / 30, undefined, 1 / 30, undefined, 1 / 30, undefined],
      'equal-time-sparse',
    );
    const denseFinal = denseReplay.final;
    const sparseFinal = sparseReplay.final;
    const denseTime = dense.world.getResource(Time).elapsed;
    const sparseTime = sparse.world.getResource(Time).elapsed;
    expect(denseTime).toBeCloseTo(sparseTime, 8);
    expect(denseFinal.inspection.volumetricFog?.status).toBe('available');
    expect(sparseFinal.inspection.volumetricFog?.status).toBe('available');
    const denseStats = roiStats(denseFinal.pixels, FOG_ROI);
    const sparseStats = roiStats(sparseFinal.pixels, FOG_ROI);
    const meanLumaDelta = Math.abs(denseStats.meanLuma - sparseStats.meanLuma);
    const pixelLumaDelta = roiMeanAbsoluteLumaDelta(denseFinal.pixels, sparseFinal.pixels, FOG_ROI);
    const denseSettleDelta = roiMeanAbsoluteLumaDelta(
      denseReplay.previous.pixels,
      denseFinal.pixels,
      FOG_ROI,
    );
    const sparseSettleDelta = roiMeanAbsoluteLumaDelta(
      sparseReplay.previous.pixels,
      sparseFinal.pixels,
      FOG_ROI,
    );
    expect(denseStats.finitePixels).toBe(denseStats.pixelCount);
    expect(sparseStats.finitePixels).toBe(sparseStats.pixelCount);
    expect(meanLumaDelta).toBeLessThanOrEqual(MAX_EQUAL_TIME_FOG_MEAN_LUMA_DELTA);
    expect(pixelLumaDelta).toBeLessThanOrEqual(MAX_EQUAL_TIME_FOG_PIXEL_LUMA_DELTA);
    expect(denseSettleDelta).toBeLessThanOrEqual(MAX_PAUSED_FOG_MEAN_LUMA_DELTA);
    expect(sparseSettleDelta).toBeLessThanOrEqual(MAX_PAUSED_FOG_MEAN_LUMA_DELTA);

    // Both controls cover the same additional 0.5s in thirty fixed-size steps.
    const laterReplay = await replay(
      dense,
      Array.from({ length: TIME_SENSITIVITY_STEPS }, () => 1 / 60),
      'equal-time-dense-different-time',
    );
    const sameTimeReplay = await replay(
      sparse,
      Array.from({ length: TIME_SENSITIVITY_STEPS }, () => undefined),
      'equal-time-sparse-same-time-control',
    );
    const laterFinal = laterReplay.final;
    const sameTimeFinal = sameTimeReplay.final;
    const laterTime = dense.world.getResource(Time).elapsed;
    const sameTime = sparse.world.getResource(Time).elapsed;
    const sameTimeNoise = roiMeanAbsoluteLumaDelta(
      sparseFinal.pixels,
      sameTimeFinal.pixels,
      FOG_ROI,
    );
    const timeSensitivity = roiMeanAbsoluteLumaDelta(
      laterFinal.pixels,
      sameTimeFinal.pixels,
      FOG_ROI,
    );
    const timeSensitivityPixels = pixelDelta(laterFinal.pixels, sameTimeFinal.pixels, FOG_ROI);
    const laterSettleDelta = roiMeanAbsoluteLumaDelta(
      laterReplay.previous.pixels,
      laterFinal.pixels,
      FOG_ROI,
    );
    const sameTimeSettleDelta = roiMeanAbsoluteLumaDelta(
      sameTimeReplay.previous.pixels,
      sameTimeFinal.pixels,
      FOG_ROI,
    );
    expect(laterTime).toBeGreaterThan(denseTime);
    expect(sameTime).toBeCloseTo(sparseTime, 8);
    expect(sameTimeNoise).toBeLessThanOrEqual(MAX_EQUAL_TIME_FOG_PIXEL_LUMA_DELTA);
    expect(timeSensitivity).toBeGreaterThan(sameTimeNoise + MIN_TIME_SENSITIVITY_FOG_PIXEL_MARGIN);
    expect(timeSensitivityPixels).toBeGreaterThan(0);
    expect(laterSettleDelta).toBeLessThanOrEqual(MAX_PAUSED_FOG_MEAN_LUMA_DELTA);
    expect(sameTimeSettleDelta).toBeLessThanOrEqual(MAX_PAUSED_FOG_MEAN_LUMA_DELTA);
    // biome-ignore lint/suspicious/noConsole: equal-World-time replay receipt for browser evidence.
    console.info(
      '[solar-atmosphere-calibration] equal-time-replay',
      JSON.stringify({
        denseTime,
        sparseTime,
        denseFrames: denseFinal.inspection.frame,
        sparseFrames: sparseFinal.inspection.frame,
        dense: denseStats,
        sparse: sparseStats,
        meanLumaDelta,
        pixelLumaDelta,
        denseSettleDelta,
        sparseSettleDelta,
        differentTime: {
          laterTime,
          sameTime,
          sameTimeNoise,
          timeSensitivity,
          timeSensitivityPixels,
          laterSettleDelta,
          sameTimeSettleDelta,
        },
      }),
    );
  } finally {
    for (const fixture of [dense, sparse]) {
      await fixture.renderer.dispose();
      fixture.world.despawn(fixture.fog).unwrap();
      fixture.world.sharedRefs.release(fixture.density).unwrap();
      fixture.recipe.dispose();
      await fixture.scene.fiber.dispose();
    }
    denseCanvas.remove();
    sparseCanvas.remove();
  }
}, 240_000);
