import { createWorldContext, type EntityHandle, FixedTime, World } from '@forgeax/engine-ecs';
import {
  ANTIALIAS_FXAA,
  ANTIALIAS_NONE,
  ANTIALIAS_TAA,
  Atmosphere,
  Camera,
  DirectionalLight,
  type DynamicGeometryCandidate,
  type FrameReceipt,
  MeshFilter,
  type Renderer,
  type RenderWorldLease,
} from '@forgeax/engine-render';
import { propagateTransforms, scenePlugin, Transform } from '@forgeax/engine-scene';
import type { Handle, MeshAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { createWave1RenderingRecipe } from '../../../../scripts/dev-verify/wave1-rendering/recipe';
import { createRenderer } from '../createRenderer';

interface ScreenshotPixels {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

interface PixelStats {
  readonly width: number;
  readonly height: number;
  readonly nonBlackPixels: number;
  readonly meanLuma: number;
  readonly maxChannel: number;
}

interface PixelDelta {
  readonly changedPixels: number;
  readonly meanAbsoluteChannelDelta: number;
  readonly maxChannelDelta: number;
}

async function screenshotPixels(
  canvas: HTMLCanvasElement,
  artifactName?: string,
): Promise<ScreenshotPixels> {
  const shot =
    artifactName === undefined
      ? await page.elementLocator(canvas).screenshot({ base64: true, save: false })
      : await page.elementLocator(canvas).screenshot({
          path: `../../../../artifacts/wave1-rendering/${artifactName}.png`,
          base64: true,
        });
  const base64 = typeof shot === 'string' ? shot : shot.base64;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const offscreen = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = offscreen.getContext('2d', { willReadFrequently: true });
  if (context === null) {
    bitmap.close();
    throw new Error('wave1-rendering: screenshot pixel context unavailable');
  }
  context.drawImage(bitmap, 0, 0);
  const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return {
    width: image.width,
    height: image.height,
    pixels: new Uint8Array(image.data),
  };
}

function pixelStats(readback: ScreenshotPixels): PixelStats {
  let nonBlackPixels = 0;
  let lumaTotal = 0;
  let maxChannel = 0;
  for (let offset = 0; offset < readback.pixels.length; offset += 4) {
    const red = readback.pixels[offset] ?? 0;
    const green = readback.pixels[offset + 1] ?? 0;
    const blue = readback.pixels[offset + 2] ?? 0;
    const brightness = red + green + blue;
    if (brightness > 3) nonBlackPixels += 1;
    lumaTotal += 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    maxChannel = Math.max(maxChannel, red, green, blue);
  }
  const pixelCount = Math.max(1, readback.width * readback.height);
  return {
    width: readback.width,
    height: readback.height,
    nonBlackPixels,
    meanLuma: lumaTotal / pixelCount,
    maxChannel,
  };
}

function pixelDelta(left: ScreenshotPixels, right: ScreenshotPixels): PixelDelta {
  if (left.width !== right.width || left.height !== right.height) {
    return {
      changedPixels: Math.max(left.width * left.height, right.width * right.height),
      meanAbsoluteChannelDelta: 255,
      maxChannelDelta: 255,
    };
  }
  let changedPixels = 0;
  let absoluteDelta = 0;
  let maxChannelDelta = 0;
  for (let offset = 0; offset < left.pixels.length; offset += 4) {
    let changed = false;
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs(
        (left.pixels[offset + channel] ?? 0) - (right.pixels[offset + channel] ?? 0),
      );
      if (delta > 0) changed = true;
      absoluteDelta += delta;
      maxChannelDelta = Math.max(maxChannelDelta, delta);
    }
    if (changed) changedPixels += 1;
  }
  const pixelCount = Math.max(1, left.width * left.height * 3);
  return {
    changedPixels,
    meanAbsoluteChannelDelta: absoluteDelta / pixelCount,
    maxChannelDelta,
  };
}

/** Copy a predictable screen region so sky evidence is not inferred from a full-frame delta. */
function cropPixels(
  readback: ScreenshotPixels,
  centerX: number,
  centerY: number,
  halfWidth: number,
  halfHeight: number,
): ScreenshotPixels {
  const x0 = Math.max(0, Math.floor((centerX - halfWidth) * readback.width));
  const y0 = Math.max(0, Math.floor((centerY - halfHeight) * readback.height));
  const x1 = Math.min(readback.width, Math.ceil((centerX + halfWidth) * readback.width));
  const y1 = Math.min(readback.height, Math.ceil((centerY + halfHeight) * readback.height));
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);
  const pixels = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const sourceOffset = ((y0 + row) * readback.width + x0) * 4;
    const targetOffset = row * width * 4;
    pixels.set(readback.pixels.subarray(sourceOffset, sourceOffset + width * 4), targetOffset);
  }
  return { width, height, pixels };
}

function inspectionStats(inspection: ReturnType<Renderer['inspect']>): Record<string, unknown> {
  const gpu = inspection.renderScene.gpu;
  return {
    state: inspection.state,
    frame: inspection.frame,
    passes: inspection.perFramePassNames,
    environment: inspection.environment,
    temporal: inspection.temporal,
    directionalShadow: inspection.directionalShadow,
    dynamicGeometry: inspection.dynamicGeometry,
    renderScene: {
      projectionRecords: inspection.renderScene.projectionRecords,
      gpu,
      gpuDriven: inspection.renderScene.gpuDriven,
    },
  };
}

async function waitForFrame(
  world: World,
  renderer: Renderer,
  lease: RenderWorldLease,
  canvas: HTMLCanvasElement,
  label: string,
  observe: boolean,
  artifactName?: string,
  cameraEntity?: number,
) {
  const receipt = await submitFrame(world, renderer, lease, cameraEntity);
  const observation = observe
    ? await renderer.observe(receipt, { include: ['timings', 'draws', 'bindings'] })
    : undefined;
  if (observation !== undefined && !observation.ok) throw observation.error;
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const pixels = await screenshotPixels(canvas, artifactName);
  const inspection = renderer.inspect();
  // biome-ignore lint/suspicious/noConsole: frame evidence is intentionally emitted for dev verification.
  console.info(
    `[wave1-rendering:p0] ${label}`,
    JSON.stringify({
      pixel: pixelStats(pixels),
      frame: receipt.frameId,
      receipt: {
        frameId: receipt.frameId,
        deviceGeneration: receipt.deviceGeneration,
        completed: true,
      },
      observation:
        observation?.ok === true
          ? {
              frameId: observation.value.frameId,
              include: observation.value.include,
              timings: observation.value.timings?.status ?? 'omitted',
            }
          : 'omitted',
      resources: inspectionStats(inspection),
    }),
  );
  return { receipt, pixels, inspection, observation };
}

async function submitFrame(
  world: World,
  renderer: Renderer,
  lease: RenderWorldLease,
  cameraEntity?: number,
): Promise<FrameReceipt> {
  propagateTransforms(world).unwrap();
  const drawn = renderer.draw({
    leases: [lease],
    camera: { lease, ...(cameraEntity === undefined ? {} : { entityKey: cameraEntity }) },
    environment: { lease },
    fixedStep: world.getResource(FixedTime).tick,
  });
  if (!drawn.ok) throw drawn.error;
  const receipt = drawn.value;
  const completed = await receipt.completed;
  if (!completed.ok) throw completed.error;
  return receipt;
}

function prepareDynamic(
  renderer: Renderer,
  world: World,
  entity: EntityHandle,
  mesh: MeshAsset,
  meshHandle: Handle<'MeshAsset', 'shared'>,
  revision: number,
): DynamicGeometryCandidate {
  return renderer
    .prepareDynamicGeometry({
      world,
      entity,
      mesh,
      meshHandle,
      revision,
    })
    .unwrap();
}

function acceptDynamic(
  renderer: Renderer,
  world: World,
  candidate: DynamicGeometryCandidate,
): DynamicGeometryCandidate {
  return renderer
    .acceptDynamicGeometry(candidate, {
      world,
      fixedStep: world.getResource(FixedTime).tick,
    })
    .unwrap();
}

it('proves the public Atmosphere toggle in the presented sky pixels', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  canvas.style.width = '256px';
  canvas.style.height = '256px';
  document.body.appendChild(canvas);
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
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  try {
    world.update(1 / 60).unwrap();
    const withAtmosphere = await waitForFrame(
      world,
      renderer,
      attached.value,
      canvas,
      'atmosphere-on',
      true,
      'wave1-p0-atmosphere-on',
    );
    const atmosphere = recipe.entities.atmosphere;
    if (atmosphere === undefined)
      throw new Error('wave1-rendering: Atmosphere fixture entity missing');
    recipe.destroy(atmosphere);
    world.update(1 / 60).unwrap();
    const withoutAtmosphere = await waitForFrame(
      world,
      renderer,
      attached.value,
      canvas,
      'atmosphere-off',
      true,
      'wave1-p0-atmosphere-off',
    );
    const skyDelta = pixelDelta(withAtmosphere.pixels, withoutAtmosphere.pixels);
    expect(skyDelta.changedPixels).toBeGreaterThan(0);
  } finally {
    await renderer.dispose();
    recipe.dispose();
    await scene.fiber.dispose();
    canvas.remove();
  }
}, 120000);

it('proves a visible sun disc and wall occlusion through a sky-only view', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  canvas.style.width = '256px';
  canvas.style.height = '256px';
  document.body.appendChild(canvas);
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
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  try {
    const atmosphere = recipe.entities.atmosphere;
    if (atmosphere === undefined) {
      throw new Error('wave1-rendering: Atmosphere fixture entity missing for sun proof');
    }

    // The component direction is the incoming light vector. Extraction turns
    // it into a view-space sun direction, so this points above the camera's -Z
    // view. Remove every mesh before the first sky-only frame to exercise the
    // camera UBO demand with no scene geometry.
    world.set(recipe.entities.sun, DirectionalLight, { direction: [0, -0.25, 1] }).unwrap();
    world.set(atmosphere, Atmosphere, { sunAngularRadius: 0 }).unwrap();
    recipe.destroy(recipe.entities.wall);
    recipe.destroy(recipe.entities.floor);
    recipe.destroy(recipe.entities.screen);
    recipe.destroy(recipe.entities.roof);
    world.update(1 / 60).unwrap();
    const visibleBaseline = await waitForFrame(
      world,
      renderer,
      lease,
      canvas,
      'sun-visible-no-disc',
      true,
    );
    world.set(atmosphere, Atmosphere, { sunAngularRadius: 0.03 }).unwrap();
    world.update(1 / 60).unwrap();
    const visibleSun = await waitForFrame(
      world,
      renderer,
      lease,
      canvas,
      'sun-visible',
      true,
      'wave1-p0-sun-visible',
    );
    // With direction [0,-0.25,1], the projected disc is in this upper sky
    // region; comparing this ROI catches the actual bright disc rather than
    // treating unrelated full-frame atmosphere changes as sun evidence.
    const visibleSkyRoi = (pixels: ScreenshotPixels) => cropPixels(pixels, 0.5, 0.28, 0.14, 0.12);
    const visibleDelta = pixelDelta(
      visibleSkyRoi(visibleBaseline.pixels),
      visibleSkyRoi(visibleSun.pixels),
    );
    expect(visibleDelta.changedPixels).toBeGreaterThan(0);
    expect(visibleDelta.meanAbsoluteChannelDelta).toBeGreaterThan(0);
    expect(visibleDelta.maxChannelDelta).toBeGreaterThan(0);

    // Put the sun just above the view axis and create one opaque wall in its
    // projected path. The paired radius-zero frame keeps exposure, atmosphere,
    // and indoor materials identical while the center ROI checks occlusion.
    world.set(recipe.entities.sun, DirectionalLight, { direction: [0, -0.01, 1] }).unwrap();
    const occluder = recipe.spawnReplacement();
    world.set(atmosphere, Atmosphere, { sunAngularRadius: 0 }).unwrap();
    world.update(1 / 60).unwrap();
    const occludedBaseline = await waitForFrame(
      world,
      renderer,
      lease,
      canvas,
      'sun-occluded-no-disc',
      true,
    );
    world.set(atmosphere, Atmosphere, { sunAngularRadius: 0.03 }).unwrap();
    world.update(1 / 60).unwrap();
    const occludedSun = await waitForFrame(
      world,
      renderer,
      lease,
      canvas,
      'sun-occluded',
      true,
      'wave1-p0-sun-occluded',
    );
    const wallRoi = (pixels: ScreenshotPixels) => cropPixels(pixels, 0.5, 0.5, 0.1, 0.1);
    const occludedDelta = pixelDelta(wallRoi(occludedBaseline.pixels), wallRoi(occludedSun.pixels));
    expect(occludedDelta.changedPixels).toBe(0);
    recipe.destroy(occluder);
  } finally {
    await renderer.dispose();
    recipe.dispose();
    await scene.fiber.dispose();
    canvas.remove();
  }
}, 120000);

it('publishes the Wave1 P0 room through real receipts, pixels, and resource evidence', async () => {
  // CI checks the same transitions and a complete movement cycle at a smaller
  // software target. The default run retains the 60-frame endurance evidence.
  const lightweight = import.meta.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1';
  const steadyFrames = lightweight ? 24 : 60;
  const initialSize = lightweight ? 192 : 384;
  const resizedCanvas = lightweight ? { width: 160, height: 120 } : { width: 320, height: 240 };
  const canvas = document.createElement('canvas');
  canvas.width = initialSize;
  canvas.height = initialSize;
  canvas.style.width = `${initialSize}px`;
  canvas.style.height = `${initialSize}px`;
  document.body.appendChild(canvas);

  const rendererResult = await createRenderer(
    canvas,
    {},
    { shaderManifestUrl: '/shaders/manifest.json' },
  );
  if (!rendererResult.ok) throw rendererResult.error;
  const renderer = rendererResult.value;
  const world = new World();
  const scene = await createWorldContext(world, [scenePlugin()]);
  const recipe = createWave1RenderingRecipe(world, { aspect: 1 });
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  const worldErrors = vi.spyOn(console, 'error');
  const errors: string[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error.code);
  });

  try {
    world.update(1 / 60).unwrap();
    const first = await waitForFrame(world, renderer, lease, canvas, 'closed', true);
    expect(first.pixels.width).toBeGreaterThan(0);
    expect(first.pixels.height).toBeGreaterThan(0);
    expect(pixelStats(first.pixels).nonBlackPixels).toBeGreaterThan(0);
    expect(first.inspection.directionalShadow.requested).not.toBe('off');
    expect(first.inspection.directionalShadow.mapSize).toBe(1024);
    expect(first.inspection.frame.frameId).toBe(first.receipt.frameId);

    const aperturePrepared = prepareDynamic(
      renderer,
      world,
      recipe.entities.wall,
      recipe.assets.wallAperture,
      recipe.assets.wallApertureHandle,
      1,
    );
    expect(world.get(recipe.entities.wall, MeshFilter).unwrap().assetHandle).toBe(
      recipe.assets.wallClosedHandle,
    );
    const prepared = await waitForFrame(world, renderer, lease, canvas, 'prepared', true);
    expect(pixelDelta(first.pixels, prepared.pixels).changedPixels).toBe(0);

    const apertureCandidate = acceptDynamic(renderer, world, aperturePrepared);
    const opened = await waitForFrame(
      world,
      renderer,
      lease,
      canvas,
      'aperture-published',
      true,
      'wave1-p0-aperture',
    );
    expect(pixelDelta(first.pixels, opened.pixels).changedPixels).toBeGreaterThan(0);
    expect(renderer.dynamicGeometryReceipt(apertureCandidate)?.frameId).toBe(
      opened.receipt.frameId,
    );
    expect(opened.inspection.dynamicGeometry?.published).toBeGreaterThanOrEqual(1);
    expect(opened.inspection.renderScene.projectionRecords).toBeGreaterThan(0);

    const successorA = recipe.spawnSuccessor([-2.1, 0, 0]);
    const successorB = recipe.spawnSuccessor([2.1, 0, 0]);
    const successors = await waitForFrame(
      world,
      renderer,
      lease,
      canvas,
      'successors-spawned',
      true,
    );
    recipe.setPosition(successorA, [-1.55, 0.25, -0.25]);
    recipe.setPosition(successorB, [1.55, -0.15, -0.25]);
    world.update(1 / 60).unwrap();
    const movedSuccessors = await waitForFrame(
      world,
      renderer,
      lease,
      canvas,
      'successors-moved',
      true,
      'wave1-p0-successors',
    );
    expect(pixelDelta(successors.pixels, movedSuccessors.pixels).changedPixels).toBeGreaterThan(0);

    const steadyStart = renderer.inspect();
    const steadyStartFrame = steadyStart.frame.frameId;
    const steadyStartMeshBytes = steadyStart.dynamicGeometry?.meshBytes ?? 0;
    for (let frame = 0; frame < steadyFrames; frame += 1) {
      const phase = (frame / steadyFrames) * Math.PI * 2;
      recipe.setPosition(successorA, [-1.55 + Math.sin(phase) * 0.18, 0.25, -0.25]);
      recipe.setPosition(successorB, [1.55 + Math.cos(phase) * 0.18, -0.15, -0.25]);
      world.update(1 / 60).unwrap();
      const receipt = await submitFrame(world, renderer, lease);
      expect(receipt.frameId).toBe(steadyStartFrame + frame + 1);
    }
    const steadyEnd = renderer.inspect();
    // This loop keeps two ordinary MeshRenderer entities moving while every
    // submit still uses a real FrameReceipt. Stable capacity and candidate
    // bytes are the bounded resource proof; no per-frame screenshot hides it.
    expect(steadyEnd.state).toBe('alive');
    expect(steadyEnd.frame.frameId).toBe(steadyStartFrame + steadyFrames);
    expect(steadyEnd.dynamicGeometry?.meshBytes ?? 0).toBe(steadyStartMeshBytes);
    // biome-ignore lint/suspicious/noConsole: the bounded loop emits its resource proof.
    console.info(
      '[wave1-rendering:p0] steady',
      JSON.stringify({
        frames: steadyFrames,
        start: inspectionStats(steadyStart),
        end: inspectionStats(steadyEnd),
      }),
    );

    const roofOffscreen = movedSuccessors;
    recipe.setPosition(recipe.entities.roof, [0, 2.35, 0.5]);
    world.update(1 / 60).unwrap();
    const roofOccluding = await waitForFrame(
      world,
      renderer,
      lease,
      canvas,
      'roof-occluding',
      true,
    );
    expect(pixelDelta(roofOffscreen.pixels, roofOccluding.pixels).changedPixels).toBeGreaterThan(0);
    recipe.setPosition(recipe.entities.roof, [20, 2.9, 0.5]);
    world.update(1 / 60).unwrap();
    const roofRestored = await waitForFrame(world, renderer, lease, canvas, 'roof-offscreen', true);
    expect(pixelDelta(roofOccluding.pixels, roofRestored.pixels).changedPixels).toBeGreaterThan(0);

    recipe.destroy(recipe.entities.wall);
    world.update(1 / 60).unwrap();
    const deleted = await waitForFrame(world, renderer, lease, canvas, 'wall-deleted', true);
    expect(pixelDelta(roofRestored.pixels, deleted.pixels).changedPixels).toBeGreaterThan(0);
    renderer.retireDynamicGeometry(apertureCandidate).unwrap();

    const replacementEntity = recipe.spawnReplacement();
    world.update(1 / 60).unwrap();
    const replacementClosed = await waitForFrame(
      world,
      renderer,
      lease,
      canvas,
      'replacement-created',
      true,
    );
    expect(pixelDelta(deleted.pixels, replacementClosed.pixels).changedPixels).toBeGreaterThan(0);
    const replacementPrepared = prepareDynamic(
      renderer,
      world,
      replacementEntity,
      recipe.assets.wallAperture,
      recipe.assets.wallApertureHandle,
      2,
    );
    const replacementCandidate = acceptDynamic(renderer, world, replacementPrepared);
    const replacementOpened = await waitForFrame(
      world,
      renderer,
      lease,
      canvas,
      'replacement-aperture-published',
      true,
    );
    expect(renderer.dynamicGeometryReceipt(replacementCandidate)?.frameId).toBe(
      replacementOpened.receipt.frameId,
    );
    expect(
      pixelDelta(replacementClosed.pixels, replacementOpened.pixels).changedPixels,
    ).toBeGreaterThan(0);

    world.set(recipe.entities.camera, Camera, { antialias: ANTIALIAS_FXAA }).unwrap();
    const fxaa = await waitForFrame(world, renderer, lease, canvas, 'aa-fxaa', true);
    expect(fxaa.inspection.temporal.mode).toBe('fxaa');
    world.set(recipe.entities.camera, Camera, { antialias: ANTIALIAS_NONE }).unwrap();
    canvas.width = resizedCanvas.width;
    canvas.height = resizedCanvas.height;
    canvas.style.width = `${resizedCanvas.width}px`;
    canvas.style.height = `${resizedCanvas.height}px`;
    world
      .set(recipe.entities.camera, Camera, { aspect: resizedCanvas.width / resizedCanvas.height })
      .unwrap();
    const resized = await waitForFrame(world, renderer, lease, canvas, 'aa-none-resize', true);
    expect(resized.pixels.width).toBeLessThan(fxaa.pixels.width);
    expect(resized.pixels.height).toBeLessThan(fxaa.pixels.height);
    expect(resized.inspection.temporal.mode).toBe('none');
    world.set(recipe.entities.camera, Camera, { antialias: ANTIALIAS_TAA }).unwrap();
    let taa = await waitForFrame(world, renderer, lease, canvas, 'aa-taa-first', true);
    expect(taa.inspection.temporal.mode).toBe('taa');
    for (let frame = 0; frame < 3; frame += 1) {
      world.update(1 / 60).unwrap();
      taa = await waitForFrame(world, renderer, lease, canvas, `aa-taa-${frame + 2}`, false);
    }
    expect(taa.inspection.temporal.historyValid).toBe(true);
    expect(taa.inspection.temporal.coverage).toEqual(resizedCanvas);
    const finalTaa = await waitForFrame(
      world,
      renderer,
      lease,
      canvas,
      'aa-taa-final',
      true,
      'wave1-p0-final-taa',
    );
    expect(finalTaa.inspection.temporal.historyValid).toBe(true);

    // Backing resolution can change independently of CSS pixels (DPR/render scale).
    canvas.width = resizedCanvas.width * 2;
    canvas.height = resizedCanvas.height * 2;
    const scaled = await waitForFrame(world, renderer, lease, canvas, 'aa-backing-scale', true);
    expect(scaled.pixels.width).toBe(finalTaa.pixels.width);
    expect(scaled.pixels.height).toBe(finalTaa.pixels.height);
    expect(scaled.inspection.temporal.coverage).toEqual({
      width: resizedCanvas.width * 2,
      height: resizedCanvas.height * 2,
    });
    expect(scaled.inspection.temporal.resetReason).toBe('resize');
    canvas.width = resizedCanvas.width;
    canvas.height = resizedCanvas.height;
    await submitFrame(world, renderer, lease);

    for (const yaw of [0.02, 0.04, 0.08, 0.45, -0.45, 0]) {
      world
        .set(recipe.entities.camera, Transform, {
          quat: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
        })
        .unwrap();
      world.update(1 / 60).unwrap();
      await submitFrame(world, renderer, lease);
    }
    for (let frame = 0; frame < 16; frame += 1) await submitFrame(world, renderer, lease);
    const settled = await waitForFrame(
      world,
      renderer,
      lease,
      canvas,
      'aa-after-camera-motion',
      true,
    );
    world.set(recipe.entities.camera, Camera, { antialias: ANTIALIAS_NONE }).unwrap();
    const reference = await waitForFrame(
      world,
      renderer,
      lease,
      canvas,
      'aa-motion-reference',
      false,
    );
    const error =
      pixelDelta(
        cropPixels(settled.pixels, 0.5, 0.55, 0.35, 0.4),
        cropPixels(reference.pixels, 0.5, 0.55, 0.35, 0.4),
      ).meanAbsoluteChannelDelta / 255;
    expect(error).toBeLessThanOrEqual(0.05);
    world.set(recipe.entities.camera, Camera, { antialias: ANTIALIAS_TAA }).unwrap();
    await submitFrame(world, renderer, lease);

    const cameraValues = world.get(recipe.entities.camera, Camera).unwrap();
    const alternate = world
      .spawn(
        { component: Transform, data: { pos: [0, 0.65, 7] } },
        { component: Camera, data: { ...cameraValues, clearColor: [...cameraValues.clearColor] } },
      )
      .unwrap();
    try {
      const original = await waitForFrame(
        world,
        renderer,
        lease,
        canvas,
        'aa-camera-original',
        false,
        undefined,
        recipe.entities.camera,
      );
      const switched = await waitForFrame(
        world,
        renderer,
        lease,
        canvas,
        'aa-camera-switched',
        true,
        undefined,
        alternate,
      );
      expect(switched.inspection.temporal.viewIdentity).not.toBe(
        original.inspection.temporal.viewIdentity,
      );
      expect(switched.inspection.temporal.resetReason).toBe('view-switch');
    } finally {
      world.despawn(alternate).unwrap();
    }
    await submitFrame(world, renderer, lease);
    renderer.releaseSurface().unwrap();
    world
      .set(recipe.entities.camera, Camera, { historyVersion: cameraValues.historyVersion + 1 })
      .unwrap();
    renderer.restoreSurface().unwrap();
    const resumed = await waitForFrame(world, renderer, lease, canvas, 'aa-resumed', true);
    expect(resumed.inspection.temporal.resetReason).toBe('history-version');
    expect(resumed.inspection.temporal.historyValid).toBe(true);

    expect(errors).toEqual([]);
    expect(worldErrors).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
    worldErrors.mockRestore();
    await renderer.dispose();
    recipe.dispose();
    await scene.fiber.dispose();
    canvas.remove();
  }
}, 120000);
