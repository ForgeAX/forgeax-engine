import {
  getModelingKernelWasm,
  type ModelingKernelWasmExports,
} from '@forgeax/modeling-kernel-wasm';
import { err, errorCodeFromId, KernelError, type KernelResult, ok } from './result';

const textDecoder = new TextDecoder();

export type WorleyModeName = 'f1' | 'edge' | 'cellId';
export type SurfaceBlendModeName =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'add'
  | 'subtract'
  | 'min'
  | 'max';

export function createRustImageBufferFromFloat32(
  width: number,
  height: number,
  channels: number,
  data: Float32Array,
): KernelResult<RustImageBuffer> {
  const expected = width * height * channels;
  if (data.length !== expected) {
    return err(
      new KernelError(
        'kernel-invalid-value',
        'data',
        `expected ${expected} f32 values, got ${data.length}`,
      ),
    );
  }
  const img = createRustImageBuffer(width, height, channels, 0);
  if (!img.ok) return img;
  const view = img.value.dataView();
  if (!view.ok) {
    img.value.dispose();
    return view;
  }
  view.value.set(data);
  return img;
}

export interface PbrLayerOptions {
  readonly baseColor: readonly [number, number, number];
  readonly roughness: number;
  readonly metallic: number;
  readonly height?: number;
  readonly emissive?: readonly [number, number, number];
  readonly mask?: RustImageBuffer;
  readonly heightMap?: RustImageBuffer;
  readonly roughnessMap?: RustImageBuffer;
  readonly opacity?: number;
}

/**
 * Final game-ready standard 8-bit PBR texture set.
 * 100% compatible with glTF 2.0, Three.js `MeshStandardMaterial`, and ForgeaX
 * `default_standard_surface.wgsl` (zero runtime shader switches or extra channels).
 */
export interface StandardPbrTextureSet {
  readonly width: number;
  readonly height: number;
  /** sRGB RGBA8 albedo (`width * height * 4` bytes). */
  readonly baseColor: Uint8Array;
  /** Linear RGBA8 tangent-space normal (`(n * 0.5 + 0.5) * 255`). */
  readonly normal: Uint8Array;
  /** Linear RGBA8 packed ORM (`R=AO, G=Roughness, B=Metallic, A=255`). */
  readonly orm: Uint8Array;
  /** Optional sRGB RGBA8 emissive (omitted if no emissive layer was added). */
  readonly emissive?: Uint8Array;
}

function readLastError(wasm: ModelingKernelWasmExports): KernelError {
  const code = errorCodeFromId(wasm.mk_last_error_code());
  const fPtr = wasm.mk_last_error_field_ptr();
  const fLen = wasm.mk_last_error_field_len();
  const rPtr = wasm.mk_last_error_reason_ptr();
  const rLen = wasm.mk_last_error_reason_len();
  const mem = new Uint8Array(wasm.memory.buffer);
  const field = fLen > 0 ? textDecoder.decode(mem.subarray(fPtr, fPtr + fLen)) : 'kernel';
  const reason = rLen > 0 ? textDecoder.decode(mem.subarray(rPtr, rPtr + rLen)) : 'kernel error';
  return new KernelError(code, field, reason);
}

function requireWasm(): KernelResult<ModelingKernelWasmExports> {
  const wasm = getModelingKernelWasm();
  if (wasm === undefined) {
    return err(
      new KernelError(
        'kernel-capability-unavailable',
        'wasm',
        'Modeling kernel WASM is not initialized; call initModelingKernelWasm(Sync) first',
      ),
    );
  }
  return ok(wasm);
}

function worleyModeId(mode: WorleyModeName): number {
  switch (mode) {
    case 'f1':
      return 0;
    case 'edge':
      return 1;
    case 'cellId':
      return 2;
  }
}

function blendModeId(mode: SurfaceBlendModeName): number {
  switch (mode) {
    case 'normal':
      return 0;
    case 'multiply':
      return 1;
    case 'screen':
      return 2;
    case 'overlay':
      return 3;
    case 'add':
      return 4;
    case 'subtract':
      return 5;
    case 'min':
      return 6;
    case 'max':
      return 7;
  }
}

/** Count of live Rust `ImageBuffer` handles in WASM linear memory (for leak checks). */
export function liveRustImageCount(): number {
  return getModelingKernelWasm()?.mk_live_images() ?? 0;
}

/** Count of live Rust `PbrSurfaceStack` handles in WASM linear memory (for leak checks). */
export function liveRustSurfaceCount(): number {
  return getModelingKernelWasm()?.mk_live_surfaces() ?? 0;
}

/** Retained high-precision `f32` image buffer stored in Rust WASM linear memory. */
export class RustImageBuffer {
  private handle: bigint;
  private disposed = false;

  constructor(
    private readonly wasm: ModelingKernelWasmExports,
    handle: bigint,
    public readonly width: number,
    public readonly height: number,
    public readonly channels: number,
  ) {
    this.handle = handle;
  }

  /** Raw arena handle for internal cross-object Rust calls. */
  get rawHandle(): bigint {
    return this.handle;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Zero-copy view into the live `f32` pixel buffer inside WASM linear memory. */
  dataView(): KernelResult<Float32Array> {
    if (this.disposed) {
      return err(new KernelError('kernel-invalid-handle', 'image', 'RustImageBuffer is disposed'));
    }
    const metaPtr = this.wasm.mk_scratch_ensure(20);
    if (this.wasm.mk_img_meta(this.handle, metaPtr) !== 0) {
      return err(readLastError(this.wasm));
    }
    const meta = new Uint32Array(this.wasm.memory.buffer, metaPtr, 5);
    return ok(new Float32Array(this.wasm.memory.buffer, meta[3] ?? 0, meta[4] ?? 0));
  }

  /** Detached copy of the `f32` pixel data (safe across WASM memory growth or after dispose). */
  toFloat32Array(): KernelResult<Float32Array> {
    const view = this.dataView();
    if (!view.ok) return view;
    return ok(new Float32Array(view.value));
  }

  levels(
    inMin: number,
    inMax: number,
    gamma = 1.0,
    outMin = 0.0,
    outMax = 1.0,
  ): KernelResult<RustImageBuffer> {
    if (this.disposed) {
      return err(new KernelError('kernel-invalid-handle', 'image', 'RustImageBuffer is disposed'));
    }
    const h = this.wasm.mk_img_levels(this.handle, inMin, inMax, gamma, outMin, outMax);
    if (h === 0n) return err(readLastError(this.wasm));
    return ok(new RustImageBuffer(this.wasm, h, this.width, this.height, this.channels));
  }

  invert(): KernelResult<RustImageBuffer> {
    if (this.disposed) {
      return err(new KernelError('kernel-invalid-handle', 'image', 'RustImageBuffer is disposed'));
    }
    const h = this.wasm.mk_img_invert(this.handle);
    if (h === 0n) return err(readLastError(this.wasm));
    return ok(new RustImageBuffer(this.wasm, h, this.width, this.height, this.channels));
  }

  blur(radius: number): KernelResult<RustImageBuffer> {
    if (this.disposed) {
      return err(new KernelError('kernel-invalid-handle', 'image', 'RustImageBuffer is disposed'));
    }
    const h = this.wasm.mk_img_blur(this.handle, Math.max(0, Math.round(radius)));
    if (h === 0n) return err(readLastError(this.wasm));
    return ok(new RustImageBuffer(this.wasm, h, this.width, this.height, this.channels));
  }

  heightToNormal(strength = 2.0): KernelResult<RustImageBuffer> {
    if (this.disposed) {
      return err(new KernelError('kernel-invalid-handle', 'image', 'RustImageBuffer is disposed'));
    }
    const h = this.wasm.mk_img_height_to_normal(this.handle, strength);
    if (h === 0n) return err(readLastError(this.wasm));
    return ok(new RustImageBuffer(this.wasm, h, this.width, this.height, 3));
  }

  blend(
    top: RustImageBuffer,
    options?: {
      readonly mode?: SurfaceBlendModeName;
      readonly opacity?: number;
      readonly mask?: RustImageBuffer;
    },
  ): KernelResult<RustImageBuffer> {
    if (this.disposed || top.disposed || options?.mask?.disposed) {
      return err(new KernelError('kernel-invalid-handle', 'image', 'RustImageBuffer is disposed'));
    }
    const h = this.wasm.mk_img_blend(
      this.handle,
      top.handle,
      options?.mask?.handle ?? 0n,
      blendModeId(options?.mode ?? 'normal'),
      options?.opacity ?? 1.0,
    );
    if (h === 0n) return err(readLastError(this.wasm));
    return ok(new RustImageBuffer(this.wasm, h, this.width, this.height, this.channels));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.wasm.mk_img_dispose(this.handle);
    this.handle = 0n;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

export function createRustImageBuffer(
  width: number,
  height: number,
  channels = 1,
  fill = 0.0,
): KernelResult<RustImageBuffer> {
  const w = requireWasm();
  if (!w.ok) return w;
  const h = w.value.mk_img_create(width, height, channels, fill);
  if (h === 0n) return err(readLastError(w.value));
  return ok(new RustImageBuffer(w.value, h, width, height, channels));
}

export function generatePerlinFbm(options: {
  readonly width: number;
  readonly height: number;
  readonly scaleX?: number;
  readonly scaleY?: number;
  readonly octaves?: number;
  readonly persistence?: number;
  readonly seed?: number;
}): KernelResult<RustImageBuffer> {
  const w = requireWasm();
  if (!w.ok) return w;
  const h = w.value.mk_img_perlin_fbm(
    options.width,
    options.height,
    options.scaleX ?? 4,
    options.scaleY ?? options.scaleX ?? 4,
    options.octaves ?? 4,
    options.persistence ?? 0.5,
    options.seed ?? 1,
  );
  if (h === 0n) return err(readLastError(w.value));
  return ok(new RustImageBuffer(w.value, h, options.width, options.height, 1));
}

export function generateWorley(options: {
  readonly width: number;
  readonly height: number;
  readonly cellsX?: number;
  readonly cellsY?: number;
  readonly jitter?: number;
  readonly mode?: WorleyModeName;
  readonly seed?: number;
}): KernelResult<RustImageBuffer> {
  const w = requireWasm();
  if (!w.ok) return w;
  const h = w.value.mk_img_worley(
    options.width,
    options.height,
    options.cellsX ?? 8,
    options.cellsY ?? options.cellsX ?? 8,
    options.jitter ?? 1.0,
    worleyModeId(options.mode ?? 'f1'),
    options.seed ?? 1,
  );
  if (h === 0n) return err(readLastError(w.value));
  return ok(new RustImageBuffer(w.value, h, options.width, options.height, 1));
}

export function generateBrick(options: {
  readonly width: number;
  readonly height: number;
  readonly cols?: number;
  readonly rows?: number;
  readonly mortar?: number;
  readonly bevel?: number;
  readonly stagger?: number;
  readonly seed?: number;
}): KernelResult<RustImageBuffer> {
  const w = requireWasm();
  if (!w.ok) return w;
  const h = w.value.mk_img_brick(
    options.width,
    options.height,
    options.cols ?? 4,
    options.rows ?? 8,
    options.mortar ?? 0.04,
    options.bevel ?? 0.04,
    options.stagger ?? 0.5,
    options.seed ?? 1,
  );
  if (h === 0n) return err(readLastError(w.value));
  return ok(new RustImageBuffer(w.value, h, options.width, options.height, 1));
}

export function generateBrushed(options: {
  readonly width: number;
  readonly height: number;
  readonly scaleU?: number;
  readonly scaleV?: number;
  readonly seed?: number;
}): KernelResult<RustImageBuffer> {
  const w = requireWasm();
  if (!w.ok) return w;
  const h = w.value.mk_img_brushed(
    options.width,
    options.height,
    options.scaleU ?? 32,
    options.scaleV ?? 4,
    options.seed ?? 1,
  );
  if (h === 0n) return err(readLastError(w.value));
  return ok(new RustImageBuffer(w.value, h, options.width, options.height, 1));
}

export function generateWood(options: {
  readonly width: number;
  readonly height: number;
  readonly rings?: number;
  readonly warp?: number;
  readonly seed?: number;
}): KernelResult<RustImageBuffer> {
  const w = requireWasm();
  if (!w.ok) return w;
  const h = w.value.mk_img_wood(
    options.width,
    options.height,
    options.rings ?? 8.0,
    options.warp ?? 0.6,
    options.seed ?? 1,
  );
  if (h === 0n) return err(readLastError(w.value));
  return ok(new RustImageBuffer(w.value, h, options.width, options.height, 1));
}

function sliceWasmBytes(
  mem: Uint8Array,
  ptr: number | undefined,
  len: number | undefined,
): Uint8Array {
  const start = ptr ?? 0;
  return mem.slice(start, start + (len ?? 0));
}

/** Retained high-precision `f32` PBR layer stack in WASM that compiles down to standard 8-bit game PBR textures. */
export class RustPbrSurface {
  private handle: bigint;
  private disposed = false;

  constructor(
    private readonly wasm: ModelingKernelWasmExports,
    handle: bigint,
    public readonly width: number,
    public readonly height: number,
  ) {
    this.handle = handle;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  addLayer(options: PbrLayerOptions): KernelResult<this> {
    if (this.disposed) {
      return err(new KernelError('kernel-invalid-handle', 'surface', 'RustPbrSurface is disposed'));
    }
    if (
      options.mask?.isDisposed ||
      options.heightMap?.isDisposed ||
      options.roughnessMap?.isDisposed
    ) {
      return err(
        new KernelError('kernel-invalid-handle', 'image', 'Layer image buffer is disposed'),
      );
    }
    const emissive = options.emissive ?? [0, 0, 0];
    const rc = this.wasm.mk_surface_add_layer(
      this.handle,
      options.baseColor[0],
      options.baseColor[1],
      options.baseColor[2],
      options.roughness,
      options.metallic,
      options.height ?? 0.5,
      emissive[0],
      emissive[1],
      emissive[2],
      options.mask?.rawHandle ?? 0n,
      options.heightMap?.rawHandle ?? 0n,
      options.roughnessMap?.rawHandle ?? 0n,
      options.opacity ?? 1.0,
    );
    if (rc !== 0) return err(readLastError(this.wasm));
    return ok(this);
  }

  applyAo(aoMap: RustImageBuffer, strength = 1.0): KernelResult<this> {
    if (this.disposed || aoMap.isDisposed) {
      return err(new KernelError('kernel-invalid-handle', 'surface', 'Handle is disposed'));
    }
    const rc = this.wasm.mk_surface_apply_ao(this.handle, aoMap.rawHandle, strength);
    if (rc !== 0) return err(readLastError(this.wasm));
    return ok(this);
  }

  applyBaseNormal(normalMap: RustImageBuffer): KernelResult<this> {
    if (this.disposed || normalMap.isDisposed) {
      return err(new KernelError('kernel-invalid-handle', 'surface', 'Handle is disposed'));
    }
    const rc = this.wasm.mk_surface_apply_base_normal(this.handle, normalMap.rawHandle);
    if (rc !== 0) return err(readLastError(this.wasm));
    return ok(this);
  }

  /**
   * Export standard 8-bit game PBR textures (`baseColor` sRGB, `normal` linear,
   * `orm` linear R=AO/G=Roughness/B=Metallic, optional `emissive` sRGB).
   * Returned `Uint8Array` buffers are detached copies owned by the caller so the
   * surface can be safely disposed immediately.
   */
  exportStandardPbr(options?: {
    readonly heightNormalStrength?: number;
    readonly dispose?: boolean;
  }): KernelResult<StandardPbrTextureSet> {
    if (this.disposed) {
      return err(new KernelError('kernel-invalid-handle', 'surface', 'RustPbrSurface is disposed'));
    }
    const rc = this.wasm.mk_surface_export_pbr(this.handle, options?.heightNormalStrength ?? 2.0);
    if (rc !== 0) return err(readLastError(this.wasm));

    const metaPtr = this.wasm.mk_scratch_ensure(40);
    if (this.wasm.mk_surface_export_meta(this.handle, metaPtr) !== 0) {
      return err(readLastError(this.wasm));
    }
    const meta = new Uint32Array(this.wasm.memory.buffer, metaPtr, 10);
    const width = meta[0] ?? 0;
    const height = meta[1] ?? 0;
    const mem = new Uint8Array(this.wasm.memory.buffer);
    const baseColor = sliceWasmBytes(mem, meta[2], meta[3]);
    const normal = sliceWasmBytes(mem, meta[4], meta[5]);
    const orm = sliceWasmBytes(mem, meta[6], meta[7]);
    const emissiveLen = meta[9] ?? 0;
    const emissive = emissiveLen > 0 ? sliceWasmBytes(mem, meta[8], emissiveLen) : undefined;

    if (options?.dispose) {
      this.dispose();
    }
    return ok({
      width,
      height,
      baseColor,
      normal,
      orm,
      ...(emissive === undefined ? {} : { emissive }),
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.wasm.mk_surface_dispose(this.handle);
    this.handle = 0n;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

export function createRustPbrSurface(width: number, height: number): KernelResult<RustPbrSurface> {
  const w = requireWasm();
  if (!w.ok) return w;
  const h = w.value.mk_surface_create(width, height);
  if (h === 0n) return err(readLastError(w.value));
  return ok(new RustPbrSurface(w.value, h, width, height));
}

// ---------------------------------------------------------------------------
// Optional Host-Injected WebGPU Compute Accelerator (zero bundled wgpu)
// ---------------------------------------------------------------------------

/** Minimal structural WebGPU device surface (accepts any standard browser/Dawn GPUDevice). */
export interface WebGpuBufferLike {
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

export interface WebGpuDeviceLike {
  createShaderModule(desc: { code: string }): unknown;
  createComputePipeline(desc: { layout: 'auto'; compute: { module: never; entryPoint: string } }): {
    getBindGroupLayout(index: number): unknown;
  };
  createBuffer(desc: { size: number; usage: number }): WebGpuBufferLike;
  createBindGroup(desc: {
    layout: never;
    entries: { binding: number; resource: { buffer: never } }[];
  }): unknown;
  createCommandEncoder(): {
    beginComputePass(): {
      setPipeline(pipeline: never): void;
      setBindGroup(index: number, group: never): void;
      dispatchWorkgroups(x: number, y?: number, z?: number): void;
      end(): void;
    };
    copyBufferToBuffer(
      src: never,
      srcOffset: number,
      dst: never,
      dstOffset: number,
      size: number,
    ): void;
    finish(): unknown;
  };
  readonly queue: {
    writeBuffer(buffer: never, bufferOffset: number, data: ArrayBufferView): void;
    submit(commands: never[]): void;
  };
}

interface InternalWebGpuDevice {
  createShaderModule(desc: { code: string }): unknown;
  createComputePipeline(desc: {
    layout: 'auto';
    compute: { module: unknown; entryPoint: string };
  }): { getBindGroupLayout(index: number): unknown };
  createBuffer(desc: { size: number; usage: number }): WebGpuBufferLike;
  createBindGroup(desc: {
    layout: unknown;
    entries: readonly { binding: number; resource: { buffer: unknown } }[];
  }): unknown;
  createCommandEncoder(): {
    beginComputePass(): {
      setPipeline(pipeline: unknown): void;
      setBindGroup(index: number, group: unknown): void;
      dispatchWorkgroups(x: number, y?: number, z?: number): void;
      end(): void;
    };
    copyBufferToBuffer(
      src: unknown,
      srcOffset: number,
      dst: unknown,
      dstOffset: number,
      size: number,
    ): void;
    finish(): unknown;
  };
  readonly queue: {
    writeBuffer(buffer: unknown, bufferOffset: number, data: ArrayBufferView): void;
    submit(commands: readonly unknown[]): void;
  };
}

const GPU_BUFFER_USAGE = {
  MAP_READ: 0x0001,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
} as const;

const WGSL_PERLIN_FBM = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  scale_x: u32,
  scale_y: u32,
  octaves: u32,
  seed: u32,
  persistence: f32,
  _pad: f32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> out_buf: array<f32>;

fn hash2(x: i32, y: i32, seed: u32) -> u32 {
  var h = u32(x) * 374761393u + u32(y) * 668265263u + seed * 1442695041u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  return h ^ (h >> 16u);
}

fn hash_f32(x: i32, y: i32, seed: u32) -> f32 {
  return f32(hash2(x, y, seed) & 0x00ffffffu) / 16777216.0;
}

fn fade(t: f32) -> f32 {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

fn rem_euclid(a: i32, b: i32) -> i32 {
  let r = a % b;
  return select(r, r + b, r < 0);
}

fn grad_dot(gx: i32, gy: i32, px: i32, py: i32, dx: f32, dy: f32, seed: u32) -> f32 {
  let wx = rem_euclid(gx, px);
  let wy = rem_euclid(gy, py);
  let angle = hash_f32(wx, wy, seed) * 6.28318530718;
  return cos(angle) * dx + sin(angle) * dy;
}

fn periodic_noise(u: f32, v: f32, px: i32, py: i32, seed: u32) -> f32 {
  let x = u * f32(px);
  let y = v * f32(py);
  let x0 = i32(floor(x));
  let y0 = i32(floor(y));
  let fx = x - f32(x0);
  let fy = y - f32(y0);
  let ux = fade(fx);
  let uy = fade(fy);
  let n00 = grad_dot(x0, y0, px, py, fx, fy, seed);
  let n10 = grad_dot(x0 + 1, y0, px, py, fx - 1.0, fy, seed);
  let n01 = grad_dot(x0, y0 + 1, px, py, fx, fy - 1.0, seed);
  let n11 = grad_dot(x0 + 1, y0 + 1, px, py, fx - 1.0, fy - 1.0, seed);
  let nx0 = mix(n00, n10, ux);
  let nx1 = mix(n01, n11, ux);
  return mix(nx0, nx1, uy);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let u = (f32(gid.x) + 0.5) / f32(params.width);
  let v = (f32(gid.y) + 0.5) / f32(params.height);
  var sum = 0.0;
  var amp = 1.0;
  var norm = 0.0;
  var px = i32(max(params.scale_x, 1u));
  var py = i32(max(params.scale_y, 1u));
  let octs = clamp(params.octaves, 1u, 10u);
  for (var o = 0u; o < octs; o = o + 1u) {
    sum = sum + periodic_noise(u, v, px, py, params.seed + o * 1013u) * amp;
    norm = norm + amp;
    amp = amp * clamp(params.persistence, 0.1, 0.95);
    px = px * 2;
    py = py * 2;
  }
  out_buf[gid.y * params.width + gid.x] = clamp((sum / norm) * 0.7 + 0.5, 0.0, 1.0);
}
`;

const WGSL_LEVELS = /* wgsl */ `
struct LevelsParams {
  count: u32,
  in_min: f32,
  in_max: f32,
  inv_gamma: f32,
  out_min: f32,
  out_max: f32,
  _p0: u32,
  _p1: u32,
};

@group(0) @binding(0) var<uniform> params: LevelsParams;
@group(0) @binding(1) var<storage, read> src_buf: array<f32>;
@group(0) @binding(2) var<storage, read_write> out_buf: array<f32>;

@compute @workgroup_size(256, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let span = max(params.in_max - params.in_min, 1e-6);
  let t = pow(clamp((src_buf[i] - params.in_min) / span, 0.0, 1.0), params.inv_gamma);
  out_buf[i] = params.out_min + t * (params.out_max - params.out_min);
}
`;

const WGSL_HEIGHT_TO_NORMAL = /* wgsl */ `
struct NormalParams {
  width: u32,
  height: u32,
  strength: f32,
  _pad: f32,
};

@group(0) @binding(0) var<uniform> params: NormalParams;
@group(0) @binding(1) var<storage, read> height_buf: array<f32>;
@group(0) @binding(2) var<storage, read_write> normal_buf: array<f32>;

fn sample_wrap(x: i32, y: i32) -> f32 {
  let w = i32(params.width);
  let h = i32(params.height);
  let wx = ((x % w) + w) % w;
  let wy = ((y % h) + h) % h;
  return height_buf[u32(wy) * params.width + u32(wx)];
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  let x = i32(gid.x);
  let y = i32(gid.y);
  let tl = sample_wrap(x - 1, y - 1);
  let t  = sample_wrap(x,     y - 1);
  let tr = sample_wrap(x + 1, y - 1);
  let l  = sample_wrap(x - 1, y);
  let r  = sample_wrap(x + 1, y);
  let bl = sample_wrap(x - 1, y + 1);
  let b  = sample_wrap(x,     y + 1);
  let br = sample_wrap(x + 1, y + 1);
  let dx = (3.0 * tr + 10.0 * r + 3.0 * br) - (3.0 * tl + 10.0 * l + 3.0 * bl);
  let dy = (3.0 * bl + 10.0 * b + 3.0 * br) - (3.0 * tl + 10.0 * t + 3.0 * tr);
  let scale = params.strength / 32.0;
  let n = normalize(vec3<f32>(-dx * scale, dy * scale, 1.0));
  let base = (gid.y * params.width + gid.x) * 3u;
  normal_buf[base] = n.x;
  normal_buf[base + 1u] = n.y;
  normal_buf[base + 2u] = n.z;
}
`;

const WGSL_MIP_CHAIN = /* wgsl */ `
struct MipParams {
  src_w: u32,
  src_h: u32,
  dst_w: u32,
  dst_h: u32,
  mode: u32,         // 0=linear, 1=srgb, 2=normal, 3=ormh+toksvig
  dst_u32_offset: u32,
  has_normal: u32,
  _pad: u32,
};

@group(0) @binding(0) var<uniform> params: MipParams;
@group(0) @binding(1) var<storage, read> src_rgba: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> src_norm: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> dst_rgba: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> dst_norm: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> packed_out: array<u32>;

fn encode_srgb(v: f32) -> f32 {
  let c = clamp(v, 0.0, 1.0);
  if (c <= 0.0031308) { return 12.92 * c; }
  return 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}

fn toksvig(r: f32, norm_len: f32) -> f32 {
  let alpha = max(r * r, 1e-4);
  let s = 2.0 / (alpha * alpha) - 2.0;
  let l = clamp(norm_len, 1e-6, 1.0);
  let filtered = (s * l) / (l + s * (1.0 - l));
  return min(1.0, sqrt(sqrt(2.0 / (filtered + 2.0))));
}

fn pack_u8x4(c: vec4<f32>) -> u32 {
  let r = u32(round(clamp(c.x, 0.0, 1.0) * 255.0));
  let g = u32(round(clamp(c.y, 0.0, 1.0) * 255.0));
  let b = u32(round(clamp(c.z, 0.0, 1.0) * 255.0));
  let a = u32(round(clamp(c.w, 0.0, 1.0) * 255.0));
  return r | (g << 8u) | (b << 16u) | (a << 24u);
}

@compute @workgroup_size(8, 8, 1)
fn downsample(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.dst_w || gid.y >= params.dst_h) { return; }
  let sx0 = min(gid.x * 2u, params.src_w - 1u);
  let sx1 = min(sx0 + 1u, params.src_w - 1u);
  let sy0 = min(gid.y * 2u, params.src_h - 1u);
  let sy1 = min(sy0 + 1u, params.src_h - 1u);
  let i00 = sy0 * params.src_w + sx0;
  let i10 = sy0 * params.src_w + sx1;
  let i01 = sy1 * params.src_w + sx0;
  let i11 = sy1 * params.src_w + sx1;

  let avg = 0.25 * (src_rgba[i00] + src_rgba[i10] + src_rgba[i01] + src_rgba[i11]);
  let dst_i = gid.y * params.dst_w + gid.x;
  dst_rgba[dst_i] = avg;

  var out_val = avg;
  if (params.mode == 1u) {
    out_val = vec4<f32>(encode_srgb(avg.x), encode_srgb(avg.y), encode_srgb(avg.z), avg.w);
  } else if (params.mode == 2u) {
    let l = length(avg.xyz);
    let n = select(vec3<f32>(0.0, 0.0, 1.0), avg.xyz / l, l > 0.0);
    out_val = vec4<f32>(n * 0.5 + 0.5, avg.w);
  } else if (params.mode == 3u && params.has_normal != 0u) {
    let n_avg = 0.25 * (src_norm[i00] + src_norm[i10] + src_norm[i01] + src_norm[i11]);
    dst_norm[dst_i] = n_avg;
    out_val = vec4<f32>(avg.x, toksvig(avg.y, length(n_avg.xyz)), avg.z, avg.w);
  }
  packed_out[params.dst_u32_offset + dst_i] = pack_u8x4(out_val);
}
`;

const WGSL_UNPACK_LEVEL0 = /* wgsl */ `
struct UnpackParams {
  count: u32,
  mode: u32, // 0=linear, 1=srgb, 2=normal
  _p0: u32,
  _p1: u32,
};

@group(0) @binding(0) var<uniform> params: UnpackParams;
@group(0) @binding(1) var<storage, read> src_u32: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst_f32: array<vec4<f32>>;

fn decode_srgb(v: f32) -> f32 {
  if (v <= 0.04045) { return v / 12.92; }
  return pow((v + 0.055) / 1.055, 2.4);
}

@compute @workgroup_size(256, 1, 1)
fn unpack(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let w = src_u32[i];
  let r = f32(w & 255u) / 255.0;
  let g = f32((w >> 8u) & 255u) / 255.0;
  let b = f32((w >> 16u) & 255u) / 255.0;
  let a = f32((w >> 24u) & 255u) / 255.0;
  if (params.mode == 1u) {
    dst_f32[i] = vec4<f32>(decode_srgb(r), decode_srgb(g), decode_srgb(b), a);
  } else if (params.mode == 2u) {
    let raw = vec3<f32>(r * 2.0 - 1.0, g * 2.0 - 1.0, b * 2.0 - 1.0);
    let len = length(raw);
    let n = select(vec3<f32>(0.0, 0.0, 1.0), raw / len, len > 0.0);
    dst_f32[i] = vec4<f32>(n, a);
  } else {
    dst_f32[i] = vec4<f32>(r, g, b, a);
  }
}
`;

export interface WebGpuMipChainOptions {
  readonly layout: 'color' | 'normal' | 'ormh';
  readonly srgb?: boolean;
  /** Optional level-0 normal map RGBA8 bytes for Toksvig roughness widening (`layout === 'ormh'`). */
  readonly roughnessFromNormal?: Uint8Array;
}

export interface WebGpuMipChainResult {
  readonly width: number;
  readonly height: number;
  readonly levelCount: number;
  readonly levels: readonly Uint8Array[];
  /** Mip-major packed RGBA8 buffer across all levels. */
  readonly packed: Uint8Array;
}

/**
 * Optional host-injected WebGPU Compute accelerator for high-resolution (1K–4K)
 * procedural texture generation, filters, and mipmap generation. Bundles zero `wgpu`
 * runtime — uses the host's existing `GPUDevice` directly.
 */
export class WebGpuSurfaceAccelerator {
  private readonly device: InternalWebGpuDevice;
  private fbmPipelineCache?: { getBindGroupLayout(index: number): unknown };
  private levelsPipelineCache?: { getBindGroupLayout(index: number): unknown };
  private heightToNormalPipelineCache?: { getBindGroupLayout(index: number): unknown };
  private unpackPipelineCache?: { getBindGroupLayout(index: number): unknown };
  private mipPipelineCache?: { getBindGroupLayout(index: number): unknown };

  constructor(device: WebGpuDeviceLike) {
    this.device = device as unknown as InternalWebGpuDevice;
  }

  private get fbmPipeline() {
    this.fbmPipelineCache ??= this.device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: this.device.createShaderModule({ code: WGSL_PERLIN_FBM }),
        entryPoint: 'main',
      },
    });
    return this.fbmPipelineCache;
  }

  private get levelsPipeline() {
    this.levelsPipelineCache ??= this.device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: this.device.createShaderModule({ code: WGSL_LEVELS }),
        entryPoint: 'main',
      },
    });
    return this.levelsPipelineCache;
  }

  private get heightToNormalPipeline() {
    this.heightToNormalPipelineCache ??= this.device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: this.device.createShaderModule({ code: WGSL_HEIGHT_TO_NORMAL }),
        entryPoint: 'main',
      },
    });
    return this.heightToNormalPipelineCache;
  }

  private get unpackPipeline() {
    this.unpackPipelineCache ??= this.device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: this.device.createShaderModule({ code: WGSL_UNPACK_LEVEL0 }),
        entryPoint: 'unpack',
      },
    });
    return this.unpackPipelineCache;
  }

  private get mipPipeline() {
    this.mipPipelineCache ??= this.device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: this.device.createShaderModule({ code: WGSL_MIP_CHAIN }),
        entryPoint: 'downsample',
      },
    });
    return this.mipPipelineCache;
  }

  /** WGSL source exposed for host inspection/caching. */
  static readonly fbmWgsl: string = WGSL_PERLIN_FBM;
  static readonly mipChainWgsl: string = WGSL_MIP_CHAIN;

  /** Dispatch seamlessly tileable Perlin fBm on GPU and read back a `Float32Array`. */
  async generatePerlinFbm(options: {
    readonly width: number;
    readonly height: number;
    readonly scaleX?: number;
    readonly scaleY?: number;
    readonly octaves?: number;
    readonly persistence?: number;
    readonly seed?: number;
  }): Promise<Float32Array> {
    const count = options.width * options.height;
    const byteLength = count * 4;
    const uniformData = new ArrayBuffer(32);
    const u32 = new Uint32Array(uniformData);
    const f32 = new Float32Array(uniformData);
    u32[0] = options.width;
    u32[1] = options.height;
    u32[2] = options.scaleX ?? 4;
    u32[3] = options.scaleY ?? options.scaleX ?? 4;
    u32[4] = options.octaves ?? 4;
    u32[5] = options.seed ?? 1;
    f32[6] = options.persistence ?? 0.5;
    f32[7] = 0;

    const uniformBuf = this.device.createBuffer({
      size: 32,
      usage: GPU_BUFFER_USAGE.UNIFORM | GPU_BUFFER_USAGE.COPY_DST,
    });
    const storageBuf = this.device.createBuffer({
      size: byteLength,
      usage: GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_SRC,
    });
    const readbackBuf = this.device.createBuffer({
      size: byteLength,
      usage: GPU_BUFFER_USAGE.MAP_READ | GPU_BUFFER_USAGE.COPY_DST,
    });

    try {
      this.device.queue.writeBuffer(uniformBuf, 0, new Uint8Array(uniformData));
      const bindGroup = this.device.createBindGroup({
        layout: this.fbmPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniformBuf } },
          { binding: 1, resource: { buffer: storageBuf } },
        ],
      });
      const enc = this.device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(this.fbmPipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(options.width / 8), Math.ceil(options.height / 8), 1);
      pass.end();
      enc.copyBufferToBuffer(storageBuf, 0, readbackBuf, 0, byteLength);
      this.device.queue.submit([enc.finish()]);

      await readbackBuf.mapAsync(GPU_BUFFER_USAGE.MAP_READ);
      const out = new Float32Array(readbackBuf.getMappedRange().slice(0));
      readbackBuf.unmap();
      return out;
    } finally {
      uniformBuf.destroy();
      storageBuf.destroy();
      readbackBuf.destroy();
    }
  }

  /** Dispatch scalar/multi-channel `levels` adjustment on GPU. */
  async levels(
    src: Float32Array,
    inMin: number,
    inMax: number,
    gamma = 1.0,
    outMin = 0.0,
    outMax = 1.0,
  ): Promise<Float32Array> {
    const byteLength = src.byteLength;
    const uniformData = new ArrayBuffer(32);
    new Uint32Array(uniformData)[0] = src.length;
    const f32 = new Float32Array(uniformData);
    f32[1] = inMin;
    f32[2] = inMax;
    f32[3] = 1.0 / Math.max(gamma, 1e-4);
    f32[4] = outMin;
    f32[5] = outMax;

    const uBuf = this.device.createBuffer({
      size: 32,
      usage: GPU_BUFFER_USAGE.UNIFORM | GPU_BUFFER_USAGE.COPY_DST,
    });
    const inBuf = this.device.createBuffer({
      size: byteLength,
      usage: GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_DST,
    });
    const outBuf = this.device.createBuffer({
      size: byteLength,
      usage: GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_SRC,
    });
    const readBuf = this.device.createBuffer({
      size: byteLength,
      usage: GPU_BUFFER_USAGE.MAP_READ | GPU_BUFFER_USAGE.COPY_DST,
    });
    try {
      this.device.queue.writeBuffer(uBuf, 0, new Uint8Array(uniformData));
      this.device.queue.writeBuffer(inBuf, 0, src);
      const bg = this.device.createBindGroup({
        layout: this.levelsPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uBuf } },
          { binding: 1, resource: { buffer: inBuf } },
          { binding: 2, resource: { buffer: outBuf } },
        ],
      });
      const enc = this.device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(this.levelsPipeline);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(Math.ceil(src.length / 256), 1, 1);
      pass.end();
      enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, byteLength);
      this.device.queue.submit([enc.finish()]);
      await readBuf.mapAsync(GPU_BUFFER_USAGE.MAP_READ);
      const out = new Float32Array(readBuf.getMappedRange().slice(0));
      readBuf.unmap();
      return out;
    } finally {
      uBuf.destroy();
      inBuf.destroy();
      outBuf.destroy();
      readBuf.destroy();
    }
  }

  /** Dispatch tileable 3x3 Scharr height-to-normal on GPU (returns RGB `f32` in `[-1, 1]`). */
  async heightToNormal(
    heightField: Float32Array,
    width: number,
    height: number,
    strength = 2.0,
  ): Promise<Float32Array> {
    const outBytes = width * height * 3 * 4;
    const uniformData = new ArrayBuffer(16);
    const u32 = new Uint32Array(uniformData);
    u32[0] = width;
    u32[1] = height;
    new Float32Array(uniformData)[2] = strength;

    const uBuf = this.device.createBuffer({
      size: 16,
      usage: GPU_BUFFER_USAGE.UNIFORM | GPU_BUFFER_USAGE.COPY_DST,
    });
    const inBuf = this.device.createBuffer({
      size: heightField.byteLength,
      usage: GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_DST,
    });
    const outBuf = this.device.createBuffer({
      size: outBytes,
      usage: GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_SRC,
    });
    const readBuf = this.device.createBuffer({
      size: outBytes,
      usage: GPU_BUFFER_USAGE.MAP_READ | GPU_BUFFER_USAGE.COPY_DST,
    });
    try {
      this.device.queue.writeBuffer(uBuf, 0, new Uint8Array(uniformData));
      this.device.queue.writeBuffer(inBuf, 0, heightField);
      const bg = this.device.createBindGroup({
        layout: this.heightToNormalPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uBuf } },
          { binding: 1, resource: { buffer: inBuf } },
          { binding: 2, resource: { buffer: outBuf } },
        ],
      });
      const enc = this.device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(this.heightToNormalPipeline);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8), 1);
      pass.end();
      enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, outBytes);
      this.device.queue.submit([enc.finish()]);
      await readBuf.mapAsync(GPU_BUFFER_USAGE.MAP_READ);
      const out = new Float32Array(readBuf.getMappedRange().slice(0));
      readBuf.unmap();
      return out;
    } finally {
      uBuf.destroy();
      inBuf.destroy();
      outBuf.destroy();
      readBuf.destroy();
    }
  }

  /**
   * Generate a full mip-major RGBA8 mip chain on GPU in one submission.
   * Supports linear colors, sRGB linear-light downsampling, unit-normal renormalization,
   * and Toksvig roughness widening (`layout: 'ormh'` + `roughnessFromNormal`).
   */
  async generateMipChainRgba8(
    level0: Uint8Array,
    width: number,
    height: number,
    options: WebGpuMipChainOptions,
  ): Promise<WebGpuMipChainResult> {
    const sizes: [number, number][] = [[width, height]];
    let cw = width;
    let ch = height;
    while (cw > 1 || ch > 1) {
      cw = Math.max(1, cw >> 1);
      ch = Math.max(1, ch >> 1);
      sizes.push([cw, ch]);
    }
    const offsets: number[] = [];
    let totalTexels = 0;
    for (const [w, h] of sizes) {
      offsets.push(totalTexels);
      totalTexels += w * h;
    }
    const level0Texels = width * height;
    const totalBytes = totalTexels * 4;
    if (sizes.length === 1) {
      const copy = level0.slice(0, level0Texels * 4);
      return { width, height, levelCount: 1, levels: [copy], packed: copy };
    }

    const mode =
      options.layout === 'normal'
        ? 2
        : options.layout === 'ormh' && options.roughnessFromNormal !== undefined
          ? 3
          : options.srgb
            ? 1
            : 0;
    const unpackMode = mode === 1 ? 1 : mode === 2 ? 2 : 0;
    const hasNormal = mode === 3 && options.roughnessFromNormal !== undefined;

    const toDestroy: { destroy(): void }[] = [];
    const makeBuf = (size: number, usage: number) => {
      const b = this.device.createBuffer({ size: Math.max(16, size), usage });
      toDestroy.push(b);
      return b;
    };

    try {
      const packedGpu = makeBuf(
        totalBytes,
        GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_SRC | GPU_BUFFER_USAGE.COPY_DST,
      );
      const readback = makeBuf(totalBytes, GPU_BUFFER_USAGE.MAP_READ | GPU_BUFFER_USAGE.COPY_DST);
      const srcU32 = makeBuf(
        level0Texels * 4,
        GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_DST,
      );
      const pingRgba = makeBuf(level0Texels * 16, GPU_BUFFER_USAGE.STORAGE);
      const pongRgba = makeBuf(Math.max(1, level0Texels >> 2) * 16, GPU_BUFFER_USAGE.STORAGE);
      const pingNorm = makeBuf(hasNormal ? level0Texels * 16 : 16, GPU_BUFFER_USAGE.STORAGE);
      const pongNorm = makeBuf(
        hasNormal ? Math.max(1, level0Texels >> 2) * 16 : 16,
        GPU_BUFFER_USAGE.STORAGE,
      );

      const level0Slice = level0.subarray(0, level0Texels * 4);
      this.device.queue.writeBuffer(srcU32, 0, level0Slice);
      this.device.queue.writeBuffer(packedGpu, 0, level0Slice);

      const enc = this.device.createCommandEncoder();

      // 1. Unpack level 0 RGBA8 -> f32 linear / normal
      const uUnpack = makeBuf(16, GPU_BUFFER_USAGE.UNIFORM | GPU_BUFFER_USAGE.COPY_DST);
      this.device.queue.writeBuffer(uUnpack, 0, new Uint32Array([level0Texels, unpackMode, 0, 0]));
      {
        const bg = this.device.createBindGroup({
          layout: this.unpackPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: uUnpack } },
            { binding: 1, resource: { buffer: srcU32 } },
            { binding: 2, resource: { buffer: pingRgba } },
          ],
        });
        const pass = enc.beginComputePass();
        pass.setPipeline(this.unpackPipeline);
        pass.setBindGroup(0, bg);
        pass.dispatchWorkgroups(Math.ceil(level0Texels / 256), 1, 1);
        pass.end();
      }

      if (hasNormal && options.roughnessFromNormal !== undefined) {
        const normU32 = makeBuf(
          level0Texels * 4,
          GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_DST,
        );
        this.device.queue.writeBuffer(
          normU32,
          0,
          options.roughnessFromNormal.subarray(0, level0Texels * 4),
        );
        const uUnpackN = makeBuf(16, GPU_BUFFER_USAGE.UNIFORM | GPU_BUFFER_USAGE.COPY_DST);
        this.device.queue.writeBuffer(uUnpackN, 0, new Uint32Array([level0Texels, 2, 0, 0]));
        const bgN = this.device.createBindGroup({
          layout: this.unpackPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: uUnpackN } },
            { binding: 1, resource: { buffer: normU32 } },
            { binding: 2, resource: { buffer: pingNorm } },
          ],
        });
        const pass = enc.beginComputePass();
        pass.setPipeline(this.unpackPipeline);
        pass.setBindGroup(0, bgN);
        pass.dispatchWorkgroups(Math.ceil(level0Texels / 256), 1, 1);
        pass.end();
      }

      // 2. Cascade mip levels 1..N-1 in a single command buffer
      let curRgba = pingRgba;
      let nxtRgba = pongRgba;
      let curNorm = pingNorm;
      let nxtNorm = pongNorm;
      for (let k = 1; k < sizes.length; k++) {
        const [sw, sh] = sizes[k - 1] as [number, number];
        const [dw, dh] = sizes[k] as [number, number];
        const dstOffset = offsets[k] ?? 0;
        const uMip = makeBuf(32, GPU_BUFFER_USAGE.UNIFORM | GPU_BUFFER_USAGE.COPY_DST);
        this.device.queue.writeBuffer(
          uMip,
          0,
          new Uint32Array([sw, sh, dw, dh, mode, dstOffset, hasNormal ? 1 : 0, 0]),
        );
        const bg = this.device.createBindGroup({
          layout: this.mipPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: uMip } },
            { binding: 1, resource: { buffer: curRgba } },
            { binding: 2, resource: { buffer: curNorm } },
            { binding: 3, resource: { buffer: nxtRgba } },
            { binding: 4, resource: { buffer: nxtNorm } },
            { binding: 5, resource: { buffer: packedGpu } },
          ],
        });
        const pass = enc.beginComputePass();
        pass.setPipeline(this.mipPipeline);
        pass.setBindGroup(0, bg);
        pass.dispatchWorkgroups(Math.ceil(dw / 8), Math.ceil(dh / 8), 1);
        pass.end();

        [curRgba, nxtRgba] = [nxtRgba, curRgba];
        [curNorm, nxtNorm] = [nxtNorm, curNorm];
      }

      enc.copyBufferToBuffer(packedGpu, 0, readback, 0, totalBytes);
      this.device.queue.submit([enc.finish()]);

      await readback.mapAsync(GPU_BUFFER_USAGE.MAP_READ);
      const packed = new Uint8Array(readback.getMappedRange().slice(0));
      readback.unmap();

      const levels = sizes.map(([w, h], k) => {
        const start = (offsets[k] ?? 0) * 4;
        return packed.subarray(start, start + w * h * 4);
      });
      return { width, height, levelCount: sizes.length, levels, packed };
    } finally {
      for (const b of toDestroy) b.destroy();
    }
  }
}
