import { World } from '@forgeax/engine-ecs';
import { packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import type {
  RendererHostAssembly,
  RendererLegacyHostAdapter,
} from '@forgeax/engine-render/internal/construct-renderer';
import {
  Camera,
  Materials,
  MeshFilter,
  MeshRenderer,
  TONEMAP_LINEAR,
  perspective,
} from '@forgeax/engine-render';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { Transform } from '@forgeax/engine-scene';
import { err, ok, type MeshAsset, type VertexAttributeMap } from '@forgeax/engine-types';
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  HalfFloatType,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicMaterial,
  NoBlending,
  PerspectiveCamera,
  RenderTarget,
  Scene,
  SRGBColorSpace,
  UnsignedByteType,
} from 'three';
import { WebGPURenderer } from 'three/webgpu';
import type {
  VertexColorBackend,
  VertexColorCaptureOutput,
  VertexColorDomain,
  VertexColorSemanticFixture,
} from '../contracts/types';
import { VERTEX_COLOR_REQUIRED_CASES } from '../coverage/required-cases';

const WIDTH = 128;
const HEIGHT = 128;
const FRAME_COUNT = 60;
const FLOATS_PER_HALF_PIXEL = 4;

type FixtureVertex = readonly [number, number, number, number];

export interface VertexColorForgeaxBundler {
  readonly importTransport?: unknown;
  readonly shaderManifestUrl?: string;
}

export type VertexColorFalsifierMode = 'white-color' | 'no-color-baseline';

export interface VertexCaptureOptions {
  readonly fixture: VertexColorSemanticFixture;
  readonly backend: VertexColorBackend;
  readonly sourceSha: string;
  readonly forgeaxBundler?: VertexColorForgeaxBundler;
  readonly vertexColorFalsifier?: VertexColorFalsifierMode;
}

/**
 * A renderer session amortizes backend construction across the seven required
 * fixtures (and their producer-owned falsifiers). The evidence contract still
 * opens a fresh World and renders 60 frames for every capture; only the
 * renderer/device/manifest lifetime is shared.
 */
export interface VertexColorCaptureSession {
  capture(options: VertexCaptureOptions): Promise<VertexColorCaptureOutput>;
  dispose(): Promise<void>;
}

interface CaptureCanvas {
  readonly canvas: HTMLCanvasElement;
  readonly destroy: () => void;
}

interface NodeAnimationContext {
  readonly requestAnimationFrame?: (callback: (time: number) => void) => number;
  readonly cancelAnimationFrame?: (requestId: number | null) => void;
}

interface AnimationContextLease {
  readonly restore: () => void;
}

export function installNodeAnimationContext(): AnimationContextLease {
  if (typeof document !== 'undefined') return { restore: () => {} };
  const globalScope = globalThis as unknown as { self?: NodeAnimationContext };
  const previousSelf = globalScope.self;
  const context = (previousSelf === undefined ? {} : { ...previousSelf }) as NodeAnimationContext & {
    requestAnimationFrame: (callback: (time: number) => void) => number;
    cancelAnimationFrame: (requestId: number | null) => void;
  };
  const pending = new Map<number, ReturnType<typeof setTimeout>>();
  let nextRequestId = 0;
  let callbackCount = 0;
  const maxCallbacks = FRAME_COUNT + 2;
  context.requestAnimationFrame = (callback) => {
    const requestId = ++nextRequestId;
    if (callbackCount >= maxCallbacks) return requestId;
    callbackCount += 1;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      callback(typeof performance === 'undefined' ? Date.now() : performance.now());
    }, 0);
    pending.set(requestId, timer);
    return requestId;
  };
  context.cancelAnimationFrame = (requestId) => {
    if (requestId === null) return;
    const timer = pending.get(requestId);
    if (timer === undefined) return;
    clearTimeout(timer);
    pending.delete(requestId);
  };
  globalScope.self = context;
  return {
    restore() {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      if (previousSelf === undefined) delete globalScope.self;
      else globalScope.self = previousSelf;
    },
  };
}

function fixtureVertices(fixture: VertexColorSemanticFixture, forceWhite = false): readonly FixtureVertex[] {
  const vertices = fixture.vertices;
  if (!Array.isArray(vertices) || vertices.length < 3) {
    if (fixture.caseId === 'vertex-color-normalized') {
      const normalized: readonly FixtureVertex[] = [
        [0, 0, 0, 1],
        [0.5, 0.5, 0.5, 1],
        [1, 1, 1, 1],
      ];
      return forceWhite ? normalized.map(() => [1, 1, 1, 1] as const) : normalized;
    }
    if (fixture.caseId === 'vertex-color-mask-taa') {
      const masked: readonly FixtureVertex[] = [
        [1, 0.1, 0.1, 0.35],
        [1, 0.1, 0.1, 0.65],
        [1, 0.1, 0.1, 0.35],
      ];
      return forceWhite ? masked.map((vertex) => [1, 1, 1, vertex[3]] as FixtureVertex) : masked;
    }
    if (fixture.caseId === 'vertex-color-mixed-primitives') {
      const mixed: readonly FixtureVertex[] = [
        [1, 0, 0, 1],
        [0, 1, 0, 1],
        [0, 0, 1, 1],
      ];
      return forceWhite ? mixed.map(() => [1, 1, 1, 1] as const) : mixed;
    }
    if (fixture.caseId === 'vertex-color-vec3') {
      const vec3: readonly FixtureVertex[] = [
        [1, 0, 0, 1],
        [0, 1, 0, 1],
        [0, 0, 1, 1],
      ];
      return forceWhite ? vec3.map(() => [1, 1, 1, 1] as const) : vec3;
    }
    if (fixture.caseId === 'vertex-color-vec4') {
      const vec4: readonly FixtureVertex[] = [
        [1, 0.2, 0.1, 0.35],
        [0.1, 1, 0.2, 0.65],
        [0.2, 0.1, 1, 0.85],
      ];
      return forceWhite
        ? vec4.map((vertex) => [1, 1, 1, vertex[3]] as FixtureVertex)
        : vec4;
    }
    const fallback: readonly FixtureVertex[] = [
      [1, 1, 1, 1],
      [1, 1, 1, 1],
      [1, 1, 1, 1],
    ];
    return fallback;
  }
  const normalizedVertices: readonly FixtureVertex[] = vertices.map((vertex) => {
    if (!Array.isArray(vertex) || vertex.length < 3) return [1, 1, 1, 1] as FixtureVertex;
    return [
      Number(vertex[0] ?? 0),
      Number(vertex[1] ?? 0),
      Number(vertex[2] ?? 0),
      Number(vertex[3] ?? 1),
    ] as FixtureVertex;
  });
  return forceWhite ? normalizedVertices.map((vertex) => [1, 1, 1, vertex[3]] as FixtureVertex) : normalizedVertices;
}

function isNoColorFixture(fixture: VertexColorSemanticFixture): boolean {
  return fixture.caseId === 'vertex-color-no-color-baseline' || fixture.colorAccessor === null;
}

function makeMesh(
  fixture: VertexColorSemanticFixture,
  includeColor = !isNoColorFixture(fixture),
  xOffset = 0,
  forceWhite = false,
): MeshAsset {
  const colors = fixtureVertices(fixture, forceWhite);
  const positions = new Float32Array([
    -0.4 + xOffset, -0.75, 0,
    0.4 + xOffset, -0.75, 0,
    0 + xOffset, 0.85, 0,
  ]);
  const attributes: VertexAttributeMap = {
    position: positions,
    normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uv: new Float32Array([0, 0, 1, 0, 0.5, 1]),
    tangent: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]),
  };
  if (includeColor) {
    attributes.color = new Float32Array(colors.flatMap((vertex) => vertex));
  }
  if (fixture.caseId === 'vertex-color-skinning') {
    attributes.skinIndex = new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    attributes.skinWeight = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  }
  const packed = packInterleavedVertexAttributes(attributes, 3);
  if (!packed.ok) throw packed.error;
  return {
    kind: 'mesh',
    vertices: packed.value.vertices,
    attributes,
    indices: new Uint16Array([0, 1, 2]),
    submeshes: [
      { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list', materialSlot: 0 },
    ],
    materialSlots: [{ slotName: 'vertex-color-fixture' }],
  };
}

export function canvasViewFormats(format: GPUTextureFormat): readonly GPUTextureFormat[] {
  switch (format) {
    case 'rgba8unorm':
      return ['rgba8unorm-srgb'];
    case 'bgra8unorm':
      return ['bgra8unorm-srgb'];
    default:
      return [];
  }
}

function createCanvas(): CaptureCanvas {
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    document.body?.append(canvas);
    return { canvas, destroy: () => canvas.remove() };
  }
  let device: GPUDevice | undefined;
  let texture: GPUTexture | undefined;
  const canvas = {
    width: WIDTH,
    height: HEIGHT,
    style: { width: '', height: '' },
    getContext(kind: string): unknown {
      if (kind !== 'webgpu') return null;
      return {
        configure(desc: { device: GPUDevice; format?: GPUTextureFormat }) {
          device = desc.device;
          texture?.destroy();
          const format = desc.format ?? 'rgba8unorm';
          texture = device.createTexture({
            size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
            format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
            viewFormats: [...canvasViewFormats(format)],
          });
        },
        unconfigure() {},
        getCurrentTexture() {
          if (texture === undefined && device !== undefined) {
            const format = 'rgba8unorm';
            texture = device.createTexture({
              size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
              format,
              usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
              viewFormats: [...canvasViewFormats(format)],
            });
          }
          if (texture === undefined) throw new Error('Dawn canvas texture is unavailable');
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

function makeSampleValues(
  bytes: Uint8Array,
  fixture: Pick<VertexColorSemanticFixture, 'samplePoints'>,
  width: number,
  height: number,
  halfFloat: boolean,
): VertexColorCaptureOutput['samples'] {
  const read = (index: number): number => {
    if (!halfFloat) return (bytes[index] ?? 0) / 255;
    const bits = (bytes[index] ?? 0) | ((bytes[index + 1] ?? 0) << 8);
    const sign = (bits & 0x8000) === 0 ? 1 : -1;
    const exponent = (bits >>> 10) & 0x1f;
    const mantissa = bits & 0x3ff;
    if (exponent === 0) return sign * (mantissa / 1024) * 2 ** -14;
    if (exponent === 0x1f) return mantissa === 0 ? sign * Infinity : NaN;
    return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
  };
  return fixture.samplePoints.map((sample) => {
    const x = Math.min(width - 1, Math.max(0, Math.floor(sample.coordinate[0] * width)));
    const y = Math.min(height - 1, Math.max(0, Math.floor((1 - sample.coordinate[1]) * height)));
    const pixel = y * width + x;
    const stride = halfFloat ? FLOATS_PER_HALF_PIXEL * 2 : FLOATS_PER_HALF_PIXEL;
    const offset = pixel * stride;
    return {
      id: sample.id,
      coordinate: sample.coordinate,
      rgba: [read(offset), read(offset + (halfFloat ? 2 : 1)), read(offset + (halfFloat ? 4 : 2)), read(offset + (halfFloat ? 6 : 3))],
    };
  });
}

export function sampleValuesForDomain(
  linearBytes: Uint8Array,
  finalBytes: Uint8Array,
  fixture: Pick<VertexColorSemanticFixture, 'colorDomain' | 'samplePoints'>,
  width: number,
  height: number,
): VertexColorCaptureOutput['samples'] {
  const domain: VertexColorDomain = fixture.colorDomain;
  return domain === 'linearHdr'
    ? makeSampleValues(linearBytes, fixture, width, height, true)
    : makeSampleValues(finalBytes, fixture, width, height, false);
}

export function normalizeCanvasReadbackBytes(
  bytes: Uint8Array,
  format: GPUTextureFormat | undefined,
): Uint8Array {
  if (format !== 'bgra8unorm' && format !== 'bgra8unorm-srgb') return bytes;
  const normalized = new Uint8Array(bytes);
  for (let offset = 0; offset + 3 < normalized.length; offset += 4) {
    const red = normalized[offset];
    normalized[offset] = normalized[offset + 2] ?? 0;
    normalized[offset + 2] = red ?? 0;
  }
  return normalized;
}

function decodeHalfPixels(bytes: Uint8Array): number[] {
  const values: number[] = [];
  for (let offset = 0; offset + 1 < bytes.length; offset += 2) {
    const bits = (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
    const sign = (bits & 0x8000) === 0 ? 1 : -1;
    const exponent = (bits >>> 10) & 0x1f;
    const mantissa = bits & 0x3ff;
    if (exponent === 0) values.push(sign * (mantissa / 1024) * 2 ** -14);
    else if (exponent === 0x1f) values.push(mantissa === 0 ? sign * Infinity : NaN);
    else values.push(sign * (1 + mantissa / 1024) * 2 ** (exponent - 15));
  }
  return values;
}

async function copyTextureBytes(
  device: RhiDevice,
  texture: unknown,
  width: number,
  height: number,
  bytesPerPixel: number,
): Promise<Uint8Array> {
  const rowBytes = width * bytesPerPixel;
  const alignedRowBytes = Math.ceil(rowBytes / 256) * 256;
  const buffer = device.createBuffer({ size: alignedRowBytes * height, usage: 0x08 | 0x01 });
  if (!buffer.ok) throw new Error(buffer.error.code);
  const encoder = device.createCommandEncoder({});
  if (!encoder.ok) throw new Error(encoder.error.code);
  encoder.value.copyTextureToBuffer(
    { texture } as never,
    { buffer: buffer.value, offset: 0, bytesPerRow: alignedRowBytes, rowsPerImage: height } as never,
    { width, height, depthOrArrayLayers: 1 },
  );
  const finished = encoder.value.finish();
  if (!finished.ok) throw new Error(finished.error.code);
  const submitted = device.queue.submit([finished.value]);
  if (!submitted.ok) throw new Error(submitted.error.code);
  await device.queue.onSubmittedWorkDone();
  const mapped = await buffer.value.mapAsync(0x01);
  if (!mapped.ok) throw new Error(mapped.error.code);
  const range = mapped.value.getMappedRange();
  if (!range.ok) throw new Error(range.error.code);
  const bytes = new Uint8Array(rowBytes * height);
  const full = new Uint8Array(range.value);
  for (let row = 0; row < height; row += 1) {
    bytes.set(full.subarray(row * alignedRowBytes, row * alignedRowBytes + rowBytes), row * rowBytes);
  }
  mapped.value.unmap();
  const destroyed = device.destroyBuffer(buffer.value);
  if (!destroyed.ok) throw new Error(destroyed.error.code);
  return bytes;
}

async function copyForgeaxObservation(
  host: RendererLegacyHostAdapter,
  device: RhiDevice,
): Promise<Uint8Array> {
  const observation = await host.observeCurrentFrame({
    semantic: 'linear-hdr',
    readback: async (lease) => {
      const source = lease.beginReadback();
      if (!source.ok) return err(new Error(source.error.hint));
      const width = lease.descriptor.size.width;
      const height = lease.descriptor.size.height;
      return ok(await copyTextureBytes(device, source.value.texture, width, height, 8));
    },
  });
  if (!observation.ok) {
    throw new Error(`ForgeaX copyTextureToBuffer readback unavailable: ${observation.error.code}`);
  }
  return observation.value.bytes;
}

async function copyForgeaxSurface(device: RhiDevice, canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const context = canvas.getContext('webgpu') as unknown as { getCurrentTexture(): unknown } | null;
  if (context === null) throw new Error('ForgeaX display surface context is unavailable');
  return copyTextureBytes(device, context.getCurrentTexture(), WIDTH, HEIGHT, 4);
}

function setupWorld(fixture: VertexColorSemanticFixture, forceWhite = false): World {
  const world = new World();
  const alphaCutoff = typeof fixture.alphaCutoff === 'number' ? fixture.alphaCutoff : undefined;
  const material = Materials.unlit([1, 1, 1, 1], {
    renderState: { cullMode: 'none' },
    ...(alphaCutoff === undefined ? {} : { alphaCutoff }),
  });
  const materialHandle = world.allocSharedRef('MaterialAsset', material);
  const spawnMesh = (mesh: MeshAsset): void => {
    const meshHandle = world.allocSharedRef('MeshAsset', mesh);
    world.spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    ).unwrap();
  };
  if (fixture.caseId === 'vertex-color-mixed-primitives') {
    spawnMesh(makeMesh(fixture, true, -0.45, forceWhite));
    spawnMesh(makeMesh(fixture, false, 0.45, forceWhite));
  } else {
    spawnMesh(makeMesh(fixture, undefined, 0, forceWhite));
  }
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 3] } },
    {
      component: Camera,
      data: {
        ...perspective({ fov: Math.PI / 4, aspect: 1 }),
        // The producer reads the renderer-owned linear-HDR observation below.
        // Explicitly opt into the linear output-transform path; the camera's
        // zero-config tonemap path writes directly to the display surface and
        // intentionally publishes no HDR observation attachment.
        tonemap: TONEMAP_LINEAR,
        clearColor: [0, 0, 0, 1],
      },
    },
  ).unwrap();
  return world;
}

async function captureForgeaxWithAssembly(
  assembly: RendererHostAssembly,
  surface: CaptureCanvas,
  { fixture, backend, sourceSha, vertexColorFalsifier }: VertexCaptureOptions,
): Promise<VertexColorCaptureOutput> {
  const { renderer, debugDrawHost } = assembly;
  const legacyHost = debugDrawHost as unknown as RendererLegacyHostAdapter;
  const device = debugDrawHost.device;
  const world = setupWorld(fixture, vertexColorFalsifier === 'white-color');
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  try {
    for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
      world.update().unwrap();
      const draw = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
      if (!draw.ok) throw new Error(`ForgeaX frame ${frame} failed: ${draw.error.code}`);
      if (frame === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    const finalBytes = normalizeCanvasReadbackBytes(
      await copyForgeaxSurface(device, surface.canvas),
      (globalThis as { __forgeaxSwapChainFormat?: GPUTextureFormat }).__forgeaxSwapChainFormat,
    );
    // Acquire the browser swap-chain texture before the observation copy. A
    // completed copy submission can advance a browser surface to its next
    // texture; reading getCurrentTexture() afterward would capture a valid but
    // untouched zeroed frame while the linear attachment remains populated.
    const bytes = await copyForgeaxObservation(legacyHost, device);
    const sourceFixtureHash = VERTEX_COLOR_REQUIRED_CASES.find((entry) => entry.caseId === fixture.caseId)?.sourceFixtureHash;
    if (sourceFixtureHash === undefined) throw new Error(`missing fixture hash for ${fixture.caseId}`);
    return {
      backend,
      frameCount: FRAME_COUNT,
      sourceSha,
      sourceFixtureHash,
      colorDomain: fixture.colorDomain,
      samples: sampleValuesForDomain(bytes, finalBytes, fixture, WIDTH, HEIGHT),
      linear: decodeHalfPixels(bytes),
      // The linear HDR attachment and the display surface are two independent
      // GPU copy reads; final is normalized RGBA8 display data, not raw bytes.
      final: Array.from(finalBytes, (value) => value / 255),
      readback: 'copyTextureToBuffer',
    };
  } finally {
    // The device stays alive for the next fixture. Detaching the lease removes
    // the World-owned derived systems and read lease before the next capture.
    legacyHost.detachScene(world);
  }
}

export async function createForgeaxVertexColorCaptureSession(
  forgeaxBundler: VertexColorForgeaxBundler,
): Promise<VertexColorCaptureSession> {
  const surface = createCanvas();
  const constructed = await constructRuntimeRendererHost(surface.canvas, {}, forgeaxBundler as never);
  if (!constructed.ok) {
    surface.destroy();
    const error = constructed.error;
    const code = 'code' in error ? error.code : 'engine-environment-error';
    throw new Error(`ForgeaX renderer unavailable: ${code}`);
  }
  let disposed = false;
  return {
    capture(options) {
      if (disposed) return Promise.reject(new Error('ForgeaX vertex-color capture session is disposed'));
      return captureForgeaxWithAssembly(constructed.value, surface, options);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        await constructed.value.renderer.dispose();
      } finally {
        surface.destroy();
      }
    },
  };
}

export async function captureForgeaxVertexColor(options: VertexCaptureOptions): Promise<VertexColorCaptureOutput> {
  if (options.forgeaxBundler === undefined) {
    throw new Error(JSON.stringify({
      code: 'producer-entry-missing',
      detail: 'ForgeaX bundler options were not injected into the capture entry',
      recovery: 'run a producer entry with an injected shader manifest (Browser adapter or Dawn data URL)',
    }));
  }
  const session = await createForgeaxVertexColorCaptureSession(options.forgeaxBundler);
  try {
    return await session.capture(options);
  } finally {
    await session.dispose();
  }
}

export async function captureThreeVertexColor({ fixture, backend, sourceSha, vertexColorFalsifier }: VertexCaptureOptions): Promise<VertexColorCaptureOutput> {
  const animationContext = installNodeAnimationContext();
  const surface = createCanvas();
  const canvas = surface.canvas;
  let disposeRenderer: (() => void) | undefined;
  try {
    const renderer = new WebGPURenderer({ canvas, antialias: false, forceWebGL: false });
    disposeRenderer = () => renderer.dispose();
    await renderer.init();
    if (renderer.backend?.isWebGPUBackend !== true) throw new Error('Three r184 WebGPU backend unavailable');
    renderer.setClearColor(0x000000, 1);
    const linearTarget = new RenderTarget(WIDTH, HEIGHT, {
      depthBuffer: true,
      stencilBuffer: false,
      type: HalfFloatType,
      colorSpace: LinearSRGBColorSpace,
    });
    const finalTarget = new RenderTarget(WIDTH, HEIGHT, {
      depthBuffer: true,
      stencilBuffer: false,
      type: UnsignedByteType,
      colorSpace: SRGBColorSpace,
    });
    const colors = fixtureVertices(fixture, vertexColorFalsifier === 'white-color');
    const scene = new Scene();
    const geometries: Array<{ dispose(): void }> = [];
    const materials: Array<{ dispose(): void }> = [];
    const addPrimitive = (includeColor: boolean, xOffset: number): void => {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array([
        -0.4 + xOffset, -0.75, 0,
        0.4 + xOffset, -0.75, 0,
        xOffset, 0.85, 0,
      ]), 3));
      if (includeColor) geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors.flatMap((vertex) => vertex)), 4));
      geometry.computeVertexNormals();
      const hasVertexAlpha = includeColor && colors.some((vertex) => vertex[3] !== 1);
      const material = new MeshBasicMaterial({
        color: 0xffffff,
        vertexColors: includeColor,
        side: DoubleSide,
        alphaTest: typeof fixture.alphaCutoff === 'number' ? fixture.alphaCutoff : 0,
        ...(hasVertexAlpha ? { transparent: true, blending: NoBlending } : {}),
      });
      geometries.push(geometry);
      materials.push(material);
      scene.add(new Mesh(geometry, material));
    };
    if (fixture.caseId === 'vertex-color-mixed-primitives') {
      addPrimitive(true, -0.45);
      addPrimitive(false, 0.45);
    } else {
      addPrimitive(!isNoColorFixture(fixture), 0);
    }
    const camera = new PerspectiveCamera(45, 1, 0.1, 10);
    camera.position.set(0, 0, 3);
    try {
      renderer.setRenderTarget(linearTarget);
      // renderer.init() completed before the loop. Calling the deprecated
      // renderAsync() 300 times re-enters that wrapper for no benefit and
      // creates avoidable work on the overloaded CI GPU.
      for (let frame = 0; frame < FRAME_COUNT; frame += 1) renderer.render(scene, camera);
      const linearReadback = await renderer.readRenderTargetPixelsAsync(linearTarget, 0, 0, WIDTH, HEIGHT);
      renderer.setRenderTarget(finalTarget);
      renderer.render(scene, camera);
      const finalReadback = await renderer.readRenderTargetPixelsAsync(finalTarget, 0, 0, WIDTH, HEIGHT);
      const linearBytes = new Uint8Array(
        (linearReadback as { readonly buffer: ArrayBuffer; readonly byteOffset: number; readonly byteLength: number }).buffer,
        (linearReadback as { readonly byteOffset: number }).byteOffset,
        (linearReadback as { readonly byteLength: number }).byteLength,
      );
      const finalBytes = Uint8Array.from(finalReadback as ArrayLike<number>);
      const sourceFixtureHash = VERTEX_COLOR_REQUIRED_CASES.find((entry) => entry.caseId === fixture.caseId)?.sourceFixtureHash;
      if (sourceFixtureHash === undefined) throw new Error(`missing fixture hash for ${fixture.caseId}`);
      return {
        backend,
        frameCount: FRAME_COUNT,
        sourceSha,
        sourceFixtureHash,
        colorDomain: fixture.colorDomain,
        samples: sampleValuesForDomain(linearBytes, finalBytes, fixture, WIDTH, HEIGHT),
        linear: decodeHalfPixels(linearBytes),
        final: Array.from(finalBytes, (value) => value / 255),
        readback: 'readRenderTargetPixelsAsync',
      };
    } finally {
      linearTarget.dispose();
      finalTarget.dispose();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    }
  } finally {
    disposeRenderer?.();
    surface.destroy();
    animationContext.restore();
  }
}

export async function captureVertexColor(
  implementation: 'forgeax' | 'three',
  options: VertexCaptureOptions,
): Promise<VertexColorCaptureOutput> {
  return implementation === 'forgeax' ? captureForgeaxVertexColor(options) : captureThreeVertexColor(options);
}
