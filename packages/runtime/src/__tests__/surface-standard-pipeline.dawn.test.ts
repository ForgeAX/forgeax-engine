import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer as createTcpServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { halfFloat } from '@forgeax/engine-math';
import { decodeMaterialProgramWire } from '@forgeax/engine-pack/runtime';
import {
  Camera,
  DynamicResolution,
  LightProbe,
  PointLight,
  type Renderer,
} from '@forgeax/engine-render';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { attachRecorder, type RecorderAttachment } from '@forgeax/engine-rhi-debug';
import * as captureWebgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';
import {
  createStandaloneRuntimeAssetBinding,
  type RuntimeAssetBinding,
} from '@forgeax/engine-types';
import { createServer, loadConfigFromFile } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { createDevImportTransport } from '../dev-import-transport';
import { constructRuntimeRendererHost, type RendererHostAssembly } from '../renderer-host';
import { renderValue } from './standard-gbuffer-replay.fixture';
import {
  assertMaterialPayload,
  assertSurfacePixelFalsification,
  createSurfaceDynamicInput,
  createSurfaceWaterInstanceTransforms,
  loadSurfaceMaterial,
  parseSurfaceGuid,
  populateSurfaceWorld,
  runSurfaceManagedMediumOracle,
  runSurfaceMsaaEdgeOracle,
  runSurfaceOpticalOracle,
  SURFACE_CASES,
  SURFACE_CLOSURE,
  SURFACE_HEIGHT,
  SURFACE_PIXEL_EPSILON,
  SURFACE_WIDTH,
} from './surface-standard-pipeline.runtime-fixture';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const EVIDENCE_SOURCE_SHA = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: rootDir,
  encoding: 'utf8',
}).trim();
const EVIDENCE_BUILD_ID = `vitest-dawn-${EVIDENCE_SOURCE_SHA.slice(0, 12)}`;

async function loadPreviewConfig() {
  const previousSurfaceOnly = process.env.FORGEAX_SURFACE_ONLY;
  process.env.FORGEAX_SURFACE_ONLY = '1';
  try {
    const loaded = await loadConfigFromFile(
      { command: 'serve', mode: 'test', isSsrBuild: false, isPreview: false },
      resolve(rootDir, 'apps/preview/vite.config.ts'),
      rootDir,
    );
    if (loaded === null) throw new Error('surface-standard: Preview Vite config unavailable');
    return loaded.config;
  } finally {
    if (previousSurfaceOnly === undefined) delete process.env.FORGEAX_SURFACE_ONLY;
    else process.env.FORGEAX_SURFACE_ONLY = previousSurfaceOnly;
  }
}

async function allocateLoopbackPort(): Promise<number> {
  const probe = createTcpServer();
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error): void => {
        probe.off('listening', onListening);
        rejectListen(error);
      };
      const onListening = (): void => {
        probe.off('error', onError);
        resolveListen();
      };
      probe.once('error', onError);
      probe.once('listening', onListening);
      probe.listen(0, '127.0.0.1');
    });
    const address = probe.address();
    if (address === null || typeof address === 'string') {
      throw new Error('surface-standard: loopback port probe did not expose a TCP address');
    }
    expect(address.port).toBeGreaterThan(0);
    return address.port;
  } finally {
    if (probe.listening) {
      await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
    }
  }
}

const ROI_RADIUS = Math.max(1, Math.round(SURFACE_WIDTH / 120));
const BYTES_PER_ROW = Math.ceil((SURFACE_WIDTH * 4) / 256) * 256;
const TEXTURE_USAGE_COPY_SRC = 0x01;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const BUFFER_USAGE_MAP_READ = 0x0001;
const BUFFER_USAGE_COPY_DST = 0x0008;
const MAP_MODE_READ = 0x0001;
const DAWN_TEARDOWN_TIMEOUT_MS = 60_000;
const SURFACE_DAWN_LIGHTWEIGHT = process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1';
const SURFACE_TIMELINE = SURFACE_DAWN_LIGHTWEIGHT
  ? {
      totalFrames: 20,
      direct: 1,
      gpu: 3,
      directRestored: 5,
      swapProbes: 6,
      swappedProbes: 7,
      restoreProbes: 8,
      restoredProbes: 9,
      paused: [10, 11] as const,
      resumed: 12,
      active: [13, 14] as const,
      stopped: 15,
    }
  : {
      totalFrames: 300,
      direct: 9,
      gpu: 19,
      directRestored: 29,
      swapProbes: 30,
      swappedProbes: 39,
      restoreProbes: 40,
      restoredProbes: 49,
      paused: [100, 149] as const,
      resumed: 199,
      active: [200, 249] as const,
      stopped: 250,
    };

function describeStructuredError(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error);
  const candidate = error as {
    readonly code?: unknown;
    readonly expected?: unknown;
    readonly hint?: unknown;
    readonly detail?: unknown;
    readonly message?: unknown;
  };
  return JSON.stringify({
    code: candidate.code,
    expected: candidate.expected,
    hint: candidate.hint,
    detail: candidate.detail,
    message: candidate.message,
  });
}

function parseStructuredError(error: unknown): unknown {
  const encoded = describeStructuredError(error);
  try {
    return JSON.parse(encoded);
  } catch {
    return encoded;
  }
}

type DawnCanvas = HTMLCanvasElement & { target?: GPUTexture };

function absoluteBinding(binding: RuntimeAssetBinding, baseUrl: string): RuntimeAssetBinding {
  return {
    ...binding,
    catalogUrl: new URL(binding.catalogUrl, baseUrl).href,
    importUrlBase: new URL(binding.importUrlBase, baseUrl).href,
    packageUrlBase: new URL(binding.packageUrlBase, baseUrl).href,
  };
}

function createDawnCanvas(onDevice: (device: GPUDevice) => void): DawnCanvas {
  let configured: { readonly device: GPUDevice; readonly format: GPUTextureFormat } | undefined;
  let targetSize = { width: 0, height: 0 };
  const ensureTarget = (): GPUTexture => {
    if (configured === undefined) throw new Error('surface-standard: target not configured');
    if (
      canvas.target === undefined ||
      targetSize.width !== canvas.width ||
      targetSize.height !== canvas.height
    ) {
      canvas.target?.destroy();
      canvas.target = configured.device.createTexture({
        size: { width: canvas.width, height: canvas.height, depthOrArrayLayers: 1 },
        format: configured.format,
        usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_COPY_SRC,
        viewFormats: ['rgba8unorm-srgb'],
      });
      targetSize = { width: canvas.width, height: canvas.height };
    }
    return canvas.target;
  };
  const canvas = {
    width: SURFACE_WIDTH,
    height: SURFACE_HEIGHT,
    getContext(kind: string): unknown {
      if (kind !== 'webgpu') return null;
      return {
        configure(descriptor: { device: GPUDevice; format?: GPUTextureFormat }) {
          if (configured !== undefined && configured.device !== descriptor.device) {
            canvas.target?.destroy();
            delete canvas.target;
            targetSize = { width: 0, height: 0 };
          }
          onDevice(descriptor.device);
          configured = { device: descriptor.device, format: descriptor.format ?? 'rgba8unorm' };
          ensureTarget();
        },
        unconfigure() {},
        getCurrentTexture() {
          return ensureTarget();
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as DawnCanvas;
  return canvas;
}

async function readPresentedPixels(device: GPUDevice, texture: GPUTexture): Promise<Uint8Array> {
  const buffer = device.createBuffer({
    size: BYTES_PER_ROW * SURFACE_HEIGHT,
    usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture },
    { buffer, bytesPerRow: BYTES_PER_ROW, rowsPerImage: SURFACE_HEIGHT },
    { width: SURFACE_WIDTH, height: SURFACE_HEIGHT, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  await buffer.mapAsync(MAP_MODE_READ);
  const pixels = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  return pixels;
}

function samplePresentedPixel(
  pixels: Uint8Array,
  index: number,
): readonly [number, number, number, number] {
  const x = Math.min(
    SURFACE_WIDTH - 1,
    Math.max(0, Math.floor(((index + 0.5) * SURFACE_WIDTH) / SURFACE_CASES.length)),
  );
  const offset = Math.floor(SURFACE_HEIGHT / 2) * BYTES_PER_ROW + x * 4;
  return [
    pixels[offset] ?? 0,
    pixels[offset + 1] ?? 0,
    pixels[offset + 2] ?? 0,
    pixels[offset + 3] ?? 0,
  ];
}

function samplePresentedRoi(
  pixels: Uint8Array,
  index: number,
): readonly [number, number, number, number] {
  const centerX = Math.min(
    SURFACE_WIDTH - 1,
    Math.max(0, Math.floor(((index + 0.5) * SURFACE_WIDTH) / SURFACE_CASES.length)),
  );
  const centerY = Math.floor(SURFACE_HEIGHT / 2);
  const sum = [0, 0, 0, 0];
  let count = 0;
  for (let y = centerY - ROI_RADIUS; y < centerY + ROI_RADIUS; y += 1) {
    for (let x = centerX - ROI_RADIUS; x < centerX + ROI_RADIUS; x += 1) {
      const offset = y * BYTES_PER_ROW + x * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        sum[channel] = (sum[channel] ?? 0) + (pixels[offset + channel] ?? 0);
      }
      count += 1;
    }
  }
  return sum.map((value) => Math.round(value / count)) as unknown as readonly [
    number,
    number,
    number,
    number,
  ];
}

function samplePresentedRoiPixels(pixels: Uint8Array, index: number): Uint8Array {
  const centerX = Math.min(
    SURFACE_WIDTH - 1,
    Math.max(0, Math.floor(((index + 0.5) * SURFACE_WIDTH) / SURFACE_CASES.length)),
  );
  const centerY = Math.floor(SURFACE_HEIGHT / 2);
  const sampled = new Uint8Array((ROI_RADIUS * 2) ** 2 * 4);
  let target = 0;
  for (let y = centerY - ROI_RADIUS; y < centerY + ROI_RADIUS; y += 1) {
    for (let x = centerX - ROI_RADIUS; x < centerX + ROI_RADIUS; x += 1) {
      const source = y * BYTES_PER_ROW + x * 4;
      sampled.set(pixels.subarray(source, source + 4), target);
      target += 4;
    }
  }
  return sampled;
}

function roiPixelDistance(left: Uint8Array, right: Uint8Array): number {
  if (left.byteLength !== right.byteLength) {
    throw new Error('surface-standard: fixed ROI byte lengths differ');
  }
  let maximum = 0;
  for (let offset = 0; offset < left.byteLength; offset += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      maximum = Math.max(
        maximum,
        Math.abs((left[offset + channel] ?? 0) - (right[offset + channel] ?? 0)),
      );
    }
  }
  return maximum / 255;
}

type SurfaceRenderInspection = ReturnType<Renderer['inspect']>;
type SurfaceSubmissionReceipt = NonNullable<SurfaceRenderInspection['renderScene']['submission']>;
type SurfaceGpuDrivenInspection = SurfaceRenderInspection['renderScene']['gpuDriven'];
type SurfaceArtifactInspection = NonNullable<SurfaceGpuDrivenInspection['surfaceArtifact']>;
type SurfaceRoi = readonly [number, number, number, number];
type SurfaceWorldLayout = ReturnType<typeof populateSurfaceWorld>;
type SurfaceDynamicInput = ReturnType<typeof createSurfaceDynamicInput>;
type SurfaceWorldLease = Extract<ReturnType<Renderer['attach']>, { ok: true }>['value'];
type SurfaceMsaaEdgeEvidence = Awaited<ReturnType<typeof runSurfaceMsaaEdgeOracle>>;
type SurfaceCase = (typeof SURFACE_CASES)[number];
type SurfaceAssets = RendererHostAssembly['assets'];
type SurfaceCatalogRow = ReturnType<SurfaceAssets['listCatalog']>[number];
type SurfaceDeviceLoss = Awaited<RhiDevice['lost']>;

/**
 * Native-device observer: records validation errors, keeps the temporal target
 * copyable and remembers the scene-data target the last frame wrote.
 */
class SurfaceDawnDeviceObserver {
  readonly nativeErrors: string[] = [];
  readonly textureViews = new WeakMap<object, GPUTexture>();
  temporalTarget: GPUTexture | undefined;
  injectDeviceLoss: ((info: SurfaceDeviceLoss) => void) | undefined;

  instrument(created: GPUDevice): void {
    created.addEventListener('uncapturederror', (event) =>
      this.nativeErrors.push(event.error.message),
    );
    const createTexture = created.createTexture.bind(created);
    created.createTexture = (descriptor) => {
      // The observer reads the existing motion target; production keeps its
      // render/sample-only usage and performs no diagnostic readback.
      const texture = createTexture(
        descriptor.label === 'standard-scene-temporal'
          ? { ...descriptor, usage: descriptor.usage | TEXTURE_USAGE_COPY_SRC }
          : descriptor,
      );
      const createView = texture.createView.bind(texture);
      texture.createView = (viewDescriptor) => {
        const view = createView(viewDescriptor);
        this.textureViews.set(view, texture);
        return view;
      };
      return texture;
    };
    const createEncoder = created.createCommandEncoder.bind(created);
    created.createCommandEncoder = (descriptor) => {
      const encoder = createEncoder(descriptor);
      const begin = encoder.beginRenderPass.bind(encoder);
      encoder.beginRenderPass = (descriptor) => {
        this.observeRenderPass(descriptor);
        return begin(descriptor);
      };
      return encoder;
    };
  }

  /** The renderer-owned device-loss seam, raced against a test-injected loss. */
  deviceLost(
    device: RhiDevice,
    recorder: RecorderAttachment | undefined,
  ): Promise<SurfaceDeviceLoss> {
    return Promise.race([
      device.lost,
      new Promise<SurfaceDeviceLoss>((resolveLost) => {
        this.injectDeviceLoss = resolveLost;
      }),
    ]).then((info) => {
      recorder?.deviceLost();
      return info;
    });
  }

  private observeRenderPass(descriptor: GPURenderPassDescriptor): void {
    const attachments = Array.from(descriptor.colorAttachments);
    const view = attachments.at(-1)?.view;
    const target = view == null ? undefined : this.textureViews.get(view);
    if (
      descriptor.label === 'standard-scene-data' ||
      ((descriptor.label === 'g-buffer' || descriptor.label === 'g-buffer-late') &&
        attachments.length >= 6 &&
        target?.format === 'rgba16float')
    )
      this.temporalTarget = target;
  }
}

async function createPreviewServer(): Promise<Awaited<ReturnType<typeof createServer>>> {
  const previewInlineConfig = await loadPreviewConfig();
  const previewServer = {
    host: '127.0.0.1',
    port: await allocateLoopbackPort(),
    strictPort: true,
    ...(previewInlineConfig.server?.fs === undefined ? {} : { fs: previewInlineConfig.server.fs }),
  };
  return createServer({
    ...previewInlineConfig,
    configFile: false,
    root: resolve(rootDir, 'apps/preview'),
    logLevel: 'error',
    server: previewServer,
  });
}

interface SurfacePublication {
  readonly surfaceCase: SurfaceCase;
  readonly row: SurfaceCatalogRow | undefined;
  readonly publication: { readonly generation?: unknown; readonly digest?: unknown };
  readonly material: MaterialAsset;
}

/** Every Surface case resolves through the live catalog to a published, decodable program. */
async function loadSurfacePublications(assets: SurfaceAssets): Promise<{
  readonly materials: MaterialAsset[];
  readonly publications: SurfacePublication[];
}> {
  await Promise.all(
    SURFACE_CASES.map(async ({ guid }) => (await assets.load(guid, 'material')).unwrap()),
  );
  const catalog = assets.listCatalog();
  const materials: MaterialAsset[] = [];
  const publications: SurfacePublication[] = [];
  for (const surfaceCase of SURFACE_CASES) {
    const row = catalog.find((entry) => entry.guid.toLowerCase() === surfaceCase.guid);
    expect(row?.sourceKey).toBe(surfaceCase.sourceKey);
    expect(row?.packageUrl).toMatch(/^http/);
    const publicationResponse = await fetch(row?.packageUrl ?? '');
    expect(publicationResponse.ok).toBe(true);
    const decoded = decodeMaterialProgramWire(await publicationResponse.json());
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error(decoded.error.expected);
    const publication = decoded.value as {
      generation?: unknown;
      digest?: unknown;
    };
    expect(Number.isSafeInteger(publication.generation)).toBe(true);
    expect(typeof publication.digest).toBe('string');
    const loaded = await loadSurfaceMaterial(assets, parseSurfaceGuid(surfaceCase.guid));
    expect(loaded.ok, loaded.ok ? '' : describeStructuredError(loaded.error)).toBe(true);
    if (!loaded.ok) throw new Error(describeStructuredError(loaded.error));
    const material = assertMaterialPayload(surfaceCase, loaded.value);
    materials.push(material);
    publications.push({ surfaceCase, row, publication, material });
  }
  return { materials, publications };
}

async function expectOpticalOracle(renderer: Renderer, assets: SurfaceAssets): Promise<void> {
  const opticalEvidence = await runSurfaceOpticalOracle(renderer, assets);
  expect(opticalEvidence.observation.format).toBe('rgba16float');
  expect(opticalEvidence.observation.frameId).toBe(opticalEvidence.receipt.frameId);
  expect(opticalEvidence.records.every((record) => record.maxError <= 0.05)).toBe(true);
  // biome-ignore lint/suspicious/noConsole: linear HDR oracle evidence is the test artifact.
  console.log(
    JSON.stringify({
      kind: 'surface-water-linear-hdr-optical-oracle',
      backend: 'dawn-native',
      ...opticalEvidence,
      records: opticalEvidence.records.map(({ samples: _samples, ...record }) => record),
    }),
  );
}

async function expectMsaaEdgeOracle(
  renderer: Renderer,
  assets: SurfaceAssets,
  canvas: () => DawnCanvas | undefined,
): Promise<SurfaceMsaaEdgeEvidence> {
  const msaaEdgeEvidence = await runSurfaceMsaaEdgeOracle(renderer, assets, {
    get width() {
      return canvas()?.width ?? SURFACE_WIDTH;
    },
    get height() {
      return canvas()?.height ?? SURFACE_HEIGHT;
    },
    setBackingSize(width, height) {
      const current = canvas();
      if (current === undefined) throw new Error('surface-msaa-edge: Dawn canvas unavailable');
      current.width = width;
      current.height = height;
    },
  });
  expect(msaaEdgeEvidence.witnesses).toHaveLength(5);
  expect(
    msaaEdgeEvidence.witnesses.every(
      (witness) =>
        witness.eligiblePixelCount > 0 &&
        witness.failedPixelCount === 0 &&
        witness.maxError <= 0.05,
    ),
  ).toBe(true);
  expect(
    msaaEdgeEvidence.witnesses.filter(
      (witness) => witness.resolveExpectation === 'nearest-opaque-pair',
    ),
  ).toHaveLength(2);
  expect(msaaEdgeEvidence.movementWitnessCount).toBe(15);
  expect(msaaEdgeEvidence.resizedWitnessCount).toBe(5);
  expect(msaaEdgeEvidence.fourX).toHaveLength(3);
  expect(msaaEdgeEvidence.resized.fourX.observation.width).toBeGreaterThan(SURFACE_WIDTH);
  // biome-ignore lint/suspicious/noConsole: receipt-bound edge evidence is the test artifact.
  console.log(
    JSON.stringify({
      kind: 'surface-water-msaa-edge-oracle',
      backend: 'dawn-webgpu',
      ...msaaEdgeEvidence,
    }),
  );
  return msaaEdgeEvidence;
}

/** The attached Surface World and the live Dawn surface its frames present into. */
interface SurfaceDawnRun {
  readonly renderer: Renderer;
  readonly world: World;
  readonly lease: SurfaceWorldLease;
  readonly layout: SurfaceWorldLayout;
  readonly materials: readonly MaterialAsset[];
  readonly observer: SurfaceDawnDeviceObserver;
  readonly recorder: RecorderAttachment | undefined;
  readonly captureRoot: string | undefined;
  readonly rendererErrors: unknown[];
  readonly laneParity: boolean;
  /** The current device and presented texture; recovery replaces both. */
  readonly presented: () => { readonly device: GPUDevice | undefined; readonly canvas: DawnCanvas };
}

async function readSurfaceTarget(run: SurfaceDawnRun, unavailable: string): Promise<Uint8Array> {
  const { device, canvas } = run.presented();
  if (device === undefined || canvas.target === undefined) throw new Error(unavailable);
  return readPresentedPixels(device, canvas.target);
}

const SURFACE_LANE_EVIDENCE_FRAMES: readonly number[] = [
  SURFACE_TIMELINE.direct,
  SURFACE_TIMELINE.gpu,
  SURFACE_TIMELINE.directRestored,
  SURFACE_TIMELINE.swappedProbes,
  SURFACE_TIMELINE.restoredProbes,
];

const SURFACE_EVIDENCE_FRAMES: readonly number[] = [
  ...SURFACE_LANE_EVIDENCE_FRAMES,
  ...SURFACE_TIMELINE.paused,
  SURFACE_TIMELINE.resumed,
  ...SURFACE_TIMELINE.active,
  SURFACE_TIMELINE.stopped,
];

/** Dynamic-input event clock of one timeline frame: hold, pause, resume, then activate. */
function surfaceTimelineFrameTime(frame: number, laneParity: boolean): number {
  const pausedTime = 100 / 60;
  if (laneParity && frame <= SURFACE_TIMELINE.restoredProbes) return 0.5;
  if (!SURFACE_DAWN_LIGHTWEIGHT && frame < 100) return frame / 60;
  if (frame <= SURFACE_TIMELINE.paused[1]) return pausedTime;
  if (frame <= SURFACE_TIMELINE.resumed)
    return SURFACE_DAWN_LIGHTWEIGHT ? 149 / 60 : (frame - 50) / 60;
  return frame >= SURFACE_TIMELINE.active[0] ? 2.5 : pausedTime;
}

function setSurfaceProbeIrradiance(
  world: World,
  layout: SurfaceWorldLayout,
  irradiance: readonly [Float32Array, Float32Array],
): void {
  world
    .set(layout.probeDomains[0].entity, LightProbe, { irradiance: irradiance[0], radius: 1.0 })
    .unwrap();
  world
    .set(layout.probeDomains[1].entity, LightProbe, { irradiance: irradiance[1], radius: 1.0 })
    .unwrap();
}

/** Lane parity swaps the two probe domains' irradiance, then restores it. */
function applyTimelineProbeEdits(run: SurfaceDawnRun, frame: number): void {
  if (!run.laneParity) return;
  const [first, second] = run.layout.probeDomains;
  if (frame === SURFACE_TIMELINE.swapProbes)
    setSurfaceProbeIrradiance(run.world, run.layout, [second.irradiance, first.irradiance]);
  else if (frame === SURFACE_TIMELINE.restoreProbes)
    setSurfaceProbeIrradiance(run.world, run.layout, [first.irradiance, second.irradiance]);
}

function timelineDynamicInputFrame(
  dynamicInput: SurfaceDynamicInput,
  frame: number,
  frameTime: number,
) {
  const stopped = frame >= SURFACE_TIMELINE.stopped;
  const swapped = frame >= SURFACE_TIMELINE.swapProbes;
  let ranges = dynamicInput.ranges;
  if (stopped) ranges = [];
  else if (swapped) ranges = [...dynamicInput.ranges].reverse();
  let projectionRevision = 1;
  if (stopped) projectionRevision = 3;
  else if (swapped) projectionRevision = 2;
  return { ...dynamicInput, ranges, projectionRevision, frameTime };
}

function usesDirectTimelineLane(laneParity: boolean, frame: number): boolean {
  return (
    laneParity &&
    (frame <= SURFACE_TIMELINE.direct ||
      (frame > SURFACE_TIMELINE.gpu && frame <= SURFACE_TIMELINE.directRestored))
  );
}

function writeFinalLifecycleCapture(
  run: SurfaceDawnRun,
  captureRoot: string,
  tape: { readonly bytes: Uint8Array },
): void {
  mkdirSync(captureRoot, { recursive: true });
  writeFileSync(resolve(captureRoot, 'lifecycle-final.rhitape'), tape.bytes);
  writeFileSync(
    resolve(captureRoot, 'lifecycle-final.json'),
    JSON.stringify(
      {
        channels: run.renderer.inspect().renderScene.gpuDriven.channels,
        materials: run.materials.map(({ passes, parameters, surface, values }) => ({
          passes,
          parameters,
          surface,
          values,
        })),
      },
      null,
      2,
    ),
  );
}

/** Fixed-ROI and lane evidence recorded at selected frames of the Surface timeline. */
class SurfaceTimelineEvidence {
  completedFrames = 0;
  readonly waterBRoiByFrame = new Map<number, SurfaceRoi>();
  readonly laneRoisByFrame = new Map<number, readonly SurfaceRoi[]>();
  readonly lanePhysicalRoisByFrame = new Map<number, readonly Uint8Array[]>();
  readonly laneReceiptsByFrame = new Map<number, SurfaceSubmissionReceipt>();
  readonly laneArtifactsByFrame = new Map<number, SurfaceArtifactInspection>();
  readonly laneGpuDrivenByFrame = new Map<number, SurfaceGpuDrivenInspection>();
  readonly laneProbeRecordsByFrame = new Map<number, readonly string[]>();

  async record(
    run: SurfaceDawnRun,
    frame: number,
    receipt: Awaited<ReturnType<typeof drawReadyFrame>>,
  ): Promise<void> {
    const intermediate = await readSurfaceTarget(
      run,
      'surface-standard: intermediate Dawn target unavailable',
    );
    this.waterBRoiByFrame.set(frame, samplePresentedRoi(intermediate, SURFACE_CASES.length - 1));
    if (run.laneParity && SURFACE_LANE_EVIDENCE_FRAMES.includes(frame))
      await this.recordLane(run, frame, receipt, intermediate);
  }

  private async recordLane(
    run: SurfaceDawnRun,
    frame: number,
    receipt: Awaited<ReturnType<typeof drawReadyFrame>>,
    intermediate: Uint8Array,
  ): Promise<void> {
    const { renderer } = run;
    const observed = await renderer.observe(receipt, { include: ['draws'] });
    expect(observed.ok, observed.ok ? '' : describeStructuredError(observed.error)).toBe(true);
    const waterIndices = [SURFACE_CASES.length - 2, SURFACE_CASES.length - 1];
    this.laneRoisByFrame.set(
      frame,
      waterIndices.map((index) => samplePresentedRoi(intermediate, index)),
    );
    this.lanePhysicalRoisByFrame.set(
      frame,
      waterIndices.map((index) => samplePresentedRoiPixels(intermediate, index)),
    );
    const submission = renderer.inspect().renderScene.submission;
    if (submission === undefined) {
      throw new Error(`surface-standard: frame ${frame} submission receipt unavailable`);
    }
    expect(submission.frameId).toBe(receipt.frameId);
    this.laneReceiptsByFrame.set(frame, submission);
    const laneInspection = renderer.inspect();
    this.laneGpuDrivenByFrame.set(frame, laneInspection.renderScene.gpuDriven);
    this.laneProbeRecordsByFrame.set(
      frame,
      Object.freeze(
        (laneInspection.renderScene.probeBlend?.records ?? [])
          .filter((record) => record.accepted)
          .map((record) => JSON.stringify(record.shPreblend)),
      ),
    );
    const selectedArtifact = laneInspection.renderScene.gpuDriven.surfaceArtifact;
    if (selectedArtifact === undefined) {
      throw new Error(`surface-standard: frame ${frame} selected artifact unavailable`);
    }
    this.laneArtifactsByFrame.set(frame, selectedArtifact);
  }
}

// Standard material pipelines are compiled lazily on first use. Submit
// enough frames for the authored Surface artifacts to publish their PSOs
// before taking the Dawn readback, matching the browser evidence lane.
async function runSurfaceTimeline(
  run: SurfaceDawnRun,
  dynamicInput: SurfaceDynamicInput,
): Promise<SurfaceTimelineEvidence> {
  const { renderer, world, lease, recorder, captureRoot } = run;
  const evidence = new SurfaceTimelineEvidence();
  for (let frame = 0; frame < SURFACE_TIMELINE.totalFrames; frame += 1) {
    const frameTime = surfaceTimelineFrameTime(frame, run.laneParity);
    applyTimelineProbeEdits(run, frame);
    renderer.setSurfaceDynamicInput(timelineDynamicInputFrame(dynamicInput, frame, frameTime));
    const finalCapture =
      frame === SURFACE_TIMELINE.totalFrames - 1 ? recorder?.captureFrame() : undefined;
    if (finalCapture !== undefined && recorder !== undefined)
      (await recorder.frameBoundary()).unwrap();
    world.update(1 / 60).unwrap();
    const receipt = await drawReadyFrame(renderer, {
      leases: [lease],
      camera: { lease },
      environment: { lease },
      ...(usesDirectTimelineLane(run.laneParity, frame) ? { geometryLane: 'direct' as const } : {}),
    });
    if (finalCapture !== undefined && recorder !== undefined && captureRoot !== undefined) {
      (await recorder.frameBoundary()).unwrap();
      writeFinalLifecycleCapture(run, captureRoot, (await finalCapture).unwrap());
    }
    evidence.completedFrames += 1;
    if (SURFACE_EVIDENCE_FRAMES.includes(frame)) await evidence.record(run, frame, receipt);
  }
  return evidence;
}

function roiMaxChannelDistance(left: SurfaceRoi, right: SurfaceRoi): number {
  return (
    Math.max(
      ...left.slice(0, 3).map((value, channel) => Math.abs(value - (right[channel] ?? Number.NaN))),
    ) / 255
  );
}

function expectSurfaceLifecycleRois(evidence: SurfaceTimelineEvidence): void {
  const { waterBRoiByFrame } = evidence;
  const pausedFrames = SURFACE_TIMELINE.paused;
  const activeFrames = SURFACE_TIMELINE.active;
  expect(waterBRoiByFrame.get(pausedFrames[1])).toEqual(waterBRoiByFrame.get(pausedFrames[0]));
  expect(waterBRoiByFrame.get(activeFrames[1])).toEqual(waterBRoiByFrame.get(activeFrames[0]));
  expect(waterBRoiByFrame.get(SURFACE_TIMELINE.resumed)).not.toEqual(
    waterBRoiByFrame.get(pausedFrames[1]),
  );
}

function expectSurfaceLaneReceipts(evidence: SurfaceTimelineEvidence): void {
  const { laneReceiptsByFrame } = evidence;
  expect(laneReceiptsByFrame.get(SURFACE_TIMELINE.direct)).toMatchObject({
    requestedLane: 'direct',
    actualLane: 'direct',
    status: 'completed',
    passes: [{ pass: 'nearest-layer' }, { pass: 'color' }],
  });
  expect(laneReceiptsByFrame.get(SURFACE_TIMELINE.gpu)).toMatchObject({
    requestedLane: 'gpu-driven',
    actualLane: 'gpu-driven',
    status: 'completed',
    passes: [
      {
        pass: 'nearest-layer',
        memberEvidence: 'indirect-visible-readback',
      },
      { pass: 'color', memberEvidence: 'indirect-visible-readback' },
    ],
  });
  expect(laneReceiptsByFrame.get(SURFACE_TIMELINE.directRestored)).toMatchObject({
    requestedLane: 'direct',
    actualLane: 'direct',
    status: 'completed',
    passes: [{ pass: 'nearest-layer' }, { pass: 'color' }],
  });
}

/** GPU-driven passes carry every medium member through producer-receipt indirect commands. */
function expectGpuLaneMembers(
  run: SurfaceDawnRun,
  evidence: SurfaceTimelineEvidence,
  expectedMemberIds: readonly string[],
): SurfaceSubmissionReceipt | undefined {
  const { mediumMembers } = run.layout;
  const gpuReceipt = evidence.laneReceiptsByFrame.get(SURFACE_TIMELINE.gpu);
  expect(gpuReceipt?.passes.every((pass) => (pass.memberIds?.length ?? 0) > 0)).toBe(true);
  expect(gpuReceipt?.passes[0]?.memberIds).toEqual(gpuReceipt?.passes[1]?.memberIds);
  expect(new Set(gpuReceipt?.passes[0]?.memberIds).size).toBe(mediumMembers.length);
  expect([...(gpuReceipt?.passes[0]?.memberIds ?? [])].sort()).toEqual(expectedMemberIds);
  const invalidGpuCommands = gpuReceipt?.passes.flatMap((pass) =>
    pass.commands
      .filter(
        (command) =>
          (command.kind !== 'draw-indirect' && command.kind !== 'draw-indexed-indirect') ||
          command.programEvidence !== 'producer-receipt' ||
          command.receiptIdentity === undefined ||
          command.receiptGeneration === undefined,
      )
      .map((command) => ({ pass: pass.pass, command })),
  );
  expect(
    invalidGpuCommands,
    JSON.stringify({
      invalidGpuCommands,
      gpuDriven: evidence.laneGpuDrivenByFrame.get(SURFACE_TIMELINE.gpu),
      rendererErrors: run.rendererErrors.map((error) => JSON.parse(describeStructuredError(error))),
    }),
  ).toEqual([]);
  return gpuReceipt;
}

type SurfaceLaneCommand = SurfaceSubmissionReceipt['passes'][number]['commands'][number];

function directMemberIds(command: SurfaceLaneCommand): readonly string[] {
  return command.kind === 'draw' || command.kind === 'draw-indexed' ? command.memberIds : [];
}

/** Direct passes cover the same members with producer-receipt draws and surface frame bases. */
function expectDirectLaneMembers(
  evidence: SurfaceTimelineEvidence,
  expectedMemberIds: readonly string[],
  gpuReceipt: SurfaceSubmissionReceipt | undefined,
): void {
  const directReceipt = evidence.laneReceiptsByFrame.get(SURFACE_TIMELINE.directRestored);
  const directCommands = directReceipt?.passes.flatMap((pass) => pass.commands) ?? [];
  const directMembers = [...new Set(directCommands.flatMap(directMemberIds))].sort();
  expect(directMembers).toEqual(expectedMemberIds);
  expect(directMembers).toEqual([...(gpuReceipt?.passes[0]?.memberIds ?? [])].sort());
  expect(
    directCommands.every(
      (command) =>
        command.programEvidence === 'producer-receipt' &&
        command.receiptIdentity !== undefined &&
        command.receiptGeneration !== undefined,
    ),
  ).toBe(true);
}

function expectLaneFrameOrder(
  evidence: SurfaceTimelineEvidence,
  msaaEdgeEvidence: SurfaceMsaaEdgeEvidence,
): void {
  const { laneReceiptsByFrame } = evidence;
  const directFrame = laneReceiptsByFrame.get(SURFACE_TIMELINE.direct)?.frameId;
  const gpuFrame = laneReceiptsByFrame.get(SURFACE_TIMELINE.gpu)?.frameId;
  const restoredFrame = laneReceiptsByFrame.get(SURFACE_TIMELINE.directRestored)?.frameId;
  if (directFrame === undefined || gpuFrame === undefined || restoredFrame === undefined)
    throw new Error('Surface lane frame receipts unavailable');
  expect(directFrame).toBeGreaterThan(msaaEdgeEvidence.resized.fourX.receipt.frameId);
  expect(gpuFrame).toBeGreaterThan(directFrame);
  expect(restoredFrame).toBeGreaterThan(gpuFrame);
}

function expectDirectInstanceBases(evidence: SurfaceTimelineEvidence): void {
  const directReceipt = evidence.laneReceiptsByFrame.get(SURFACE_TIMELINE.directRestored);
  const directCommands = directReceipt?.passes.flatMap((pass) => pass.commands) ?? [];
  expect(
    directCommands.some(
      (command) =>
        (command.kind === 'draw' || command.kind === 'draw-indexed') &&
        command.surfaceFrameBase > 0 &&
        command.firstInstance === 0,
    ),
  ).toBe(true);
  expect(
    directCommands.some(
      (command) =>
        (command.kind === 'draw' || command.kind === 'draw-indexed') &&
        command.memberIds.some((member) => {
          const parsed = JSON.parse(member) as readonly unknown[];
          return parsed[2] === 1 && parsed[3] === 1;
        }),
    ),
  ).toBe(true);
}

interface SurfaceLaneRois {
  readonly coldDirect: readonly SurfaceRoi[];
  readonly gpuAfterDirect: readonly SurfaceRoi[];
  readonly directAfterGpu: readonly SurfaceRoi[];
}

function requireLaneRois(evidence: SurfaceTimelineEvidence): SurfaceLaneRois {
  const { laneRoisByFrame } = evidence;
  const coldDirect = laneRoisByFrame.get(SURFACE_TIMELINE.direct);
  const gpuAfterDirect = laneRoisByFrame.get(SURFACE_TIMELINE.gpu);
  const directAfterGpu = laneRoisByFrame.get(SURFACE_TIMELINE.directRestored);
  const swappedDomains = laneRoisByFrame.get(SURFACE_TIMELINE.swappedProbes);
  const reorderedRestoredDomains = laneRoisByFrame.get(SURFACE_TIMELINE.restoredProbes);
  if (
    coldDirect === undefined ||
    gpuAfterDirect === undefined ||
    directAfterGpu === undefined ||
    swappedDomains === undefined ||
    reorderedRestoredDomains === undefined
  ) {
    throw new Error('surface-standard: lane parity ROI evidence unavailable');
  }
  return { coldDirect, gpuAfterDirect, directAfterGpu };
}

function expectLaneProbeRecords(evidence: SurfaceTimelineEvidence): void {
  const { laneProbeRecordsByFrame } = evidence;
  expect(laneProbeRecordsByFrame.get(SURFACE_TIMELINE.swappedProbes)).not.toEqual(
    laneProbeRecordsByFrame.get(SURFACE_TIMELINE.directRestored),
  );
  expect(laneProbeRecordsByFrame.get(SURFACE_TIMELINE.restoredProbes)).toEqual(
    laneProbeRecordsByFrame.get(SURFACE_TIMELINE.directRestored),
  );
  // Medium artifacts carry the ProbeBlend ABI through the surface receipt;
  // the inspection projection intentionally omits that receipt detail and
  // therefore keeps variantSet absent for this authored Surface route.
  expect(
    evidence.laneArtifactsByFrame.get(SURFACE_TIMELINE.swappedProbes)?.variantSet,
  ).toBeUndefined();
}

/** Swapped probe domains change the fixed physical ROI; direct and restored match GPU. */
function expectLanePhysicalRois(evidence: SurfaceTimelineEvidence): void {
  const { lanePhysicalRoisByFrame, laneProbeRecordsByFrame } = evidence;
  const directPhysical = lanePhysicalRoisByFrame.get(SURFACE_TIMELINE.directRestored);
  const gpuPhysical = lanePhysicalRoisByFrame.get(SURFACE_TIMELINE.gpu);
  const swappedPhysical = lanePhysicalRoisByFrame.get(SURFACE_TIMELINE.swappedProbes);
  const restoredPhysical = lanePhysicalRoisByFrame.get(SURFACE_TIMELINE.restoredProbes);
  if (
    directPhysical === undefined ||
    gpuPhysical === undefined ||
    swappedPhysical === undefined ||
    restoredPhysical === undefined
  ) {
    throw new Error('surface-standard: fixed physical ROI evidence unavailable');
  }
  for (let index = 0; index < directPhysical.length; index += 1) {
    const directPixels = directPhysical[index];
    const gpuPixels = gpuPhysical[index];
    const swappedPixels = swappedPhysical[index];
    const restoredPixels = restoredPhysical[index];
    if (
      directPixels === undefined ||
      gpuPixels === undefined ||
      swappedPixels === undefined ||
      restoredPixels === undefined
    ) {
      throw new Error(`surface-standard: physical ROI ${index} unavailable`);
    }
    expect(roiPixelDistance(directPixels, gpuPixels)).toBeLessThanOrEqual(SURFACE_PIXEL_EPSILON);
    expect(
      roiPixelDistance(swappedPixels, gpuPixels),
      JSON.stringify({
        index,
        swappedPixels: [...swappedPixels],
        gpuPixels: [...gpuPixels],
        swappedRecords: laneProbeRecordsByFrame.get(SURFACE_TIMELINE.swappedProbes),
        gpuRecords: laneProbeRecordsByFrame.get(SURFACE_TIMELINE.gpu),
      }),
    ).toBeGreaterThan(SURFACE_PIXEL_EPSILON);
    expect(roiPixelDistance(restoredPixels, gpuPixels)).toBeLessThanOrEqual(SURFACE_PIXEL_EPSILON);
  }
}

function logLaneRedGate(
  run: SurfaceDawnRun,
  evidence: SurfaceTimelineEvidence,
  dynamicInput: SurfaceDynamicInput,
  rois: SurfaceLaneRois,
): void {
  const { laneReceiptsByFrame } = evidence;
  // biome-ignore lint/suspicious/noConsole: executable red-gate evidence includes the exact owner inputs and receipts.
  console.log(
    JSON.stringify({
      kind: 'surface-water-direct-gpu-red-gate',
      frameTime: 0.5,
      selectedArtifacts: Object.fromEntries(evidence.laneArtifactsByFrame),
      members: run.layout.mediumMembers,
      dynamicInput: {
        pageId: dynamicInput.page.pageId,
        contentRevision: dynamicInput.page.contentRevision,
        bufferGeneration: dynamicInput.page.bufferGeneration,
        deviceGeneration: dynamicInput.page.deviceGeneration,
        projectionRevision: dynamicInput.projectionRevision,
      },
      coldDirect: {
        frame: SURFACE_TIMELINE.direct,
        receipt: laneReceiptsByFrame.get(SURFACE_TIMELINE.direct),
        rois: rois.coldDirect,
      },
      directToGpu: {
        frame: SURFACE_TIMELINE.gpu,
        receipt: laneReceiptsByFrame.get(SURFACE_TIMELINE.gpu),
        rois: rois.gpuAfterDirect,
      },
      gpuToDirect: {
        frame: SURFACE_TIMELINE.directRestored,
        receipt: laneReceiptsByFrame.get(SURFACE_TIMELINE.directRestored),
        rois: rois.directAfterGpu,
      },
    }),
  );
}

function expectLaneRoiParity(rois: SurfaceLaneRois): void {
  for (const [index, directRoi] of rois.coldDirect.entries()) {
    const gpuRoi = rois.gpuAfterDirect[index];
    const switchedDirectRoi = rois.directAfterGpu[index];
    if (gpuRoi === undefined || switchedDirectRoi === undefined) {
      throw new Error(`surface-standard: lane ROI ${index} unavailable`);
    }
    expect(
      roiMaxChannelDistance(directRoi, gpuRoi),
      `surface-standard: water ${index} coldDirect=${JSON.stringify(directRoi)} gpu=${JSON.stringify(gpuRoi)}`,
    ).toBeLessThanOrEqual(SURFACE_PIXEL_EPSILON);
    expect(
      roiMaxChannelDistance(switchedDirectRoi, gpuRoi),
      `surface-standard: water ${index} switchedDirect=${JSON.stringify(switchedDirectRoi)} gpu=${JSON.stringify(gpuRoi)}`,
    ).toBeLessThanOrEqual(SURFACE_PIXEL_EPSILON);
  }
}

/** Direct, GPU-driven and restored direct lanes render the same members and pixels. */
function expectSurfaceLaneParity(
  run: SurfaceDawnRun,
  evidence: SurfaceTimelineEvidence,
  dynamicInput: SurfaceDynamicInput,
  msaaEdgeEvidence: SurfaceMsaaEdgeEvidence,
): void {
  expectSurfaceLaneReceipts(evidence);
  const expectedMemberIds = run.layout.mediumMembers
    .map((member) =>
      JSON.stringify([
        member.worldIdentity,
        member.entityKey,
        member.drawItemIndex,
        member.instanceOrdinal,
      ]),
    )
    .sort();
  const gpuReceipt = expectGpuLaneMembers(run, evidence, expectedMemberIds);
  expectDirectLaneMembers(evidence, expectedMemberIds, gpuReceipt);
  expectLaneFrameOrder(evidence, msaaEdgeEvidence);
  expectDirectInstanceBases(evidence);
  const rois = requireLaneRois(evidence);
  expectLaneProbeRecords(evidence);
  expectLanePhysicalRois(evidence);
  logLaneRedGate(run, evidence, dynamicInput, rois);
  expectLaneRoiParity(rois);
}

function expectStoppedLifecycleRoi(evidence: SurfaceTimelineEvidence): void {
  const { waterBRoiByFrame } = evidence;
  const activeRoi = waterBRoiByFrame.get(SURFACE_TIMELINE.active[1]);
  const stoppedRoi = waterBRoiByFrame.get(SURFACE_TIMELINE.stopped);
  if (activeRoi === undefined || stoppedRoi === undefined) {
    throw new Error('surface-standard: lifecycle ROI evidence unavailable');
  }
  expect(roiMaxChannelDistance(activeRoi, stoppedRoi)).toBeGreaterThan(SURFACE_PIXEL_EPSILON);
  // biome-ignore lint/suspicious/noConsole: fixed-ROI lifecycle values are the physical evidence artifact.
  console.log(
    JSON.stringify({
      kind: 'surface-water-lifecycle-roi',
      frameWindow: SURFACE_TIMELINE.totalFrames,
      paused: SURFACE_TIMELINE.paused.map((frame) => ({ frame, roi: waterBRoiByFrame.get(frame) })),
      resumed: {
        frame: SURFACE_TIMELINE.resumed,
        roi: waterBRoiByFrame.get(SURFACE_TIMELINE.resumed),
      },
      stableActive: SURFACE_TIMELINE.active.map((frame) => ({
        frame,
        roi: waterBRoiByFrame.get(frame),
      })),
      stopped: { frame: SURFACE_TIMELINE.stopped, roi: stoppedRoi },
    }),
  );
}

/** The final frame stays on the GPU lane with distinct accepted probe blends. */
function expectFinalGpuDrivenFrame(observed: SurfaceRenderInspection): void {
  const gpuDriven = observed.renderScene.gpuDriven;
  expect(gpuDriven.submitted).toBe(true);
  expect(gpuDriven.indirectDrawCount).toBeGreaterThan(0);
  const gpuChannels = gpuDriven.channels.filter(
    (channel) => channel.viewPass === 'main' || channel.viewPass === 'directional-shadow',
  );
  expect(gpuChannels.length).toBeGreaterThan(0);
  expect(
    gpuChannels.every((channel) => channel.lane === 'gpu'),
    JSON.stringify(gpuChannels),
  ).toBe(true);
  expect(gpuChannels.every((channel) => channel.residualDrawCount === 0)).toBe(true);
  const probeRecords = observed.renderScene.probeBlend?.records.filter((record) => record.accepted);
  expect(probeRecords?.length).toBeGreaterThanOrEqual(2);
  expect(new Set(probeRecords?.map((record) => record.objectKey)).size).toBe(probeRecords?.length);
  expect(probeRecords?.every((record) => record.generation >= 0)).toBe(true);
  expect(new Set(probeRecords?.map((record) => JSON.stringify(record.shPreblend))).size).toBe(
    probeRecords?.length,
  );
  expect(observed.perFramePassNames.some((name) => name.toLowerCase().includes('shadow'))).toBe(
    true,
  );
  expect(observed.perFramePassNames).toContain('main');
}

function surfaceSelectedEntries(material: MaterialAsset) {
  return material.passes?.map((entry) => ({
    name: entry.name,
    fragmentEntry: entry.program.fragmentEntry,
    lightMode: (entry.renderState?.tags as Record<string, string> | undefined)?.LightMode,
  }));
}

function surfacePublicationRecord(
  { surfaceCase, row, publication, material }: SurfacePublication,
  samples: SurfaceRoi,
  observed: SurfaceRenderInspection,
) {
  const program = material.passes?.[0]?.program;
  const programIdentity = program?.module ?? 'unavailable';
  return {
    id: surfaceCase.id,
    materialGuid: surfaceCase.guid,
    sourceKey: row?.sourceKey,
    publicationGeneration: publication.generation,
    publicationDigest: publication.digest,
    closure: SURFACE_CLOSURE,
    rootPlan: surfaceCase.rootPlan,
    pass: surfaceCase.pass,
    actualPasses: material.passes?.map((entry) => entry.name),
    selectedEntries: surfaceSelectedEntries(material),
    cookIdentity: publication.digest,
    programIdentity,
    pipelineIdentity: `${surfaceCase.pass}:${surfaceCase.rootPlan}:${programIdentity}`,
    sourceClosure: surfaceCase.sourceClosure,
    backend: 'dawn-native',
    backendKind: observed.capabilities.backendKind,
    frameId: observed.observation.frameId,
    samples,
    artifact: row?.packageUrl,
    provenance: {
      sourceSha: EVIDENCE_SOURCE_SHA,
      buildId: EVIDENCE_BUILD_ID,
      frameId: observed.observation.frameId,
      artifact: row?.packageUrl,
      readbackKind: 'gpu-texture-copy',
      readbackFormat: 'rgba8unorm',
      readbackWidth: SURFACE_WIDTH,
      readbackHeight: SURFACE_HEIGHT,
      clearColor: [0, 0, 0, 1],
      closure: SURFACE_CLOSURE,
      rootPlan: surfaceCase.rootPlan,
      pass: surfaceCase.pass,
      actualPasses: material.passes?.map((entry) => entry.name),
      selectedEntries: surfaceSelectedEntries(material),
      cookIdentity: publication.digest,
      programIdentity,
      pipelineIdentity: `${surfaceCase.pass}:${surfaceCase.rootPlan}:${programIdentity}`,
      sourceClosure: surfaceCase.sourceClosure,
      lane: 'dawn-native',
    },
  };
}

type SurfacePublicationRecord = ReturnType<typeof surfacePublicationRecord>;

async function collectSurfacePublicationRecords(
  run: SurfaceDawnRun,
  publications: readonly SurfacePublication[],
): Promise<SurfacePublicationRecord[]> {
  const pixels = await readSurfaceTarget(run, 'surface-standard: Dawn target unavailable');
  const observed = run.renderer.inspect();
  expectFinalGpuDrivenFrame(observed);
  const records = publications.map((publication, index) =>
    surfacePublicationRecord(publication, samplePresentedPixel(pixels, index), observed),
  );
  for (const record of records) {
    expect(record.samples[3], `${record.id} alpha ${JSON.stringify(record.samples)}`).toBe(255);
    expect(
      record.samples[0] + record.samples[1] + record.samples[2],
      `${record.id} readback sample ${JSON.stringify(record.samples)}; all=${JSON.stringify(
        records.map((entry) => ({ id: entry.id, samples: entry.samples })),
      )}`,
    ).toBeGreaterThan(0);
  }
  assertSurfacePixelFalsification(records);
  return records;
}

const SURFACE_PROFILE_CASES = [
  { renderPath: 'forward', ssao: false, antialias: 0, bloom: 0 },
  { renderPath: 'deferred', ssao: false, antialias: 0, bloom: 0 },
  { renderPath: 'forward', ssao: false, antialias: 0, bloom: 0, probe: true },
  { renderPath: 'deferred', ssao: false, antialias: 0, bloom: 0, probe: true },
  { renderPath: 'deferred', ssao: true, antialias: 0, bloom: 0 },
  {
    renderPath: 'forward',
    ssao: false,
    antialias: 0,
    bloom: 0,
    noProbes: true,
    geometryLane: 'direct',
  },
  { renderPath: 'deferred', ssao: false, antialias: 0, bloom: 0, noProbes: true },
  { renderPath: 'forward', ssao: false, antialias: 2, bloom: 0 },
  { renderPath: 'deferred', ssao: true, antialias: 1, bloom: 1 },
  { renderPath: 'deferred', ssao: true, antialias: 3, bloom: 1 },
  { renderPath: 'deferred', ssao: true, antialias: 3, bloom: 1, scale: 0.67 },
] as const;

type SurfaceProfileCase = (typeof SURFACE_PROFILE_CASES)[number];

/** Forward/Deferred profile matrix state shared across its ordered combinations. */
class SurfaceProfileMatrix {
  readonly run: SurfaceDawnRun;
  readonly surfaceProbe: EntityHandle;
  readonly deferredParity: { id: string; maxError: number }[] = [];
  probesRemoved = false;
  forwardRois: readonly (readonly number[])[] | undefined;
  forwardPixels: Uint8Array | undefined;
  withoutProbePixels: Uint8Array | undefined;

  constructor(run: SurfaceDawnRun) {
    this.run = run;
    this.surfaceProbe = run.world
      .spawn(
        { component: Transform, data: {} },
        { component: LightProbe, data: { irradiance: new Float32Array(27), radius: 20 } },
      )
      .unwrap();
  }

  async render(
    combination: SurfaceProfileCase,
    originalProfile: SurfaceRenderInspection['profile'],
  ): Promise<void> {
    this.authorCombination(combination, originalProfile);
    for (let frame = 0; frame < 6; frame++) await this.drawProfileFrame(combination, frame);
    const current = this.run.renderer.inspect();
    if (!('geometryLane' in combination)) {
      expect(current.renderScene.gpuDriven.submitted, JSON.stringify(this.run.rendererErrors)).toBe(
        true,
      );
      expect(current.renderScene.gpuDriven.indirectDrawCount).toBeGreaterThan(0);
      expect(current.renderScene.gpuDriven.cpuFallbackDrawItems).toBe(0);
    }
    expect(current.perFramePassNames.includes('ssao-calc')).toBe(combination.ssao);
    if (combination.antialias === 3) await this.expectStationaryTemporalCoverage();
    const lit = await readSurfaceTarget(this.run, 'surface-standard: Dawn target unavailable');
    expect(lit.some((value, index) => index % 4 !== 3 && value > 0)).toBe(true);
    if (!combination.ssao && combination.antialias === 0 && combination.bloom === 0)
      this.compareUnfilteredImage(combination, lit);
  }

  private authorCombination(
    combination: SurfaceProfileCase,
    originalProfile: SurfaceRenderInspection['profile'],
  ): void {
    const { world, renderer, layout } = this.run;
    const irradiance = new Float32Array(27);
    if ('probe' in combination) irradiance.set([64, 32, 16]);
    if ('noProbes' in combination && !this.probesRemoved) {
      for (const entity of [
        this.surfaceProbe,
        ...layout.probeDomains.map((domain) => domain.entity),
      ]) {
        world.despawn(entity).unwrap();
      }
      this.probesRemoved = true;
    }
    if (!this.probesRemoved) world.set(this.surfaceProbe, LightProbe, { irradiance }).unwrap();
    propagateTransforms(world).unwrap();
    if ('scale' in combination) {
      world
        .addComponent(layout.cameraEntity, {
          component: DynamicResolution,
          data: {
            minScale: combination.scale,
            maxScale: combination.scale,
          },
        })
        .unwrap();
    }
    renderValue(
      renderer.setProfile({
        ...originalProfile,
        renderPath: combination.renderPath,
        ssao: combination.ssao,
      }),
    );
    world
      .set(layout.cameraEntity, Camera, {
        antialias: combination.antialias,
        bloom: combination.bloom,
      })
      .unwrap();
  }

  private async drawProfileFrame(combination: SurfaceProfileCase, frame: number): Promise<void> {
    const { world, renderer, lease, recorder, captureRoot, observer } = this.run;
    const capture =
      frame === 5 && combination.antialias === 0 && combination.bloom === 0
        ? recorder?.captureFrame()
        : undefined;
    if (capture !== undefined && recorder !== undefined) (await recorder.frameBoundary()).unwrap();
    world.update(1 / 60).unwrap();
    observer.temporalTarget = undefined;
    const receipt = await drawReadyFrame(renderer, {
      ...('geometryLane' in combination ? { geometryLane: combination.geometryLane } : {}),
      leases: [lease],
      camera: { lease },
      environment: { lease },
    });
    const completed = await receipt.completed;
    if (!completed.ok) this.throwProfileCompletion(combination, frame, completed.error);
    if (capture !== undefined && recorder !== undefined && captureRoot !== undefined) {
      (await recorder.frameBoundary()).unwrap();
      const tape = (await capture).unwrap();
      const directory = resolve(
        captureRoot,
        `${combination.renderPath}-ssao${combination.ssao}-probe${'probe' in combination}-empty${this.probesRemoved}`,
      );
      mkdirSync(directory, { recursive: true });
      writeFileSync(resolve(directory, 'frame.rhitape'), tape.bytes);
      writeFileSync(
        resolve(directory, 'live.rgba8'),
        await readSurfaceTarget(this.run, 'surface-standard: Dawn target unavailable'),
      );
    }
  }

  private throwProfileCompletion(
    combination: SurfaceProfileCase,
    frame: number,
    error: unknown,
  ): never {
    const { renderer, rendererErrors } = this.run;
    throw new Error(
      JSON.stringify(
        {
          stage: 'surface-profile-completion',
          combination,
          frame,
          error: parseStructuredError(error),
          rendererErrors: rendererErrors.map(parseStructuredError),
          profile: renderer.inspect().profile,
          gpuDriven: renderer.inspect().renderScene.gpuDriven,
          perFramePassNames: renderer.inspect().perFramePassNames,
        },
        null,
        2,
      ),
    );
  }

  // Read actual motion coverage, independent of MRT/supplement pass
  // placement and empty GPU indirect commands. All four opaque material
  // centers lie on the plane at view distance six, including at DRS .67.
  private async expectStationaryTemporalCoverage(): Promise<void> {
    const temporalTarget = this.run.observer.temporalTarget;
    expect(temporalTarget).toBeDefined();
    if (temporalTarget === undefined) throw new Error('missing Surface temporal target');
    const device = this.run.presented().device;
    if (device === undefined) throw new Error('surface-standard: Dawn target unavailable');
    const motionBuffer = device.createBuffer({
      size: 256 * 4,
      usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
    });
    try {
      const encoder = device.createCommandEncoder();
      for (let index = 0; index < 4; index++) {
        encoder.copyTextureToBuffer(
          {
            texture: temporalTarget,
            origin: {
              x: Math.floor(((index + 0.5) * temporalTarget.width) / SURFACE_CASES.length),
              y: Math.floor(temporalTarget.height / 2),
              z: 0,
            },
          },
          { buffer: motionBuffer, offset: index * 256, bytesPerRow: 256 },
          { width: 1, height: 1, depthOrArrayLayers: 1 },
        );
      }
      device.queue.submit([encoder.finish()]);
      await motionBuffer.mapAsync(MAP_MODE_READ);
      const values = new DataView(motionBuffer.getMappedRange());
      for (let index = 0; index < 4; index++) expectStationaryMotionSample(values, index);
      motionBuffer.unmap();
    } finally {
      motionBuffer.destroy();
    }
  }

  private compareUnfilteredImage(combination: SurfaceProfileCase, lit: Uint8Array): void {
    const rois = SURFACE_CASES.map((_, index) => samplePresentedRoi(lit, index));
    if (combination.renderPath === 'forward' && !('probe' in combination))
      this.withoutProbePixels = lit;
    if ('probe' in combination) this.expectProbeConsumption(combination, lit);
    if (combination.renderPath === 'forward') {
      this.forwardRois = rois;
      this.forwardPixels = lit;
    } else this.expectForwardDeferredParity(lit, rois);
  }

  private expectProbeConsumption(combination: SurfaceProfileCase, lit: Uint8Array): void {
    const withoutProbePixels = this.withoutProbePixels;
    if (withoutProbePixels === undefined) throw new Error('missing probe baseline');
    for (const index of [0, 1, 2, 3]) {
      expect(
        cellInteriorDelta(lit, withoutProbePixels, index),
        `${SURFACE_CASES[index]?.id}: ${combination.renderPath} must consume SH`,
      ).toBeGreaterThan(0.01);
    }
  }

  private expectForwardDeferredParity(lit: Uint8Array, rois: readonly SurfaceRoi[]): void {
    const { forwardRois, forwardPixels } = this;
    if (forwardRois === undefined || forwardPixels === undefined)
      throw new Error('missing paired Forward image');
    let fullImageMaxError = 0;
    for (let byte = 0; byte < lit.length; byte++) {
      fullImageMaxError = Math.max(
        fullImageMaxError,
        Math.abs((lit[byte] ?? Number.NaN) - (forwardPixels[byte] ?? Number.NaN)) / 255,
      );
    }
    expect(
      fullImageMaxError,
      'full Surface image must retain local lighting across Forward and Deferred',
    ).toBeLessThanOrEqual(0.05);
    for (const [index, surfaceCase] of SURFACE_CASES.entries()) {
      const baseline = forwardRois[index];
      const currentRoi = rois[index];
      if (baseline === undefined || currentRoi === undefined)
        throw new Error('missing Surface ROI');
      const maxError = Math.max(
        ...currentRoi
          .slice(0, 3)
          .map((value, channel) => Math.abs(value - (baseline[channel] ?? Number.NaN)) / 255),
      );
      expect(maxError, `${surfaceCase.id}: Forward/Deferred Surface parity`).toBeLessThanOrEqual(
        0.05,
      );
      this.deferredParity.push({ id: surfaceCase.id, maxError });
    }
  }
}

function expectStationaryMotionSample(values: DataView, index: number): void {
  // temporal-v1 stores log2(1 + view depth) in its half-float Z lane.
  const depth = 2 ** halfFloat.f16ToF32(values.getUint16(index * 256 + 4, true)) - 1;
  expect(depth, `${SURFACE_CASES[index]?.id}: actual temporal coverage`).toBeCloseTo(6, 2);
  for (const channel of [0, 1]) {
    expect(
      Math.abs(halfFloat.f16ToF32(values.getUint16(index * 256 + channel * 2, true))),
      `${SURFACE_CASES[index]?.id}: stationary motion`,
    ).toBeLessThan(0.001);
  }
}

// The rusted iron center is a pure metal and correctly has no diffuse SH.
// Inspect each cell's interior, including its authored nonmetal corrosion.
function cellInteriorDelta(lit: Uint8Array, baseline: Uint8Array, index: number): number {
  let delta = 0;
  const centerX = Math.floor(((index + 0.5) * SURFACE_WIDTH) / SURFACE_CASES.length);
  for (
    let y = SURFACE_HEIGHT / 2 - Math.floor((SURFACE_HEIGHT * 64) / 540);
    y < SURFACE_HEIGHT / 2 + Math.floor((SURFACE_HEIGHT * 64) / 540);
    y++
  ) {
    for (
      let x = centerX - Math.floor(SURFACE_WIDTH / 20);
      x < centerX + Math.floor(SURFACE_WIDTH / 20);
      x++
    ) {
      for (let channel = 0; channel < 3; channel++) {
        const byte = y * BYTES_PER_ROW + x * 4 + channel;
        delta = Math.max(
          delta,
          Math.abs((lit[byte] ?? Number.NaN) - (baseline[byte] ?? Number.NaN)) / 255,
        );
      }
    }
  }
  return delta;
}

// Inject the backend loss signal, replace the real Dawn device, and
// prove the same Surface/Cluster/SSAO/TAA World resumes indirect submission.
async function recoverSurfaceDevice(
  run: SurfaceDawnRun,
  profileSurfaceDynamicInput: SurfaceDynamicInput,
): Promise<void> {
  const { renderer, world, lease, rendererErrors, observer } = run;
  const injectDeviceLoss = observer.injectDeviceLoss;
  if (injectDeviceLoss === undefined) throw new Error('device loss instrumentation missing');
  injectDeviceLoss({ reason: 'unknown', message: 'Surface recovery regression injection' });
  for (let attempt = 0; attempt < 20 && renderer.state() !== 'device-lost'; attempt++)
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 0));
  expect(renderer.state()).toBe('device-lost');
  const recovered = await renderer.recover();
  if (!recovered.ok)
    throw new Error(JSON.stringify({ error: recovered.error, rendererErrors }, null, 2));
  profileSurfaceDynamicInput.page.release().unwrap();
  const recoveredSurfaceDynamicInput = createSurfaceDynamicInput(
    run.materials,
    run.layout.mediumMembers,
    renderer.inspect().frame.deviceGeneration,
  );
  renderer.setSurfaceDynamicInput({ ...recoveredSurfaceDynamicInput, frameTime: 2.5 });
  for (let frame = 0; frame < 10; frame++) {
    world.update(1 / 60).unwrap();
    await drawReadyFrame(renderer, {
      leases: [lease],
      camera: { lease },
      environment: { lease },
    });
  }
  expect(renderer.inspect().renderScene.gpuDriven.submitted).toBe(true);
  expect(renderer.inspect().renderScene.gpuDriven.cpuFallbackDrawItems).toBe(0);
  const restored = await readSurfaceTarget(run, 'surface-standard: Dawn target unavailable');
  expect(restored.some((value, index) => index % 4 !== 3 && value > 0)).toBe(true);
  expect(rendererErrors.map(parseStructuredError)).toMatchObject([
    {
      code: 'device-operation-failed',
      detail: { operation: 'renderer-event', cause: { code: 'device-lost' } },
    },
  ]);
  recoveredSurfaceDynamicInput.page.release().unwrap();
  renderer.setSurfaceDynamicInput(undefined);
}

/** Profile matrix, then device recovery, on a fresh dynamic-input page with a point light. */
async function runSurfaceProfileMatrix(
  run: SurfaceDawnRun,
  records: readonly SurfacePublicationRecord[],
): Promise<{ readonly id: string; readonly maxError: number }[]> {
  const { renderer, world, rendererErrors } = run;
  const profileSurfaceDynamicInput = createSurfaceDynamicInput(
    run.materials,
    run.layout.mediumMembers,
    renderer.inspect().frame.deviceGeneration,
  );
  renderer.setSurfaceDynamicInput({ ...profileSurfaceDynamicInput, frameTime: 2.5 });
  expect(new Set(records.map((record) => record.materialGuid))).toHaveLength(6);
  expect(records.every((record) => record.backend === 'dawn-native')).toBe(true);
  expect(records.every((record) => record.backendKind === 'webgpu')).toBe(true);
  const point = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 2] } },
      { component: PointLight, data: { color: [1, 1, 1], intensity: 4, range: 10 } },
    )
    .unwrap();
  propagateTransforms(world).unwrap();
  const originalProfile = renderer.inspect().profile;
  const matrix = new SurfaceProfileMatrix(run);
  for (const combination of SURFACE_PROFILE_CASES)
    await matrix.render(combination, originalProfile);
  await recoverSurfaceDevice(run, profileSurfaceDynamicInput);
  rendererErrors.length = 0;
  world.despawn(point).unwrap();
  renderValue(renderer.setProfile(originalProfile));
  return matrix.deferredParity;
}

describe('Standard Surface runtime Dawn publication', () => {
  let recorder: RecorderAttachment | undefined;
  let renderer: Renderer | undefined;
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let canvas: DawnCanvas | undefined;
  let device: GPUDevice | undefined;

  afterEach(async () => {
    await renderer?.dispose();
    if (recorder !== undefined) (await recorder.dispose()).unwrap();
    recorder = undefined;
    if (canvas?.target !== undefined) canvas.target.destroy();
    device?.destroy();
    await server?.close();
    renderer = undefined;
    canvas = undefined;
    device = undefined;
    server = undefined;
  }, DAWN_TEARDOWN_TIMEOUT_MS);

  // The full optical/MSAA, two App lifecycles, Forward/Deferred matrix and
  // device recovery share the Browser carrier's bounded 300s allowance.
  // Cold lavapipe reached the matrix after 140s in run 36597854898.
  it('publishes and renders Standard plus two medium GUIDs through Dawn Runtime Renderer', async () => {
    const laneParity = process.env.FORGEAX_SURFACE_LANE_PARITY === '1';
    const binding = createStandaloneRuntimeAssetBinding('preview');
    server = await createPreviewServer();
    await server.listen();
    const baseUrl = server.resolvedUrls?.local[0];
    if (baseUrl === undefined)
      throw new Error('surface-standard: Dawn publication server URL unavailable');
    const liveBinding = absoluteBinding(binding, baseUrl);
    const shaderManifestUrl = new URL('shaders/manifest.json', baseUrl).href;
    const observer = new SurfaceDawnDeviceObserver();
    const dawnCanvas = createDawnCanvas((created) => {
      device = created;
      observer.instrument(created);
    });
    canvas = dawnCanvas;
    const captureRoot = process.env.FORGEAX_SURFACE_RHI_CAPTURE_DIR;
    if (captureRoot !== undefined) recorder = attachRecorder(captureWebgpu).unwrap();
    const captureRecorder = recorder;
    const constructed = await constructRuntimeRendererHost(
      dawnCanvas,
      {
        ...(captureRecorder === undefined ? {} : { rhi: captureRecorder.backend.rhi }),
        rhiInstrumentation: {
          deviceLost: (lostDevice) => observer.deviceLost(lostDevice, captureRecorder),
        },
      },
      {
        shaderManifestUrl,
        importTransport: createDevImportTransport(liveBinding),
      },
    );
    expect(constructed.ok, constructed.ok ? '' : describeStructuredError(constructed.error)).toBe(
      true,
    );
    if (!constructed.ok) throw new Error(describeStructuredError(constructed.error));
    const surfaceRenderer = constructed.value.renderer;
    renderer = surfaceRenderer;
    const rendererErrors: unknown[] = [];
    surfaceRenderer.subscribe((event) => {
      if (event.kind === 'error') rendererErrors.push(event.error);
    });
    const assets = constructed.value.assets;
    assets.configureRuntimeBinding(liveBinding);
    const { materials, publications } = await loadSurfacePublications(assets);
    // Browser owns the complete public App/VFX lifecycle and queued-loss journey.
    await expectOpticalOracle(surfaceRenderer, assets);
    const msaaEdgeEvidence = await expectMsaaEdgeOracle(surfaceRenderer, assets, () => canvas);
    const managedMedium = await runSurfaceManagedMediumOracle(surfaceRenderer, assets);
    expect(managedMedium).toHaveLength(4);
    // biome-ignore lint/suspicious/noConsole: native pixel falsifiers are gate evidence.
    console.log(
      JSON.stringify({ kind: 'managed-medium', backend: 'dawn', records: managedMedium }),
    );
    const world = new World({ assets });
    const layout = populateSurfaceWorld(world, materials, createSurfaceWaterInstanceTransforms(), {
      msaa4x: process.env.FORGEAX_SURFACE_MSAA4X === '1',
    });
    const surfaceDynamicInput = createSurfaceDynamicInput(
      materials,
      layout.mediumMembers,
      surfaceRenderer.inspect().frame.deviceGeneration,
    );
    const attached = surfaceRenderer.attach(world);
    expect(attached.ok, attached.ok ? '' : describeStructuredError(attached.error)).toBe(true);
    if (!attached.ok) throw new Error(describeStructuredError(attached.error));
    const run: SurfaceDawnRun = {
      renderer: surfaceRenderer,
      world,
      lease: attached.value,
      layout,
      materials,
      observer,
      recorder: captureRecorder,
      captureRoot,
      rendererErrors,
      laneParity,
      presented: () => ({ device, canvas: dawnCanvas }),
    };
    const timeline = await runSurfaceTimeline(run, surfaceDynamicInput);
    expect(timeline.completedFrames).toBe(SURFACE_TIMELINE.totalFrames);
    expectSurfaceLifecycleRois(timeline);
    if (laneParity) expectSurfaceLaneParity(run, timeline, surfaceDynamicInput, msaaEdgeEvidence);
    expectStoppedLifecycleRoi(timeline);
    const records = await collectSurfacePublicationRecords(run, publications);
    surfaceDynamicInput.page.release().unwrap();
    expect(surfaceDynamicInput.page.writeRecord(0, {})).toMatchObject({
      ok: false,
      error: { code: 'released' },
    });
    const deferredParity = await runSurfaceProfileMatrix(run, records);
    expect(rendererErrors).toEqual([]);
    expect(observer.nativeErrors, 'Surface pipelines must pass native GPU validation').toEqual([]);
    // biome-ignore lint/suspicious/noConsole: runtime provenance is the test artifact.
    console.log(
      JSON.stringify({ backend: 'dawn-native', lane: 'runtime', records, deferredParity }),
    );
    mkdirSync('artifacts/standard-deferred', { recursive: true });
    writeFileSync(
      'artifacts/standard-deferred/surface-parity.json',
      JSON.stringify(deferredParity, null, 2),
    );
  }, 300_000);
});
