import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import type { TextureFormat } from '@forgeax/engine-rhi';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import {
  ANTIALIAS_NONE,
  DEFAULT_STANDARD_PROFILE,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  TONEMAP_ACES_FILMIC,
  Camera,
  perspective,
  type FrameReceiptObservation,
  type Renderer,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import {
  AUTO_EXPOSURE_SCENE_CASE,
  AUTO_EXPOSURE_THREE_R184_FIXTURE,
} from '../contracts/auto-exposure-scene-case';
import {
  AC27_COMMON_STAGE_MAPPING,
  type AutoExposureAc27Capture,
  type AutoExposureAc27RendererConfig,
  type AutoExposureAc27StageObservation,
  type AutoExposureAc27ForgeaxProvenance,
} from '../evidence/auto-exposure-ac27-join';
import { normalizeCanvasReadbackBytes } from './vertex-color-capture';

/** Bundler payload accepted by the Runtime renderer host in Browser and Dawn. */
export interface AutoExposureForgeaxBundler {
  readonly importTransport?: unknown;
  readonly shaderManifestUrl?: string;
}

export interface AutoExposureForgeaxCaptureOptions {
  readonly width: number;
  readonly height: number;
  /** Exact product commit paired with the Three r184 reference capture. */
  readonly testedRevision: string;
  readonly runner: { readonly kind: 'browser-webgpu' | 'dawn'; readonly id: string };
  readonly referenceLane?: 'direct' | 'clustered';
  /** SHA-256 of the built source/dist surface used by this producer. */
  readonly build: string;
  readonly version?: string;
  readonly sourceSha?: string;
  readonly forgeaxBundler: AutoExposureForgeaxBundler;
}

export interface AutoExposureForgeaxArtifact extends AutoExposureAc27Capture {
  readonly schemaVersion: 1;
  readonly kind: 'auto-exposure-forgeax-live';
  readonly qualification: 'live-forgeax-renderer-readback';
  readonly caseId: typeof AUTO_EXPOSURE_SCENE_CASE.caseId;
  readonly scene: typeof AUTO_EXPOSURE_THREE_R184_FIXTURE;
  readonly stageOrder: typeof AC27_COMMON_STAGE_MAPPING;
  readonly source?: { readonly path: string; readonly sha256: string };
  readonly readback: {
    readonly method: 'renderer.observe';
    readonly origin: 'top-left';
    readonly sourceFormat: TextureFormat;
    readonly normalization: 'none' | 'bgra-to-rgba';
    /** Hash of the compact bytes returned by the native renderer readback. */
    readonly sourceRawHash: string;
    /** Hash of the compact RGBA bytes used for stage values and comparison. */
    readonly normalizedRawHash: string;
    readonly roi: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
    readonly receipt: {
      readonly frameId: number;
      readonly deviceGeneration: number;
      readonly graphGeneration: number;
    };
    readonly stages: readonly {
      readonly stage: AutoExposureAc27StageObservation['stage'];
      readonly format: TextureFormat | 'decoded-srgb-roi';
      readonly byteLength: number;
      readonly bytesPerRow: number;
      readonly rawHash: string;
    }[];
  };
  readonly status: 'observation';
  readonly overallParityClaim: false;
  readonly notApplicable: typeof AUTO_EXPOSURE_SCENE_CASE.notApplicable;
}

interface CaptureCanvas {
  readonly canvas: HTMLCanvasElement;
  readonly destroy: () => void;
}

interface RgbaRoi {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

type DomainObservation = NonNullable<FrameReceiptObservation['observations']>[number];

const ROI_MAX_SIZE = 16;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REVISION_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

function roiFor(width: number, height: number): RgbaRoi {
  const roiWidth = Math.min(ROI_MAX_SIZE, width);
  const roiHeight = Math.min(ROI_MAX_SIZE, height);
  const fixture = AUTO_EXPOSURE_THREE_R184_FIXTURE;
  const depth = Math.abs(fixture.camera.position[2] - fixture.asset.transform.z);
  const tanHalfFov = Math.tan((fixture.camera.fovDeg * Math.PI) / 360);
  const objectNdcY = fixture.asset.transform.y / (depth * tanHalfFov);
  const objectPixelY = ((1 - objectNdcY) * height) / 2;
  return {
    x: Math.floor((width - roiWidth) / 2),
    y: Math.min(height - roiHeight, Math.max(0, Math.floor(objectPixelY - roiHeight / 2))),
    width: roiWidth,
    height: roiHeight,
  };
}

function canvasViewFormats(format: GPUTextureFormat): readonly GPUTextureFormat[] {
  if (format === 'rgba8unorm') return ['rgba8unorm-srgb'];
  if (format === 'bgra8unorm') return ['bgra8unorm-srgb'];
  return [];
}

function createCanvas(width: number, height: number): CaptureCanvas {
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    document.body?.append(canvas);
    return { canvas, destroy: () => canvas.remove() };
  }
  let device: GPUDevice | undefined;
  let texture: GPUTexture | undefined;
  const canvas = {
    width,
    height,
    style: { width: '', height: '' },
    getContext(kind: string): unknown {
      if (kind !== 'webgpu') return null;
      return {
        configure(desc: { readonly device: GPUDevice; readonly format?: GPUTextureFormat }) {
          device = desc.device;
          texture?.destroy();
          const format = desc.format ?? 'rgba8unorm';
          texture = device.createTexture({
            size: { width, height, depthOrArrayLayers: 1 },
            format,
            usage: 0x10 | 0x01,
            viewFormats: [...canvasViewFormats(format)],
          });
        },
        unconfigure() {},
        getCurrentTexture() {
          if (texture === undefined && device !== undefined) {
            texture = device.createTexture({
              size: { width, height, depthOrArrayLayers: 1 },
              format: 'rgba8unorm',
              usage: 0x10 | 0x01,
              viewFormats: ['rgba8unorm-srgb'],
            });
          }
          if (texture === undefined) throw new Error('ForgeaX AC-27 canvas texture is unavailable');
          return texture;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
    remove() {},
    setAttribute() {},
    getAttribute() { return null; },
  } as unknown as HTMLCanvasElement;
  return { canvas, destroy: () => texture?.destroy() };
}

function setupWorld(): World {
  const world = new World();
  const fixture = AUTO_EXPOSURE_THREE_R184_FIXTURE;
  for (const { offset, color } of fixture.asset.barLayout) {
    const material = world.allocSharedRef(
      'MaterialAsset',
      Materials.unlit(color),
    );
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [offset, fixture.asset.transform.y, fixture.asset.transform.z],
          quat: [0, 0, 0, 1],
          scale: fixture.asset.transform.scale,
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [material] } },
    ).unwrap();
  }
  world.spawn({
    component: DirectionalLight,
    data: {
      direction: fixture.light.direction,
      color: fixture.light.color,
      intensity: fixture.light.intensity,
      castShadow: false,
    },
  }).unwrap();
  world.spawn(
    {
      component: Transform,
      data: {
        pos: fixture.camera.position,
        quat: fixture.camera.rotation,
        scale: [1, 1, 1],
      },
    },
    {
      component: Camera,
      data: {
        ...cameraData(),
        tonemap: TONEMAP_ACES_FILMIC,
        antialias: ANTIALIAS_NONE,
        clearColor: fixture.clearColor,
      },
    },
  ).unwrap();
  return world;
}

function cameraData() {
  return perspective({
    fov: AUTO_EXPOSURE_THREE_R184_FIXTURE.camera.fovDeg * Math.PI / 180,
    aspect: AUTO_EXPOSURE_THREE_R184_FIXTURE.camera.aspect,
    near: AUTO_EXPOSURE_THREE_R184_FIXTURE.camera.near,
    far: AUTO_EXPOSURE_THREE_R184_FIXTURE.camera.far,
    autoAspect: false,
    exposure: { kind: 'manual', multiplier: 1 },
  });
}

function compactRows(bytes: Uint8Array, bytesPerRow: number, width: number, height: number, bytesPerPixel: number): Uint8Array {
  const rowBytes = width * bytesPerPixel;
  if (bytesPerRow < rowBytes || bytes.byteLength < bytesPerRow * height) {
    throw new Error(`ForgeaX AC-27 readback row shape is invalid (${bytes.byteLength}/${bytesPerRow}x${height})`);
  }
  const compact = new Uint8Array(rowBytes * height);
  for (let row = 0; row < height; row += 1) {
    compact.set(bytes.subarray(row * bytesPerRow, row * bytesPerRow + rowBytes), row * rowBytes);
  }
  return compact;
}

function halfToFloat(bits: number): number {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits >>> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * (mantissa / 1024) * 2 ** -14;
  if (exponent === 0x1f) return mantissa === 0 ? sign * Infinity : Number.NaN;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

function decodeHalfValues(bytes: Uint8Array): number[] {
  const values: number[] = [];
  for (let offset = 0; offset + 1 < bytes.byteLength; offset += 2) {
    values.push(halfToFloat((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)));
  }
  return values;
}

function decodeByteValues(bytes: Uint8Array): number[] {
  return Array.from(bytes, (value) => value / 255);
}

export function normalizeAutoExposureFinalReadback(bytes: Uint8Array, format: TextureFormat): {
  readonly bytes: Uint8Array;
  readonly normalization: 'none' | 'bgra-to-rgba';
} {
  if (format !== 'rgba8unorm' && format !== 'rgba8unorm-srgb'
    && format !== 'bgra8unorm' && format !== 'bgra8unorm-srgb') {
    throw new Error(`ForgeaX AC-27 final-display observation format is not an 8-bit display format: ${format}`);
  }
  return {
    bytes: normalizeCanvasReadbackBytes(bytes, format),
    normalization: format === 'bgra8unorm' || format === 'bgra8unorm-srgb' ? 'bgra-to-rgba' : 'none',
  };
}

function sampleRoi(values: readonly number[], width: number, roi: RgbaRoi): number[] {
  const sampled: number[] = [];
  for (let y = roi.y; y < roi.y + roi.height; y += 1) {
    for (let x = roi.x; x < roi.x + roi.width; x += 1) {
      const offset = (y * width + x) * 4;
      sampled.push(values[offset] ?? 0, values[offset + 1] ?? 0, values[offset + 2] ?? 0, values[offset + 3] ?? 0);
    }
  }
  if (sampled.some((value) => !Number.isFinite(value))) throw new Error('ForgeaX AC-27 ROI contains a non-finite channel');
  return sampled;
}

function decodeSrgb(value: number): number {
  const normalized = Math.min(1, Math.max(0, value));
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new Error('ForgeaX AC-27 hashing requires WebCrypto subtle.digest');
  return subtle.digest('SHA-256', bytes as unknown as BufferSource).then((digest) =>
    Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(''),
  );
}

function stableConfig(): AutoExposureAc27RendererConfig {
  return { ...AUTO_EXPOSURE_SCENE_CASE.rendererConfig };
}

function observationByDomain(observation: FrameReceiptObservation, domain: DomainObservation['domain']): DomainObservation {
  const match = observation.observations?.find((candidate) => candidate.domain === domain);
  if (match === undefined) throw new Error(`ForgeaX AC-27 ${domain} observation is missing`);
  return match;
}

function stageFormat(domain: DomainObservation['domain']): 'rgba16float' | 'rgba8unorm-srgb' {
  return domain === 'final-display' ? 'rgba8unorm-srgb' : 'rgba16float';
}

function provenance(options: AutoExposureForgeaxCaptureOptions): AutoExposureAc27ForgeaxProvenance {
  return {
    implementation: 'forgeax',
    package: '@forgeax/engine',
    version: options.version ?? 'workspace',
    commit: options.testedRevision,
    build: options.build,
    backend: options.runner.kind,
  };
}

function validateOptions(options: AutoExposureForgeaxCaptureOptions): void {
  positiveInteger(options.width, 'width');
  positiveInteger(options.height, 'height');
  if (!REVISION_PATTERN.test(options.testedRevision)) throw new Error('ForgeaX AC-27 requires an exact paired revision');
  if (!SHA256_PATTERN.test(options.build)) throw new Error('ForgeaX AC-27 requires a SHA-256 build digest');
  if (options.sourceSha !== undefined && !SHA256_PATTERN.test(options.sourceSha)) throw new Error('ForgeaX AC-27 sourceSha must be a SHA-256 digest');
  if (options.runner.id.length === 0) throw new Error('ForgeaX AC-27 runner id is required');
  if (options.referenceLane !== undefined && options.referenceLane !== 'direct' && options.referenceLane !== 'clustered') throw new Error('ForgeaX AC-27 lane must be direct or clustered');
}

export function validateAutoExposureForgeaxArtifact(input: unknown): { ok: true } | { ok: false; reason: string } {
  if (input === null || typeof input !== 'object') return { ok: false, reason: 'artifact must be an object' };
  const artifact = input as Partial<AutoExposureForgeaxArtifact>;
  if (artifact.schemaVersion !== 1 || artifact.kind !== 'auto-exposure-forgeax-live' || artifact.qualification !== 'live-forgeax-renderer-readback') return { ok: false, reason: 'artifact kind/version is not live ForgeaX' };
  if (artifact.side !== 'forgeax' || artifact.caseId !== AUTO_EXPOSURE_SCENE_CASE.caseId) return { ok: false, reason: 'artifact is not bound to the ForgeaX AC-27 case' };
  if (artifact.provenance?.implementation !== 'forgeax' || typeof artifact.provenance.commit !== 'string' || !REVISION_PATTERN.test(artifact.provenance.commit) || typeof artifact.provenance.build !== 'string' || !SHA256_PATTERN.test(artifact.provenance.build)) return { ok: false, reason: 'artifact ForgeaX provenance is incomplete' };
  if (JSON.stringify(artifact.fixtureIdentity) !== JSON.stringify(AUTO_EXPOSURE_SCENE_CASE.fixtureIdentity) || JSON.stringify(artifact.scene) !== JSON.stringify(AUTO_EXPOSURE_THREE_R184_FIXTURE)) return { ok: false, reason: 'artifact fixture does not match the canonical executable fixture' };
  if (JSON.stringify(artifact.config) !== JSON.stringify(AUTO_EXPOSURE_SCENE_CASE.rendererConfig)) return { ok: false, reason: 'artifact renderer config is not the pinned AC-27 config' };
  if (JSON.stringify(artifact.stageOrder) !== JSON.stringify(AC27_COMMON_STAGE_MAPPING) || !Array.isArray(artifact.stages) || artifact.stages.length !== AC27_COMMON_STAGE_MAPPING.length) return { ok: false, reason: 'artifact common-stage mapping is incomplete' };
  const stages = artifact.stages as readonly AutoExposureAc27StageObservation[];
  for (const stage of stages) {
    if (!Array.isArray(stage.values) || stage.values.length === 0 || stage.values.some((value: unknown) => typeof value !== 'number' || !Number.isFinite(value)) || typeof stage.rawHash !== 'string' || !SHA256_PATTERN.test(stage.rawHash)) return { ok: false, reason: 'artifact stage readback is incomplete' };
  }
  const decoded = stages.find((stage) => stage.stage === 'decoded-sRGB-roi');
  if (decoded === undefined || decoded.values.every((value) => value === 0)) return { ok: false, reason: 'artifact decoded-sRGB ROI is vacuous' };
  if (artifact.readback?.method !== 'renderer.observe'
    || artifact.readback.sourceFormat === undefined
    || typeof artifact.readback.sourceRawHash !== 'string'
    || !SHA256_PATTERN.test(artifact.readback.sourceRawHash)
    || typeof artifact.readback.normalizedRawHash !== 'string'
    || !SHA256_PATTERN.test(artifact.readback.normalizedRawHash)
    || (artifact.readback.normalization !== 'none' && artifact.readback.normalization !== 'bgra-to-rgba')
    || artifact.status !== 'observation'
    || artifact.overallParityClaim !== false) return { ok: false, reason: 'artifact readback provenance is incomplete' };
  if (artifact.readback.normalization === 'bgra-to-rgba'
    && artifact.readback.sourceFormat !== 'bgra8unorm'
    && artifact.readback.sourceFormat !== 'bgra8unorm-srgb') return { ok: false, reason: 'artifact readback normalization does not match source format' };
  if (artifact.readback.normalization === 'none'
    && artifact.readback.sourceFormat !== 'rgba8unorm'
    && artifact.readback.sourceFormat !== 'rgba8unorm-srgb') return { ok: false, reason: 'artifact readback source format is not a canonical RGBA display format' };
  const outputStage = stages.find((stage) => stage.stage === 'output-encoding');
  if (outputStage === undefined || artifact.readback.normalizedRawHash !== outputStage.rawHash) {
    return { ok: false, reason: 'artifact normalized output hash does not match the output-encoding stage' };
  }
  if (artifact.readback.normalization === 'none' && artifact.readback.sourceRawHash !== artifact.readback.normalizedRawHash) {
    return { ok: false, reason: 'RGBA readback must preserve the native source hash when no normalization is applied' };
  }
  return { ok: true };
}

/** Capture all common AC-27 domains from the real ForgeaX renderer receipt. */
export async function captureAutoExposureForgeax(options: AutoExposureForgeaxCaptureOptions): Promise<AutoExposureForgeaxArtifact> {
  validateOptions(options);
  const surface = createCanvas(options.width, options.height);
  const referenceLane = options.referenceLane ?? 'direct';
  const standardProfile = {
    ...DEFAULT_STANDARD_PROFILE,
    renderPath: referenceLane === 'clustered' ? 'deferred' as const : 'forward' as const,
  };
  const constructed = await constructRuntimeRendererHost(
    surface.canvas,
    { standardProfile },
    options.forgeaxBundler as never,
  );
  if (!constructed.ok) {
    surface.destroy();
    throw new Error(`ForgeaX AC-27 renderer unavailable: ${'code' in constructed.error ? constructed.error.code : String(constructed.error)}`);
  }
  const renderer = constructed.value.renderer as Renderer;
  const debugHost = constructed.value.debugDrawHost as {
    readonly perFramePassNames?: readonly string[];
    readonly renderFeatureDiagnostics?: () => readonly unknown[];
  };
  const world = setupWorld();
  const attached = renderer.attach(world);
  if (!attached.ok) {
    await renderer.dispose();
    surface.destroy();
    throw new Error(`ForgeaX AC-27 attach failed: ${attached.error.code}`);
  }
  try {
    let receipt;
    for (let frame = 0; frame < 2; frame += 1) {
      world.update(1 / 60).unwrap();
      if (frame === 1) {
        const requested = renderer.requestObservation?.(['linear-hdr', 'linear-ldr', 'final-display']);
        if (requested === undefined || !requested.ok) throw new Error(`ForgeaX AC-27 observation request failed: ${requested === undefined ? 'unavailable' : requested.error.code}`);
      }
      const drawn = renderer.draw({ leases: [attached.value], camera: { lease: attached.value }, environment: { lease: attached.value } });
      if (!drawn.ok) throw new Error(`ForgeaX AC-27 draw failed: ${drawn.error.code}`);
      receipt = drawn.value;
    }
    if (receipt === undefined) throw new Error('ForgeaX AC-27 did not produce a receipt');
    const completed = await receipt.completed;
    if (!completed.ok) throw new Error(`ForgeaX AC-27 receipt failed: ${completed.error.code}`);
    const observed = await renderer.observe(receipt, { include: ['linear-hdr', 'linear-ldr', 'final-display'] });
    if (!observed.ok) throw new Error(`ForgeaX AC-27 observation failed: ${JSON.stringify({ error: observed.error, passNames: debugHost.perFramePassNames, features: debugHost.renderFeatureDiagnostics?.() })}`);
    const roi = roiFor(options.width, options.height);
    const domains = {
      hdr: observationByDomain(observed.value, 'linear-hdr'),
      ldr: observationByDomain(observed.value, 'linear-ldr'),
      final: observationByDomain(observed.value, 'final-display'),
    };
    const finalRaw = compactRows(domains.final.bytes, domains.final.metadata.bytesPerRow, options.width, options.height, 4);
    const normalizedFinal = normalizeAutoExposureFinalReadback(finalRaw, domains.final.metadata.format);
    const compact = {
      hdr: compactRows(domains.hdr.bytes, domains.hdr.metadata.bytesPerRow, options.width, options.height, 8),
      ldr: compactRows(domains.ldr.bytes, domains.ldr.metadata.bytesPerRow, options.width, options.height, 8),
      final: normalizedFinal.bytes,
    };
    const [hdrHash, ldrHash, sourceFinalHash, normalizedFinalHash] = await Promise.all([
      sha256Bytes(compact.hdr),
      sha256Bytes(compact.ldr),
      sha256Bytes(finalRaw),
      sha256Bytes(compact.final),
    ]);
    const hdrValues = decodeHalfValues(compact.hdr);
    const ldrValues = decodeHalfValues(compact.ldr);
    const finalValues = decodeByteValues(compact.final);
    const decodedValues = sampleRoi(finalValues, options.width, roi).map(decodeSrgb);
    const decodedHash = await sha256Bytes(new Uint8Array(new Float32Array(decodedValues).buffer));
    const stages: AutoExposureAc27StageObservation[] = [
      { stage: 'linear-HDR', domain: 'linear-HDR', values: sampleRoi(hdrValues, options.width, roi), rawHash: hdrHash },
      { stage: 'tone-mapping', domain: 'linear-LDR', values: sampleRoi(ldrValues, options.width, roi), rawHash: ldrHash },
      { stage: 'output-encoding', domain: 'final-sRGB', values: sampleRoi(finalValues, options.width, roi), rawHash: normalizedFinalHash },
      { stage: 'decoded-sRGB-roi', domain: 'decoded-sRGB', values: decodedValues, rawHash: decodedHash },
    ];
    const artifact: AutoExposureForgeaxArtifact = {
      schemaVersion: 1,
      kind: 'auto-exposure-forgeax-live',
      qualification: 'live-forgeax-renderer-readback',
      caseId: AUTO_EXPOSURE_SCENE_CASE.caseId,
      side: 'forgeax',
      referenceLane,
      testedRevision: options.testedRevision,
      runner: options.runner,
      resolution: { width: options.width, height: options.height },
      provenance: provenance(options),
      fixtureIdentity: AUTO_EXPOSURE_SCENE_CASE.fixtureIdentity,
      scene: AUTO_EXPOSURE_THREE_R184_FIXTURE,
      config: stableConfig(),
      stages,
      stageOrder: AC27_COMMON_STAGE_MAPPING,
      ...(options.sourceSha === undefined ? {} : { source: { path: 'apps/hello/taa/src/main.ts', sha256: options.sourceSha } }),
      readback: {
        method: 'renderer.observe',
        origin: 'top-left',
        sourceFormat: domains.final.metadata.format,
        normalization: normalizedFinal.normalization,
        sourceRawHash: sourceFinalHash,
        normalizedRawHash: normalizedFinalHash,
        roi,
        receipt: {
          frameId: receipt.frameId,
          deviceGeneration: receipt.deviceGeneration,
          graphGeneration: receipt.graphGeneration ?? 0,
        },
        stages: [
          { stage: 'linear-HDR', format: stageFormat('linear-hdr'), byteLength: compact.hdr.byteLength, bytesPerRow: domains.hdr.metadata.bytesPerRow, rawHash: hdrHash },
          { stage: 'tone-mapping', format: stageFormat('linear-ldr'), byteLength: compact.ldr.byteLength, bytesPerRow: domains.ldr.metadata.bytesPerRow, rawHash: ldrHash },
          { stage: 'output-encoding', format: domains.final.metadata.format, byteLength: finalRaw.byteLength, bytesPerRow: domains.final.metadata.bytesPerRow, rawHash: normalizedFinalHash },
          { stage: 'decoded-sRGB-roi', format: 'rgba8unorm-srgb', byteLength: decodedValues.length * 4, bytesPerRow: decodedValues.length * 4, rawHash: decodedHash },
        ],
      },
      status: 'observation',
      overallParityClaim: false,
      notApplicable: AUTO_EXPOSURE_SCENE_CASE.notApplicable,
    };
    const valid = validateAutoExposureForgeaxArtifact(artifact);
    if (!valid.ok) throw new Error(`ForgeaX AC-27 artifact validation failed: ${valid.reason}`);
    return Object.freeze(artifact);
  } finally {
    await renderer.dispose();
    surface.destroy();
  }
}

export function serializeAutoExposureForgeaxArtifact(artifact: AutoExposureForgeaxArtifact): string {
  const valid = validateAutoExposureForgeaxArtifact(artifact);
  if (!valid.ok) throw new Error(`cannot serialize invalid ForgeaX AC-27 artifact: ${valid.reason}`);
  return `${JSON.stringify(artifact, null, 2)}\n`;
}
