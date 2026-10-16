import { createWorldContext, World } from '@forgeax/engine-ecs';
import { createBoxGeometry, deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import {
  DirectionalLight,
  type FrameReceipt,
  MeshFilter,
  MeshRenderer,
  type Renderer,
  type RenderWorldLease,
} from '@forgeax/engine-render';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  type FrameModel,
  type V7Tape,
  type WorkEntry,
} from '@forgeax/engine-rhi-debug';
import { propagateTransforms, scenePlugin } from '@forgeax/engine-scene';
import type { Handle, MeshAsset } from '@forgeax/engine-types';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { createWave1RenderingRecipe } from '../../../../scripts/dev-verify/wave1-rendering/recipe';
import { loadBackendPack } from '../backend-selection';
import { constructRuntimeRendererHost } from '../renderer-host';

interface ScreenshotPixels {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

interface PixelStats {
  readonly nonBlackPixels: number;
  readonly meanLuma: number;
  readonly maxChannel: number;
}

interface PixelDelta {
  readonly changedPixels: number;
  readonly meanAbsoluteChannelDelta: number;
  readonly maxChannelDelta: number;
}

interface FrameEvidence {
  readonly receipt: FrameReceipt;
  readonly pixels: ScreenshotPixels;
}

function inspect(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item instanceof Error ? { ...item, message: item.message } : item,
  );
}

async function screenshotPixels(
  canvas: HTMLCanvasElement,
  artifactName: string,
): Promise<ScreenshotPixels> {
  const shot = await page.elementLocator(canvas).screenshot({
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
    throw new Error('wave1-shadow-diagnostic: screenshot pixel context unavailable');
  }
  context.drawImage(bitmap, 0, 0);
  const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return { width: image.width, height: image.height, pixels: new Uint8Array(image.data) };
}

function pixelStats(readback: ScreenshotPixels): PixelStats {
  let nonBlackPixels = 0;
  let lumaTotal = 0;
  let maxChannel = 0;
  for (let offset = 0; offset < readback.pixels.length; offset += 4) {
    const red = readback.pixels[offset] ?? 0;
    const green = readback.pixels[offset + 1] ?? 0;
    const blue = readback.pixels[offset + 2] ?? 0;
    if (red + green + blue > 3) nonBlackPixels += 1;
    lumaTotal += 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    maxChannel = Math.max(maxChannel, red, green, blue);
  }
  return {
    nonBlackPixels,
    meanLuma: lumaTotal / Math.max(1, readback.width * readback.height),
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
  return {
    changedPixels,
    meanAbsoluteChannelDelta: absoluteDelta / Math.max(1, left.width * left.height * 3),
    maxChannelDelta,
  };
}

function cropPixels(
  readback: ScreenshotPixels,
  centerX: number,
  centerY: number,
  halfWidth: number,
  halfHeight: number,
): ScreenshotPixels {
  const minX = Math.max(0, Math.floor((centerX - halfWidth) * readback.width));
  const maxX = Math.min(readback.width, Math.ceil((centerX + halfWidth) * readback.width));
  const minY = Math.max(0, Math.floor((centerY - halfHeight) * readback.height));
  const maxY = Math.min(readback.height, Math.ceil((centerY + halfHeight) * readback.height));
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const pixels = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const sourceStart = ((minY + row) * readback.width + minX) * 4;
    const sourceEnd = sourceStart + width * 4;
    pixels.set(readback.pixels.subarray(sourceStart, sourceEnd), row * width * 4);
  }
  return { width, height, pixels };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function meshLayout(mesh: MeshAsset): Record<string, unknown> {
  const projection = deriveVertexLayoutProjection(mesh.attributes);
  return {
    digest: projection.digest,
    arrayStride: projection.arrayStride,
    attributes: projection.attributes.map((attribute) => ({
      key: attribute.key,
      shaderLocation: attribute.shaderLocation,
      offset: attribute.offset,
      format: attribute.format,
    })),
  };
}

function pipelineVertexLayouts(work: WorkEntry): readonly unknown[] {
  const pipeline = asRecord(work.pipeline.descriptor);
  const desc = asRecord(pipeline?.desc);
  const vertex = asRecord(desc?.vertex);
  const buffers = vertex?.buffers;
  return Array.isArray(buffers)
    ? buffers.map((buffer) => {
        const layout = asRecord(buffer);
        return layout === undefined
          ? null
          : {
              arrayStride: layout.arrayStride ?? null,
              stepMode: layout.stepMode ?? null,
              attributes: Array.isArray(layout.attributes) ? layout.attributes : [],
            };
      })
    : [];
}

function arrayStrideOf(layout: unknown): number | undefined {
  const record = asRecord(layout);
  return typeof record?.arrayStride === 'number' ? record.arrayStride : undefined;
}

function sourceKind(work: WorkEntry): 'shadow' | 'forward' | 'unavailable' {
  if (work.pipeline.status !== 'available') return 'unavailable';
  if (
    work.attachments?.colorViewHandleIds.length === 0 ||
    work.pipeline.shaders.some(
      (shader) =>
        shader.entryPoint?.includes('shadow') === true ||
        shader.source?.includes('fn fs_shadow') === true,
    )
  ) {
    return 'shadow';
  }
  return 'forward';
}

function isStandardForwardWork(work: WorkEntry): boolean {
  if (work.pipeline.kind !== 'render' || work.pipeline.status !== 'available') return false;
  const entries = new Set(work.pipeline.shaders.map((shader) => shader.entryPoint));
  return entries.has('vs_scene_index') && (entries.has('fs_main') || entries.has('fs_opaque'));
}

function workEvidence(model: FrameModel): readonly Record<string, unknown>[] {
  return model.works
    .filter((work) => work.pipeline.kind === 'render')
    .map((work) => {
      const command = model.commands[work.commandIndex];
      return {
        workIndex: work.workIndex,
        passIndex: work.passIndex,
        kind: work.kind,
        sourceKind: sourceKind(work),
        commandKind: command?.kind ?? null,
        commandGroup: command?.group ?? [],
        vertexBuffers: work.vertexBuffers,
        pipelineVertexLayouts: pipelineVertexLayouts(work),
        shaders: work.pipeline.shaders.map((shader) => ({
          stage: shader.stage,
          entryPoint: shader.entryPoint,
          sourceMarker:
            shader.source === null
              ? null
              : shader.source.includes('default-shadow-caster')
                ? 'default-shadow-caster'
                : shader.source.includes('shadow')
                  ? 'shadow-related'
                  : 'other',
        })),
        attachments: work.attachments,
      };
    });
}

function bootstrapPipelineEvidence(tape: V7Tape): readonly Record<string, unknown>[] {
  const shaders = new Map(
    tape.bootstrap
      .filter((resource) => resource.kind === 'shader-module')
      .map((resource) => {
        const create = asRecord(resource.create);
        return [resource.handleId, create?.wgslCode];
      }),
  );
  return tape.bootstrap
    .filter((resource) => resource.kind === 'pipeline')
    .map((resource) => {
      const create = asRecord(resource.create);
      const desc = asRecord(create?.desc);
      const vertex = asRecord(desc?.vertex);
      const fragment = asRecord(desc?.fragment);
      const vertexShaderModuleHandleId = create?.vertexShaderModuleHandleId;
      const fragmentShaderModuleHandleId = create?.fragmentShaderModuleHandleId;
      const vertexSource =
        typeof vertexShaderModuleHandleId === 'string'
          ? shaders.get(vertexShaderModuleHandleId)
          : undefined;
      const fragmentSource =
        typeof fragmentShaderModuleHandleId === 'string'
          ? shaders.get(fragmentShaderModuleHandleId)
          : undefined;
      return {
        handleId: resource.handleId,
        vertexEntryPoint: vertex?.entryPoint ?? null,
        fragmentEntryPoint: fragment?.entryPoint ?? null,
        vertexSourceMarker:
          typeof vertexSource === 'string'
            ? vertexSource.includes('shadow')
              ? 'shadow-related'
              : 'other'
            : null,
        fragmentSourceMarker:
          typeof fragmentSource === 'string'
            ? fragmentSource.includes('shadow')
              ? 'shadow-related'
              : 'other'
            : null,
        vertexBuffers: Array.isArray(vertex?.buffers)
          ? vertex.buffers.map((buffer) => {
              const layout = asRecord(buffer);
              return layout === undefined
                ? null
                : {
                    arrayStride: layout.arrayStride ?? null,
                    stepMode: layout.stepMode ?? null,
                    attributes: Array.isArray(layout.attributes) ? layout.attributes : [],
                  };
            })
          : [],
      };
    });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function submitFrame(
  world: World,
  renderer: Renderer,
  lease: RenderWorldLease,
): Promise<FrameReceipt> {
  propagateTransforms(world).unwrap();
  const drawn = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
  if (!drawn.ok) throw drawn.error;
  const completed = await drawn.value.completed;
  if (!completed.ok) throw completed.error;
  return drawn.value;
}

async function renderVariant(
  world: World,
  renderer: Renderer,
  lease: RenderWorldLease,
  canvas: HTMLCanvasElement,
  artifactName: string,
): Promise<FrameEvidence> {
  world.update(1 / 60).unwrap();
  const receipt = await submitFrame(world, renderer, lease);
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  return { receipt, pixels: await screenshotPixels(canvas, artifactName) };
}

it('captures one shadow layout tape and isolates jagged shadow casters', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 320;
  canvas.style.width = '320px';
  canvas.style.height = '320px';
  document.body.appendChild(canvas);

  const backend = await loadBackendPack({});
  if (!backend.ok) throw backend.error;
  if (backend.value.createShaderModule === undefined) {
    throw new Error('wave1-shadow-diagnostic: backend shader factory unavailable');
  }
  const recording = attachRecorder({
    ...backend.value,
    createShaderModule: backend.value.createShaderModule,
  });
  if (!recording.ok) throw recording.error;
  const recorder = recording.value;
  const rendererResult = await constructRuntimeRendererHost(
    canvas,
    {
      rhi: recorder.backend.rhi,
      rhiInstrumentation: {
        resolveSurfaceDevice(device) {
          const unwrapped = recorder.backend.unwrapDeviceForSurface(device);
          if (!unwrapped.ok) throw unwrapped.error;
          return ok(unwrapped.value);
        },
      },
    },
    { shaderManifestUrl: '/shaders/manifest.json' },
  );
  if (!rendererResult.ok) throw rendererResult.error;
  const renderer = rendererResult.value.renderer;
  const world = new World();
  const scene = await createWorldContext(world, [scenePlugin()]);
  const recipe = createWave1RenderingRecipe(world, { aspect: 1, includeAtmosphere: true });
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  let canonicalHandle: Handle<'MeshAsset', 'shared'> | undefined;
  let canonicalFloorHandle: Handle<'MeshAsset', 'shared'> | undefined;
  const rendererErrors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') rendererErrors.push(event.error);
  });

  try {
    // Warm the ordinary scene so the captured frame contains the actual
    // shadow and forward pipelines rather than first-touch skip-draws.
    for (let frame = 0; frame < 4; frame += 1) {
      world.update(1 / 60).unwrap();
      await submitFrame(world, renderer, lease);
    }

    // Make the capture frame a shadow-cache invalidation point. A steady
    // frame is allowed to expose the shadow writer pass with zero work when
    // its cached atlas is reused; this tiny transform change makes the
    // producer record the caster draw in the same tape as the forward draw.
    recipe.setPosition(recipe.entities.wall, [0.03, 0, 0]);
    const capture = recorder.captureFrame();
    const before = await recorder.frameBoundary();
    if (!before.ok) throw before.error;
    const full = await renderVariant(world, renderer, lease, canvas, 'wave1-shadow-full');
    const after = await recorder.frameBoundary();
    if (!after.ok) throw after.error;
    const encoded = await capture;
    if (!encoded.ok) throw encoded.error;
    const decoded = decodeTape(encoded.value.bytes);
    if (!decoded.ok) throw decoded.error;
    const model = buildFrameModel(decoded.value);
    const evidence = workEvidence(model);
    const coloredLayout = meshLayout(recipe.assets.wallClosed);
    const coloredFloorLayout = meshLayout(recipe.assets.floor);
    const canonicalMesh = createBoxGeometry(2.8, 2.6, 0.55).unwrap();
    const canonicalFloorMesh = createBoxGeometry(8, 0.2, 8).unwrap();
    const canonicalLayout = meshLayout(canonicalMesh);
    const canonicalFloorLayout = meshLayout(canonicalFloorMesh);
    canonicalHandle = world.allocSharedRef('MeshAsset', canonicalMesh);
    canonicalFloorHandle = world.allocSharedRef('MeshAsset', canonicalFloorMesh);

    // Persist the raw tape through Vitest's host file command. Sending this
    // multi-megabyte payload through console reporting can stall CI log transport.
    const tapePath = 'artifacts/wave1-rendering/wave1-shadow.rhitape';
    await commands.writeFile(tapePath, bytesToBase64(encoded.value.bytes), 'base64');
    // Retain every render work's bound buffer and pipeline layout in the summary.
    // biome-ignore lint/suspicious/noConsole: raw diagnostic evidence is intentional.
    console.info(
      '[wave1-shadow-diagnostic] capture',
      JSON.stringify({
        tape: {
          path: tapePath,
          digest: encoded.value.digest,
          byteLength: encoded.value.bytes.byteLength,
          formatVersion: decoded.value.header.formatVersion,
          eventCount: decoded.value.events.length,
          bootstrapCount: decoded.value.bootstrap.length,
        },
        sourceLayouts: {
          colored: coloredLayout,
          coloredFloor: coloredFloorLayout,
          canonical: canonicalLayout,
          canonicalFloor: canonicalFloorLayout,
        },
        resources: model.resourceLifecycle,
        renderer: renderer.inspect(),
        passes: model.passes,
        bootstrapPipelines: bootstrapPipelineEvidence(decoded.value),
        renderWorks: evidence,
      }),
    );
    expect(decoded.value.header.formatVersion).toBe(7);
    expect(evidence.some((work) => work.sourceKind === 'forward')).toBe(true);

    const wallAndFloorOnly = recipe.entities.screen;
    const roof = recipe.entities.roof;
    recipe.destroy(wallAndFloorOnly);
    recipe.destroy(roof);
    const stripped = await renderVariant(
      world,
      renderer,
      lease,
      canvas,
      'wave1-shadow-wall-floor-only',
    );

    world.set(recipe.entities.sun, DirectionalLight, { castShadow: false }).unwrap();
    const noCasterShadow = await renderVariant(
      world,
      renderer,
      lease,
      canvas,
      'wave1-shadow-cast-shadow-off',
    );

    world.set(recipe.entities.sun, DirectionalLight, { castShadow: true }).unwrap();
    world.set(recipe.entities.wall, MeshRenderer, { materials: [recipe.assets.wood] }).unwrap();
    world.set(recipe.entities.wall, MeshFilter, { assetHandle: canonicalHandle }).unwrap();
    world
      .set(recipe.entities.floor, MeshRenderer, { materials: [recipe.assets.floorMaterial] })
      .unwrap();
    world.set(recipe.entities.floor, MeshFilter, { assetHandle: canonicalFloorHandle }).unwrap();
    const canonical = await renderVariant(
      world,
      renderer,
      lease,
      canvas,
      'wave1-shadow-canonical-box',
    );

    const floorRoi = (readback: ScreenshotPixels): ScreenshotPixels =>
      cropPixels(readback, 0.5, 0.82, 0.38, 0.14);
    const deltas = {
      fullToWallFloor: pixelDelta(full.pixels, stripped.pixels),
      wallFloorToShadowOff: pixelDelta(stripped.pixels, noCasterShadow.pixels),
      shadowOffToCanonical: pixelDelta(noCasterShadow.pixels, canonical.pixels),
    };
    const floorRoiStats = {
      full: pixelStats(floorRoi(full.pixels)),
      wallFloorOnly: pixelStats(floorRoi(stripped.pixels)),
      castShadowOff: pixelStats(floorRoi(noCasterShadow.pixels)),
      canonicalBox: pixelStats(floorRoi(canonical.pixels)),
    };
    const floorRoiDeltas = {
      wallFloorToShadowOff: pixelDelta(floorRoi(stripped.pixels), floorRoi(noCasterShadow.pixels)),
      shadowOffToCanonical: pixelDelta(floorRoi(noCasterShadow.pixels), floorRoi(canonical.pixels)),
    };
    // biome-ignore lint/suspicious/noConsole: variant pixels are diagnostic evidence.
    console.info(
      '[wave1-shadow-diagnostic] variants',
      JSON.stringify({
        frames: {
          full: { receipt: full.receipt, pixels: pixelStats(full.pixels) },
          wallFloorOnly: { receipt: stripped.receipt, pixels: pixelStats(stripped.pixels) },
          castShadowOff: {
            receipt: noCasterShadow.receipt,
            pixels: pixelStats(noCasterShadow.pixels),
          },
          canonicalBox: { receipt: canonical.receipt, pixels: pixelStats(canonical.pixels) },
        },
        deltas,
        floorRoi: { stats: floorRoiStats, deltas: floorRoiDeltas },
        rendererErrors: rendererErrors.map(inspect),
      }),
    );
    const shadowPasses = model.passes.filter(
      (pass) =>
        pass.kind === 'render' &&
        pass.depthStencilViewHandleId !== null &&
        pass.colorAttachmentViewHandleIds.length === 0,
    );
    const shadowWorks = model.works.filter((work) =>
      shadowPasses.some((pass) => pass.workIndices.includes(work.workIndex)),
    );
    const shadowStrides = shadowWorks.flatMap((work) =>
      pipelineVertexLayouts(work).flatMap((layout) => {
        const stride = arrayStrideOf(layout);
        return stride === undefined ? [] : [stride];
      }),
    );
    // Follow the actual caster streams into the color pass. Environment
    // cubemap generation also has color attachments and its own cube layout.
    const casterBuffers = new Set(
      shadowWorks.flatMap((work) => work.vertexBuffers.map((buffer) => buffer.bufferHandleId)),
    );
    const forwardWorks = model.works.filter(
      (work) =>
        isStandardForwardWork(work) &&
        work.pipeline.kind === 'render' &&
        work.vertexBuffers.some((buffer) => casterBuffers.has(buffer.bufferHandleId)) &&
        (model.passes[work.passIndex]?.colorAttachmentViewHandleIds.length ?? 0) > 0,
    );
    const forwardStrides = forwardWorks.flatMap((work) =>
      pipelineVertexLayouts(work).flatMap((layout) => {
        const stride = arrayStrideOf(layout);
        return stride === undefined ? [] : [stride];
      }),
    );
    // This is deliberately a red reproducer on the pre-fix source: the
    // shadow graph advertises writer passes but records no caster work when
    // the default caster pipeline is not built for the colored mesh layout.
    // Once the owner fixes the pipeline, the same gate locks shadow and
    // forward vertex strides to the recipe's 64-byte layout.
    expect(
      shadowWorks.length,
      JSON.stringify({ shadowPasses, shadowStrides, forwardStrides, evidence }),
    ).toBeGreaterThan(0);
    expect(new Set(shadowStrides)).toEqual(new Set([coloredLayout.arrayStride]));
    expect(forwardWorks.length).toBeGreaterThan(0);
    expect(new Set(forwardStrides)).toEqual(new Set([coloredLayout.arrayStride]));
    expect(full.pixels.width).toBeGreaterThan(0);
    expect(full.pixels.height).toBeGreaterThan(0);
    expect(pixelStats(full.pixels).nonBlackPixels).toBeGreaterThan(0);
    expect(pixelStats(stripped.pixels).nonBlackPixels).toBeGreaterThan(0);
    expect(pixelStats(noCasterShadow.pixels).nonBlackPixels).toBeGreaterThan(0);
    expect(pixelStats(canonical.pixels).nonBlackPixels).toBeGreaterThan(0);
    expect(full.receipt.frameId).toBeLessThan(stripped.receipt.frameId);
    expect(stripped.receipt.frameId).toBeLessThan(noCasterShadow.receipt.frameId);
    expect(noCasterShadow.receipt.frameId).toBeLessThan(canonical.receipt.frameId);
    expect(rendererErrors).toEqual([]);
  } finally {
    unsubscribe();
    await renderer.dispose();
    recipe.dispose();
    if (canonicalHandle !== undefined) world.sharedRefs.release(canonicalHandle).unwrap();
    if (canonicalFloorHandle !== undefined) world.sharedRefs.release(canonicalFloorHandle).unwrap();
    await scene.fiber.dispose();
    const recorderDisposed = await recorder.dispose();
    expect(recorderDisposed.ok, inspect(recorderDisposed)).toBe(true);
    canvas.remove();
  }
}, 120000);
