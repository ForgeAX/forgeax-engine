import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer as createTcpServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '@forgeax/engine-ecs';
import {
  Camera,
  DynamicResolution,
  LightProbe,
  PointLight,
  type Renderer,
} from '@forgeax/engine-render';
import type { DeviceLostInfo } from '@forgeax/engine-rhi';
import { attachRecorder, halfToFloat, type RecorderAttachment } from '@forgeax/engine-rhi-debug';
import * as captureWebgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';
import {
  createStandaloneRuntimeAssetBinding,
  type RuntimeAssetBinding,
} from '@forgeax/engine-types';
import { createServer, loadConfigFromFile } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { createDevImportTransport } from '../dev-import-transport';
import { constructRuntimeRendererHost } from '../renderer-host';
import {
  assertMaterialPayload,
  assertSurfacePixelFalsification,
  createSurfaceDynamicInput,
  createSurfaceWaterInstanceTransforms,
  parseSurfaceGuid,
  populateSurfaceWorld,
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
            canvas.target = undefined;
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
        sum[channel] += pixels[offset + channel] ?? 0;
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
    const previewInlineConfig = await loadPreviewConfig();
    const previewServer = {
      host: '127.0.0.1',
      port: await allocateLoopbackPort(),
      strictPort: true,
      ...(previewInlineConfig.server?.fs === undefined
        ? {}
        : { fs: previewInlineConfig.server.fs }),
    };
    server = await createServer({
      ...previewInlineConfig,
      configFile: false,
      root: resolve(rootDir, 'apps/preview'),
      logLevel: 'error',
      server: previewServer,
    });
    await server.listen();
    const baseUrl = server.resolvedUrls?.local[0];
    if (baseUrl === undefined)
      throw new Error('surface-standard: Dawn publication server URL unavailable');
    const liveBinding = absoluteBinding(binding, baseUrl);
    const shaderManifestUrl = new URL('shaders/manifest.json', baseUrl).href;
    let temporalTarget: GPUTexture | undefined;
    const textureViews = new WeakMap<object, GPUTexture>();
    const nativeErrors: string[] = [];
    canvas = createDawnCanvas((created) => {
      device = created;
      created.addEventListener('uncapturederror', (event) =>
        nativeErrors.push(event.error.message),
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
          textureViews.set(view, texture);
          return view;
        };
        return texture;
      };
      const createEncoder = created.createCommandEncoder.bind(created);
      created.createCommandEncoder = (descriptor) => {
        const encoder = createEncoder(descriptor);
        const begin = encoder.beginRenderPass.bind(encoder);
        encoder.beginRenderPass = (descriptor) => {
          const attachments = Array.from(descriptor.colorAttachments);
          const view = attachments.at(-1)?.view;
          const target = view == null ? undefined : textureViews.get(view);
          if (
            descriptor.label === 'standard-scene-data' ||
            ((descriptor.label === 'g-buffer' || descriptor.label === 'g-buffer-late') &&
              attachments.length >= 6 &&
              target?.format === 'rgba16float')
          )
            temporalTarget = target;
          return begin(descriptor);
        };
        return encoder;
      };
    });
    let injectDeviceLoss: ((info: DeviceLostInfo) => void) | undefined;
    const captureRoot = process.env.FORGEAX_SURFACE_RHI_CAPTURE_DIR;
    if (captureRoot !== undefined) recorder = attachRecorder(captureWebgpu).unwrap();
    const constructed = await constructRuntimeRendererHost(
      canvas,
      {
        ...(recorder === undefined ? {} : { rhi: recorder.backend.rhi }),
        rhiInstrumentation: {
          deviceLost: (device) => {
            return Promise.race([
              device.lost,
              new Promise<DeviceLostInfo>((resolveLost) => {
                injectDeviceLoss = resolveLost;
              }),
            ]).then((info) => {
              recorder?.deviceLost();
              return info;
            });
          },
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
    renderer = constructed.value.renderer;
    const rendererErrors: unknown[] = [];
    renderer.subscribe((event) => {
      if (event.kind === 'error') rendererErrors.push(event.error);
    });
    const assets = constructed.value.assets;
    assets.configureRuntimeBinding(liveBinding);
    const catalogDeadline = Date.now() + 180_000;
    while (!(await assets.refreshCatalog())) {
      if (Date.now() >= catalogDeadline) {
        throw new Error(
          `surface-standard: timed out waiting for catalog ${liveBinding.catalogUrl}`,
        );
      }
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
    }
    const catalog = assets.listCatalog();
    const materials: MaterialAsset[] = [];
    const publications = [];
    for (const surfaceCase of SURFACE_CASES) {
      const row = catalog.find((entry) => entry.guid.toLowerCase() === surfaceCase.guid);
      expect(row?.sourceKey).toBe(surfaceCase.sourceKey);
      expect(row?.packageUrl).toMatch(/^http/);
      const publicationResponse = await fetch(row?.packageUrl ?? '');
      expect(publicationResponse.ok).toBe(true);
      const publication = (await publicationResponse.json()) as {
        generation?: unknown;
        digest?: unknown;
      };
      expect(Number.isSafeInteger(publication.generation)).toBe(true);
      expect(typeof publication.digest).toBe('string');
      const loaded = await assets.loadByGuid<MaterialAsset>(parseSurfaceGuid(surfaceCase.guid));
      expect(loaded.ok, loaded.ok ? '' : describeStructuredError(loaded.error)).toBe(true);
      if (!loaded.ok) throw new Error(describeStructuredError(loaded.error));
      const material = assertMaterialPayload(surfaceCase, loaded.value);
      materials.push(material);
      publications.push({ surfaceCase, row, publication, material });
    }
    // Browser owns the complete public App/VFX lifecycle and queued-loss journey.
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
    const msaaEdgeEvidence = await runSurfaceMsaaEdgeOracle(renderer, assets, {
      get width() {
        return canvas?.width ?? SURFACE_WIDTH;
      },
      get height() {
        return canvas?.height ?? SURFACE_HEIGHT;
      },
      setBackingSize(width, height) {
        if (canvas === undefined) throw new Error('surface-msaa-edge: Dawn canvas unavailable');
        canvas.width = width;
        canvas.height = height;
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
    const world = new World();
    const { mediumMembers, probeDomains, cameraEntity } = populateSurfaceWorld(
      world,
      materials,
      createSurfaceWaterInstanceTransforms(),
      { msaa4x: process.env.FORGEAX_SURFACE_MSAA4X === '1' },
    );
    const surfaceDynamicInput = createSurfaceDynamicInput(
      materials,
      mediumMembers,
      renderer.inspect().frame.deviceGeneration,
    );
    const attached = renderer.attach(world);
    expect(attached.ok, attached.ok ? '' : describeStructuredError(attached.error)).toBe(true);
    if (!attached.ok) throw new Error(describeStructuredError(attached.error));
    // Standard material pipelines are compiled lazily on first use. Submit
    // enough frames for the authored Surface artifacts to publish their PSOs
    // before taking the Dawn readback, matching the browser evidence lane.
    let completedFrames = 0;
    const waterBRoiByFrame = new Map<number, readonly [number, number, number, number]>();
    const laneRoisByFrame = new Map<
      number,
      readonly (readonly [number, number, number, number])[]
    >();
    const lanePhysicalRoisByFrame = new Map<number, readonly Uint8Array[]>();
    const laneReceiptsByFrame = new Map<
      number,
      NonNullable<ReturnType<Renderer['inspect']>['renderScene']['submission']>
    >();
    const laneArtifactsByFrame = new Map<
      number,
      NonNullable<ReturnType<Renderer['inspect']>['renderScene']['gpuDriven']['surfaceArtifact']>
    >();
    const laneGpuDrivenByFrame = new Map<
      number,
      ReturnType<Renderer['inspect']>['renderScene']['gpuDriven']
    >();
    const laneProbeRecordsByFrame = new Map<number, readonly string[]>();
    for (let frame = 0; frame < SURFACE_TIMELINE.totalFrames; frame += 1) {
      const pausedTime = 100 / 60;
      const frameTime =
        laneParity && frame <= SURFACE_TIMELINE.restoredProbes
          ? 0.5
          : !SURFACE_DAWN_LIGHTWEIGHT && frame < 100
            ? frame / 60
            : frame <= SURFACE_TIMELINE.paused[1]
              ? pausedTime
              : frame <= SURFACE_TIMELINE.resumed
                ? SURFACE_DAWN_LIGHTWEIGHT
                  ? 149 / 60
                  : (frame - 50) / 60
                : frame >= SURFACE_TIMELINE.active[0]
                  ? 2.5
                  : pausedTime;
      if (laneParity && frame === SURFACE_TIMELINE.swapProbes) {
        world
          .set(probeDomains[0].entity, LightProbe, {
            irradiance: probeDomains[1].irradiance,
            radius: 1.0,
          })
          .unwrap();
        world
          .set(probeDomains[1].entity, LightProbe, {
            irradiance: probeDomains[0].irradiance,
            radius: 1.0,
          })
          .unwrap();
      } else if (laneParity && frame === SURFACE_TIMELINE.restoreProbes) {
        world
          .set(probeDomains[0].entity, LightProbe, {
            irradiance: probeDomains[0].irradiance,
            radius: 1.0,
          })
          .unwrap();
        world
          .set(probeDomains[1].entity, LightProbe, {
            irradiance: probeDomains[1].irradiance,
            radius: 1.0,
          })
          .unwrap();
      }
      renderer.setSurfaceDynamicInput({
        ...surfaceDynamicInput,
        ranges:
          frame >= SURFACE_TIMELINE.swapProbes && frame < SURFACE_TIMELINE.stopped
            ? [...surfaceDynamicInput.ranges].reverse()
            : frame < SURFACE_TIMELINE.stopped
              ? surfaceDynamicInput.ranges
              : [],
        projectionRevision:
          frame < SURFACE_TIMELINE.swapProbes ? 1 : frame < SURFACE_TIMELINE.stopped ? 2 : 3,
        frameTime,
      });
      world.update(1 / 60).unwrap();
      const drawn = renderer.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
        ...(laneParity &&
        (frame <= SURFACE_TIMELINE.direct ||
          (frame > SURFACE_TIMELINE.gpu && frame <= SURFACE_TIMELINE.directRestored))
          ? { geometryLane: 'direct' as const }
          : {}),
      });
      const drawFailure = drawn.ok
        ? ''
        : JSON.stringify({
            draw: JSON.parse(describeStructuredError(drawn.error)),
            rendererErrors: rendererErrors.map((error) =>
              JSON.parse(describeStructuredError(error)),
            ),
          });
      expect(drawn.ok, drawFailure).toBe(true);
      if (!drawn.ok) throw new Error(drawFailure);
      expect(
        drawn.ok,
        drawn.ok ? undefined : JSON.stringify({ error: drawn.error, rendererErrors }),
      ).toBe(true);
      if (!drawn.ok) throw drawn.error;
      const completion = await drawn.value.completed;
      expect(completion.ok, completion.ok ? '' : describeStructuredError(completion.error)).toBe(
        true,
      );
      if (!completion.ok) throw new Error(describeStructuredError(completion.error));
      completedFrames += 1;
      const evidenceFrames = [
        SURFACE_TIMELINE.direct,
        SURFACE_TIMELINE.gpu,
        SURFACE_TIMELINE.directRestored,
        SURFACE_TIMELINE.swappedProbes,
        SURFACE_TIMELINE.restoredProbes,
        ...SURFACE_TIMELINE.paused,
        SURFACE_TIMELINE.resumed,
        ...SURFACE_TIMELINE.active,
        SURFACE_TIMELINE.stopped,
      ];
      if (evidenceFrames.includes(frame)) {
        if (device === undefined || canvas.target === undefined) {
          throw new Error('surface-standard: intermediate Dawn target unavailable');
        }
        const intermediate = await readPresentedPixels(device, canvas.target);
        waterBRoiByFrame.set(frame, samplePresentedRoi(intermediate, SURFACE_CASES.length - 1));
        if (
          laneParity &&
          [
            SURFACE_TIMELINE.direct,
            SURFACE_TIMELINE.gpu,
            SURFACE_TIMELINE.directRestored,
            SURFACE_TIMELINE.swappedProbes,
            SURFACE_TIMELINE.restoredProbes,
          ].includes(frame)
        ) {
          const observed = await renderer.observe(drawn.value, { include: ['draws'] });
          expect(observed.ok, observed.ok ? '' : describeStructuredError(observed.error)).toBe(
            true,
          );
          laneRoisByFrame.set(
            frame,
            [SURFACE_CASES.length - 2, SURFACE_CASES.length - 1].map((index) =>
              samplePresentedRoi(intermediate, index),
            ),
          );
          lanePhysicalRoisByFrame.set(
            frame,
            [SURFACE_CASES.length - 2, SURFACE_CASES.length - 1].map((index) =>
              samplePresentedRoiPixels(intermediate, index),
            ),
          );
          const submission = renderer.inspect().renderScene.submission;
          if (submission === undefined) {
            throw new Error(`surface-standard: frame ${frame} submission receipt unavailable`);
          }
          laneReceiptsByFrame.set(frame, submission);
          const laneInspection = renderer.inspect();
          laneGpuDrivenByFrame.set(frame, laneInspection.renderScene.gpuDriven);
          laneProbeRecordsByFrame.set(
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
          laneArtifactsByFrame.set(frame, selectedArtifact);
        }
      }
    }
    expect(completedFrames).toBe(SURFACE_TIMELINE.totalFrames);
    const pausedFrames = SURFACE_TIMELINE.paused;
    const resumedFrame = SURFACE_TIMELINE.resumed;
    const activeFrames = SURFACE_TIMELINE.active;
    const stoppedFrame = SURFACE_TIMELINE.stopped;
    expect(waterBRoiByFrame.get(pausedFrames[1])).toEqual(waterBRoiByFrame.get(pausedFrames[0]));
    expect(waterBRoiByFrame.get(activeFrames[1])).toEqual(waterBRoiByFrame.get(activeFrames[0]));
    expect(waterBRoiByFrame.get(resumedFrame)).not.toEqual(waterBRoiByFrame.get(pausedFrames[1]));
    if (laneParity) {
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
      const gpuReceipt = laneReceiptsByFrame.get(SURFACE_TIMELINE.gpu);
      const expectedMemberIds = mediumMembers
        .map((member) =>
          JSON.stringify([
            member.worldIdentity,
            member.entityKey,
            member.drawItemIndex,
            member.instanceOrdinal,
          ]),
        )
        .sort();
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
          gpuDriven: laneGpuDrivenByFrame.get(SURFACE_TIMELINE.gpu),
          rendererErrors: rendererErrors.map((error) => JSON.parse(describeStructuredError(error))),
        }),
      ).toEqual([]);
      const directReceipt = laneReceiptsByFrame.get(SURFACE_TIMELINE.directRestored);
      const directCommands = directReceipt?.passes.flatMap((pass) => pass.commands) ?? [];
      const directMemberIds = [
        ...new Set(
          directCommands.flatMap((command) =>
            command.kind === 'draw' || command.kind === 'draw-indexed' ? command.memberIds : [],
          ),
        ),
      ].sort();
      expect(directMemberIds).toEqual(expectedMemberIds);
      expect(directMemberIds).toEqual([...(gpuReceipt?.passes[0]?.memberIds ?? [])].sort());
      expect(
        directCommands.every(
          (command) =>
            command.programEvidence === 'producer-receipt' &&
            command.receiptIdentity !== undefined &&
            command.receiptGeneration !== undefined,
        ),
      ).toBe(true);
      expect(
        [SURFACE_TIMELINE.direct, SURFACE_TIMELINE.gpu, SURFACE_TIMELINE.directRestored].map(
          (frame) => laneReceiptsByFrame.get(frame)?.frameId,
        ),
      ).toEqual(
        [SURFACE_TIMELINE.direct, SURFACE_TIMELINE.gpu, SURFACE_TIMELINE.directRestored].map(
          (frame) => msaaEdgeEvidence.resized.fourX.receipt.frameId + frame + 1,
        ),
      );
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
      expect(laneProbeRecordsByFrame.get(SURFACE_TIMELINE.swappedProbes)).not.toEqual(
        laneProbeRecordsByFrame.get(SURFACE_TIMELINE.directRestored),
      );
      expect(laneProbeRecordsByFrame.get(SURFACE_TIMELINE.restoredProbes)).toEqual(
        laneProbeRecordsByFrame.get(SURFACE_TIMELINE.directRestored),
      );
      // Medium artifacts carry the ProbeBlend ABI through the surface receipt;
      // the inspection projection intentionally omits that receipt detail and
      // therefore keeps variantSet absent for this authored Surface route.
      expect(laneArtifactsByFrame.get(SURFACE_TIMELINE.swappedProbes)?.variantSet).toBeUndefined();
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
        expect(roiPixelDistance(directPixels, gpuPixels)).toBeLessThanOrEqual(
          SURFACE_PIXEL_EPSILON,
        );
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
        expect(roiPixelDistance(restoredPixels, gpuPixels)).toBeLessThanOrEqual(
          SURFACE_PIXEL_EPSILON,
        );
      }
      // biome-ignore lint/suspicious/noConsole: executable red-gate evidence includes the exact owner inputs and receipts.
      console.log(
        JSON.stringify({
          kind: 'surface-water-direct-gpu-red-gate',
          frameTime: 0.5,
          selectedArtifacts: Object.fromEntries(laneArtifactsByFrame),
          members: mediumMembers,
          dynamicInput: {
            pageId: surfaceDynamicInput.page.pageId,
            contentRevision: surfaceDynamicInput.page.contentRevision,
            bufferGeneration: surfaceDynamicInput.page.bufferGeneration,
            deviceGeneration: surfaceDynamicInput.page.deviceGeneration,
            projectionRevision: surfaceDynamicInput.projectionRevision,
          },
          coldDirect: {
            frame: SURFACE_TIMELINE.direct,
            receipt: laneReceiptsByFrame.get(SURFACE_TIMELINE.direct),
            rois: coldDirect,
          },
          directToGpu: {
            frame: SURFACE_TIMELINE.gpu,
            receipt: laneReceiptsByFrame.get(SURFACE_TIMELINE.gpu),
            rois: gpuAfterDirect,
          },
          gpuToDirect: {
            frame: SURFACE_TIMELINE.directRestored,
            receipt: laneReceiptsByFrame.get(SURFACE_TIMELINE.directRestored),
            rois: directAfterGpu,
          },
        }),
      );
      for (const [index, directRoi] of coldDirect.entries()) {
        const gpuRoi = gpuAfterDirect[index];
        const switchedDirectRoi = directAfterGpu[index];
        if (gpuRoi === undefined || switchedDirectRoi === undefined) {
          throw new Error(`surface-standard: lane ROI ${index} unavailable`);
        }
        expect(
          Math.max(
            ...directRoi.slice(0, 3).map((value, channel) => Math.abs(value - gpuRoi[channel])),
          ) / 255,
          `surface-standard: water ${index} coldDirect=${JSON.stringify(directRoi)} gpu=${JSON.stringify(gpuRoi)}`,
        ).toBeLessThanOrEqual(SURFACE_PIXEL_EPSILON);
        expect(
          Math.max(
            ...switchedDirectRoi
              .slice(0, 3)
              .map((value, channel) => Math.abs(value - gpuRoi[channel])),
          ) / 255,
          `surface-standard: water ${index} switchedDirect=${JSON.stringify(switchedDirectRoi)} gpu=${JSON.stringify(gpuRoi)}`,
        ).toBeLessThanOrEqual(SURFACE_PIXEL_EPSILON);
      }
    }
    const activeRoi = waterBRoiByFrame.get(activeFrames[1]);
    const stoppedRoi = waterBRoiByFrame.get(stoppedFrame);
    if (activeRoi === undefined || stoppedRoi === undefined) {
      throw new Error('surface-standard: lifecycle ROI evidence unavailable');
    }
    expect(
      Math.max(
        ...activeRoi.slice(0, 3).map((value, index) => Math.abs(value - stoppedRoi[index])),
      ) / 255,
    ).toBeGreaterThan(SURFACE_PIXEL_EPSILON);
    // biome-ignore lint/suspicious/noConsole: fixed-ROI lifecycle values are the physical evidence artifact.
    console.log(
      JSON.stringify({
        kind: 'surface-water-lifecycle-roi',
        frameWindow: SURFACE_TIMELINE.totalFrames,
        paused: pausedFrames.map((frame) => ({ frame, roi: waterBRoiByFrame.get(frame) })),
        resumed: { frame: resumedFrame, roi: waterBRoiByFrame.get(resumedFrame) },
        stableActive: activeFrames.map((frame) => ({ frame, roi: waterBRoiByFrame.get(frame) })),
        stopped: { frame: stoppedFrame, roi: stoppedRoi },
      }),
    );
    if (device === undefined || canvas.target === undefined)
      throw new Error('surface-standard: Dawn target unavailable');
    const pixels = await readPresentedPixels(device, canvas.target);
    const observed = renderer.inspect();
    const gpuDriven = observed.renderScene.gpuDriven;
    expect(gpuDriven.submitted).toBe(true);
    expect(gpuDriven.indirectDrawCount).toBeGreaterThan(0);
    const gpuChannels = gpuDriven.channels.filter(
      (channel) => channel.viewPass === 'main' || channel.viewPass === 'directional-shadow',
    );
    expect(gpuChannels.length).toBeGreaterThan(0);
    expect(gpuChannels.every((channel) => channel.lane === 'gpu')).toBe(true);
    expect(gpuChannels.every((channel) => channel.residualDrawCount === 0)).toBe(true);
    const probeRecords = observed.renderScene.probeBlend?.records.filter(
      (record) => record.accepted,
    );
    expect(probeRecords?.length).toBeGreaterThanOrEqual(2);
    expect(new Set(probeRecords?.map((record) => record.objectKey)).size).toBe(
      probeRecords?.length,
    );
    expect(probeRecords?.every((record) => record.generation >= 0)).toBe(true);
    expect(new Set(probeRecords?.map((record) => JSON.stringify(record.shPreblend))).size).toBe(
      probeRecords?.length,
    );
    expect(observed.perFramePassNames.some((name) => name.toLowerCase().includes('shadow'))).toBe(
      true,
    );
    expect(observed.perFramePassNames).toContain('main');
    const records = publications.map(({ surfaceCase, row, publication, material }, index) => {
      const samples = samplePresentedPixel(pixels, index);
      const program = material.passes?.[0]?.program;
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
        selectedEntries: material.passes?.map((entry) => ({
          name: entry.name,
          fragmentEntry: entry.program.fragmentEntry,
          lightMode: (entry.renderState?.tags as Record<string, string> | undefined)?.LightMode,
        })),
        cookIdentity: publication.digest,
        programIdentity: program?.module ?? 'unavailable',
        pipelineIdentity: `${surfaceCase.pass}:${surfaceCase.rootPlan}:${program?.module ?? 'unavailable'}`,
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
          selectedEntries: material.passes?.map((entry) => ({
            name: entry.name,
            fragmentEntry: entry.program.fragmentEntry,
            lightMode: (entry.renderState?.tags as Record<string, string> | undefined)?.LightMode,
          })),
          cookIdentity: publication.digest,
          programIdentity: program?.module ?? 'unavailable',
          pipelineIdentity: `${surfaceCase.pass}:${surfaceCase.rootPlan}:${program?.module ?? 'unavailable'}`,
          sourceClosure: surfaceCase.sourceClosure,
          lane: 'dawn-native',
        },
      };
    });
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
    surfaceDynamicInput.page.release().unwrap();
    expect(surfaceDynamicInput.page.writeRecord(0, {})).toMatchObject({
      ok: false,
      error: { code: 'released' },
    });
    const profileSurfaceDynamicInput = createSurfaceDynamicInput(
      materials,
      mediumMembers,
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
    let forwardRois: readonly (readonly number[])[] | undefined;
    let forwardPixels: Uint8Array | undefined;
    let withoutProbePixels: Uint8Array | undefined;
    const surfaceProbe = world
      .spawn(
        { component: Transform, data: {} },
        { component: LightProbe, data: { irradiance: new Float32Array(27), radius: 20 } },
      )
      .unwrap();
    const deferredParity: { id: string; maxError: number }[] = [];
    let probesRemoved = false;
    const cases = [
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
    for (const combination of cases) {
      const { renderPath, ssao, antialias, bloom } = combination;
      const irradiance = new Float32Array(27);
      if ('probe' in combination) irradiance.set([64, 32, 16]);
      if ('noProbes' in combination && !probesRemoved) {
        for (const entity of [surfaceProbe, ...probeDomains.map((domain) => domain.entity)]) {
          world.despawn(entity).unwrap();
        }
        probesRemoved = true;
      }
      if (!probesRemoved) world.set(surfaceProbe, LightProbe, { irradiance }).unwrap();
      propagateTransforms(world).unwrap();
      if ('scale' in combination) {
        world
          .addComponent(cameraEntity, {
            component: DynamicResolution,
            data: {
              minScale: combination.scale,
              maxScale: combination.scale,
            },
          })
          .unwrap();
      }
      renderer.setProfile({ ...originalProfile, renderPath, ssao }).unwrap();
      world.set(cameraEntity, Camera, { antialias, bloom }).unwrap();
      for (let frame = 0; frame < 6; frame++) {
        const capture =
          frame === 5 && antialias === 0 && bloom === 0 ? recorder?.captureFrame() : undefined;
        if (capture !== undefined && recorder !== undefined)
          (await recorder.frameBoundary()).unwrap();
        world.update(1 / 60).unwrap();
        temporalTarget = undefined;
        const draw = renderer.draw({
          ...('geometryLane' in combination ? { geometryLane: combination.geometryLane } : {}),
          leases: [attached.value],
          camera: { lease: attached.value },
          environment: { lease: attached.value },
        });
        if (!draw.ok) {
          throw new Error(
            JSON.stringify(
              {
                stage: 'surface-profile-draw',
                combination,
                frame,
                error: parseStructuredError(draw.error),
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
        const completed = await draw.value.completed;
        if (!completed.ok) {
          throw new Error(
            JSON.stringify(
              {
                stage: 'surface-profile-completion',
                combination,
                frame,
                error: parseStructuredError(completed.error),
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
        if (capture !== undefined && recorder !== undefined && captureRoot !== undefined) {
          (await recorder.frameBoundary()).unwrap();
          const tape = (await capture).unwrap();
          const directory = resolve(
            captureRoot,
            `${renderPath}-ssao${ssao}-probe${'probe' in combination}-empty${probesRemoved}`,
          );
          mkdirSync(directory, { recursive: true });
          writeFileSync(resolve(directory, 'frame.rhitape'), tape.bytes);
          writeFileSync(
            resolve(directory, 'live.rgba8'),
            await readPresentedPixels(device, canvas.target),
          );
        }
      }
      const current = renderer.inspect();
      if (!('geometryLane' in combination)) {
        expect(current.renderScene.gpuDriven.submitted, JSON.stringify(rendererErrors)).toBe(true);
        expect(current.renderScene.gpuDriven.indirectDrawCount).toBeGreaterThan(0);
        expect(current.renderScene.gpuDriven.cpuFallbackDrawItems).toBe(0);
      }
      expect(current.perFramePassNames.includes('ssao-calc')).toBe(ssao);
      if (antialias === 3) {
        // Read actual motion coverage, independent of MRT/supplement pass
        // placement and empty GPU indirect commands. All four opaque material
        // centers lie on the plane at view distance six, including at DRS .67.
        expect(temporalTarget).toBeDefined();
        if (temporalTarget === undefined) throw new Error('missing Surface temporal target');
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
          for (let index = 0; index < 4; index++) {
            // temporal-v1 stores log2(1 + view depth) in its half-float Z lane.
            const depth = 2 ** halfToFloat(values.getUint16(index * 256 + 4, true)) - 1;
            expect(depth, `${SURFACE_CASES[index]?.id}: actual temporal coverage`).toBeCloseTo(
              6,
              2,
            );
            for (const channel of [0, 1]) {
              expect(
                Math.abs(halfToFloat(values.getUint16(index * 256 + channel * 2, true))),
                `${SURFACE_CASES[index]?.id}: stationary motion`,
              ).toBeLessThan(0.001);
            }
          }
          motionBuffer.unmap();
        } finally {
          motionBuffer.destroy();
        }
      }
      const lit = await readPresentedPixels(device, canvas.target);
      expect(lit.some((value, index) => index % 4 !== 3 && value > 0)).toBe(true);
      if (!ssao && antialias === 0 && bloom === 0) {
        const rois = SURFACE_CASES.map((_, index) => samplePresentedRoi(lit, index));
        if (renderPath === 'forward' && !('probe' in combination)) withoutProbePixels = lit;
        if ('probe' in combination) {
          if (withoutProbePixels === undefined) throw new Error('missing probe baseline');
          for (const index of [0, 1, 2, 3]) {
            // The rusted iron center is a pure metal and correctly has no diffuse SH.
            // Inspect each cell's interior, including its authored nonmetal corrosion.
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
                    Math.abs((lit[byte] ?? Number.NaN) - (withoutProbePixels[byte] ?? Number.NaN)) /
                      255,
                  );
                }
              }
            }
            expect(
              delta,
              `${SURFACE_CASES[index]?.id}: ${renderPath} must consume SH`,
            ).toBeGreaterThan(0.01);
          }
        }
        if (renderPath === 'forward') {
          forwardRois = rois;
          forwardPixels = lit;
        } else {
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
            expect(
              maxError,
              `${surfaceCase.id}: Forward/Deferred Surface parity`,
            ).toBeLessThanOrEqual(0.05);
            deferredParity.push({ id: surfaceCase.id, maxError });
          }
        }
      }
    }
    // Inject the backend loss signal, replace the real Dawn device, and
    // prove the same Surface/Cluster/SSAO/TAA World resumes indirect submission.
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
      materials,
      mediumMembers,
      renderer.inspect().frame.deviceGeneration,
    );
    renderer.setSurfaceDynamicInput({ ...recoveredSurfaceDynamicInput, frameTime: 2.5 });
    for (let frame = 0; frame < 10; frame++) {
      world.update(1 / 60).unwrap();
      const draw = renderer.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      });
      if (!draw.ok) throw draw.error;
      const completed = await draw.value.completed;
      if (!completed.ok) throw completed.error;
    }
    expect(renderer.inspect().renderScene.gpuDriven.submitted).toBe(true);
    expect(renderer.inspect().renderScene.gpuDriven.cpuFallbackDrawItems).toBe(0);
    const restored = await readPresentedPixels(device, canvas.target);
    expect(restored.some((value, index) => index % 4 !== 3 && value > 0)).toBe(true);
    expect(rendererErrors.map(parseStructuredError)).toMatchObject([
      {
        code: 'device-operation-failed',
        detail: { operation: 'renderer-event', cause: { code: 'device-lost' } },
      },
    ]);
    recoveredSurfaceDynamicInput.page.release().unwrap();
    renderer.setSurfaceDynamicInput(undefined);
    rendererErrors.length = 0;
    world.despawn(point).unwrap();
    renderer.setProfile(originalProfile).unwrap();
    expect(rendererErrors).toEqual([]);
    expect(nativeErrors, 'Surface pipelines must pass native GPU validation').toEqual([]);
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
