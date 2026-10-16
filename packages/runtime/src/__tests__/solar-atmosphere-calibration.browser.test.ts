import { createWorldContext, World } from '@forgeax/engine-ecs';
import {
  ANTIALIAS_NONE,
  Atmosphere,
  BLOOM_DISABLED,
  CAMERA_EXPOSURE_MODE_MANUAL,
  Camera,
  DirectionalLight,
} from '@forgeax/engine-render';
import { scenePlugin } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { createWave1RenderingRecipe } from '../../../../scripts/dev-verify/wave1-rendering/recipe';
import { createRenderer } from '../createRenderer';
import {
  attachRenderer,
  captureFrame,
  createCanvas,
  DAYLIGHT,
  DISC_RADIUS,
  LOW_SUN,
  OUTPUT_HEIGHT,
  OUTPUT_WIDTH,
  pixelDelta,
  type Roi,
  roiStats,
  setAtmosphere,
} from './solar-atmosphere-calibration.fixture';

// These are fixed screenshot-space tolerances for the 256x256 manual-exposure
// carrier. They are deliberately directional: a response that merely changes
// in the wrong direction must fail instead of being treated as calibration.
const MIN_STRENGTH_LUMA_DELTA = 0.25;

const MIN_WIDTH_RADIAL_DELTA = 0.0001;

const SKY_ROIS: Record<'daylight' | 'low-sun', Roi> = {
  daylight: { centerX: 0.5, centerY: 0.28, halfWidth: 0.28, halfHeight: 0.2 },
  'low-sun': { centerX: 0.5, centerY: 0.5, halfWidth: 0.28, halfHeight: 0.2 },
};

const HORIZON_ROIS: Record<'daylight' | 'low-sun', Roi> = {
  daylight: { centerX: 0.5, centerY: 0.46, halfWidth: 0.35, halfHeight: 0.025 },
  'low-sun': { centerX: 0.5, centerY: 0.46, halfWidth: 0.35, halfHeight: 0.025 },
};

it('calibrates physical Mie scattering and anisotropy with fixed exposure and sun disc', async () => {
  const canvas = createCanvas();
  const rendererResult = await createRenderer(
    canvas,
    {},
    { shaderManifestUrl: '/shaders/manifest.json' },
  );
  if (!rendererResult.ok) throw rendererResult.error;
  const renderer = rendererResult.value;
  const world = new World();
  const scene = await createWorldContext(world, [scenePlugin()]);
  const recipe = createWave1RenderingRecipe(world, {
    aspect: OUTPUT_WIDTH / OUTPUT_HEIGHT,
    includeAtmosphere: true,
  });
  const atmosphere = recipe.entities.atmosphere;
  if (atmosphere === undefined) throw new Error('sun-atmosphere: fixture Atmosphere missing');
  recipe.destroy(recipe.entities.wall);
  recipe.destroy(recipe.entities.floor);
  recipe.destroy(recipe.entities.screen);
  recipe.destroy(recipe.entities.roof);
  recipe.destroy(recipe.entities.skylight);
  recipe.destroy(recipe.entities.localLight);
  world
    .set(recipe.entities.camera, Camera, {
      exposureMode: CAMERA_EXPOSURE_MODE_MANUAL,
      exposure: 1 / 5000,
      bloom: BLOOM_DISABLED,
      antialias: ANTIALIAS_NONE,
    })
    .unwrap();
  const lease = attachRenderer(renderer, world);
  try {
    const directions = [
      ['daylight', DAYLIGHT],
      ['low-sun', LOW_SUN],
    ] as const;
    const evidence: Record<string, unknown> = {};
    for (const [name, direction] of directions) {
      world.set(recipe.entities.sun, DirectionalLight, { direction, intensity: 100_000 }).unwrap();
      setAtmosphere(world, atmosphere, 0, 1);
      world.update(1 / 60).unwrap();
      const strengthZero = await captureFrame(world, renderer, lease, canvas, `${name}-strength-0`);
      setAtmosphere(world, atmosphere, 1, 1);
      world.update(1 / 60).unwrap();
      const strengthOne = await captureFrame(world, renderer, lease, canvas, `${name}-strength-1`);
      setAtmosphere(world, atmosphere, 1, 0.5);
      world.update(1 / 60).unwrap();
      const widthNarrow = await captureFrame(world, renderer, lease, canvas, `${name}-width-0.5`);
      setAtmosphere(world, atmosphere, 1, 2);
      world.update(1 / 60).unwrap();
      const widthWide = await captureFrame(world, renderer, lease, canvas, `${name}-width-2`);
      const skyRoi = SKY_ROIS[name];
      const horizonRoi = HORIZON_ROIS[name];
      const zeroStats = roiStats(strengthZero.pixels, skyRoi, DISC_RADIUS * 1.25);
      const oneStats = roiStats(strengthOne.pixels, skyRoi, DISC_RADIUS * 1.25);
      const narrowStats = roiStats(widthNarrow.pixels, skyRoi, DISC_RADIUS * 1.25);
      const wideStats = roiStats(widthWide.pixels, skyRoi, DISC_RADIUS * 1.25);
      const horizonStats = roiStats(widthWide.pixels, horizonRoi);
      const camera = world.get(recipe.entities.camera, Camera).unwrap();
      const authored = world.get(atmosphere, Atmosphere).unwrap();
      expect(camera.exposureMode).toBe(CAMERA_EXPOSURE_MODE_MANUAL);
      expect(camera.exposure).toBe(Math.fround(1 / 5000));
      expect(camera.bloom).toBe(BLOOM_DISABLED);
      expect(authored.sunAngularRadius).toBeCloseTo(DISC_RADIUS, 6);
      for (const stats of [zeroStats, oneStats, narrowStats, wideStats, horizonStats]) {
        expect(stats.finitePixels).toBe(stats.pixelCount);
        expect(stats.nonBlackPixels).toBeGreaterThan(0);
        expect(Number.isFinite(stats.meanLuma)).toBe(true);
        expect(Number.isFinite(stats.radialWidth)).toBe(true);
      }
      expect(pixelDelta(strengthZero.pixels, strengthOne.pixels, skyRoi)).toBeGreaterThan(0);
      expect(oneStats.meanLuma).toBeGreaterThan(zeroStats.meanLuma + MIN_STRENGTH_LUMA_DELTA);
      expect(wideStats.radialWidth).toBeGreaterThan(
        narrowStats.radialWidth + MIN_WIDTH_RADIAL_DELTA,
      );
      evidence[name] = {
        direction,
        camera: {
          exposureMode: camera.exposureMode,
          exposure: camera.exposure,
          bloom: camera.bloom,
        },
        sunAngularRadius: authored.sunAngularRadius,
        skyRoi,
        horizonRoi,
        strengthDeltaPixels: pixelDelta(strengthZero.pixels, strengthOne.pixels, skyRoi),
        strengthZero: zeroStats,
        strengthOne: oneStats,
        widthNarrow: narrowStats,
        widthWide: wideStats,
        horizon: horizonStats,
        inspection: widthWide.inspection.observation,
      };
    }
    // biome-ignore lint/suspicious/noConsole: fixed calibration receipt for browser evidence.
    console.info(
      '[solar-atmosphere-calibration] calibration',
      JSON.stringify({ output: [OUTPUT_WIDTH, OUTPUT_HEIGHT], evidence }),
    );
  } finally {
    await renderer.dispose();
    recipe.dispose();
    await scene.fiber.dispose();
    canvas.remove();
  }
}, 180_000);
