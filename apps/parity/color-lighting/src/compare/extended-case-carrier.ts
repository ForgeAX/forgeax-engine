import type { RenderInspection } from '@forgeax/engine-render';
import {
  deriveExtendedLightingCapability,
  EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES,
} from '@forgeax/engine-render/internal';
import type { SceneCase } from '../contracts/types';
import { readbackRgba16float } from '../capture/rhi-readback';
import {
  buildLightingReferenceEvidence,
  buildRecoveryLightingReferenceEvidence,
  buildSpotCombinedLightingReferenceEvidence,
  createLightingSceneManifest,
  type LightingReferenceKind,
} from './lighting-reference';
import {
  createExtendedLightingRuntime,
  type ExtendedLightingRuntimeMode,
} from './extended-lighting-runtime';

const COPY_SRC = 0x01;
const TEXTURE_BINDING = 0x04;
const RENDER_ATTACHMENT = 0x10;
const MAP_READ = 0x01;
const COPY_DST = 0x08;
const DAWN_LIGHTWEIGHT = (
  globalThis as {
    process?: { env?: Record<string, string | undefined> };
  }
).process?.env?.FORGEAX_DAWN_LIGHTWEIGHT === '1';

export type RequiredExtendedLightingCaseId = 'rect-area' | 'spot-modifiers' | 'probe' | 'recovery';

export interface ExtendedLightingCarrierSurface {
  readonly canvas: HTMLCanvasElement;
  getDevice(): GPUDevice;
  getTexture(): GPUTexture;
}

export interface ExtendedLightingRecoveryReceipt {
  readonly cycles: 3;
  readonly generations: readonly number[];
  readonly resourceCounts: readonly number[];
  readonly terminalState: 'alive';
}

export interface ExtendedLightingCarrierReceipt {
  readonly schemaVersion: 1;
  readonly caseId: RequiredExtendedLightingCaseId;
  readonly status: 'ready' | 'recovered' | 'unsupported';
  readonly verdict: 'passed' | 'notRun';
  readonly runtimeMode: ExtendedLightingRuntimeMode;
  readonly exactProductHead: string;
  readonly backendKind: string;
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly linearHdr: {
    readonly format: string;
    readonly width: number;
    readonly height: number;
    readonly byteLength: number;
    readonly rawHash: string;
  };
  readonly finalDisplay: {
    readonly format: 'rgba8unorm';
    readonly width: number;
    readonly height: number;
    readonly byteLength: number;
    readonly rawHash: string;
    readonly nonBlackPixels: number;
  };
  readonly renderErrors: readonly {
    readonly code: string;
    readonly expected?: string;
    readonly hint?: string;
  }[];
  readonly referenceKinds: readonly LightingReferenceKind[];
  readonly referenceProvenance: readonly string[];
  readonly inspection: RenderInspection;
  readonly capability: {
    readonly requiredSampledTextures: number;
    readonly maxSampledTexturesPerShaderStage: number | null;
    readonly maxTextureArrayLayers: number | null;
    readonly maxUniformBuffersPerShaderStage: number | null;
    readonly storageBuffer: boolean;
    readonly rgba16floatRenderable: boolean;
    readonly samplerAliasing: boolean;
    readonly admitted: boolean;
    readonly reason: string | undefined;
  };
  readonly unavailable?: {
    readonly topology: 'extendedLighting';
    readonly reason: string;
  };
  readonly probeComparison?: {
    readonly recordCount: number;
    readonly expectedCoverage: readonly number[];
    readonly observedCoverage: readonly number[];
    readonly maxDelta: number;
  };
  readonly recovery?: ExtendedLightingRecoveryReceipt;
}

type RuntimeBundler = Parameters<typeof createExtendedLightingRuntime>[0]['bundler'];

export type ExtendedLightingCookieContrastReceipt =
  | {
      readonly status: 'ready';
      readonly changedPixels: number;
      readonly maxChannelDelta: number;
      readonly pixelCount: number;
    }
  | {
      readonly status: 'unsupported';
      readonly reason: string;
    };

export function createExtendedLightingCarrierSurface(
  width: number,
  height: number,
): ExtendedLightingCarrierSurface {
  let device: GPUDevice | undefined;
  let texture: GPUTexture | undefined;
  const canvas = {
    width,
    height,
    getContext(kind: string): unknown {
      if (kind !== 'webgpu') return null;
      return {
        configure(desc: {
          device: GPUDevice;
          format?: GPUTextureFormat;
          usage?: number;
          viewFormats?: readonly GPUTextureFormat[];
        }) {
          texture?.destroy();
          device = desc.device;
          texture = device.createTexture({
            size: { width, height, depthOrArrayLayers: 1 },
            format: desc.format ?? 'rgba8unorm',
            usage: desc.usage ?? (RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC),
            viewFormats: [...(desc.viewFormats ?? [])],
          });
        },
        unconfigure() {
          texture?.destroy();
          texture = undefined;
        },
        getCurrentTexture() {
          if (texture === undefined) throw new Error('extended-lighting surface is not configured');
          return texture;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;
  return {
    canvas,
    getDevice() {
      if (device === undefined) throw new Error('extended-lighting surface device is unavailable');
      return device;
    },
    getTexture() {
      if (texture === undefined) throw new Error('extended-lighting surface texture is unavailable');
      return texture;
    },
  };
}

function runtimeMode(caseId: RequiredExtendedLightingCaseId): ExtendedLightingRuntimeMode {
  switch (caseId) {
    case 'rect-area': return 'rect';
    case 'spot-modifiers': return 'spot-combined';
    case 'probe': return 'probe';
    case 'recovery': return 'recovery';
  }
}

function sceneManifestMode(caseId: RequiredExtendedLightingCaseId): 'rect' | 'ies' | 'probe' {
  switch (caseId) {
    case 'rect-area': return 'rect';
    case 'spot-modifiers':
    case 'recovery': return 'ies';
    case 'probe': return 'probe';
  }
}

function referenceEvidence(caseId: RequiredExtendedLightingCaseId) {
  switch (caseId) {
    case 'rect-area': return [buildLightingReferenceEvidence('rect', true)];
    case 'spot-modifiers': return [buildSpotCombinedLightingReferenceEvidence(true)];
    case 'probe': return [buildLightingReferenceEvidence('probe', true)];
    case 'recovery': return [buildRecoveryLightingReferenceEvidence(true)];
  }
}

function hashBytes(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function readSurfacePixels(
  surface: ExtendedLightingCarrierSurface,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const device = surface.getDevice();
  const unpaddedBytesPerRow = width * 4;
  const bytesPerRow = Math.ceil(unpaddedBytesPerRow / 256) * 256;
  const buffer = device.createBuffer({
    size: bytesPerRow * height,
    usage: MAP_READ | COPY_DST,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: surface.getTexture() },
    { buffer, bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(MAP_READ);
  const mapped = new Uint8Array(buffer.getMappedRange());
  const pixels = new Uint8Array(unpaddedBytesPerRow * height);
  for (let row = 0; row < height; row += 1) {
    pixels.set(
      mapped.subarray(row * bytesPerRow, row * bytesPerRow + unpaddedBytesPerRow),
      row * unpaddedBytesPerRow,
    );
  }
  buffer.unmap();
  buffer.destroy();
  return pixels;
}

function countNonBlackPixels(bytes: Uint8Array): number {
  let count = 0;
  for (let index = 0; index + 3 < bytes.length; index += 4) {
    if ((bytes[index] ?? 0) > 2 || (bytes[index + 1] ?? 0) > 2 || (bytes[index + 2] ?? 0) > 2) count += 1;
  }
  return count;
}

function compareCookieResponses(left: Uint8Array, right: Uint8Array): {
  readonly changedPixels: number;
  readonly maxChannelDelta: number;
} {
  if (left.byteLength !== right.byteLength || left.byteLength % 4 !== 0) {
    throw new Error(`Cookie contrast requires equal RGBA8 buffers: ${left.byteLength} vs ${right.byteLength}`);
  }
  let changedPixels = 0;
  let maxChannelDelta = 0;
  for (let index = 0; index < left.length; index += 4) {
    const delta = Math.max(
      Math.abs((left[index] ?? 0) - (right[index] ?? 0)),
      Math.abs((left[index + 1] ?? 0) - (right[index + 1] ?? 0)),
      Math.abs((left[index + 2] ?? 0) - (right[index + 2] ?? 0)),
    );
    maxChannelDelta = Math.max(maxChannelDelta, delta);
    if (delta > 2) changedPixels += 1;
  }
  return { changedPixels, maxChannelDelta };
}

async function captureCookieVariant(input: {
  readonly fixture: SceneCase;
  readonly exactProductHead: string;
  readonly bundler: RuntimeBundler;
  readonly variant: 'quadrants' | 'opaque-white';
}): Promise<
  | { readonly status: 'ready'; readonly bytes: Uint8Array }
  | { readonly status: 'unsupported'; readonly reason: string }
> {
  const sceneData = await createLightingSceneManifest(
    'cookie',
    input.exactProductHead,
    true,
    input.variant,
  );
  const surface = createExtendedLightingCarrierSurface(input.fixture.scene.width, input.fixture.scene.height);
  const session = await createExtendedLightingRuntime({
    canvas: surface.canvas,
    mode: 'cookie',
    assets: { ies: sceneData.ies, cookie: sceneData.cookie },
    manifest: sceneData.manifest,
    bundler: input.bundler,
    frameCount: 12,
    comparisonMode: true,
  });
  try {
    const capability = extendedLightingCapability(session);
    if (!capability.admitted) return { status: 'unsupported', reason: capability.reason ?? 'extendedLighting unavailable' };
    const finalBytes = await readSurfacePixels(surface, input.fixture.scene.width, input.fixture.scene.height);
    if (countNonBlackPixels(finalBytes) === 0) throw new Error(`Cookie ${input.variant} capture is all black`);
    const inspection = session.inspect();
    if (inspection.state !== 'alive') throw new Error(`Cookie ${input.variant} renderer state is ${inspection.state}`);
    if (session.renderErrors.length > 0) {
      throw new Error(`Cookie ${input.variant} renderer emitted errors: ${JSON.stringify(session.renderErrors)}`);
    }
    return { status: 'ready', bytes: finalBytes };
  } finally {
    await session.dispose();
  }
}

/**
 * Live-GPU falsifier for the cookie transport. A white texture and the
 * authored quadrant texture must produce different final display bytes; a
 * green test that only checks readiness/resources would miss a disconnected
 * shader sample or a stale fallback texture.
 */
export async function runExtendedLightingCookieContrast(input: {
  readonly fixture: SceneCase;
  readonly exactProductHead: string;
  readonly bundler: RuntimeBundler;
}): Promise<ExtendedLightingCookieContrastReceipt> {
  const quadrants = await captureCookieVariant({ ...input, variant: 'quadrants' });
  if (quadrants.status === 'unsupported') return quadrants;
  const opaqueWhite = await captureCookieVariant({ ...input, variant: 'opaque-white' });
  if (opaqueWhite.status === 'unsupported') return opaqueWhite;
  const contrast = compareCookieResponses(quadrants.bytes, opaqueWhite.bytes);
  return {
    status: 'ready',
    ...contrast,
    pixelCount: quadrants.bytes.byteLength / 4,
  };
}

async function waitForState(
  getState: () => string,
  expected: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (getState() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`renderer did not reach ${expected}; current=${getState()}`);
}

async function recoverThreeTimes(
  session: Awaited<ReturnType<typeof createExtendedLightingRuntime>>,
): Promise<ExtendedLightingRecoveryReceipt> {
  const generations = [session.inspect().frame.deviceGeneration];
  const resourceCounts = [session.inspect().extendedLighting.resourceCount];
  for (let cycle = 0; cycle < 3; cycle += 1) {
    if (session.forceDeviceLoss === undefined) {
      throw new Error('recovery carrier is missing its controlled device-loss trigger');
    }
    session.forceDeviceLoss();
    await waitForState(() => session.renderer.state(), 'device-lost');
    const recovered = await session.renderer.recover();
    if (!recovered.ok) throw recovered.error;
    await session.draw(2);
    const inspection = session.inspect();
    if (inspection.state !== 'alive') throw new Error(`recovery cycle ${cycle + 1} ended in ${inspection.state}`);
    generations.push(inspection.frame.deviceGeneration);
    resourceCounts.push(inspection.extendedLighting.resourceCount);
  }
  if (!generations.every((generation, index) => index === 0 || generation > (generations[index - 1] ?? -1))) {
    throw new Error(`recovery generations are not strictly increasing: ${generations.join(',')}`);
  }
  const baseline = resourceCounts[0] ?? 0;
  if (resourceCounts.some((count) => count > baseline)) {
    throw new Error(`recovery resource count grew: ${resourceCounts.join(',')}`);
  }
  return { cycles: 3, generations, resourceCounts, terminalState: 'alive' };
}

function probeComparison(
  caseId: RequiredExtendedLightingCaseId,
  inspection: RenderInspection,
) {
  if (caseId !== 'probe') return undefined;
  const reference = buildLightingReferenceEvidence('probe', true).probe?.objects ?? [];
  const records = inspection.renderScene.probeBlend?.records ?? [];
  const expectedCoverage = reference.map((object) => Math.fround(object.C)).sort((left, right) => left - right);
  const observedCoverage = records.map((record) => record.localBlendFraction).sort((left, right) => left - right);
  if (expectedCoverage.length !== observedCoverage.length || expectedCoverage.length === 0) {
    throw new Error(`probe record count mismatch expected=${expectedCoverage.length} observed=${observedCoverage.length}`);
  }
  const maxDelta = expectedCoverage.reduce(
    (maximum, expected, index) => Math.max(maximum, Math.abs(expected - (observedCoverage[index] ?? Number.NaN))),
    0,
  );
  if (!Number.isFinite(maxDelta) || maxDelta > 1e-5) {
    throw new Error(`probe coverage mismatch maxDelta=${maxDelta}`);
  }
  return { recordCount: records.length, expectedCoverage, observedCoverage, maxDelta };
}

function extendedLightingCapability(session: Awaited<ReturnType<typeof createExtendedLightingRuntime>>) {
  const inspection = session.inspect();
  const result = deriveExtendedLightingCapability(session.device);
  return {
    requiredSampledTextures: EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES,
    maxSampledTexturesPerShaderStage: session.device.limits.maxSampledTexturesPerShaderStage ?? null,
    maxTextureArrayLayers: session.device.limits.maxTextureArrayLayers ?? null,
    maxUniformBuffersPerShaderStage: session.device.limits.maxUniformBuffersPerShaderStage ?? null,
    storageBuffer: inspection.capabilities.storageBuffer,
    rgba16floatRenderable: inspection.capabilities.rgba16floatRenderable,
    samplerAliasing: inspection.capabilities.samplerAliasing,
    admitted: result.admitted,
    reason: result.reason,
  };
}

export async function runExtendedLightingCarrier(input: {
  readonly fixture: SceneCase;
  readonly exactProductHead: string;
  readonly bundler: RuntimeBundler;
}): Promise<ExtendedLightingCarrierReceipt> {
  const caseId = input.fixture.caseId as RequiredExtendedLightingCaseId;
  if (!['rect-area', 'spot-modifiers', 'probe', 'recovery'].includes(caseId)) {
    throw new Error(`unsupported extended-lighting carrier ${input.fixture.caseId}`);
  }
  const mode = runtimeMode(caseId);
  const sceneData = await createLightingSceneManifest(
    sceneManifestMode(caseId),
    input.exactProductHead,
    caseId !== 'recovery',
  );
  const surface = createExtendedLightingCarrierSurface(input.fixture.scene.width, input.fixture.scene.height);
  const session = await createExtendedLightingRuntime({
    canvas: surface.canvas,
    mode,
    assets: { ies: sceneData.ies, cookie: sceneData.cookie },
    manifest: sceneData.manifest,
    bundler: input.bundler,
    // The carrier's assertions are readback/inspection based; twelve warmup
    // frames are useful for local/nightly evidence, while the CI Dawn profile
    // needs only four settled submissions before the same observations.
    frameCount: DAWN_LIGHTWEIGHT ? 4 : 12,
    ...(caseId === 'recovery'
      ? { deviceLoss: { destroyCurrentDevice: () => surface.getDevice().destroy() } }
      : {}),
  });
  try {
    const capability = extendedLightingCapability(session);
    const requiresExtendedLighting = caseId === 'rect-area'
      || caseId === 'spot-modifiers'
      || caseId === 'recovery';
    const unsupported = requiresExtendedLighting && !capability.admitted;
    const recovery = caseId === 'recovery' && !unsupported ? await recoverThreeTimes(session) : undefined;
    const observation = await session.observationHost.observeCurrentFrame({
      semantic: 'linear-hdr',
      readback: (lease) => readbackRgba16float(session.device, lease),
    });
    if (!observation.ok) throw observation.error;
    const finalBytes = await readSurfacePixels(surface, input.fixture.scene.width, input.fixture.scene.height);
    const nonBlackPixels = countNonBlackPixels(finalBytes);
    if (nonBlackPixels === 0) throw new Error(`${caseId} final display is all black`);
    const inspection = session.inspect();
    if (inspection.state !== 'alive') throw new Error(`${caseId} renderer state is ${inspection.state}`);
    const unexpectedRenderErrors = session.renderErrors.filter(
      (error) => !(caseId === 'recovery' && error.code === 'device-lost'),
    );
    if (unexpectedRenderErrors.length > 0) {
      throw new Error(`${caseId} renderer emitted errors: ${JSON.stringify(unexpectedRenderErrors)}`);
    }
    if ((caseId === 'rect-area' || caseId === 'spot-modifiers' || caseId === 'recovery')
      && !unsupported
      && inspection.extendedLighting.accepted === undefined) {
      throw new Error(`${caseId} has no accepted extendedLighting identity: ${JSON.stringify({
        state: inspection.state,
        extendedLighting: inspection.extendedLighting,
        extendedLightingCapability: capability,
        renderErrors: session.renderErrors,
      })}`);
    }
    if (!unsupported && inspection.extendedLighting.failure !== undefined) {
      throw new Error(`${caseId} extendedLighting failed: ${inspection.extendedLighting.failure}`);
    }
    const references = referenceEvidence(caseId);
    const probe = probeComparison(caseId, inspection);
    return {
      schemaVersion: 1,
      caseId,
      status: unsupported ? 'unsupported' : recovery === undefined ? 'ready' : 'recovered',
      verdict: unsupported ? 'notRun' : 'passed',
      runtimeMode: mode,
      exactProductHead: input.exactProductHead,
      backendKind: inspection.capabilities.backendKind,
      frameId: inspection.frame.frameId,
      deviceGeneration: inspection.frame.deviceGeneration,
      linearHdr: {
        format: observation.value.metadata.format,
        width: observation.value.metadata.size.width,
        height: observation.value.metadata.size.height,
        byteLength: observation.value.bytes.byteLength,
        rawHash: hashBytes(observation.value.bytes),
      },
      finalDisplay: {
        format: 'rgba8unorm',
        width: input.fixture.scene.width,
        height: input.fixture.scene.height,
        byteLength: finalBytes.byteLength,
        rawHash: hashBytes(finalBytes),
        nonBlackPixels,
      },
      renderErrors: session.renderErrors,
      referenceKinds: references.map((reference) => reference.referenceKind),
      referenceProvenance: references.flatMap((reference) => reference.adapters.map((adapter) => adapter.adapterId)),
      inspection,
      capability,
      ...(unsupported
        ? {
            unavailable: {
              topology: 'extendedLighting' as const,
              reason: capability.reason ?? 'extendedLighting capability is unavailable',
            },
          }
        : {}),
      ...(probe === undefined ? {} : { probeComparison: probe }),
      ...(recovery === undefined ? {} : { recovery }),
    };
  } finally {
    await session.dispose();
  }
}
