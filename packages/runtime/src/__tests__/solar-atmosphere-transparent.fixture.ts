import { createWorldContext, FixedTime, Time, World } from '@forgeax/engine-ecs';
import {
  ANTIALIAS_NONE,
  ANTIALIAS_TAA,
  BLOOM_DISABLED,
  CAMERA_EXPOSURE_MODE_MANUAL,
  Camera,
  DEFAULT_STANDARD_PROFILE,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  ShadowParticipation,
  VolumetricFog,
} from '@forgeax/engine-render';
import { scenePlugin, Transform } from '@forgeax/engine-scene';
import { expect } from 'vitest';
import { createWave1RenderingRecipe } from '../../../../scripts/dev-verify/wave1-rendering/recipe';
import { createRenderer } from '../createRenderer';
import { testAssets } from './helpers/runtime-assets';
import {
  attachRenderer,
  type CameraProjectionConfig,
  captureFrame,
  createCanvas,
  createDensity,
  DAYLIGHT,
  type FrameSample,
  pixelDelta,
  projectCameraBounds,
  type Roi,
  roiMeanAbsoluteLumaDelta,
  submitFrame,
} from './solar-atmosphere-calibration.fixture';

// The successor's right-hand box projects into this interior ROI at both the
// near and far positions below. Keeping the ROI away from the box edge makes
// the foreground response a depth/composition signal instead of an edge
// coverage signal.
const TRANSPARENT_COMPOSITION_ROI: Roi = {
  centerX: 0.55,
  centerY: 0.58,
  halfWidth: 0.03,
  halfHeight: 0.08,
};

const TRANSPARENT_NEAR_POSITION: readonly [number, number, number] = [0, 0, 1];

const TRANSPARENT_FAR_POSITION: readonly [number, number, number] = [0, 0, -1];

const TRANSPARENT_OFFSCREEN_POSITION: readonly [number, number, number] = [20, 0, 1];

const TRANSPARENT_HALF_EXTENTS: readonly [number, number, number] = [0.75, 0.9, 0.25];

const TRANSPARENT_RIGHT_BOX_HALF_EXTENTS: readonly [number, number, number] = [0.325, 0.9, 0.25];

const MAX_TRANSPARENT_FROZEN_NOISE = 2;

const MIN_TRANSPARENT_FROZEN_SIGNAL = 0.25;

const TRANSPARENT_FROZEN_SAMPLES = 8;

export async function verifyTransparentSolarComposition(
  renderPath: 'forward' | 'deferred',
): Promise<void> {
  const canvas = createCanvas();
  const rendererResult = await createRenderer(
    canvas,
    {
      standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath },
    },
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
  recipe.destroy(recipe.entities.roof);
  world
    .set(recipe.entities.camera, Camera, {
      exposureMode: CAMERA_EXPOSURE_MODE_MANUAL,
      exposure: 1,
      bloom: BLOOM_DISABLED,
      antialias: ANTIALIAS_TAA,
    })
    .unwrap();
  const compositionDensity = createDensity();
  // The optical carriers already exercise heterogeneous density. Keep this
  // composition oracle spatially quiet so the frozen near/far signal cannot be
  // hidden by per-frame volume sampling noise. The midpoint value survives
  // the production density remap, keeping the authored medium active instead
  // of turning the fog into a bypass.
  compositionDensity.data.fill(128);
  const density = testAssets(world).create(compositionDensity).unwrap();
  const fog = world
    .spawn({
      component: VolumetricFog,
      data: {
        light: recipe.entities.sun,
        density,
        boundsMin: [-8, -4, -2] as const,
        boundsMax: [8, 4, 6] as const,
        // Keep the authored volume visible enough that the foreground color
        // remains a measurable composition witness while still exercising the
        // production volume-composite path.
        extinction: [0.04, 0.04, 0.04] as const,
        albedo: [0.8, 0.8, 0.8] as const,
        emission: [0, 0, 0] as const,
        anisotropy: 0,
        maxDistance: 30,
      },
    })
    .unwrap();
  const transparentMaterial = testAssets(world)
    .create(
      Materials.unlit([0.05, 0.95, 0.2, 0.72], {
        queue: 3000,
        renderState: {
          cullMode: 'none',
          depthWriteEnabled: false,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        },
      }),
    )
    .unwrap();
  const transparent = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 1] } },
      { component: MeshFilter, data: { assetHandle: recipe.assets.successorHandle } },
      { component: MeshRenderer, data: { materials: [transparentMaterial, transparentMaterial] } },
      { component: ShadowParticipation, data: { cast: false, receive: true } },
    )
    .unwrap();
  // The Standard pipelines expose the dedicated transparent draw lane when
  // the scene has transmission demand. Keep that demand off-screen so the
  // visible authored unlit blend exercises the production lane without
  // changing the camera fixture.
  const transmissionTriggerMaterial = testAssets(world)
    .create(
      Materials.standard({
        baseColor: [0, 0, 0, 0],
        metallic: 0,
        roughness: 1,
        transmission: 1,
      }),
    )
    .unwrap();
  const transmissionTrigger = world
    .spawn(
      { component: Transform, data: { pos: TRANSPARENT_OFFSCREEN_POSITION } },
      { component: MeshFilter, data: { assetHandle: recipe.assets.successorHandle } },
      {
        component: MeshRenderer,
        data: { materials: [transmissionTriggerMaterial, transmissionTriggerMaterial] },
      },
      { component: ShadowParticipation, data: { cast: false, receive: true } },
    )
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
  const nearProjection = projectCameraBounds(
    TRANSPARENT_NEAR_POSITION,
    TRANSPARENT_HALF_EXTENTS,
    TRANSPARENT_COMPOSITION_ROI,
    cameraProjection,
  );
  const farProjection = projectCameraBounds(
    TRANSPARENT_FAR_POSITION,
    TRANSPARENT_HALF_EXTENTS,
    TRANSPARENT_COMPOSITION_ROI,
    cameraProjection,
  );
  const nearRightBoxProjection = projectCameraBounds(
    [0.42, 0, TRANSPARENT_NEAR_POSITION[2]],
    TRANSPARENT_RIGHT_BOX_HALF_EXTENTS,
    TRANSPARENT_COMPOSITION_ROI,
    cameraProjection,
  );
  const farRightBoxProjection = projectCameraBounds(
    [0.42, 0, TRANSPARENT_FAR_POSITION[2]],
    TRANSPARENT_RIGHT_BOX_HALF_EXTENTS,
    TRANSPARENT_COMPOSITION_ROI,
    cameraProjection,
  );
  expect(nearProjection.intersects).toBe(true);
  expect(farProjection.intersects).toBe(true);
  expect(nearProjection.minDepth).toBeLessThan(farProjection.minDepth);
  expect(nearRightBoxProjection.containsRoi).toBe(true);
  expect(farRightBoxProjection.containsRoi).toBe(true);
  const opaqueWallFrontDepth = cameraProjection.position[2] - 0.55 / 2;
  expect(nearProjection.minDepth).toBeLessThan(opaqueWallFrontDepth);
  expect(opaqueWallFrontDepth).toBeLessThan(farProjection.minDepth);
  const lease = attachRenderer(renderer, world);
  try {
    world.set(recipe.entities.sun, DirectionalLight, { direction: DAYLIGHT }).unwrap();
    world.update(1 / 60).unwrap();
    const initial = await captureFrame(
      world,
      renderer,
      lease,
      canvas,
      `composition-${renderPath}-initial`,
    );
    const initialVolume = initial.inspection.volumetricFog;
    expect(initialVolume?.status).toBe('available');
    expect(initialVolume?.resourceFacts?.totalBytes).toBeGreaterThan(0);
    const volumePass = initial.inspection.perFramePassNames.indexOf('volume-composite');
    // The public inspection roster names the volume composite explicitly;
    // transparent draw ownership is proved by the authored blend material
    // and the foreground on/off pixel pair below, so it does not depend on
    // an internal per-frame pass label.
    expect(volumePass).toBeGreaterThanOrEqual(0);
    expect(initial.inspection.temporal.mode).toBe('taa');
    expect(initial.inspection.standardLighting?.renderPath).toBe(renderPath);

    // Keep the world and fixed clocks frozen while the transparent box moves
    // from in front of the opaque wall to behind it. The near/far geometry
    // shares this projected ROI, so a signal above the no-op redraw noise is
    // attributable to transparent composition rather than fog time or camera
    // motion. The offscreen pair is an unchanged control for TAA redraw noise.
    // Establish the causal depth baseline with TAA disabled; the same authored
    // scene is switched back to TAA immediately afterward for the resize and
    // history assertions below.
    world.set(recipe.entities.camera, Camera, { antialias: ANTIALIAS_NONE }).unwrap();
    const noTaaWarmup = await captureFrame(
      world,
      renderer,
      lease,
      canvas,
      `composition-${renderPath}-transparent-depth-baseline`,
    );
    expect(noTaaWarmup.inspection.temporal.mode).toBe('none');
    const frozenWorldTime = world.getResource(Time).elapsed;
    const frozenFixedTick = world.getResource(FixedTime).tick;
    const captureFrozen = async (prefix: string): Promise<FrameSample[]> => {
      const frames: FrameSample[] = [];
      for (let sample = 0; sample < TRANSPARENT_FROZEN_SAMPLES; sample += 1) {
        if (sample < TRANSPARENT_FROZEN_SAMPLES - 2) {
          await submitFrame(world, renderer, lease);
        } else {
          frames.push(
            await captureFrame(
              world,
              renderer,
              lease,
              canvas,
              `composition-${renderPath}-${prefix}-${sample}`,
            ),
          );
        }
        expect(world.getResource(Time).elapsed).toBe(frozenWorldTime);
        expect(world.getResource(FixedTime).tick).toBe(frozenFixedTick);
      }
      return frames;
    };

    recipe.setPosition(transparent, TRANSPARENT_NEAR_POSITION);
    const nearFrames = await captureFrozen('foreground-near');
    recipe.setPosition(transparent, TRANSPARENT_FAR_POSITION);
    const farFrames = await captureFrozen('foreground-far');
    recipe.setPosition(transparent, TRANSPARENT_OFFSCREEN_POSITION);
    const offscreenFrames = await captureFrozen('foreground-offscreen');
    const nearFinal = nearFrames.at(-1);
    const nearPrevious = nearFrames.at(-2);
    const farFinal = farFrames.at(-1);
    const farPrevious = farFrames.at(-2);
    const offscreenFinal = offscreenFrames.at(-1);
    const offscreenPrevious = offscreenFrames.at(-2);
    if (
      nearFinal === undefined ||
      nearPrevious === undefined ||
      farFinal === undefined ||
      farPrevious === undefined ||
      offscreenFinal === undefined ||
      offscreenPrevious === undefined
    ) {
      throw new Error('sun-atmosphere: transparent frozen sample window was incomplete');
    }
    const nearNoise = roiMeanAbsoluteLumaDelta(
      nearPrevious.pixels,
      nearFinal.pixels,
      TRANSPARENT_COMPOSITION_ROI,
    );
    const farNoise = roiMeanAbsoluteLumaDelta(
      farPrevious.pixels,
      farFinal.pixels,
      TRANSPARENT_COMPOSITION_ROI,
    );
    const offscreenNoise = roiMeanAbsoluteLumaDelta(
      offscreenPrevious.pixels,
      offscreenFinal.pixels,
      TRANSPARENT_COMPOSITION_ROI,
    );
    const nearFarSignal = roiMeanAbsoluteLumaDelta(
      nearFinal.pixels,
      farFinal.pixels,
      TRANSPARENT_COMPOSITION_ROI,
    );
    const farOffscreenSignal = roiMeanAbsoluteLumaDelta(
      farFinal.pixels,
      offscreenFinal.pixels,
      TRANSPARENT_COMPOSITION_ROI,
    );
    expect(nearNoise).toBeLessThanOrEqual(MAX_TRANSPARENT_FROZEN_NOISE);
    expect(farNoise).toBeLessThanOrEqual(MAX_TRANSPARENT_FROZEN_NOISE);
    expect(offscreenNoise).toBeLessThanOrEqual(MAX_TRANSPARENT_FROZEN_NOISE);
    expect(nearFarSignal).toBeGreaterThan(
      Math.max(nearNoise, farNoise, offscreenNoise) + MIN_TRANSPARENT_FROZEN_SIGNAL,
    );
    expect(
      pixelDelta(nearFinal.pixels, farFinal.pixels, TRANSPARENT_COMPOSITION_ROI),
    ).toBeGreaterThan(0);
    expect(farOffscreenSignal).toBeLessThanOrEqual(
      MAX_TRANSPARENT_FROZEN_NOISE + MIN_TRANSPARENT_FROZEN_SIGNAL,
    );
    expect(farFinal.inspection.volumetricFog?.status).toBe('available');

    world.set(recipe.entities.camera, Camera, { antialias: ANTIALIAS_TAA }).unwrap();
    const taaRestored = await captureFrame(
      world,
      renderer,
      lease,
      canvas,
      `composition-${renderPath}-taa-restored`,
    );
    expect(taaRestored.inspection.temporal.mode).toBe('taa');

    canvas.width = 128;
    canvas.height = 192;
    canvas.style.width = '128px';
    canvas.style.height = '192px';
    world.set(recipe.entities.camera, Camera, { aspect: canvas.width / canvas.height }).unwrap();
    const resized = await captureFrame(
      world,
      renderer,
      lease,
      canvas,
      `composition-${renderPath}-resize`,
    );
    expect(resized.inspection.temporal.resetReason).toBe('resize');
    expect(resized.inspection.temporal.coverage).toEqual({ width: 128, height: 192 });
    expect(resized.inspection.volumetricFog?.status).toBe('available');
    expect(resized.inspection.volumetricFog?.resourceFacts?.totalBytes).toBeGreaterThan(0);

    recipe.setPosition(transparent, TRANSPARENT_NEAR_POSITION);
    world
      .set(recipe.entities.camera, Transform, {
        pos: [0, 0.15, 7],
        quat: [0, 0.02, 0, 0.9998],
      })
      .unwrap();
    world.update(1 / 60).unwrap();
    const afterCut = await captureFrame(
      world,
      renderer,
      lease,
      canvas,
      `composition-${renderPath}-camera-cut`,
    );
    expect(afterCut.inspection.temporal.mode).toBe('taa');
    expect(afterCut.inspection.temporal.historyValid).toBe(true);
    expect(afterCut.inspection.volumetricFog?.status).toBe('available');
    expect(afterCut.inspection.volumetricFog?.resourceFacts?.totalBytes).toBeLessThanOrEqual(
      48 * 1024 * 1024,
    );
    for (let frame = 0; frame < 16; frame += 1) {
      world.update(1 / 60).unwrap();
      await submitFrame(world, renderer, lease);
      const settled = renderer.inspect();
      expect(settled.volumetricFog?.status).toBe('available');
      expect(settled.temporal.historyValid).toBe(true);
      expect(settled.volumetricFog?.resourceFacts?.totalBytes).toBeLessThanOrEqual(
        48 * 1024 * 1024,
      );
    }
    // biome-ignore lint/suspicious/noConsole: direct/deferred composition receipt.
    console.info(
      '[solar-atmosphere-calibration] transparent-composition',
      JSON.stringify({
        renderPath,
        initialFrame: initial.inspection.frame,
        transparentFrozen: {
          roi: TRANSPARENT_COMPOSITION_ROI,
          nearDepth: nearProjection,
          farDepth: farProjection,
          nearRightBox: nearRightBoxProjection,
          farRightBox: farRightBoxProjection,
          opaqueWallFrontDepth,
          nearNoise,
          farNoise,
          offscreenNoise,
          nearFarSignal,
          farOffscreenSignal,
        },
        resize: resized.inspection.temporal,
        afterCut: afterCut.inspection.temporal,
        volumetricFog: afterCut.inspection.volumetricFog,
        passes: afterCut.inspection.perFramePassNames,
      }),
    );
  } finally {
    await renderer.dispose();
    world.despawn(transparent).unwrap();
    testAssets(world).release(transparentMaterial).unwrap();
    world.despawn(transmissionTrigger).unwrap();
    testAssets(world).release(transmissionTriggerMaterial).unwrap();
    world.despawn(fog).unwrap();
    testAssets(world).release(density).unwrap();
    recipe.dispose();
    await scene.fiber.dispose();
    canvas.remove();
  }
}
