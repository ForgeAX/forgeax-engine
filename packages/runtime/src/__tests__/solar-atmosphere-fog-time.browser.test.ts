import { createWorldContext, FixedTime, Time, World } from '@forgeax/engine-ecs';
import {
  ANTIALIAS_NONE,
  BLOOM_DISABLED,
  CAMERA_EXPOSURE_MODE_MANUAL,
  Camera,
  DirectionalLight,
  MeshFilter,
  VolumetricFog,
} from '@forgeax/engine-render';
import { scenePlugin, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { createWave1RenderingRecipe } from '../../../../scripts/dev-verify/wave1-rendering/recipe';
import { createRenderer } from '../createRenderer';
import { testAssets } from './helpers/runtime-assets';
import {
  attachRenderer,
  type CameraProjectionConfig,
  captureFrame,
  createCanvas,
  createDensity,
  FOG_ROI,
  type FrameSample,
  MAX_PAUSED_FOG_MEAN_LUMA_DELTA,
  OUTPUT_HEIGHT,
  OUTPUT_WIDTH,
  pixelDelta,
  projectCameraBounds,
  type Roi,
  roiStats,
  submitFrame,
} from './solar-atmosphere-calibration.fixture';

// This direction is deliberately outside the camera's horizontal viewport.
// DirectionalLight.direction is the outgoing vector (light -> surface), so
// the projected solar ray below uses its negation (surface -> light).
const OFFSCREEN_SUN: readonly [number, number, number] = [0.92, -0.01, 0.39];

const CAMERA_SHADOW_DISTANCE = 25;

const MAX_CONTROL_BEAM_MEAN_LUMA_DELTA = 1;

const MIN_ENABLED_BEAM_MEAN_LUMA_DELTA = 2;

const ROOF_OPEN_POSITION: readonly [number, number, number] = [20, 2.9, 0.5];

const ROOF_CASTER_POSITION: readonly [number, number, number] = [0, 2.35, 0.5];

const ROOF_MOVED_POSITION: readonly [number, number, number] = [0.75, 2.35, 0.5];

// The successor is an ordinary MeshAsset with two 0.65-wide boxes centred at
// +/-0.42. Its complete projected x extent stays left of the common beam ROI
// while the offscreen sun can still cast its shadow through that ROI.
const CASTER_HALF_EXTENTS: readonly [number, number, number] = [0.75, 0.9, 0.25];

interface CameraProjectionReceipt {
  readonly ndcX: number;
  readonly ndcY: number;
  readonly depth: number;
  readonly inViewport: boolean;
}

function projectSolarDirection(
  direction: readonly [number, number, number],
  camera: CameraProjectionConfig,
): CameraProjectionReceipt {
  const incoming = [-direction[0], -direction[1], -direction[2]] as const;
  const depth = -incoming[2];
  const tanHalfFov = Math.tan(camera.fov / 2);
  const ndcX = incoming[0] / (depth * tanHalfFov);
  const ndcY = incoming[1] / (depth * tanHalfFov);
  return {
    ndcX,
    ndcY,
    depth,
    inViewport:
      depth > 0 &&
      depth >= camera.near &&
      depth <= camera.far &&
      Math.abs(ndcX) <= 1 &&
      Math.abs(ndcY) <= 1,
  };
}

it('projects authored VolumetricFog density from World time across pause and redraw', async () => {
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
  const recipe = createWave1RenderingRecipe(world, testAssets(world), {
    aspect: 1,
    includeAtmosphere: false,
  });
  recipe.destroy(recipe.entities.screen);
  recipe.destroy(recipe.entities.localLight);
  recipe.destroy(recipe.entities.skylight);
  world
    .set(recipe.entities.camera, Camera, {
      exposureMode: CAMERA_EXPOSURE_MODE_MANUAL,
      exposure: 1,
      bloom: BLOOM_DISABLED,
      antialias: ANTIALIAS_NONE,
    })
    .unwrap();
  const authoredCamera = world.get(recipe.entities.camera, Camera).unwrap();
  const authoredTransform = world.get(recipe.entities.camera, Transform).unwrap();
  const cameraProjection: CameraProjectionConfig = {
    position: [
      authoredTransform.pos[0] ?? 0,
      authoredTransform.pos[1] ?? 0,
      authoredTransform.pos[2] ?? 0,
    ],
    fov: authoredCamera.fov,
    near: authoredCamera.near,
    far: authoredCamera.far,
  };
  const density = testAssets(world).create(createDensity()).unwrap();
  const fogData = {
    light: recipe.entities.sun,
    density,
    boundsMin: [-8, -4, -2] as const,
    boundsMax: [8, 4, 6] as const,
    extinction: [0.28, 0.28, 0.28] as const,
    albedo: [0.8, 0.8, 0.8] as const,
    emission: [0, 0, 0] as const,
    anisotropy: 0,
    maxDistance: 30,
  };
  const fog = world
    .spawn({
      component: VolumetricFog,
      data: fogData,
    })
    .unwrap();
  recipe.destroy(recipe.entities.roof);
  const caster = recipe.spawnSuccessor(ROOF_OPEN_POSITION);
  const lease = attachRenderer(renderer, world);
  try {
    // Keep the solar direction off-screen while the ordinary roof remains in
    // the camera frustum and inside the light's configured shadow distance.
    // This is a geometric receipt for the intended off-screen-light case; it
    // does not pretend that the camera can observe the sun disc itself.
    const solarProjection = projectSolarDirection(OFFSCREEN_SUN, cameraProjection);
    expect(solarProjection.inViewport).toBe(false);
    expect(Math.abs(solarProjection.ndcX)).toBeGreaterThan(1);
    recipe.setPosition(caster, ROOF_CASTER_POSITION);
    world.set(recipe.entities.sun, DirectionalLight, { direction: OFFSCREEN_SUN }).unwrap();
    const assertOffscreenSun = (): void => {
      const actual = world.get(recipe.entities.sun, DirectionalLight).unwrap().direction;
      for (let index = 0; index < OFFSCREEN_SUN.length; index += 1) {
        expect(actual[index]).toBeCloseTo(OFFSCREEN_SUN[index] ?? 0, 5);
      }
    };
    assertOffscreenSun();
    world.update(1 / 60).unwrap();
    const offscreenSolarFrame = await captureFrame(
      world,
      renderer,
      lease,
      canvas,
      'fog-solar-offscreen-caster-in-coverage',
    );
    expect(offscreenSolarFrame.inspection.perFramePassNames).toContain('shadowCascade0');
    expect(offscreenSolarFrame.inspection.volumetricFog?.status).toBe('available');

    assertOffscreenSun();
    world.update(1 / 60).unwrap();
    const first = await captureFrame(world, renderer, lease, canvas, 'fog-time-1');
    const firstTime = world.getResource(Time).elapsed;
    const firstTick = world.getResource(FixedTime).tick;
    const firstStats = roiStats(first.pixels, FOG_ROI);
    expect(first.inspection.volumetricFog?.status).toBe('available');
    expect(first.inspection.perFramePassNames).toContain('volume-composite');
    expect(firstStats.nonBlackPixels).toBeGreaterThan(0);

    // Redraws advance the renderer frame receipt, but World time and FixedTime
    // stay frozen until the owning World is updated. This is the production
    // proof that medium motion does not use a second wall-clock.
    const paused = await captureFrame(world, renderer, lease, canvas, 'fog-time-paused');
    // Let the production volume history settle while the simulation clock is
    // frozen; compare the final pair instead of the first jittered samples.
    let pausedAgain = paused;
    for (let sample = 0; sample < 6; sample += 1) {
      if (sample < 5) {
        await submitFrame(world, renderer, lease);
        continue;
      }
      pausedAgain = await captureFrame(
        world,
        renderer,
        lease,
        canvas,
        `fog-time-paused-settle-${sample}`,
      );
    }
    expect(world.getResource(Time).elapsed).toBe(firstTime);
    expect(world.getResource(FixedTime).tick).toBe(firstTick);
    expect(pausedAgain.inspection.frame.frameId).toBeGreaterThan(paused.inspection.frame.frameId);
    expect(paused.inspection.volumetricFog?.status).toBe('available');
    const pausedStats = roiStats(paused.pixels, FOG_ROI);
    const pausedAgainStats = roiStats(pausedAgain.pixels, FOG_ROI);
    const pausedMeanLumaDelta = Math.abs(pausedStats.meanLuma - pausedAgainStats.meanLuma);
    expect(pausedMeanLumaDelta).toBeLessThanOrEqual(MAX_PAUSED_FOG_MEAN_LUMA_DELTA);

    world.update(1 / 60).unwrap();
    const resumed = await captureFrame(world, renderer, lease, canvas, 'fog-time-resumed');
    const resumedTime = world.getResource(Time).elapsed;
    expect(resumedTime).toBeGreaterThan(firstTime);
    expect(world.getResource(FixedTime).tick).toBeGreaterThan(firstTick);
    expect(resumed.inspection.volumetricFog?.status).toBe('available');
    expect(resumed.inspection.volumetricFog?.resourceFacts).toBeDefined();
    const resumedStats = roiStats(resumed.pixels, FOG_ROI);
    expect(Number.isFinite(resumedStats.meanLuma)).toBe(true);
    expect(pixelDelta(first.pixels, resumed.pixels, FOG_ROI)).toBeGreaterThan(0);

    // Freeze the simulation clock after the resumed frame. The same ordinary
    // Mesh caster is first outside the shadow fit, then moved into the solar
    // path while the measured ROI remains free of caster pixels, and finally
    // shifted laterally. Three redraws per state bound temporal convergence
    // without introducing another wall clock or a synthetic beam primitive.
    const beamRoi: Roi = { centerX: 0.78, centerY: 0.35, halfWidth: 0.04, halfHeight: 0.04 };
    const beamBackgroundRoi: Roi = {
      centerX: 0.9,
      centerY: 0.35,
      halfWidth: 0.04,
      halfHeight: 0.04,
    };
    // Keep the existing surface/depth projection fixed. The successor caster
    // is an ordinary Mesh whose complete projected bounds are checked against
    // this common ROI, so a response cannot be explained by its own pixels.
    const casterProjection = projectCameraBounds(
      ROOF_CASTER_POSITION,
      CASTER_HALF_EXTENTS,
      beamRoi,
      cameraProjection,
    );
    const movedCasterProjection = projectCameraBounds(
      ROOF_MOVED_POSITION,
      CASTER_HALF_EXTENTS,
      beamRoi,
      cameraProjection,
    );
    expect(casterProjection.minDepth).toBeGreaterThanOrEqual(cameraProjection.near);
    expect(casterProjection.maxDepth).toBeLessThanOrEqual(CAMERA_SHADOW_DISTANCE);
    expect(casterProjection.maxNdcX).toBeGreaterThanOrEqual(-1);
    expect(casterProjection.minNdcX).toBeLessThanOrEqual(1);
    expect(casterProjection.maxNdcY).toBeGreaterThanOrEqual(-1);
    expect(casterProjection.minNdcY).toBeLessThanOrEqual(1);
    expect(casterProjection.roiMinNdcY).toBeCloseTo(
      1 - 2 * (beamRoi.centerY + beamRoi.halfHeight),
      12,
    );
    expect(casterProjection.roiMaxNdcY).toBeCloseTo(
      1 - 2 * (beamRoi.centerY - beamRoi.halfHeight),
      12,
    );
    expect(casterProjection.roiMinNdcY).toBeLessThan(casterProjection.roiMaxNdcY);
    expect(casterProjection.intersects).toBe(false);
    expect(movedCasterProjection.intersects).toBe(false);
    const frozenTime = world.getResource(Time).elapsed;
    const frozenTick = world.getResource(FixedTime).tick;
    const captureFrozen = async (prefix: string): Promise<FrameSample[]> => {
      const frames: FrameSample[] = [];
      for (let sample = 0; sample < 3; sample += 1) {
        frames.push(await captureFrame(world, renderer, lease, canvas, `${prefix}-${sample}`));
      }
      return frames;
    };
    recipe.setPosition(caster, ROOF_OPEN_POSITION);
    const beamOpen = await captureFrozen('fog-beam-open');
    assertOffscreenSun();
    recipe.setPosition(caster, ROOF_CASTER_POSITION);
    const beamClosed = await captureFrozen('fog-beam-closed');
    assertOffscreenSun();
    recipe.setPosition(caster, ROOF_MOVED_POSITION);
    const beamMoved = await captureFrozen('fog-beam-moved');
    assertOffscreenSun();
    recipe.setPosition(caster, ROOF_OPEN_POSITION);
    const beamRestored = await captureFrozen('fog-beam-restored');
    expect(world.getResource(Time).elapsed).toBe(frozenTime);
    expect(world.getResource(FixedTime).tick).toBe(frozenTick);
    const finalFrame = (frames: readonly FrameSample[]): FrameSample => {
      const frame = frames.at(-1);
      if (frame === undefined) throw new Error('frozen beam capture produced no frame');
      return frame;
    };
    const beamOpenFrame = finalFrame(beamOpen);
    const beamClosedFrame = finalFrame(beamClosed);
    const beamMovedFrame = finalFrame(beamMoved);
    const beamRestoredFrame = finalFrame(beamRestored);
    const beamOpenStats = roiStats(beamOpenFrame.pixels, beamRoi);
    const beamClosedStats = roiStats(beamClosedFrame.pixels, beamRoi);
    const beamMovedStats = roiStats(beamMovedFrame.pixels, beamRoi);
    const beamRestoredStats = roiStats(beamRestoredFrame.pixels, beamRoi);
    const backgroundOpenStats = roiStats(beamOpenFrame.pixels, beamBackgroundRoi);
    const backgroundClosedStats = roiStats(beamClosedFrame.pixels, beamBackgroundRoi);
    const backgroundMeanLumaDelta = Math.abs(
      backgroundOpenStats.meanLuma - backgroundClosedStats.meanLuma,
    );
    const openToClosedLuma = beamOpenStats.meanLuma - beamClosedStats.meanLuma;
    const movedToRestoredLuma = beamRestoredStats.meanLuma - beamMovedStats.meanLuma;
    expect(openToClosedLuma).toBeGreaterThan(MIN_ENABLED_BEAM_MEAN_LUMA_DELTA);
    expect(movedToRestoredLuma).toBeGreaterThan(MIN_ENABLED_BEAM_MEAN_LUMA_DELTA);
    expect(Math.abs(beamOpenStats.meanLuma - beamRestoredStats.meanLuma)).toBeLessThanOrEqual(
      MAX_PAUSED_FOG_MEAN_LUMA_DELTA,
    );

    const beamStateMeanLumaDelta = (frames: readonly FrameSample[], roi: Roi): number => {
      const first = frames[0];
      const last = frames.at(-1);
      if (first === undefined || last === undefined) {
        throw new Error('frozen beam settle window produced no frames');
      }
      return Math.abs(roiStats(first.pixels, roi).meanLuma - roiStats(last.pixels, roi).meanLuma);
    };
    const beamSettledMeanLumaDelta = (frames: readonly FrameSample[], roi: Roi): number => {
      const last = frames.at(-1);
      const previous = frames.at(-2);
      if (last === undefined || previous === undefined) {
        throw new Error('frozen beam settle window needs two frames');
      }
      return Math.abs(
        roiStats(previous.pixels, roi).meanLuma - roiStats(last.pixels, roi).meanLuma,
      );
    };

    // Controls use the identical fixed-time open/closed sequence. Removing
    // VolumetricFog must eliminate the beam response while preserving the
    // ordinary Mesh caster and its shadow pass.
    world.removeComponent(fog, VolumetricFog).unwrap();
    assertOffscreenSun();
    recipe.setPosition(caster, ROOF_OPEN_POSITION);
    const fogDisabledOpen = await captureFrozen('fog-beam-fog-disabled-open');
    recipe.setPosition(caster, ROOF_CASTER_POSITION);
    const fogDisabledClosed = await captureFrozen('fog-beam-fog-disabled-closed');
    const fogDisabledOpenFrame = finalFrame(fogDisabledOpen);
    const fogDisabledClosedFrame = finalFrame(fogDisabledClosed);
    const fogDisabledDelta = Math.abs(
      roiStats(fogDisabledOpenFrame.pixels, beamRoi).meanLuma -
        roiStats(fogDisabledClosedFrame.pixels, beamRoi).meanLuma,
    );
    expect(fogDisabledOpenFrame.inspection.volumetricFog?.status).toBe('off');
    expect(fogDisabledOpenFrame.inspection.perFramePassNames).not.toContain('volume-composite');
    expect(fogDisabledDelta).toBeLessThanOrEqual(MAX_CONTROL_BEAM_MEAN_LUMA_DELTA);

    // Re-add the authored medium, then disable only DirectionalLight shadows.
    // The fog stays active, but the Mesh caster can no longer occlude the
    // light transport. The control therefore removes the open/closed beam
    // contrast while keeping volume passes present.
    world
      .addComponent(fog, {
        component: VolumetricFog,
        data: fogData,
      })
      .unwrap();
    world.set(recipe.entities.sun, DirectionalLight, { castShadow: false }).unwrap();
    world.update(0).unwrap();
    assertOffscreenSun();
    recipe.setPosition(caster, ROOF_OPEN_POSITION);
    const shadowDisabledOpen = await captureFrozen('fog-beam-shadow-disabled-open');
    recipe.setPosition(caster, ROOF_CASTER_POSITION);
    const shadowDisabledClosed = await captureFrozen('fog-beam-shadow-disabled-closed');
    const shadowDisabledOpenFrame = finalFrame(shadowDisabledOpen);
    const shadowDisabledClosedFrame = finalFrame(shadowDisabledClosed);
    const shadowDisabledDelta = Math.abs(
      roiStats(shadowDisabledOpenFrame.pixels, beamRoi).meanLuma -
        roiStats(shadowDisabledClosedFrame.pixels, beamRoi).meanLuma,
    );
    expect(shadowDisabledOpenFrame.inspection.volumetricFog?.status).toBe('available');
    expect(shadowDisabledOpenFrame.inspection.perFramePassNames).not.toContain('shadowCascade0');
    expect(shadowDisabledDelta).toBeLessThanOrEqual(MAX_CONTROL_BEAM_MEAN_LUMA_DELTA);

    // Every control uses the same three-redraw frozen window. A large first
    // to last drift would make the control comparison a temporal artifact.
    for (const frames of [
      fogDisabledOpen,
      fogDisabledClosed,
      shadowDisabledOpen,
      shadowDisabledClosed,
    ]) {
      expect(beamStateMeanLumaDelta(frames, beamRoi)).toBeLessThanOrEqual(
        MAX_PAUSED_FOG_MEAN_LUMA_DELTA,
      );
      expect(beamSettledMeanLumaDelta(frames, beamRoi)).toBeLessThanOrEqual(
        MAX_PAUSED_FOG_MEAN_LUMA_DELTA,
      );
    }
    for (const frames of [beamOpen, beamClosed, beamMoved, beamRestored]) {
      expect(beamSettledMeanLumaDelta(frames, beamRoi)).toBeLessThanOrEqual(
        MAX_PAUSED_FOG_MEAN_LUMA_DELTA,
      );
    }
    expect(world.getResource(Time).elapsed).toBe(frozenTime);
    expect(world.getResource(FixedTime).tick).toBe(frozenTick);
    world.set(recipe.entities.sun, DirectionalLight, { castShadow: true }).unwrap();
    recipe.setPosition(caster, ROOF_OPEN_POSITION);
    // biome-ignore lint/suspicious/noConsole: frozen beam receipt is browser evidence.
    console.info(
      '[solar-atmosphere-calibration] frozen-beam',
      JSON.stringify({
        worldTime: frozenTime,
        fixedTick: frozenTick,
        roi: beamRoi,
        backgroundRoi: beamBackgroundRoi,
        openToClosedLuma,
        movedToRestoredLuma,
        backgroundMeanLumaDelta,
        open: beamOpenStats,
        closed: beamClosedStats,
        moved: beamMovedStats,
        restored: beamRestoredStats,
        projection: {
          solarDirection: OFFSCREEN_SUN,
          solar: solarProjection,
          caster: { position: ROOF_CASTER_POSITION, ...casterProjection },
          movedCaster: { position: ROOF_MOVED_POSITION, ...movedCasterProjection },
          shadowDistance: CAMERA_SHADOW_DISTANCE,
        },
        controls: {
          fogDisabledDelta,
          shadowDisabledDelta,
          fogDisabledSettle: beamStateMeanLumaDelta(fogDisabledOpen, beamRoi),
          shadowDisabledSettle: beamStateMeanLumaDelta(shadowDisabledOpen, beamRoi),
          fogDisabledFinalPair: beamSettledMeanLumaDelta(fogDisabledOpen, beamRoi),
          shadowDisabledFinalPair: beamSettledMeanLumaDelta(shadowDisabledOpen, beamRoi),
        },
      }),
    );

    // The entity remains an ordinary MeshFilter/MeshRenderer owner. Changing
    // its authored asset is the supported opening/closure seam; no volume
    // blocker or synthetic shadow is introduced by this carrier.
    world
      .set(recipe.entities.wall, MeshFilter, { assetHandle: recipe.assets.wallApertureHandle })
      .unwrap();
    world.update(1 / 60).unwrap();
    const opening = await captureFrame(world, renderer, lease, canvas, 'fog-opening');
    world
      .set(recipe.entities.wall, MeshFilter, { assetHandle: recipe.assets.wallClosedHandle })
      .unwrap();
    world.update(1 / 60).unwrap();
    const closure = await captureFrame(world, renderer, lease, canvas, 'fog-closure');
    expect(pixelDelta(opening.pixels, closure.pixels, FOG_ROI)).toBeGreaterThan(0);

    // Move the same ordinary Mesh occluder out of and back into the authored
    // solar ray. The renderer keeps the authored fog resource alive in both
    // states and reports its lifecycle through inspect().
    recipe.setPosition(recipe.entities.wall, [12, 0, 0]);
    world.update(1 / 60).unwrap();
    const moved = await captureFrame(world, renderer, lease, canvas, 'fog-occluder-moved');
    recipe.setPosition(recipe.entities.wall, [0, 0, 0]);
    world.update(1 / 60).unwrap();
    const restored = await captureFrame(world, renderer, lease, canvas, 'fog-occluder-restored');
    expect(pixelDelta(moved.pixels, restored.pixels, FOG_ROI)).toBeGreaterThan(0);
    // biome-ignore lint/suspicious/noConsole: deterministic World/fog browser receipt.
    console.info(
      '[solar-atmosphere-calibration] authored-fog',
      JSON.stringify({
        output: [OUTPUT_WIDTH, OUTPUT_HEIGHT],
        roi: FOG_ROI,
        worldTime: { first: firstTime, resumed: resumedTime },
        fixedTick: { first: firstTick, resumed: world.getResource(FixedTime).tick },
        frame: {
          first: first.inspection.frame,
          paused: paused.inspection.frame,
          pausedAgain: pausedAgain.inspection.frame,
          resumed: resumed.inspection.frame,
        },
        pixels: {
          first: firstStats,
          resumed: resumedStats,
          pauseMeanLumaDelta: pausedMeanLumaDelta,
          resumeDelta: pixelDelta(first.pixels, resumed.pixels, FOG_ROI),
          openingToClosure: pixelDelta(opening.pixels, closure.pixels, FOG_ROI),
          movedToRestored: pixelDelta(moved.pixels, restored.pixels, FOG_ROI),
        },
        volumetricFog: resumed.inspection.volumetricFog,
        temporal: resumed.inspection.temporal,
        resources: resumed.inspection.observation.resourceStats,
        passes: resumed.inspection.perFramePassNames,
      }),
    );
  } finally {
    await renderer.dispose();
    world.despawn(fog).unwrap();
    testAssets(world).release(density).unwrap();
    recipe.dispose();
    await scene.fiber.dispose();
    canvas.remove();
  }
}, 180_000);
