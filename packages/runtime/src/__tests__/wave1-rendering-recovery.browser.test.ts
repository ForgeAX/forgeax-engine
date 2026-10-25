import { createWorldContext, type EntityHandle, FixedTime, World } from '@forgeax/engine-ecs';
import {
  ANTIALIAS_TAA,
  Atmosphere,
  BarrelDistortion,
  CAMERA_EXPOSURE_MODE_AUTO,
  Camera,
  type DynamicGeometryCandidate,
  type FrameReceipt,
  MeshFilter,
  MeshRenderer,
  type RenderError,
  type Renderer,
  type RenderWorldLease,
} from '@forgeax/engine-render';
import type { Buffer, RhiDevice, RhiRenderCommands } from '@forgeax/engine-rhi';
import { propagateTransforms, scenePlugin } from '@forgeax/engine-scene';
import type { AssetHandle, MeshAsset, TextureAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { page } from 'vitest/browser';
import {
  createWave1RenderingRecipe,
  WAVE1_ATMOSPHERE_PRESET,
} from '../../../../scripts/dev-verify/wave1-rendering/recipe';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import type { RhiBackendInstrumentation } from '../../../render/src/assembly/backend-contract';
import { constructRuntimeRendererHost } from '../renderer-host';
import { testAssets } from './helpers/runtime-assets';

interface ScreenshotPixels {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

interface PixelStats {
  readonly nonBlackPixels: number;
  readonly meanLuma: number;
}

interface PixelDelta {
  readonly changedPixels: number;
  readonly meanAbsoluteChannelDelta: number;
}

interface HostLossSignal {
  readonly device: RhiDevice;
  readonly trigger: () => void;
  readonly outputAllocations: { buffers: number; lutViews: number };
  readonly meshIndexBuffers: ReadonlySet<Buffer>;
  readonly indexUploads: Map<Buffer, Uint8Array>;
  readonly indexBindings: Array<{
    readonly buffer: Buffer;
    readonly format: 'uint16' | 'uint32';
    readonly offset: number | undefined;
    readonly size: number | undefined;
  }>;
  readonly retiredIndices: Set<Buffer>;
}

function expectedHostLossGeneration(error: RenderError): number | undefined {
  if (error.code !== 'device-operation-failed') return undefined;
  if (error.detail.operation !== 'renderer-event') return undefined;
  if (error.detail.cause.code !== 'device-lost') return undefined;
  const match =
    /^device-lost reason: unknown; message: host-injected wave1 loss for generation (0|1)$/.exec(
      error.detail.cause.hint,
    );
  if (match === null) return undefined;
  const generation = Number(match[1]);
  return Number.isInteger(generation) ? generation : undefined;
}

type LossInfo = Awaited<RhiDevice['lost']>;
type Inspection = ReturnType<Renderer['inspect']>;

interface FrameSample {
  readonly receipt: FrameReceipt;
  readonly pixels: ScreenshotPixels;
  readonly inspection: Inspection;
}

interface RecoveryResourceSample {
  readonly generation: number;
  readonly graphResources: number;
  readonly gpuCapacity: number;
  readonly gpuFullRebuilds: number;
  readonly dynamicMeshBytes: number;
  readonly dynamicCandidates: number;
}

function createHostLossInstrumentation(): {
  readonly signals: HostLossSignal[];
  readonly instrumentation: RhiBackendInstrumentation;
} {
  const signals: HostLossSignal[] = [];
  const deviceLost: NonNullable<RhiBackendInstrumentation['deviceLost']> = (device) => {
    let resolveLoss!: (info: LossInfo) => void;
    const loss = new Promise<LossInfo>((resolve) => {
      resolveLoss = resolve;
    });
    const generation = signals.length;
    const outputAllocations = { buffers: 0, lutViews: 0 };
    const meshIndexBuffers = new Set<Buffer>();
    const indexUploads = new Map<Buffer, Uint8Array>();
    const indexBindings: HostLossSignal['indexBindings'] = [];
    const retiredIndices = new Set<Buffer>();
    const createBuffer = device.createBuffer.bind(device);
    device.createBuffer = (descriptor) => {
      const result = createBuffer(descriptor);
      if (result.ok && descriptor.label?.startsWith('standard-auto-exposure-'))
        outputAllocations.buffers += 1;
      if (result.ok && descriptor.label?.startsWith('mesh-') && descriptor.label.endsWith('-ibo'))
        meshIndexBuffers.add(result.value);
      if (result.ok && descriptor.label?.endsWith('-ibo'))
        indexUploads.set(result.value, new Uint8Array(descriptor.size ?? 0));
      return result;
    };
    const writeBuffer = device.queue.writeBuffer.bind(device.queue);
    device.queue.writeBuffer = (buffer, bufferOffset, data, dataOffset, size) => {
      const result = writeBuffer(buffer, bufferOffset, data, dataOffset, size);
      const upload = indexUploads.get(buffer);
      if (result.ok && upload !== undefined) {
        const bytes = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
        upload.set(
          bytes.subarray(dataOffset ?? 0, (dataOffset ?? 0) + (size ?? bytes.length)),
          bufferOffset,
        );
      }
      return result;
    };
    const destroyBuffer = device.destroyBuffer.bind(device);
    device.destroyBuffer = (buffer) => {
      const result = destroyBuffer(buffer);
      if (result.ok && indexUploads.has(buffer)) retiredIndices.add(buffer);
      return result;
    };
    const observeIndexBindings = (commands: RhiRenderCommands) => {
      const setIndexBuffer = commands.setIndexBuffer.bind(commands);
      commands.setIndexBuffer = (buffer, format, offset, size) => {
        indexBindings.push({ buffer, format, offset, size });
        setIndexBuffer(buffer, format, offset, size);
      };
    };
    const createBundle = device.createRenderBundleEncoder.bind(device);
    device.createRenderBundleEncoder = (descriptor) => {
      const result = createBundle(descriptor);
      if (result.ok) observeIndexBindings(result.value);
      return result;
    };
    const createEncoder = device.createCommandEncoder.bind(device);
    device.createCommandEncoder = (descriptor) => {
      const result = createEncoder(descriptor);
      if (result.ok) {
        const beginRenderPass = result.value.beginRenderPass.bind(result.value);
        result.value.beginRenderPass = (passDescriptor) => {
          const pass = beginRenderPass(passDescriptor);
          observeIndexBindings(pass);
          return pass;
        };
      }
      return result;
    };
    const createTextureView = device.createTextureView.bind(device);
    device.createTextureView = (texture, descriptor) => {
      const result = createTextureView(texture, descriptor);
      if (result.ok && descriptor?.dimension === '3d') outputAllocations.lutViews += 1;
      return result;
    };
    signals.push({
      outputAllocations,
      meshIndexBuffers,
      indexUploads,
      indexBindings,
      retiredIndices,
      device,
      // This deliberately projects an unknown host signal. It does not call
      // GPUDevice.destroy() and therefore does not claim a driver reset.
      trigger: () =>
        resolveLoss({
          reason: 'unknown',
          message: `host-injected wave1 loss for generation ${generation}`,
        }),
    });
    return loss;
  };
  return { signals, instrumentation: { deviceLost } };
}

function boundIndexBuffer(signal: HostLossSignal | undefined, mesh: MeshAsset): Buffer {
  if (signal === undefined || mesh.indices === undefined)
    throw new Error('current generation and indexed mesh are required');
  const expected = new Uint8Array(
    mesh.indices.buffer,
    mesh.indices.byteOffset,
    mesh.indices.byteLength,
  );
  const found = [...signal.indexUploads].find(
    ([buffer, bytes]) =>
      !signal.retiredIndices.has(buffer) &&
      bytes.length === expected.length &&
      bytes.every((byte, index) => byte === expected[index]) &&
      signal.indexBindings.some((binding) => binding.buffer === buffer),
  );
  expect(found, 'the actual raster must bind the exact uploaded index bytes').toBeDefined();
  if (found === undefined) throw new Error('missing live physical index binding');
  const binding = signal.indexBindings.find((entry) => entry.buffer === found[0]);
  expect(binding?.format).toBe(mesh.indices instanceof Uint16Array ? 'uint16' : 'uint32');
  expect(binding?.offset ?? 0).toBe(0);
  expect(binding?.size ?? expected.length).toBe(expected.length);
  return found[0];
}

async function waitUntil<T>(
  label: string,
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  let last: T | undefined;
  while (performance.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`wave1-rendering recovery timed out at ${label}: ${JSON.stringify(last)}`);
}

async function screenshotPixels(
  canvas: HTMLCanvasElement,
  label: string,
): Promise<ScreenshotPixels> {
  const shot = await page.elementLocator(canvas).screenshot({
    path: `../../../../artifacts/wave1-rendering/wave1-recovery-${label}.png`,
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
    throw new Error('wave1-rendering recovery screenshot context unavailable');
  }
  context.drawImage(bitmap, 0, 0);
  const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return { width: image.width, height: image.height, pixels: new Uint8Array(image.data) };
}

function pixelStats(readback: ScreenshotPixels): PixelStats {
  let nonBlackPixels = 0;
  let lumaTotal = 0;
  for (let offset = 0; offset < readback.pixels.length; offset += 4) {
    const red = readback.pixels[offset] ?? 0;
    const green = readback.pixels[offset + 1] ?? 0;
    const blue = readback.pixels[offset + 2] ?? 0;
    if (red + green + blue > 3) nonBlackPixels += 1;
    lumaTotal += 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  }
  const pixels = Math.max(1, readback.width * readback.height);
  return { nonBlackPixels, meanLuma: lumaTotal / pixels };
}

function pixelDelta(left: ScreenshotPixels, right: ScreenshotPixels): PixelDelta {
  if (left.width !== right.width || left.height !== right.height) {
    return { changedPixels: left.width * left.height, meanAbsoluteChannelDelta: 255 };
  }
  let changedPixels = 0;
  let absoluteDelta = 0;
  for (let offset = 0; offset < left.pixels.length; offset += 4) {
    let changed = false;
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs(
        (left.pixels[offset + channel] ?? 0) - (right.pixels[offset + channel] ?? 0),
      );
      if (delta > 0) changed = true;
      absoluteDelta += delta;
    }
    if (changed) changedPixels += 1;
  }
  return {
    changedPixels,
    meanAbsoluteChannelDelta: absoluteDelta / Math.max(1, left.width * left.height * 3),
  };
}

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
    pixels.set(readback.pixels.subarray(sourceOffset, sourceOffset + width * 4), row * width * 4);
  }
  return { width, height, pixels };
}

async function submitFrame(
  world: World,
  renderer: Renderer,
  lease: RenderWorldLease,
  canvas: HTMLCanvasElement,
  label: string,
): Promise<FrameSample> {
  propagateTransforms(world).unwrap();
  const receipt = await drawReadyFrame(renderer, {
    leases: [lease],
    camera: { lease },
    environment: { lease },
    fixedStep: world.getResource(FixedTime).tick,
  });
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const pixels = await screenshotPixels(canvas, label);
  const inspection = renderer.inspect();
  // biome-ignore lint/suspicious/noConsole: browser recovery evidence is intentionally emitted.
  console.info(
    '[wave1-rendering:recovery]',
    JSON.stringify({
      label,
      lossSource: 'host-injected-unknown',
      receipt: {
        frameId: receipt.frameId,
        deviceGeneration: receipt.deviceGeneration,
      },
      pixels: pixelStats(pixels),
      state: inspection.state,
      temporal: inspection.temporal,
      dynamicGeometry: inspection.dynamicGeometry,
      recovery: inspection.recovery,
      recoveryEvidence: inspection.recoveryEvidence,
      gpu: inspection.renderScene.gpu,
    }),
  );
  return { receipt, pixels, inspection };
}

function prepareDynamic(
  renderer: Renderer,
  world: World,
  entity: EntityHandle,
  meshHandle: AssetHandle<'mesh'>,
  revision: number,
): DynamicGeometryCandidate {
  const prepared = renderer.prepareDynamicGeometry({ world, entity, meshHandle, revision });
  if (!prepared.ok) throw prepared.error;
  const accepted = renderer.acceptDynamicGeometry(prepared.value, {
    world,
    fixedStep: world.getResource(FixedTime).tick,
  });
  if (!accepted.ok) throw accepted.error;
  return accepted.value;
}

function resourceSample(inspection: Inspection): RecoveryResourceSample {
  const gpu = inspection.renderScene.gpu;
  if (gpu.status !== 'resident') {
    throw new Error(`wave1-rendering recovery GPU scene is not resident: ${gpu.status}`);
  }
  const dynamic = inspection.dynamicGeometry;
  return {
    generation: inspection.frame.deviceGeneration,
    graphResources: inspection.recoveryEvidence.graph.resourceCount,
    gpuCapacity: gpu.capacity,
    gpuFullRebuilds: gpu.fullRebuilds,
    dynamicMeshBytes: dynamic?.meshBytes ?? 0,
    dynamicCandidates:
      (dynamic?.prepared ?? 0) + (dynamic?.accepted ?? 0) + (dynamic?.published ?? 0),
  };
}

async function flushCleanup(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

it('recovers the same Renderer, World, and lease through two host loss cycles', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 384;
  canvas.height = 384;
  canvas.style.width = '384px';
  canvas.style.height = '384px';
  document.body.appendChild(canvas);

  const hostLoss = createHostLossInstrumentation();
  const rendererResult = await constructRuntimeRendererHost(
    canvas,
    { rhiInstrumentation: hostLoss.instrumentation },
    { shaderManifestUrl: '/shaders/manifest.json' },
  );
  if (!rendererResult.ok) throw rendererResult.error;
  const { renderer } = rendererResult.value;
  const world = new World();
  const scene = await createWorldContext(world, [scenePlugin()]);
  const recipe = createWave1RenderingRecipe(world, testAssets(world), {
    aspect: 1,
    includeAtmosphere: true,
  });
  // A tiny identity LUT exercises ordinary asset residency on every device.
  const lutBytes = new Uint16Array(2 * 2 * 2 * 4);
  for (let index = 0; index < 8; index += 1) {
    lutBytes.set(
      [index & 1 ? 0x3c00 : 0, index & 2 ? 0x3c00 : 0, index & 4 ? 0x3c00 : 0, 0x3c00],
      index * 4,
    );
  }
  const lut: TextureAsset = {
    kind: 'texture',
    shape: { viewDimension: '3d', extent: { width: 2, height: 2, depth: 2 } },
    format: 'rgba16float',
    colorSpace: 'linear',
    mips: { kind: 'none' },
    data: new Uint8Array(lutBytes.buffer),
  };
  const lutHandle = testAssets(world).create(lut).unwrap();
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  const worldIdentity = world.identity;
  const initialLease = lease;
  const errors: RenderError[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') {
      errors.push(event.error);
      // biome-ignore lint/suspicious/noConsole: recovery failure triage keeps the structured owner cause.
      console.info('[wave1-rendering:recovery-error]', JSON.stringify(event.error));
    }
  });
  const extraAtmospheres = new Set<EntityHandle>();
  let activeAtmosphere = recipe.entities.atmosphere;
  let rendererDisposed = false;

  const removeAtmosphere = (): void => {
    if (activeAtmosphere === undefined) return;
    if (activeAtmosphere === recipe.entities.atmosphere) recipe.destroy(activeAtmosphere);
    else {
      world.despawn(activeAtmosphere).unwrap();
      extraAtmospheres.delete(activeAtmosphere);
    }
    activeAtmosphere = undefined;
  };
  const addAtmosphere = (): void => {
    const entity = world.spawn({ component: Atmosphere, data: WAVE1_ATMOSPHERE_PRESET }).unwrap();
    extraAtmospheres.add(entity);
    activeAtmosphere = entity;
  };

  try {
    await waitUntil(
      'initial loss hook',
      () => hostLoss.signals.length,
      (count) => count >= 1,
    );
    world
      .set(recipe.entities.camera, Camera, {
        antialias: ANTIALIAS_TAA,
        exposureMode: CAMERA_EXPOSURE_MODE_AUTO,
        exposure: 1,
        // Keep the exposure fixed for the existing atmosphere pixel comparisons.
        rangeEv: [0, 0],
        colorLut: lutHandle,
        colorLutStrength: 0.5,
      })
      .unwrap();
    world
      .addComponent(recipe.entities.camera, {
        component: BarrelDistortion,
        data: { strength: 0.2, centerX: 0.5, centerY: 0.5 },
      })
      .unwrap();
    world.update(1 / 60).unwrap();
    const baseline = await submitFrame(world, renderer, lease, canvas, 'baseline');
    expect(baseline.receipt.deviceGeneration).toBe(0);
    expect(baseline.receipt.graphGeneration).toBeTypeOf('number');
    expect(baseline.receipt.barrelDistortion).toMatchObject({
      width: 384,
      height: 384,
      centerX: 0.5,
      centerY: 0.5,
    });
    expect(baseline.receipt.barrelDistortion?.strength).toBeCloseTo(0.2, 6);
    expect(baseline.inspection.barrelDistortion.effectiveMapping).toEqual(
      baseline.receipt.barrelDistortion,
    );
    expect(baseline.inspection.barrelDistortion.frameId).toBe(baseline.receipt.frameId);
    expect(baseline.inspection.barrelDistortion.deviceGeneration).toBe(
      baseline.receipt.deviceGeneration,
    );
    expect(baseline.inspection.barrelDistortion.graphGeneration).toBe(
      baseline.receipt.graphGeneration,
    );
    expect(baseline.inspection.state).toBe('alive');
    expect(baseline.inspection.temporal.mode).toBe('taa');
    expect(baseline.inspection.output.autoExposure?.receipt.committed).toBe(true);
    const lutSourceKey = baseline.inspection.output.standardLut?.sourceKey;
    expect(lutSourceKey).toBeTruthy();
    expect(pixelStats(baseline.pixels).nonBlackPixels).toBeGreaterThan(0);
    const baselineResources = resourceSample(baseline.inspection);
    const baselineMeshIndexBuffers = hostLoss.signals[0]?.meshIndexBuffers.size ?? 0;
    expect(baselineMeshIndexBuffers).toBeGreaterThan(0);
    const baselineIndex = boundIndexBuffer(hostLoss.signals[0], recipe.assets.wallClosed);

    const initialDynamic = prepareDynamic(
      renderer,
      world,
      recipe.entities.wall,
      recipe.assets.wallApertureHandle,
      1,
    );
    world.update(1 / 60).unwrap();
    const initialAperture = await submitFrame(world, renderer, lease, canvas, 'initial-aperture');
    expect(renderer.dynamicGeometryReceipt(initialDynamic)?.frameId).toBe(
      initialAperture.receipt.frameId,
    );
    expect(pixelDelta(baseline.pixels, initialAperture.pixels).changedPixels).toBeGreaterThan(0);

    // Stock recording resolves mesh bindings directly before execution. An
    // index replacement changes the physical binding, not the graph imports.
    const apertureResources = resourceSample(initialAperture.inspection);
    const apertureIndex = boundIndexBuffer(hostLoss.signals[0], recipe.assets.wallAperture);
    expect(apertureIndex).not.toBe(baselineIndex);
    // biome-ignore lint/suspicious/noConsole: exact physical-vs-graph evidence for this transition.
    console.info(
      '[wave1-rendering:index-replacement]',
      JSON.stringify({
        baselineGraphResources: baselineResources.graphResources,
        apertureGraphResources: apertureResources.graphResources,
        indexReplaced: apertureIndex !== baselineIndex,
        uploadedIndexBytes: recipe.assets.wallAperture.indices?.byteLength,
      }),
    );
    expect(apertureResources.graphResources).toBe(baselineResources.graphResources);
    expect(hostLoss.signals[0]?.meshIndexBuffers.size).toBe(baselineMeshIndexBuffers + 1);

    const recoveryResources: RecoveryResourceSample[] = [];
    for (let cycle = 1; cycle <= 2; cycle += 1) {
      const signal = hostLoss.signals[cycle - 1];
      if (signal === undefined) throw new Error(`missing host loss signal for cycle ${cycle}`);
      // Submit one real active-Barrel frame, then retire its device before the
      // queue completion resolves. The receipt and its mapping are one
      // picture context; recovery must reject both together and publish a
      // fresh context on the replacement device. Keep the successor edit
      // below this frame so recovery still has to rehydrate that World-only
      // change on the new device.
      propagateTransforms(world).unwrap();
      const lateDraw = renderer.draw({
        leases: [lease],
        camera: { lease },
        environment: { lease },
        fixedStep: world.getResource(FixedTime).tick,
      });
      expect(lateDraw.ok).toBe(true);
      if (!lateDraw.ok) throw lateDraw.error;
      const lateReceipt = lateDraw.value;
      expect(lateReceipt.barrelDistortion?.strength).toBeCloseTo(0.2, 6);
      expect(lateReceipt.graphGeneration).toBeTypeOf('number');

      // Bind the recipe's ordinary successor mesh after the previous
      // submission. It has never been visible on this Renderer, so this
      // World-only edit must cause a real first-use GPU upload after recovery.
      world
        .set(recipe.entities.wall, MeshFilter, {
          assetHandle: recipe.assets.successorHandle,
        })
        .unwrap();
      world
        .set(recipe.entities.wall, MeshRenderer, {
          materials: [recipe.assets.wood, recipe.assets.metal],
        })
        .unwrap();
      world.update(1 / 60).unwrap();
      signal.trigger();
      await waitUntil(
        'device-lost',
        () => renderer.state(),
        (state) => state === 'device-lost',
      );
      expect(renderer.inspect().state).toBe('device-lost');
      const lateCompletion = await lateReceipt.completed;
      expect(lateCompletion.ok).toBe(false);
      if (!lateCompletion.ok) expect(lateCompletion.error.code).toBe('device-operation-failed');
      // Device loss retires the physical picture and clears the detached
      // mapping before recovery can expose a replacement graph.
      expect(renderer.inspect().barrelDistortion.effectiveMapping).toBeUndefined();

      const recovered = await renderer.recover();
      expect(
        recovered.ok,
        recovered.ok
          ? ''
          : JSON.stringify({
              recovery: recovered.error,
              shaderManifest: (globalThis as { __forgeaxShaderManifest?: unknown })
                .__forgeaxShaderManifest,
            }),
      ).toBe(true);
      await waitUntil(
        'alive after recovery',
        () => renderer.state(),
        (state) => state === 'alive',
      );
      await waitUntil(
        'replacement loss hook',
        () => hostLoss.signals.length,
        (count) => count >= cycle + 1,
      );
      expect(renderer.inspect().barrelDistortion.effectiveMapping).toBeUndefined();
      const staleLateObservation = await renderer.observe(lateReceipt, { include: [] });
      expect(staleLateObservation.ok).toBe(false);
      if (!staleLateObservation.ok)
        expect(staleLateObservation.error.code).toBe('frame-receipt-stale');

      // Recovery validates the device; the first completed frame reconstructs
      // derived output and scene resources from the current World.
      expect(hostLoss.signals[cycle]?.outputAllocations.buffers).toBe(0);
      expect(hostLoss.signals[cycle]?.outputAllocations.lutViews).toBeGreaterThan(0);
      expect(world.identity).toBe(worldIdentity);
      expect(lease).toBe(initialLease);
      const recoveryReadyMeshEpoch =
        renderer.inspect().recoveryEvidence.residency.meshResidencyEpoch;
      const recoveredSignal = hostLoss.signals[cycle];
      if (recoveredSignal === undefined) throw new Error(`missing recovered device ${cycle}`);
      const recoveryReadyMeshIndexBuffers = recoveredSignal.meshIndexBuffers.size;
      expect(recoveryReadyMeshIndexBuffers).toBe(0);
      world.update(1 / 60).unwrap();
      const firstRecovered = await submitFrame(
        world,
        renderer,
        lease,
        canvas,
        `cycle-${cycle}-recovered-first`,
      );
      expect(hostLoss.signals[cycle]?.outputAllocations.buffers).toBe(4);
      expect(hostLoss.signals[cycle]?.outputAllocations.lutViews).toBeGreaterThan(0);
      const firstRecoveredMeshIndexBuffers = recoveredSignal.meshIndexBuffers.size;
      expect(firstRecoveredMeshIndexBuffers).toBeGreaterThan(0);
      world.update(1 / 60).unwrap();
      const recoveredFrame = await submitFrame(
        world,
        renderer,
        lease,
        canvas,
        `cycle-${cycle}-recovered-steady`,
      );
      expect(firstRecovered.receipt.deviceGeneration).toBe(cycle);
      const successorIndex = boundIndexBuffer(hostLoss.signals[cycle], recipe.assets.successor);
      expect(successorIndex).not.toBe(apertureIndex);
      expect(recoveredFrame.receipt.deviceGeneration).toBe(cycle);
      expect(recoveredFrame.receipt.frameId).toBeGreaterThan(lateReceipt.frameId);
      expect(recoveredFrame.receipt.graphGeneration).toBeTypeOf('number');
      expect(recoveredFrame.receipt.graphGeneration).not.toBe(lateReceipt.graphGeneration);
      expect(recoveredFrame.receipt.barrelDistortion).toMatchObject({
        width: 384,
        height: 384,
        centerX: 0.5,
        centerY: 0.5,
      });
      expect(recoveredFrame.receipt.barrelDistortion?.strength).toBeCloseTo(0.2, 6);
      expect(recoveredFrame.inspection.barrelDistortion.effectiveMapping).toEqual(
        recoveredFrame.receipt.barrelDistortion,
      );
      expect(recoveredFrame.inspection.barrelDistortion.frameId).toBe(
        recoveredFrame.receipt.frameId,
      );
      expect(recoveredFrame.inspection.barrelDistortion.deviceGeneration).toBe(
        recoveredFrame.receipt.deviceGeneration,
      );
      expect(recoveredFrame.inspection.barrelDistortion.graphGeneration).toBe(
        recoveredFrame.receipt.graphGeneration,
      );
      expect(recoveredFrame.inspection.state).toBe('alive');
      expect(recoveredFrame.inspection.output.autoExposure?.receipt.committed).toBe(true);
      expect(recoveredFrame.inspection.output.standardLut?.deviceEpoch).toBe(cycle);
      expect(recoveredFrame.inspection.output.standardLut?.sourceKey).toBe(lutSourceKey);
      expect(recoveredFrame.inspection.temporal.mode).toBe('taa');
      expect(recoveredFrame.inspection.temporal.historyValid).toBe(true);
      expect(pixelStats(recoveredFrame.pixels).nonBlackPixels).toBeGreaterThan(0);
      expect(recoveredFrame.inspection.recovery.lastOutcome).toBe('succeeded');
      expect(recoveredFrame.inspection.recovery.candidateGeneration).toBe(cycle);
      expect(recoveredFrame.inspection.recoveryEvidence.graph.ready).toBe(true);
      expect(recoveredFrame.inspection.recoveryEvidence.receipts.lastGeneration).toBe(cycle);
      expect(
        pixelDelta(initialAperture.pixels, firstRecovered.pixels).changedPixels,
      ).toBeGreaterThan(0);
      expect(
        firstRecovered.inspection.recoveryEvidence.residency.meshResidencyEpoch,
      ).toBeGreaterThan(recoveryReadyMeshEpoch);
      // The World-only successor has distinct indices from the recovery seed.
      // It must allocate on the replacement device, never reuse an old handle.
      const recoveredMeshIndexBuffers = recoveredSignal.meshIndexBuffers.size;
      expect(recoveredMeshIndexBuffers).toBe(firstRecoveredMeshIndexBuffers);
      for (const buffer of recoveredSignal.meshIndexBuffers)
        expect(signal.meshIndexBuffers.has(buffer)).toBe(false);
      const recoveredResources = resourceSample(recoveredFrame.inspection);
      expect(recoveredResources.gpuCapacity).toBe(baselineResources.gpuCapacity);
      expect(recoveredResources.graphResources).toBe(apertureResources.graphResources);
      // Recovery invalidates device-bound dynamic credentials but retains the
      // World MeshFilter; the next candidate must be prepared on this device.
      expect(recoveredResources.dynamicCandidates).toBe(0);
      expect(recoveredResources.dynamicMeshBytes).toBe(0);

      const skyOn = cropPixels(recoveredFrame.pixels, 0.5, 0.2, 0.45, 0.18);
      removeAtmosphere();
      world.update(1 / 60).unwrap();
      const atmosphereOff = await submitFrame(
        world,
        renderer,
        lease,
        canvas,
        `cycle-${cycle}-atmosphere-off`,
      );
      expect(
        pixelDelta(skyOn, cropPixels(atmosphereOff.pixels, 0.5, 0.2, 0.45, 0.18)).changedPixels,
      ).toBeGreaterThan(0);
      addAtmosphere();
      world.update(1 / 60).unwrap();
      const atmosphereOn = await submitFrame(
        world,
        renderer,
        lease,
        canvas,
        `cycle-${cycle}-atmosphere-on`,
      );
      expect(pixelDelta(atmosphereOff.pixels, atmosphereOn.pixels).changedPixels).toBeGreaterThan(
        0,
      );
      expect(atmosphereOn.inspection.temporal.mode).toBe('taa');

      const closedCandidate = prepareDynamic(
        renderer,
        world,
        recipe.entities.wall,
        recipe.assets.wallClosedHandle,
        cycle + 1,
      );
      world.update(1 / 60).unwrap();
      const closed = await submitFrame(
        world,
        renderer,
        lease,
        canvas,
        `cycle-${cycle}-dynamic-closed`,
      );
      expect(renderer.dynamicGeometryReceipt(closedCandidate)?.frameId).toBe(
        closed.receipt.frameId,
      );
      expect(pixelDelta(atmosphereOn.pixels, closed.pixels).changedPixels).toBeGreaterThan(0);
      expect(closed.inspection.dynamicGeometry?.published).toBeGreaterThanOrEqual(1);
      boundIndexBuffer(hostLoss.signals[cycle], recipe.assets.wallClosed);
      expect(resourceSample(closed.inspection).graphResources).toBe(
        baselineResources.graphResources,
      );
      expect(recoveredSignal.meshIndexBuffers.size).toBe(recoveredMeshIndexBuffers);

      // Swap the ECS binding back before receipt-bound retirement. This is the
      // public unload path and keeps the dynamic candidate budget bounded.
      world
        .set(recipe.entities.wall, MeshFilter, {
          assetHandle: recipe.assets.wallApertureHandle,
        })
        .unwrap();
      world
        .set(recipe.entities.wall, MeshRenderer, {
          materials: [
            recipe.assets.wood,
            recipe.assets.metal,
            recipe.assets.wood,
            recipe.assets.metal,
          ],
        })
        .unwrap();
      world.update(1 / 60).unwrap();
      const retired = renderer.retireDynamicGeometry(closedCandidate);
      expect(retired.ok, retired.ok ? '' : JSON.stringify(retired.error)).toBe(true);
      await flushCleanup();
      const afterUnload = renderer.inspect();
      expect(afterUnload.dynamicGeometry?.meshBytes ?? 0).toBe(0);
      expect(
        (afterUnload.dynamicGeometry?.prepared ?? 0) +
          (afterUnload.dynamicGeometry?.accepted ?? 0) +
          (afterUnload.dynamicGeometry?.published ?? 0),
      ).toBe(0);
      // Publish the current ECS binding before the next host loss. The next
      // replacement device reconstructs its first frame from that current World.
      const afterUnloadFrame = await submitFrame(
        world,
        renderer,
        lease,
        canvas,
        `cycle-${cycle}-after-unload`,
      );
      expect(afterUnloadFrame.receipt.deviceGeneration).toBe(cycle);
      expect(afterUnloadFrame.inspection.dynamicGeometry?.meshBytes ?? 0).toBe(0);
      expect(
        (afterUnloadFrame.inspection.dynamicGeometry?.prepared ?? 0) +
          (afterUnloadFrame.inspection.dynamicGeometry?.accepted ?? 0) +
          (afterUnloadFrame.inspection.dynamicGeometry?.published ?? 0),
      ).toBe(0);
      const apertureAfterUnload = resourceSample(afterUnloadFrame.inspection);
      boundIndexBuffer(hostLoss.signals[cycle], recipe.assets.wallAperture);
      expect(apertureAfterUnload.graphResources).toBe(apertureResources.graphResources);
      // The aperture was absent from the first recovered World. Its first
      // ordinary binding now creates exactly one replacement-device IBO.
      expect(recoveredSignal.meshIndexBuffers.size).toBe(recoveredMeshIndexBuffers + 1);
      recoveryResources.push(recoveredResources, apertureAfterUnload);
    }

    expect(recoveryResources).toHaveLength(4);
    expect(Math.max(...recoveryResources.map((sample) => sample.gpuCapacity))).toBe(
      baselineResources.gpuCapacity,
    );
    expect(Math.max(...recoveryResources.map((sample) => sample.graphResources))).toBe(
      apertureResources.graphResources,
    );
    expect(
      Math.max(...recoveryResources.map((sample) => sample.gpuFullRebuilds)),
    ).toBeLessThanOrEqual(1);
    const expectedLossGenerations = errors
      .map(expectedHostLossGeneration)
      .filter((generation): generation is number => generation !== undefined);
    expect(errors.filter((error) => expectedHostLossGeneration(error) === undefined)).toEqual([]);
    expect(expectedLossGenerations).toEqual([0, 1]);
    expect(hostLoss.signals.every((signal) => signal.device !== undefined)).toBe(true);

    const disposed = await renderer.dispose();
    expect(disposed.ok, disposed.ok ? '' : JSON.stringify(disposed.error)).toBe(true);
    rendererDisposed = true;
    expect(renderer.state()).toBe('disposed');
    expect(renderer.inspect().state).toBe('disposed');
    expect(
      hostLoss.signals.every((signal) =>
        [...signal.indexUploads.keys()].every((buffer) => signal.retiredIndices.has(buffer)),
      ),
    ).toBe(true);
    // The same renderer is terminal after dispose; no replacement Renderer or
    // World was created during either recovery cycle.
    expect(world.identity).toBe(worldIdentity);
  } finally {
    unsubscribe();
    if (!rendererDisposed) await renderer.dispose();
    removeAtmosphere();
    for (const entity of extraAtmospheres) world.despawn(entity).unwrap();
    recipe.dispose();
    testAssets(world).release(lutHandle).unwrap();
    await scene.fiber.dispose();
    canvas.remove();
  }
}, 120_000);
