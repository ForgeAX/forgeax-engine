import {
  ACESFilmicToneMapping,
  BoxGeometry,
  Color,
  DirectionalLight,
  HalfFloatType,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicMaterial,
  NoToneMapping,
  PerspectiveCamera,
  RenderTarget,
  Scene,
  SRGBColorSpace,
  UnsignedByteType,
} from 'three';
import { WebGPURenderer } from 'three/webgpu';
import {
  AUTO_EXPOSURE_SCENE_CASE,
  AUTO_EXPOSURE_THREE_R184_FIXTURE,
  THREE_R184_PROVENANCE,
} from '../contracts/auto-exposure-scene-case';
import {
  AC27_COMMON_STAGE_MAPPING,
  type AutoExposureAc27Capture,
  type AutoExposureAc27RendererConfig,
  type AutoExposureAc27StageObservation,
  type AutoExposureAc27ThreeProvenance,
} from '../evidence/auto-exposure-ac27-join';
import { installNodeAnimationContext } from './vertex-color-capture';

/**
 * A live Three.js r184 readback, rather than an analytic or contract fixture.
 * The extra fields are deliberately detached POD so a producer can persist the
 * raw readback identity without handing a renderer, target, or GPU handle to a
 * report consumer.
 */
export interface AutoExposureThreeR184Artifact extends AutoExposureAc27Capture {
  readonly schemaVersion: 1;
  readonly kind: 'auto-exposure-three-r184-live';
  readonly qualification: 'live-three-r184-webgpu-readback';
  readonly caseId: typeof AUTO_EXPOSURE_SCENE_CASE.caseId;
  readonly scene: typeof AUTO_EXPOSURE_THREE_R184_FIXTURE;
  readonly stageOrder: typeof AC27_COMMON_STAGE_MAPPING;
  readonly renderStates: readonly {
    readonly stage: AutoExposureAc27StageObservation['stage'];
    readonly toneMapping: 'NoToneMapping' | 'ACESFilmicToneMapping';
    readonly toneMappingExposure: 1;
    readonly outputColorSpace: 'LinearSRGBColorSpace' | 'SRGBColorSpace';
    readonly targetType: 'HalfFloatType' | 'UnsignedByteType';
    readonly targetColorSpace: 'LinearSRGBColorSpace' | 'SRGBColorSpace';
  }[];
  readonly readback: {
    readonly method: 'readRenderTargetPixelsAsync';
    readonly origin: 'bottom-left';
    readonly roi: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
    readonly stages: readonly {
      readonly stage: AutoExposureAc27StageObservation['stage'];
      readonly format: 'rgba16float' | 'rgba8unorm-srgb' | 'decoded-srgb-roi';
      readonly byteLength: number;
      readonly rawHash: string;
    }[];
  };
  readonly status: 'observation';
  readonly overallParityClaim: false;
  readonly notApplicable: typeof AUTO_EXPOSURE_SCENE_CASE.notApplicable;
}

export interface AutoExposureThreeR184CaptureOptions {
  readonly width: number;
  readonly height: number;
  /** The product exact head that this independent reference is paired with. */
  readonly testedRevision: string;
  readonly runner: { readonly kind: 'browser-webgpu' | 'dawn'; readonly id: string };
  readonly referenceLane?: 'direct' | 'clustered';
}

interface CaptureCanvas {
  readonly canvas: HTMLCanvasElement;
  readonly destroy: () => void;
}

interface Readback {
  readonly value: unknown;
  readonly bytes: Uint8Array;
}

interface StageReadback extends Readback {
  readonly values: readonly number[];
  readonly format: 'rgba16float' | 'rgba8unorm-srgb';
  readonly targetType: 'HalfFloatType' | 'UnsignedByteType';
  readonly targetColorSpace: 'LinearSRGBColorSpace' | 'SRGBColorSpace';
}

const ROI_MAX_SIZE = 16;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REVISION_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const FLOAT32_BYTES_PER_VALUE = 4;

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value).slice();
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  throw new Error('Three r184 readback did not return an ArrayBuffer view');
}

function halfToFloat(bits: number): number {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits >>> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * (mantissa / 1024) * 2 ** -14;
  if (exponent === 0x1f) return mantissa === 0 ? sign * Infinity : Number.NaN;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

function decodeHalfValues(bytes: Uint8Array, width: number, height: number): number[] {
  const expected = width * height * 4 * 2;
  if (bytes.byteLength !== expected) {
    throw new Error(`Three r184 rgba16float readback has ${bytes.byteLength} bytes; expected ${expected}`);
  }
  const values: number[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 2) {
    values.push(halfToFloat((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)));
  }
  return values;
}

function decodeByteValues(bytes: Uint8Array, width: number, height: number): number[] {
  const expected = width * height * 4;
  if (bytes.byteLength !== expected) {
    throw new Error(`Three r184 rgba8unorm-srgb readback has ${bytes.byteLength} bytes; expected ${expected}`);
  }
  return Array.from(bytes, (value) => value / 255);
}

function assertFinite(values: readonly number[], label: string): void {
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error(`Three r184 ${label} readback contains a non-finite channel`);
  }
}

function roiFor(width: number, height: number): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  const roiWidth = Math.min(ROI_MAX_SIZE, width);
  const roiHeight = Math.min(ROI_MAX_SIZE, height);
  const fixture = AUTO_EXPOSURE_THREE_R184_FIXTURE;
  const depth = Math.abs(fixture.camera.position[2] - fixture.asset.transform.z);
  const tanHalfFov = Math.tan((fixture.camera.fovDeg * Math.PI) / 360);
  const objectNdcY = fixture.asset.transform.y / (depth * tanHalfFov);
  const objectPixelY = ((1 - objectNdcY) * height) / 2;
  return {
    x: Math.floor((width - roiWidth) / 2),
    // The canonical bars are authored above the camera's optical center. A
    // geometric center ROI samples only the transparent clear colour and
    // makes a live readback vacuous. Derive the anchor from the executable
    // fixture's camera and asset coordinates, never from captured pixels.
    y: Math.min(height - roiHeight, Math.max(0, Math.floor(objectPixelY - roiHeight / 2))),
    width: roiWidth,
    height: roiHeight,
  };
}

function sampleRoi(values: readonly number[], width: number, roi: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): number[] {
  const sampled: number[] = [];
  for (let y = roi.y; y < roi.y + roi.height; y += 1) {
    for (let x = roi.x; x < roi.x + roi.width; x += 1) {
      const offset = (y * width + x) * 4;
      sampled.push(values[offset] ?? 0, values[offset + 1] ?? 0, values[offset + 2] ?? 0, values[offset + 3] ?? 0);
    }
  }
  assertFinite(sampled, 'ROI');
  return sampled;
}

/** Decode an sRGB code value to the linear value used by the common comparison domain. */
function decodeSrgb(value: number): number {
  const normalized = Math.min(1, Math.max(0, value));
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function decodeSrgbRoi(values: readonly number[], width: number, roi: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): number[] {
  return sampleRoi(values, width, roi).map(decodeSrgb);
}

function encodeFloat32LittleEndian(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * FLOAT32_BYTES_PER_VALUE);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * FLOAT32_BYTES_PER_VALUE, value, true));
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new Error('Three r184 artifact hashing requires WebCrypto subtle.digest');
  const digest = await subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

function canvasViewFormats(format: GPUTextureFormat): readonly GPUTextureFormat[] {
  switch (format) {
    case 'rgba8unorm':
      return ['rgba8unorm-srgb'];
    case 'bgra8unorm':
      return ['bgra8unorm-srgb'];
    default:
      return [];
  }
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
          if (texture === undefined) throw new Error('Three r184 Dawn canvas texture is unavailable');
          return texture;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
    remove() {},
    setAttribute() {},
    getAttribute() {
      return null;
    },
  } as unknown as HTMLCanvasElement;
  return { canvas, destroy: () => texture?.destroy() };
}

function createScene(): {
  readonly scene: any;
  readonly camera: any;
  readonly geometry: { dispose(): void };
  readonly materials: readonly { dispose(): void }[];
  readonly light: any;
} {
  const fixture = AUTO_EXPOSURE_THREE_R184_FIXTURE;
  const scene = new Scene();
  const geometry = new BoxGeometry(...fixture.asset.dimensions);
  const materials = fixture.asset.barLayout.map(({ color }) => new MeshBasicMaterial({
    // The canonical fixture stores RGBA, while Three's setRGB fourth
    // argument is a color-space tag (not alpha). Keep the shared alpha
    // contract explicit and pass only RGB to the color conversion API.
    color: new Color().setRGB(color[0], color[1], color[2], LinearSRGBColorSpace),
    opacity: color[3],
    transparent: color[3] < 1,
  }));
  fixture.asset.barLayout.forEach(({ offset }, index) => {
    const material = materials[index];
    if (material === undefined) throw new Error(`Three r184 canonical bar material ${index} is missing`);
    const mesh = new Mesh(geometry, material);
    mesh.position.set(offset, fixture.asset.transform.y, fixture.asset.transform.z);
    mesh.scale.set(...fixture.asset.transform.scale);
    scene.add(mesh);
  });
  const lightColor = new Color().setRGB(...fixture.light.color, LinearSRGBColorSpace);
  const light = new DirectionalLight(lightColor, fixture.light.intensity);
  light.position.set(...fixture.light.direction);
  light.target.position.set(...fixture.light.target);
  scene.add(light, light.target);
  const camera = new PerspectiveCamera(fixture.camera.fovDeg, fixture.camera.aspect, fixture.camera.near, fixture.camera.far);
  camera.position.set(...fixture.camera.position);
  camera.quaternion.set(...fixture.camera.rotation);
  return { scene, camera, geometry, materials, light };
}

async function renderStage(
  renderer: any,
  scene: any,
  camera: any,
  width: number,
  height: number,
  type: number,
  typeName: 'HalfFloatType' | 'UnsignedByteType',
  targetColorSpace: 'LinearSRGBColorSpace' | 'SRGBColorSpace',
  toneMapping: number,
  outputColorSpace: 'LinearSRGBColorSpace' | 'SRGBColorSpace',
  format: StageReadback['format'],
  outputTarget: boolean,
): Promise<StageReadback> {
  const target = new RenderTarget(width, height, {
    depthBuffer: true,
    stencilBuffer: false,
    type,
    colorSpace: targetColorSpace === 'LinearSRGBColorSpace' ? LinearSRGBColorSpace : SRGBColorSpace,
  });
  try {
    // These are real Three renderer state transitions around real GPU target
    // renders. The authored AC-27 config remains ACES/1/SRGB in the artifact;
    // stage-local state only exposes the common pipeline boundaries.
    renderer.toneMapping = toneMapping;
    renderer.toneMappingExposure = 1;
    renderer.outputColorSpace = outputColorSpace === 'LinearSRGBColorSpace' ? LinearSRGBColorSpace : SRGBColorSpace;
    // Three r184 applies tone mapping and output encoding only when the
    // renderer is producing output (`isOutputTarget === true`). A custom
    // RenderTarget set with setRenderTarget() is intentionally a linear scene
    // target, so using it for the tone stage would silently read back the HDR
    // source again. Bind the same real GPU target as the output target and let
    // r184's own output pipeline perform the stage before readback.
    if (outputTarget) {
      renderer.setOutputRenderTarget(target);
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(target);
    }
    await renderer.renderAsync(scene, camera);
    const value = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
    const bytes = asBytes(value);
    const values = typeName === 'HalfFloatType'
      ? decodeHalfValues(bytes, width, height)
      : decodeByteValues(bytes, width, height);
    assertFinite(values, format);
    return { value, bytes, values, format, targetType: typeName, targetColorSpace };
  } finally {
    renderer.setRenderTarget(null);
    if (outputTarget) renderer.setOutputRenderTarget(null);
    target.dispose();
  }
}

function stableProvenance(): AutoExposureAc27ThreeProvenance {
  return {
    implementation: 'three',
    package: 'three',
    version: '0.184.0',
    commit: THREE_R184_PROVENANCE.commit,
    integrity: THREE_R184_PROVENANCE.integrity,
    backend: 'webgpu',
  };
}

function stableConfig(): AutoExposureAc27RendererConfig {
  return { ...AUTO_EXPOSURE_SCENE_CASE.rendererConfig };
}

function validateOptions(options: AutoExposureThreeR184CaptureOptions): void {
  if (!isPositiveInteger(options.width) || !isPositiveInteger(options.height)) {
    throw new Error('Three r184 capture resolution must contain positive integers');
  }
  if (!REVISION_PATTERN.test(options.testedRevision)) {
    throw new Error('Three r184 capture requires the exact paired product revision');
  }
  if (options.runner.kind !== 'browser-webgpu' && options.runner.kind !== 'dawn') {
    throw new Error('Three r184 capture runner must be browser-webgpu or dawn');
  }
  if (options.runner.id.length === 0) throw new Error('Three r184 capture runner id is required');
}

function sceneDescription(): AutoExposureThreeR184Artifact['scene'] {
  return AUTO_EXPOSURE_THREE_R184_FIXTURE;
}

export function validateAutoExposureThreeR184Artifact(input: unknown): { ok: true } | { ok: false; reason: string } {
  if (input === null || typeof input !== 'object') return { ok: false, reason: 'artifact must be an object' };
  const artifact = input as Partial<AutoExposureThreeR184Artifact>;
  if (artifact.schemaVersion !== 1
    || artifact.kind !== 'auto-exposure-three-r184-live'
    || artifact.qualification !== 'live-three-r184-webgpu-readback') return { ok: false, reason: 'artifact kind/version is not live Three r184' };
  const provenance = artifact.provenance;
  if (artifact.side !== 'three'
    || provenance === undefined
    || provenance.implementation !== 'three'
    || provenance.package !== THREE_R184_PROVENANCE.package
    || provenance.version !== THREE_R184_PROVENANCE.version
    || provenance.commit !== THREE_R184_PROVENANCE.commit
    || provenance.integrity !== THREE_R184_PROVENANCE.integrity
    || provenance.backend !== 'webgpu') return { ok: false, reason: 'artifact is not the pinned Three r184 WebGPU producer' };
  if (artifact.caseId !== AUTO_EXPOSURE_SCENE_CASE.caseId || !REVISION_PATTERN.test(artifact.testedRevision ?? '')) return { ok: false, reason: 'artifact is not bound to the exact feature revision' };
  if (artifact.referenceLane !== 'direct' && artifact.referenceLane !== 'clustered') return { ok: false, reason: 'artifact reference lane is missing' };
  if (artifact.resolution === undefined || !isPositiveInteger(artifact.resolution.width) || !isPositiveInteger(artifact.resolution.height)) return { ok: false, reason: 'artifact resolution is invalid' };
  if (artifact.config === undefined || JSON.stringify(artifact.config) !== JSON.stringify(AUTO_EXPOSURE_SCENE_CASE.rendererConfig)) return { ok: false, reason: 'artifact renderer config is not the pinned AC-27 config' };
  if (artifact.fixtureIdentity === undefined || JSON.stringify(artifact.fixtureIdentity) !== JSON.stringify(AUTO_EXPOSURE_SCENE_CASE.fixtureIdentity)) return { ok: false, reason: 'artifact fixture identity does not match canonical identity' };
  if (artifact.scene === undefined || JSON.stringify(artifact.scene) !== JSON.stringify(AUTO_EXPOSURE_THREE_R184_FIXTURE)) return { ok: false, reason: 'artifact scene does not match the executable canonical fixture' };
  if (JSON.stringify(artifact.stageOrder) !== JSON.stringify(AC27_COMMON_STAGE_MAPPING)) return { ok: false, reason: 'artifact stage order does not match the common-stage contract' };
  if (!Array.isArray(artifact.stages) || artifact.stages.length !== AC27_COMMON_STAGE_MAPPING.length) return { ok: false, reason: 'artifact must contain all common stages' };
  const expectedStages = new Set(AC27_COMMON_STAGE_MAPPING.map((stage) => stage.stage));
  for (const candidate of artifact.stages as readonly unknown[]) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return { ok: false, reason: 'artifact stage readback is malformed' };
    const stage = candidate as Partial<AutoExposureAc27StageObservation>;
    if (typeof stage.stage !== 'string'
      || !expectedStages.has(stage.stage)
      || typeof stage.domain !== 'string'
      || typeof stage.rawHash !== 'string'
      || !SHA256_PATTERN.test(stage.rawHash)
      || !Array.isArray(stage.values)
      || stage.values.length === 0
      || stage.values.some((value): boolean => typeof value !== 'number' || !Number.isFinite(value))) return { ok: false, reason: 'artifact stage readback is incomplete or non-finite' };
  }
  const decoded = (artifact.stages as readonly AutoExposureAc27StageObservation[])
    .find((stage) => stage.stage === 'decoded-sRGB-roi');
  if (decoded === undefined || decoded.values.every((value) => value === 0)) {
    return { ok: false, reason: 'artifact decoded-sRGB ROI is vacuous; the executable fixture must contribute a non-zero signal' };
  }
  if (artifact.readback?.method !== 'readRenderTargetPixelsAsync'
    || !Array.isArray(artifact.readback.stages)
    || artifact.readback.stages.length !== AC27_COMMON_STAGE_MAPPING.length) return { ok: false, reason: 'artifact readback provenance is missing' };
  if (artifact.status !== 'observation' || artifact.overallParityClaim !== false) return { ok: false, reason: 'live artifact cannot claim parity' };
  return { ok: true };
}

/**
 * Execute the independent Three.js reference and return a persistable artifact.
 * No ForgeaX code, analytic formula, or CPU-generated candidate participates in
 * these stage values; CPU work only hashes and projects the GPU readback.
 */
export async function captureAutoExposureThreeR184(
  options: AutoExposureThreeR184CaptureOptions,
): Promise<AutoExposureThreeR184Artifact> {
  validateOptions(options);
  const animationContext = installNodeAnimationContext();
  const surface = createCanvas(options.width, options.height);
  const renderer = new WebGPURenderer({ canvas: surface.canvas, antialias: false, forceWebGL: false });
  const targetStages: StageReadback[] = [];
  const roi = roiFor(options.width, options.height);
  try {
    await renderer.init();
    if (renderer.backend?.isWebGPUBackend !== true) throw new Error('Three r184 WebGPU backend unavailable');
    renderer.setSize(options.width, options.height, false);
    renderer.setClearColor(
      new Color().setRGB(
        AUTO_EXPOSURE_THREE_R184_FIXTURE.clearColor[0],
        AUTO_EXPOSURE_THREE_R184_FIXTURE.clearColor[1],
        AUTO_EXPOSURE_THREE_R184_FIXTURE.clearColor[2],
        LinearSRGBColorSpace,
      ),
      AUTO_EXPOSURE_THREE_R184_FIXTURE.clearColor[3],
    );
    const sceneState = createScene();
    try {
      const linear = await renderStage(
        renderer,
        sceneState.scene,
        sceneState.camera,
        options.width,
        options.height,
        HalfFloatType,
        'HalfFloatType',
        'LinearSRGBColorSpace',
        NoToneMapping,
        'LinearSRGBColorSpace',
        'rgba16float',
        false,
      );
      targetStages.push(linear);
      const tone = await renderStage(
        renderer,
        sceneState.scene,
        sceneState.camera,
        options.width,
        options.height,
        HalfFloatType,
        'HalfFloatType',
        'LinearSRGBColorSpace',
        ACESFilmicToneMapping,
        'LinearSRGBColorSpace',
        'rgba16float',
        true,
      );
      targetStages.push(tone);
      const output = await renderStage(
        renderer,
        sceneState.scene,
        sceneState.camera,
        options.width,
        options.height,
        UnsignedByteType,
        'UnsignedByteType',
        // Keep the readback attachment linear so the explicit SRGB output
        // transform is observed as raw code values rather than being encoded
        // a second time by an sRGB render-attachment view.
        'LinearSRGBColorSpace',
        ACESFilmicToneMapping,
        'SRGBColorSpace',
        'rgba8unorm-srgb',
        true,
      );
      targetStages.push(output);
      const hashes = await Promise.all(targetStages.map((stage) => sha256(stage.bytes)));
      const decodedRoi = decodeSrgbRoi(output.values, options.width, roi);
      const decodedHash = await sha256(encodeFloat32LittleEndian(decodedRoi));
      const provenance = stableProvenance();
      const stages: AutoExposureAc27StageObservation[] = [
        { stage: 'linear-HDR', domain: 'linear-HDR', values: sampleRoi(linear.values, options.width, roi), rawHash: hashes[0] ?? '' },
        { stage: 'tone-mapping', domain: 'linear-LDR', values: sampleRoi(tone.values, options.width, roi), rawHash: hashes[1] ?? '' },
        { stage: 'output-encoding', domain: 'final-sRGB', values: sampleRoi(output.values, options.width, roi), rawHash: hashes[2] ?? '' },
        { stage: 'decoded-sRGB-roi', domain: 'decoded-sRGB', values: decodedRoi, rawHash: decodedHash },
      ];
      const artifact: AutoExposureThreeR184Artifact = {
        schemaVersion: 1,
        kind: 'auto-exposure-three-r184-live',
        qualification: 'live-three-r184-webgpu-readback',
        caseId: AUTO_EXPOSURE_SCENE_CASE.caseId,
        side: 'three',
        referenceLane: options.referenceLane ?? 'direct',
        testedRevision: options.testedRevision,
        runner: options.runner,
        resolution: { width: options.width, height: options.height },
        provenance,
        fixtureIdentity: AUTO_EXPOSURE_SCENE_CASE.fixtureIdentity,
        config: stableConfig(),
        stages,
        scene: sceneDescription(),
        stageOrder: AC27_COMMON_STAGE_MAPPING,
        renderStates: [
          { stage: 'linear-HDR', toneMapping: 'NoToneMapping', toneMappingExposure: 1, outputColorSpace: 'LinearSRGBColorSpace', targetType: 'HalfFloatType', targetColorSpace: 'LinearSRGBColorSpace' },
          { stage: 'tone-mapping', toneMapping: 'ACESFilmicToneMapping', toneMappingExposure: 1, outputColorSpace: 'LinearSRGBColorSpace', targetType: 'HalfFloatType', targetColorSpace: 'LinearSRGBColorSpace' },
          { stage: 'output-encoding', toneMapping: 'ACESFilmicToneMapping', toneMappingExposure: 1, outputColorSpace: 'SRGBColorSpace', targetType: 'UnsignedByteType', targetColorSpace: 'LinearSRGBColorSpace' },
          { stage: 'decoded-sRGB-roi', toneMapping: 'ACESFilmicToneMapping', toneMappingExposure: 1, outputColorSpace: 'SRGBColorSpace', targetType: 'UnsignedByteType', targetColorSpace: 'LinearSRGBColorSpace' },
        ],
        readback: {
          method: 'readRenderTargetPixelsAsync',
          origin: 'bottom-left',
          roi,
          stages: [
            { stage: 'linear-HDR', format: 'rgba16float', byteLength: linear.bytes.byteLength, rawHash: hashes[0] ?? '' },
            { stage: 'tone-mapping', format: 'rgba16float', byteLength: tone.bytes.byteLength, rawHash: hashes[1] ?? '' },
            { stage: 'output-encoding', format: 'rgba8unorm-srgb', byteLength: output.bytes.byteLength, rawHash: hashes[2] ?? '' },
            { stage: 'decoded-sRGB-roi', format: 'decoded-srgb-roi', byteLength: decodedRoi.length * FLOAT32_BYTES_PER_VALUE, rawHash: decodedHash },
          ],
        },
        status: 'observation',
        overallParityClaim: false,
        notApplicable: AUTO_EXPOSURE_SCENE_CASE.notApplicable,
      };
      const valid = validateAutoExposureThreeR184Artifact(artifact);
      if (!valid.ok) throw new Error(`Three r184 live artifact validation failed: ${valid.reason}`);
      return Object.freeze(artifact);
    } finally {
      sceneState.geometry.dispose();
      for (const material of sceneState.materials) material.dispose();
    }
  } finally {
    await Promise.resolve(renderer.dispose());
    surface.destroy();
    animationContext.restore();
  }
}

export function serializeAutoExposureThreeR184Artifact(artifact: AutoExposureThreeR184Artifact): string {
  const valid = validateAutoExposureThreeR184Artifact(artifact);
  if (!valid.ok) throw new Error(`cannot serialize invalid Three r184 artifact: ${valid.reason}`);
  return `${JSON.stringify(artifact, null, 2)}\n`;
}
