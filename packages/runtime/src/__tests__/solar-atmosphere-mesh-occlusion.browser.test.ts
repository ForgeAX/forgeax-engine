import { createWorldContext, Time, World } from '@forgeax/engine-ecs';
import {
  ANTIALIAS_TAA,
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
  DISC_RADIUS,
  LOW_SUN,
  pixelDelta,
  type Roi,
  setAtmosphere,
} from './solar-atmosphere-calibration.fixture';

it('keeps sun disc occlusion stable across ordinary Mesh pause and resume redraws', async () => {
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
  const recipe = createWave1RenderingRecipe(world, { aspect: 1, includeAtmosphere: true });
  const atmosphere = recipe.entities.atmosphere;
  if (atmosphere === undefined) throw new Error('sun-atmosphere: fixture Atmosphere missing');
  recipe.destroy(recipe.entities.floor);
  recipe.destroy(recipe.entities.screen);
  recipe.destroy(recipe.entities.roof);
  recipe.destroy(recipe.entities.skylight);
  recipe.destroy(recipe.entities.localLight);
  world
    .set(recipe.entities.camera, Camera, {
      exposureMode: CAMERA_EXPOSURE_MODE_MANUAL,
      exposure: 1,
      bloom: BLOOM_DISABLED,
      antialias: ANTIALIAS_TAA,
    })
    .unwrap();
  const lease = attachRenderer(renderer, world);
  try {
    const discRoi: Roi = { centerX: 0.5, centerY: 0.5, halfWidth: 0.1, halfHeight: 0.1 };
    // Keep the original wall out of the view, then use the recipe's default
    // replacement wall on the low-sun ray. Matched radius-zero/radius-nonzero
    // pairs isolate the authored disc contribution from unrelated geometry.
    recipe.destroy(recipe.entities.wall);
    world.set(recipe.entities.sun, DirectionalLight, { direction: LOW_SUN }).unwrap();
    setAtmosphere(world, atmosphere, 1, 1, 0);
    world.update(1 / 60).unwrap();
    const openNoDisc = await captureFrame(world, renderer, lease, canvas, 'occlusion-open-no-disc');
    setAtmosphere(world, atmosphere, 1, 1);
    world.update(1 / 60).unwrap();
    const openDisc = await captureFrame(world, renderer, lease, canvas, 'occlusion-open-disc');
    const occluder = recipe.spawnReplacement();
    setAtmosphere(world, atmosphere, 1, 1, 0);
    world.update(1 / 60).unwrap();
    const blockedNoDisc = await captureFrame(
      world,
      renderer,
      lease,
      canvas,
      'occlusion-blocked-no-disc',
    );
    setAtmosphere(world, atmosphere, 1, 1);
    world.update(1 / 60).unwrap();
    const blockedDisc = await captureFrame(
      world,
      renderer,
      lease,
      canvas,
      'occlusion-blocked-disc',
    );
    const openDiscContribution = pixelDelta(openNoDisc.pixels, openDisc.pixels, discRoi);
    const blockedDiscContribution = pixelDelta(blockedNoDisc.pixels, blockedDisc.pixels, discRoi);
    expect(openDiscContribution).toBeGreaterThan(0);
    expect(blockedDiscContribution).toBe(0);
    recipe.destroy(occluder);
    world.update(1 / 60).unwrap();
    const restoredDisc = await captureFrame(
      world,
      renderer,
      lease,
      canvas,
      'occlusion-restored-disc',
    );
    expect(pixelDelta(blockedDisc.pixels, restoredDisc.pixels, discRoi)).toBeGreaterThan(0);
    const beforePauseTime = world.getResource(Time).elapsed;
    const paused = await captureFrame(world, renderer, lease, canvas, 'occlusion-paused-redraw');
    expect(world.getResource(Time).elapsed).toBe(beforePauseTime);
    world.update(1 / 60).unwrap();
    const resumed = await captureFrame(world, renderer, lease, canvas, 'occlusion-resumed');
    expect(world.getResource(Time).elapsed).toBeGreaterThan(beforePauseTime);
    expect(paused.inspection.observation.resourceStats).toBeDefined();
    expect(resumed.inspection.observation.resourceStats).toBeDefined();
    expect(['available', 'stable']).toContain(resumed.inspection.temporal.status);
    // biome-ignore lint/suspicious/noConsole: temporal/resource state is the browser acceptance receipt.
    console.info(
      '[solar-atmosphere-calibration] occlusion',
      JSON.stringify({
        discRadius: DISC_RADIUS,
        pause: { worldTime: beforePauseTime, frame: paused.inspection.frame },
        resume: { worldTime: world.getResource(Time).elapsed, frame: resumed.inspection.frame },
        deltas: {
          openDiscContribution,
          blockedDiscContribution,
          blockedToRestored: pixelDelta(blockedDisc.pixels, restoredDisc.pixels, discRoi),
        },
        temporal: resumed.inspection.temporal,
        observation: resumed.inspection.observation,
        recoveryGraph: resumed.inspection.recoveryEvidence.graph,
        passes: resumed.inspection.perFramePassNames,
      }),
    );
  } finally {
    await renderer.dispose();
    recipe.dispose();
    await scene.fiber.dispose();
    canvas.remove();
  }
}, 180_000);
