import {
  getModelingKernelWasm,
  type ModelingKernelWasmExports,
} from '@forgeax/modeling-kernel-wasm';
import {
  ATTRIBUTE_FORMATS,
  type AttributeFormat,
  type AttributeKey,
  CANONICAL_ATTRIBUTE_KEYS,
  formatArrayCtor,
  type OutputMode,
  PRIMITIVE_TOPOLOGIES,
  type PrimitiveTopology,
  type RawAttributeChannels,
  type RawMeshData,
  type RawSubmesh,
  type VertexLayoutDeclaration,
} from './layout';
import { err, errorCodeFromId, KernelError, type KernelResult, ok } from './result';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type KernelRegionMode = 'merged' | 'perFace' | 'perIsland';
export type KernelSubdivisionScheme = 'catmullClark' | 'simple';
export type KernelSubdivisionBoundary = 'edgeOnly' | 'edgeAndCorner';
export type KernelCornerChannelName =
  | 'uv0'
  | 'uv1'
  | 'uv2'
  | 'uv3'
  | 'uv4'
  | 'uv5'
  | 'uv6'
  | 'uv7'
  | 'color';

export const KERNEL_CORNER_CHANNELS: readonly KernelCornerChannelName[] = [
  'uv0',
  'uv1',
  'uv2',
  'uv3',
  'uv4',
  'uv5',
  'uv6',
  'uv7',
  'color',
];

export interface RustEditMeshCounts {
  readonly vertexCount: number;
  readonly faceCount: number;
  readonly edgeCount: number;
  readonly vertexHighWater: number;
  readonly halfHighWater: number;
  readonly faceHighWater: number;
  readonly topologyStamp: number;
  readonly shapeStamp: number;
}

export interface RustEditMeshSoaViews {
  readonly memoryGeneration: number;
  readonly vertexHighWater: number;
  readonly halfHighWater: number;
  readonly faceHighWater: number;
  readonly tagWords: number;
  readonly pos: Float64Array;
  readonly vGen: Uint32Array;
  readonly hVert: Int32Array;
  readonly hNext: Int32Array;
  readonly hPrev: Int32Array;
  readonly hFace: Int32Array;
  readonly eFlags: Uint8Array;
  readonly fHalf: Int32Array;
  readonly fLen: Int32Array;
  readonly fGen: Uint32Array;
  readonly fMaterial: Int32Array;
  readonly fLabel: Int32Array;
  readonly fRole: Int32Array;
  readonly fFlags: Uint8Array;
  readonly fTags: Uint32Array;
}

export interface RustCornerChannelView {
  readonly dim: number;
  readonly values: Float32Array;
  readonly set: Uint8Array;
}

function readLastError(wasm: ModelingKernelWasmExports): KernelError {
  const code = errorCodeFromId(wasm.mk_last_error_code());
  const mem = new Uint8Array(wasm.memory.buffer);
  const fPtr = wasm.mk_last_error_field_ptr();
  const fLen = wasm.mk_last_error_field_len();
  const rPtr = wasm.mk_last_error_reason_ptr();
  const rLen = wasm.mk_last_error_reason_len();
  const field = fLen > 0 ? textDecoder.decode(mem.subarray(fPtr, fPtr + fLen)) : 'kernel';
  const reason = rLen > 0 ? textDecoder.decode(mem.subarray(rPtr, rPtr + rLen)) : 'unknown error';
  return new KernelError(code, field, reason);
}

const meshLeakRegistry =
  typeof FinalizationRegistry !== 'undefined'
    ? new FinalizationRegistry<{ wasm: ModelingKernelWasmExports; handle: bigint }>((entry) => {
        entry.wasm.mk_mesh_dispose(entry.handle);
      })
    : undefined;

function regionModeId(mode: KernelRegionMode): number {
  return mode === 'merged' ? 0 : mode === 'perFace' ? 1 : 2;
}

function outputModeId(mode: OutputMode): number {
  return mode === 'separate' ? 0 : mode === 'interleaved' ? 1 : 2;
}

function writeI32Scratch(
  wasm: ModelingKernelWasmExports,
  values: ArrayLike<number>,
  byteOffset = 0,
): number {
  const byteLen = values.length * 4;
  const base = wasm.mk_scratch_ensure(byteOffset + byteLen);
  const view = new Int32Array(wasm.memory.buffer, base + byteOffset, values.length);
  for (let i = 0; i < values.length; i++) view[i] = values[i] ?? 0;
  return base + byteOffset;
}

function writeStringScratch(
  wasm: ModelingKernelWasmExports,
  value: string,
  byteOffset = 0,
): { readonly ptr: number; readonly len: number } {
  const encoded = textEncoder.encode(value);
  const base = wasm.mk_scratch_ensure(byteOffset + Math.max(1, encoded.byteLength));
  new Uint8Array(wasm.memory.buffer, base + byteOffset, encoded.byteLength).set(encoded);
  return { ptr: base + byteOffset, len: encoded.byteLength };
}

/**
 * Retained Rust/WASM half-edge `EditMesh` handle.
 *
 * Exposes zero-copy SoA views directly into WASM linear memory alongside
 * native Rust FXSL v1 selector evaluation, primitives, `extrude`, `inset`,
 * `subdivide`, transforms, snapshots, and direct `toRawMeshData()` export.
 */
export class RustEditMesh {
  private handle: bigint;
  private isDisposedState = false;
  private memoryGeneration = 0;
  private lastBuffer: ArrayBufferLike;
  private readonly unregisterToken = {};

  constructor(
    private readonly wasm: ModelingKernelWasmExports,
    handle: bigint,
  ) {
    this.handle = handle;
    this.lastBuffer = wasm.memory.buffer;
    meshLeakRegistry?.register(this, { wasm, handle }, this.unregisterToken);
  }

  /** Raw arena handle for cross-mesh WASM operations. */
  get rawHandle(): bigint {
    return this.handle;
  }

  /** Notify JS SoA view caches that a Rust extension operator modified mesh topology or positions. */
  syncAfterExternalWrite(): void {
    this.trackBuffer();
    this.memoryGeneration++;
  }

  get isDisposed(): boolean {
    return this.isDisposedState;
  }

  get disposed(): boolean {
    return this.isDisposedState;
  }

  private checkAlive(): KernelResult<void> {
    if (this.isDisposed) {
      return err(new KernelError('kernel-invalid-handle', 'handle', 'EditMesh has been disposed'));
    }
    return ok(undefined);
  }

  private trackBuffer(): void {
    if (this.wasm.memory.buffer !== this.lastBuffer) {
      this.lastBuffer = this.wasm.memory.buffer;
      this.memoryGeneration++;
    }
  }

  counts(): RustEditMeshCounts {
    if (this.isDisposed) {
      return {
        vertexCount: 0,
        faceCount: 0,
        edgeCount: 0,
        vertexHighWater: 0,
        halfHighWater: 0,
        faceHighWater: 0,
        topologyStamp: 0,
        shapeStamp: 0,
      };
    }
    const ptr = this.wasm.mk_scratch_ensure(32);
    this.wasm.mk_mesh_counts(this.handle, ptr);
    const u32 = new Uint32Array(this.wasm.memory.buffer, ptr, 8);
    return {
      vertexCount: u32[0] ?? 0,
      faceCount: u32[1] ?? 0,
      edgeCount: u32[2] ?? 0,
      vertexHighWater: u32[3] ?? 0,
      halfHighWater: u32[4] ?? 0,
      faceHighWater: u32[5] ?? 0,
      topologyStamp: u32[6] ?? 0,
      shapeStamp: u32[7] ?? 0,
    };
  }

  private sliceView<T>(
    Ctor: new (buffer: ArrayBufferLike, byteOffset?: number, length?: number) => T,
    buf: ArrayBufferLike,
    ptr: number | undefined,
    len: number,
  ): T {
    return len > 0 ? new Ctor(buf, ptr ?? 0, len) : new Ctor(new ArrayBuffer(0));
  }

  /** Zero-copy SoA TypedArray views backed directly by WASM linear memory. */
  views(): RustEditMeshSoaViews {
    this.trackBuffer();
    const c = this.counts();
    const ptr = this.wasm.mk_scratch_ensure(64);
    this.wasm.mk_mesh_soa_ptrs(this.handle, ptr);
    const p = new Uint32Array(this.wasm.memory.buffer, ptr, 16);
    const buf = this.wasm.memory.buffer;
    const vhw = c.vertexHighWater;
    const hhw = c.halfHighWater;
    const fhw = c.faceHighWater;
    const tagWords = p[15] ?? 1;
    return {
      memoryGeneration: this.memoryGeneration,
      vertexHighWater: vhw,
      halfHighWater: hhw,
      faceHighWater: fhw,
      tagWords,
      pos: this.sliceView(Float64Array, buf, p[0], vhw * 3),
      vGen: this.sliceView(Uint32Array, buf, p[1], vhw),
      hVert: this.sliceView(Int32Array, buf, p[2], hhw),
      hNext: this.sliceView(Int32Array, buf, p[3], hhw),
      hPrev: this.sliceView(Int32Array, buf, p[4], hhw),
      hFace: this.sliceView(Int32Array, buf, p[5], hhw),
      eFlags: this.sliceView(Uint8Array, buf, p[6], hhw >> 1),
      fHalf: this.sliceView(Int32Array, buf, p[7], fhw),
      fLen: this.sliceView(Int32Array, buf, p[8], fhw),
      fGen: this.sliceView(Uint32Array, buf, p[9], fhw),
      fMaterial: this.sliceView(Int32Array, buf, p[10], fhw),
      fLabel: this.sliceView(Int32Array, buf, p[11], fhw),
      fRole: this.sliceView(Int32Array, buf, p[12], fhw),
      fFlags: this.sliceView(Uint8Array, buf, p[13], fhw),
      fTags: this.sliceView(Uint32Array, buf, p[14], fhw * tagWords),
    };
  }

  channelViews(name: KernelCornerChannelName): RustCornerChannelView | undefined {
    if (this.isDisposed) return undefined;
    const id = KERNEL_CORNER_CHANNELS.indexOf(name);
    if (id < 0) return undefined;
    const ptr = this.wasm.mk_scratch_ensure(16);
    const status = this.wasm.mk_mesh_channel_ptrs(this.handle, id, ptr);
    if (status !== 0) return undefined;
    const meta = new Uint32Array(this.wasm.memory.buffer, ptr, 4);
    const dim = meta[0] ?? 2;
    const halfLen = meta[3] ?? 0;
    return {
      dim,
      values:
        halfLen > 0
          ? new Float32Array(this.wasm.memory.buffer, meta[1] ?? 0, halfLen * dim)
          : new Float32Array(0),
      set:
        halfLen > 0
          ? new Uint8Array(this.wasm.memory.buffer, meta[2] ?? 0, halfLen)
          : new Uint8Array(0),
    };
  }

  addVertex(x: number, y: number, z: number): KernelResult<number> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const v = this.wasm.mk_mesh_add_vertex(this.handle, x, y, z);
    this.trackBuffer();
    return v < 0 ? err(readLastError(this.wasm)) : ok(v);
  }

  removeVertex(v: number): void {
    if (this.isDisposed) return;
    this.wasm.mk_mesh_remove_vertex(this.handle, v);
  }

  setPosition(v: number, x: number, y: number, z: number): void {
    if (this.isDisposed) return;
    this.wasm.mk_mesh_set_position(this.handle, v, x, y, z);
  }

  addFace(loop: readonly number[], material = 0): KernelResult<number> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const ptr = writeI32Scratch(this.wasm, loop);
    const f = this.wasm.mk_mesh_add_face(this.handle, ptr, loop.length, material);
    this.trackBuffer();
    return f < 0 ? err(readLastError(this.wasm)) : ok(f);
  }

  removeFace(f: number): void {
    if (this.isDisposed) return;
    this.wasm.mk_mesh_remove_face(this.handle, f);
  }

  findHalf(a: number, b: number): number {
    if (this.isDisposed) return -1;
    return this.wasm.mk_mesh_find_half(this.handle, a, b);
  }

  setCorner(name: KernelCornerChannelName, h: number, value: ArrayLike<number>): void {
    if (this.isDisposed) return;
    const id = KERNEL_CORNER_CHANNELS.indexOf(name);
    if (id < 0) return;
    const dim = name === 'color' ? 4 : 2;
    const ptr = this.wasm.mk_scratch_ensure(dim * 4);
    const f32 = new Float32Array(this.wasm.memory.buffer, ptr, dim);
    for (let i = 0; i < dim; i++) f32[i] = value[i] ?? 0;
    this.wasm.mk_mesh_set_corner(this.handle, id, h, ptr, dim);
    this.trackBuffer();
  }

  internTag(name: string, create: boolean): number {
    if (this.isDisposed) return -1;
    const { ptr, len } = writeStringScratch(this.wasm, name);
    const res = this.wasm.mk_mesh_intern_tag(this.handle, ptr, len, create ? 1 : 0);
    this.trackBuffer();
    return res;
  }

  internLabel(name: string): number {
    if (this.isDisposed) return 0;
    const { ptr, len } = writeStringScratch(this.wasm, name);
    return this.wasm.mk_mesh_intern_label(this.handle, ptr, len);
  }

  internRole(name: string): number {
    if (this.isDisposed) return 0;
    const { ptr, len } = writeStringScratch(this.wasm, name);
    return this.wasm.mk_mesh_intern_role(this.handle, ptr, len);
  }

  internMaterial(name: string): number {
    if (this.isDisposed) return 0;
    const { ptr, len } = writeStringScratch(this.wasm, name);
    return this.wasm.mk_mesh_intern_material(this.handle, ptr, len);
  }

  box(options: {
    readonly size: readonly [number, number, number];
    readonly segments?: readonly [number, number, number];
    readonly center?: readonly [number, number, number];
    readonly label?: number;
    readonly material?: number;
    readonly tag?: number;
  }): KernelResult<number> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const [sx, sy, sz] = options.size;
    const [nx, ny, nz] = options.segments ?? [1, 1, 1];
    const [cx, cy, cz] = options.center ?? [0, 0, 0];
    const count = this.wasm.mk_mesh_box(
      this.handle,
      sx,
      sy,
      sz,
      nx,
      ny,
      nz,
      cx,
      cy,
      cz,
      options.label ?? 0,
      options.material ?? 0,
      options.tag ?? -1,
    );
    this.trackBuffer();
    return count < 0 ? err(readLastError(this.wasm)) : ok(count);
  }

  plane(options: {
    readonly width: number;
    readonly height: number;
    readonly widthSegments?: number;
    readonly heightSegments?: number;
    readonly center?: readonly [number, number, number];
    readonly label?: number;
    readonly material?: number;
    readonly tag?: number;
  }): KernelResult<number> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const [cx, cy, cz] = options.center ?? [0, 0, 0];
    const count = this.wasm.mk_mesh_plane(
      this.handle,
      options.width,
      options.height,
      options.widthSegments ?? 1,
      options.heightSegments ?? 1,
      cx,
      cy,
      cz,
      options.label ?? 0,
      options.material ?? 0,
      options.tag ?? -1,
    );
    this.trackBuffer();
    return count < 0 ? err(readLastError(this.wasm)) : ok(count);
  }

  /** Evaluate FXSL v1 selector bytes directly in Rust and return matched IDs in ascending order. */
  evalFxsl(fxslBytes: Uint8Array, checkCardinality = true): KernelResult<Int32Array> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const metaBytes = 8;
    const base = this.wasm.mk_scratch_ensure(metaBytes + Math.max(1, fxslBytes.byteLength));
    const bytesPtr = base + metaBytes;
    new Uint8Array(this.wasm.memory.buffer, bytesPtr, fxslBytes.byteLength).set(fxslBytes);
    const status = this.wasm.mk_mesh_eval_fxsl(
      this.handle,
      bytesPtr,
      fxslBytes.byteLength,
      checkCardinality ? 1 : 0,
      base,
    );
    this.trackBuffer();
    if (status !== 0) return err(readLastError(this.wasm));
    const meta = new Uint32Array(this.wasm.memory.buffer, base, 2);
    const ptr = meta[0] ?? 0;
    const count = meta[1] ?? 0;
    return ok(
      count > 0 ? new Int32Array(this.wasm.memory.buffer, ptr, count).slice() : new Int32Array(0),
    );
  }

  translate(
    faces: ArrayLike<number>,
    delta: readonly [number, number, number],
  ): KernelResult<void> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const ptr = writeI32Scratch(this.wasm, faces);
    const status = this.wasm.mk_mesh_translate(
      this.handle,
      ptr,
      faces.length,
      delta[0],
      delta[1],
      delta[2],
    );
    return status === 0 ? ok(undefined) : err(readLastError(this.wasm));
  }

  scale(
    faces: ArrayLike<number>,
    factors: readonly [number, number, number],
    pivot?: readonly [number, number, number],
  ): KernelResult<void> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const ptr = writeI32Scratch(this.wasm, faces);
    const status = this.wasm.mk_mesh_scale(
      this.handle,
      ptr,
      faces.length,
      factors[0],
      factors[1],
      factors[2],
      pivot === undefined ? 0 : 1,
      pivot?.[0] ?? 0,
      pivot?.[1] ?? 0,
      pivot?.[2] ?? 0,
    );
    return status === 0 ? ok(undefined) : err(readLastError(this.wasm));
  }

  rotate(
    faces: ArrayLike<number>,
    axis: 'x' | 'y' | 'z',
    degrees: number,
    pivot?: readonly [number, number, number],
  ): KernelResult<void> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const ptr = writeI32Scratch(this.wasm, faces);
    const axisId = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
    const status = this.wasm.mk_mesh_rotate(
      this.handle,
      ptr,
      faces.length,
      axisId,
      degrees,
      pivot === undefined ? 0 : 1,
      pivot?.[0] ?? 0,
      pivot?.[1] ?? 0,
      pivot?.[2] ?? 0,
    );
    return status === 0 ? ok(undefined) : err(readLastError(this.wasm));
  }

  tagFaces(faces: ArrayLike<number>, name: string): KernelResult<void> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const encoded = textEncoder.encode(name);
    const faceBytes = faces.length * 4;
    const base = this.wasm.mk_scratch_ensure(faceBytes + Math.max(1, encoded.byteLength));
    const faceView = new Int32Array(this.wasm.memory.buffer, base, faces.length);
    for (let i = 0; i < faces.length; i++) faceView[i] = faces[i] ?? 0;
    const namePtr = base + faceBytes;
    new Uint8Array(this.wasm.memory.buffer, namePtr, encoded.byteLength).set(encoded);
    const status = this.wasm.mk_mesh_tag_faces(
      this.handle,
      base,
      faces.length,
      namePtr,
      encoded.byteLength,
    );
    this.trackBuffer();
    return status === 0 ? ok(undefined) : err(readLastError(this.wasm));
  }

  setMaterial(faces: ArrayLike<number>, slot: string): KernelResult<void> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const encoded = textEncoder.encode(slot);
    const faceBytes = faces.length * 4;
    const base = this.wasm.mk_scratch_ensure(faceBytes + Math.max(1, encoded.byteLength));
    const faceView = new Int32Array(this.wasm.memory.buffer, base, faces.length);
    for (let i = 0; i < faces.length; i++) faceView[i] = faces[i] ?? 0;
    const slotPtr = base + faceBytes;
    new Uint8Array(this.wasm.memory.buffer, slotPtr, encoded.byteLength).set(encoded);
    const status = this.wasm.mk_mesh_set_material(
      this.handle,
      base,
      faces.length,
      slotPtr,
      encoded.byteLength,
    );
    return status === 0 ? ok(undefined) : err(readLastError(this.wasm));
  }

  markEdges(edges: ArrayLike<number>, flag: number, enable = true): KernelResult<void> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const ptr = writeI32Scratch(this.wasm, edges);
    const status = this.wasm.mk_mesh_mark_edges(
      this.handle,
      ptr,
      edges.length,
      flag,
      enable ? 1 : 0,
    );
    return status === 0 ? ok(undefined) : err(readLastError(this.wasm));
  }

  extrude(
    faces: ArrayLike<number>,
    options: {
      readonly distance: number;
      readonly region?: KernelRegionMode;
      readonly label?: number;
    },
  ): KernelResult<{ readonly top: number; readonly side: number }> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const faceBytes = faces.length * 4;
    const base = this.wasm.mk_scratch_ensure(8 + faceBytes);
    const facesPtr = base + 8;
    const faceView = new Int32Array(this.wasm.memory.buffer, facesPtr, faces.length);
    for (let i = 0; i < faces.length; i++) faceView[i] = faces[i] ?? 0;
    const status = this.wasm.mk_mesh_extrude(
      this.handle,
      facesPtr,
      faces.length,
      options.distance,
      regionModeId(options.region ?? 'merged'),
      options.label ?? 0,
      base,
    );
    this.trackBuffer();
    if (status !== 0) return err(readLastError(this.wasm));
    const counts = new Uint32Array(this.wasm.memory.buffer, base, 2);
    return ok({ top: counts[0] ?? 0, side: counts[1] ?? 0 });
  }

  inset(
    faces: ArrayLike<number>,
    options: {
      readonly thickness: number;
      readonly region?: KernelRegionMode;
      readonly label?: number;
    },
  ): KernelResult<{ readonly inner: number; readonly rim: number }> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const faceBytes = faces.length * 4;
    const base = this.wasm.mk_scratch_ensure(8 + faceBytes);
    const facesPtr = base + 8;
    const faceView = new Int32Array(this.wasm.memory.buffer, facesPtr, faces.length);
    for (let i = 0; i < faces.length; i++) faceView[i] = faces[i] ?? 0;
    const status = this.wasm.mk_mesh_inset(
      this.handle,
      facesPtr,
      faces.length,
      options.thickness,
      regionModeId(options.region ?? 'merged'),
      options.label ?? 0,
      base,
    );
    this.trackBuffer();
    if (status !== 0) return err(readLastError(this.wasm));
    const counts = new Uint32Array(this.wasm.memory.buffer, base, 2);
    return ok({ inner: counts[0] ?? 0, rim: counts[1] ?? 0 });
  }

  subdivide(
    faces: ArrayLike<number>,
    options: {
      readonly levels: number;
      readonly scheme?: KernelSubdivisionScheme;
      readonly boundary?: KernelSubdivisionBoundary;
      readonly creaseSharpness?: number;
      readonly faceBudget?: number;
    },
  ): KernelResult<number> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const ptr = writeI32Scratch(this.wasm, faces);
    const outFaces = this.wasm.mk_mesh_subdivide(
      this.handle,
      ptr,
      faces.length,
      options.levels,
      options.scheme === 'simple' ? 1 : 0,
      options.boundary === 'edgeOnly' ? 0 : 1,
      options.creaseSharpness ?? Number.POSITIVE_INFINITY,
      options.faceBudget ?? 500_000,
    );
    this.trackBuffer();
    return outFaces < 0 ? err(readLastError(this.wasm)) : ok(outFaces);
  }

  offset(
    faces: ArrayLike<number>,
    options: {
      readonly distance: number;
      readonly region?: KernelRegionMode;
      readonly label?: number;
    },
  ): KernelResult<{ readonly top: number; readonly side: number }> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const faceBytes = faces.length * 4;
    const base = this.wasm.mk_scratch_ensure(8 + faceBytes);
    const facesPtr = base + 8;
    const faceView = new Int32Array(this.wasm.memory.buffer, facesPtr, faces.length);
    for (let i = 0; i < faces.length; i++) faceView[i] = faces[i] ?? 0;
    const status = this.wasm.mk_mesh_offset(
      this.handle,
      facesPtr,
      faces.length,
      options.distance,
      regionModeId(options.region ?? 'merged'),
      options.label ?? 0,
      base,
    );
    this.trackBuffer();
    if (status !== 0) return err(readLastError(this.wasm));
    const counts = new Uint32Array(this.wasm.memory.buffer, base, 2);
    return ok({ top: counts[0] ?? 0, side: counts[1] ?? 0 });
  }

  mirror(axis: 'x' | 'y' | 'z', weldDistance = 1e-5): KernelResult<number> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const axisId = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
    const copies = this.wasm.mk_mesh_mirror(this.handle, axisId, weldDistance);
    this.trackBuffer();
    return copies < 0 ? err(readLastError(this.wasm)) : ok(copies);
  }

  weld(distance: number): KernelResult<{ readonly merged: number; readonly collapsed: number }> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const base = this.wasm.mk_scratch_ensure(8);
    const status = this.wasm.mk_mesh_weld(this.handle, distance, base);
    this.trackBuffer();
    if (status !== 0) return err(readLastError(this.wasm));
    const counts = new Uint32Array(this.wasm.memory.buffer, base, 2);
    return ok({ merged: counts[0] ?? 0, collapsed: counts[1] ?? 0 });
  }

  flipFaces(faces: ArrayLike<number>): KernelResult<number> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const ptr = writeI32Scratch(this.wasm, faces);
    const n = this.wasm.mk_mesh_flip(this.handle, ptr, faces.length);
    this.trackBuffer();
    return n < 0 ? err(readLastError(this.wasm)) : ok(n);
  }

  deleteFaces(faces: ArrayLike<number>): KernelResult<number> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const ptr = writeI32Scratch(this.wasm, faces);
    const n = this.wasm.mk_mesh_delete(this.handle, ptr, faces.length);
    this.trackBuffer();
    return n < 0 ? err(readLastError(this.wasm)) : ok(n);
  }

  projectUv(
    faces: ArrayLike<number>,
    options: {
      readonly mode: 'box' | 'planar' | 'cylinder';
      readonly axis?: 'x' | 'y' | 'z';
      readonly scale: number;
      readonly channel?: 'uv0' | 'uv1';
    },
  ): KernelResult<number> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const ptr = writeI32Scratch(this.wasm, faces);
    const modeId = options.mode === 'box' ? 0 : options.mode === 'planar' ? 1 : 2;
    const axisId = options.axis === 'x' ? 0 : options.axis === 'z' ? 2 : 1;
    const chId = options.channel === 'uv1' ? 1 : 0;
    const n = this.wasm.mk_mesh_uv_project(
      this.handle,
      ptr,
      faces.length,
      modeId,
      axisId,
      options.scale,
      chId,
    );
    this.trackBuffer();
    return n < 0 ? err(readLastError(this.wasm)) : ok(n);
  }

  unwrapUv(
    faces: ArrayLike<number>,
    options: {
      readonly seams?: 'marked' | 'sharp';
      readonly channel?: 'uv0' | 'uv1';
    } = {},
  ): KernelResult<number> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const ptr = writeI32Scratch(this.wasm, faces);
    const seamId = options.seams === 'sharp' ? 1 : 0;
    const chId = options.channel === 'uv1' ? 1 : 0;
    const islands = this.wasm.mk_mesh_uv_unwrap(this.handle, ptr, faces.length, seamId, chId);
    this.trackBuffer();
    return islands < 0 ? err(readLastError(this.wasm)) : ok(islands);
  }

  packUv(
    faces: ArrayLike<number>,
    options: {
      readonly resolution: number;
      readonly paddingTexels: number;
      readonly normalize?: boolean;
      readonly rotate?: boolean;
      readonly channel?: 'uv0' | 'uv1';
    },
  ): KernelResult<number> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const ptr = writeI32Scratch(this.wasm, faces);
    const chId = options.channel === 'uv1' ? 1 : 0;
    const islands = this.wasm.mk_mesh_uv_pack(
      this.handle,
      ptr,
      faces.length,
      options.resolution,
      options.paddingTexels,
      options.normalize === false ? 0 : 1,
      options.rotate === false ? 0 : 1,
      chId,
    );
    this.trackBuffer();
    return islands < 0 ? err(readLastError(this.wasm)) : ok(islands);
  }

  cylinder(options: {
    readonly radiusTop: number;
    readonly radiusBottom: number;
    readonly height: number;
    readonly radialSegments: number;
    readonly heightSegments?: number;
    readonly openEnded?: boolean;
    readonly center?: readonly [number, number, number];
    readonly label?: number;
    readonly material?: number;
    readonly tag?: number;
  }): KernelResult<number> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const [cx, cy, cz] = options.center ?? [0, 0, 0];
    const n = this.wasm.mk_mesh_cylinder(
      this.handle,
      options.radiusTop,
      options.radiusBottom,
      options.height,
      options.radialSegments,
      options.heightSegments ?? 1,
      options.openEnded ? 1 : 0,
      cx,
      cy,
      cz,
      options.label ?? 0,
      options.material ?? 0,
      options.tag ?? -1,
    );
    this.trackBuffer();
    return n < 0 ? err(readLastError(this.wasm)) : ok(n);
  }

  sphere(options: {
    readonly radius: number;
    readonly widthSegments: number;
    readonly heightSegments: number;
    readonly center?: readonly [number, number, number];
    readonly label?: number;
    readonly material?: number;
    readonly tag?: number;
  }): KernelResult<number> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const [cx, cy, cz] = options.center ?? [0, 0, 0];
    const n = this.wasm.mk_mesh_sphere(
      this.handle,
      options.radius,
      options.widthSegments,
      options.heightSegments,
      cx,
      cy,
      cz,
      options.label ?? 0,
      options.material ?? 0,
      options.tag ?? -1,
    );
    this.trackBuffer();
    return n < 0 ? err(readLastError(this.wasm)) : ok(n);
  }

  torus(options: {
    readonly radius: number;
    readonly tube: number;
    readonly radialSegments: number;
    readonly tubularSegments: number;
    readonly angle?: number;
    readonly center?: readonly [number, number, number];
    readonly label?: number;
    readonly material?: number;
    readonly tag?: number;
  }): KernelResult<number> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const [cx, cy, cz] = options.center ?? [0, 0, 0];
    const n = this.wasm.mk_mesh_torus(
      this.handle,
      options.radius,
      options.tube,
      options.radialSegments,
      options.tubularSegments,
      options.angle ?? 360,
      cx,
      cy,
      cz,
      options.label ?? 0,
      options.material ?? 0,
      options.tag ?? -1,
    );
    this.trackBuffer();
    return n < 0 ? err(readLastError(this.wasm)) : ok(n);
  }

  revolve(options: {
    readonly points: readonly (readonly [number, number])[];
    readonly segments: number;
    readonly angle?: number;
    readonly label?: number;
    readonly material?: number;
    readonly tag?: number;
  }): KernelResult<number> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const bytes = options.points.length * 16;
    const ptr = this.wasm.mk_scratch_ensure(Math.max(16, bytes + 8));
    const aligned = (ptr + 7) & ~7;
    const view = new Float64Array(this.wasm.memory.buffer, aligned, options.points.length * 2);
    for (let i = 0; i < options.points.length; i++) {
      const p = options.points[i];
      view[i * 2] = p?.[0] ?? 0;
      view[i * 2 + 1] = p?.[1] ?? 0;
    }
    const n = this.wasm.mk_mesh_revolve(
      this.handle,
      aligned,
      options.points.length,
      options.segments,
      options.angle ?? 360,
      options.label ?? 0,
      options.material ?? 0,
      options.tag ?? -1,
    );
    this.trackBuffer();
    return n < 0 ? err(readLastError(this.wasm)) : ok(n);
  }

  appendMesh(
    source: RustEditMesh,
    options: {
      readonly translate?: readonly [number, number, number];
      readonly label?: number;
      readonly tag?: number;
    } = {},
  ): KernelResult<number> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    if (source.isDisposed) {
      return err(new KernelError('kernel-invalid-handle', 'source', 'source EditMesh is disposed'));
    }
    const [tx, ty, tz] = options.translate ?? [0, 0, 0];
    const n = this.wasm.mk_mesh_append(
      this.handle,
      source.handle,
      tx,
      ty,
      tz,
      options.label ?? 0,
      options.tag ?? -1,
    );
    this.trackBuffer();
    return n < 0 ? err(readLastError(this.wasm)) : ok(n);
  }

  arrayFaces(
    faces: ArrayLike<number>,
    options:
      | {
          readonly kind: 'linear';
          readonly count: number;
          readonly offset: readonly [number, number, number];
          readonly prefix: string;
          readonly label?: number;
          readonly tag?: number;
        }
      | {
          readonly kind: 'radial';
          readonly count: number;
          readonly axis: readonly [number, number, number];
          readonly angle?: number;
          readonly center?: readonly [number, number, number];
          readonly prefix: string;
          readonly label?: number;
          readonly tag?: number;
        },
  ): KernelResult<number> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const prefBytes = textEncoder.encode(options.prefix);
    const faceBytes = faces.length * 4;
    const base = this.wasm.mk_scratch_ensure(faceBytes + Math.max(1, prefBytes.byteLength));
    const faceView = new Int32Array(this.wasm.memory.buffer, base, faces.length);
    for (let i = 0; i < faces.length; i++) faceView[i] = faces[i] ?? 0;
    const prefPtr = base + faceBytes;
    new Uint8Array(this.wasm.memory.buffer, prefPtr, prefBytes.byteLength).set(prefBytes);

    const isLinear = options.kind === 'linear';
    const [vx, vy, vz] = isLinear ? options.offset : options.axis;
    const [cx, cy, cz] = isLinear ? [0, 0, 0] : (options.center ?? [0, 0, 0]);
    const angleDeg = isLinear ? 360 : (options.angle ?? 360);
    const n = this.wasm.mk_mesh_array(
      this.handle,
      base,
      faces.length,
      isLinear ? 0 : 1,
      options.count,
      vx,
      vy,
      vz,
      angleDeg,
      cx,
      cy,
      cz,
      prefPtr,
      prefBytes.byteLength,
      options.label ?? 0,
      options.tag ?? -1,
    );
    this.trackBuffer();
    return n < 0 ? err(readLastError(this.wasm)) : ok(n);
  }

  fillHoles(
    edges: ArrayLike<number>,
    options: { readonly material?: number; readonly label?: number; readonly tag?: number } = {},
  ): KernelResult<number> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const ptr = writeI32Scratch(this.wasm, edges);
    const n = this.wasm.mk_mesh_fill_holes(
      this.handle,
      ptr,
      edges.length,
      options.material ?? -1,
      options.label ?? 0,
      options.tag ?? -1,
    );
    this.trackBuffer();
    return n < 0 ? err(readLastError(this.wasm)) : ok(n);
  }

  taper(
    faces: ArrayLike<number>,
    options: {
      readonly axis: 'x' | 'y' | 'z';
      readonly factor: number;
      readonly axes?: readonly ('x' | 'y' | 'z')[];
      readonly range?: readonly [number, number];
      readonly origin?: readonly [number, number, number];
    },
  ): KernelResult<number> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const ptr = writeI32Scratch(this.wasm, faces);
    const axisId = options.axis === 'x' ? 0 : options.axis === 'y' ? 1 : 2;
    let axesMask = 0;
    if (options.axes !== undefined) {
      for (const ax of options.axes) axesMask |= 1 << (ax === 'x' ? 0 : ax === 'y' ? 1 : 2);
    }
    const [r0, r1] = options.range ?? [0, 0];
    const [ox, oy, oz] = options.origin ?? [0, 0, 0];
    const n = this.wasm.mk_mesh_taper(
      this.handle,
      ptr,
      faces.length,
      axisId,
      options.factor,
      axesMask,
      options.range !== undefined ? 1 : 0,
      r0,
      r1,
      options.origin !== undefined ? 1 : 0,
      ox,
      oy,
      oz,
    );
    this.trackBuffer();
    return n < 0 ? err(readLastError(this.wasm)) : ok(n);
  }

  sweepPolyline(options: {
    readonly profile: readonly (readonly [number, number])[];
    readonly path: readonly (readonly [number, number, number])[];
    readonly caps?: boolean;
    readonly sharpAngle?: number;
    readonly up?: readonly [number, number, number];
    readonly label?: number;
    readonly material?: number;
    readonly tag?: number;
  }): KernelResult<number> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const profF64 = options.profile.length * 2;
    const pathF64 = options.path.length * 3;
    const base = this.wasm.mk_scratch_ensure((profF64 + pathF64) * 8 + 16);
    const aligned = (base + 7) & ~7;
    const profView = new Float64Array(this.wasm.memory.buffer, aligned, profF64);
    for (let i = 0; i < options.profile.length; i++) {
      const p = options.profile[i];
      profView[i * 2] = p?.[0] ?? 0;
      profView[i * 2 + 1] = p?.[1] ?? 0;
    }
    const pathPtr = aligned + profF64 * 8;
    const pathView = new Float64Array(this.wasm.memory.buffer, pathPtr, pathF64);
    for (let i = 0; i < options.path.length; i++) {
      const p = options.path[i];
      pathView[i * 3] = p?.[0] ?? 0;
      pathView[i * 3 + 1] = p?.[1] ?? 0;
      pathView[i * 3 + 2] = p?.[2] ?? 0;
    }
    const [ux, uy, uz] = options.up ?? [0, 1, 0];
    const n = this.wasm.mk_mesh_sweep_polyline(
      this.handle,
      aligned,
      options.profile.length,
      pathPtr,
      options.path.length,
      options.caps === false ? 0 : 1,
      options.sharpAngle ?? 40,
      ux,
      uy,
      uz,
      options.label ?? 0,
      options.material ?? 0,
      options.tag ?? -1,
    );
    this.trackBuffer();
    return n < 0 ? err(readLastError(this.wasm)) : ok(n);
  }

  panelLinePlane(
    faces: ArrayLike<number>,
    options: {
      readonly point: readonly [number, number, number];
      readonly normal: readonly [number, number, number];
      readonly width: number;
      readonly depth: number;
      readonly material?: number;
      readonly label?: number;
      readonly tag?: number;
      readonly tolerance?: number;
    },
  ): KernelResult<number> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const ptr = writeI32Scratch(this.wasm, faces);
    const [px, py, pz] = options.point;
    const [nx, ny, nz] = options.normal;
    const n = this.wasm.mk_mesh_panel_line_plane(
      this.handle,
      ptr,
      faces.length,
      px,
      py,
      pz,
      nx,
      ny,
      nz,
      options.width,
      options.depth,
      options.material ?? -1,
      options.label ?? 0,
      options.tag ?? -1,
      options.tolerance ?? 1e-5,
    );
    this.trackBuffer();
    return n < 0 ? err(readLastError(this.wasm)) : ok(n);
  }

  bevel(
    edges: ArrayLike<number>,
    options: {
      readonly width: number;
      readonly segments: number;
      readonly material?: number;
      readonly label?: number;
      readonly tag?: number;
    },
  ): KernelResult<{ readonly bevel: number; readonly corner: number }> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const edgeBytes = edges.length * 4;
    const base = this.wasm.mk_scratch_ensure(8 + edgeBytes);
    const edgesPtr = base + 8;
    const view = new Int32Array(this.wasm.memory.buffer, edgesPtr, edges.length);
    for (let i = 0; i < edges.length; i++) view[i] = edges[i] ?? 0;
    const rc = this.wasm.mk_mesh_bevel(
      this.handle,
      edgesPtr,
      edges.length,
      options.width,
      options.segments,
      options.material ?? -1,
      options.label ?? 0,
      options.tag ?? -1,
      base,
    );
    this.trackBuffer();
    if (rc !== 0) return err(readLastError(this.wasm));
    const counts = new Uint32Array(this.wasm.memory.buffer, base, 2);
    return ok({ bevel: counts[0] ?? 0, corner: counts[1] ?? 0 });
  }

  booleanOp(
    tool: RustEditMesh,
    op: 'union' | 'difference' | 'intersection',
    eps = 1e-5,
  ): KernelResult<number> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    if (tool.isDisposed) {
      return err(new KernelError('kernel-invalid-handle', 'tool', 'tool EditMesh is disposed'));
    }
    const opId = op === 'union' ? 0 : op === 'difference' ? 1 : 2;
    const n = this.wasm.mk_mesh_boolean(this.handle, tool.handle, opId, eps);
    this.trackBuffer();
    this.memoryGeneration++;
    return n < 0 ? err(readLastError(this.wasm)) : ok(n);
  }

  autoUv(
    faces: ArrayLike<number>,
    options: {
      readonly maxNormalDeviation?: number;
      readonly respectSharp?: boolean;
      readonly resolution: number;
      readonly paddingTexels: number;
      readonly rotate?: boolean;
      readonly channel?: 'uv0' | 'uv1';
    },
  ): KernelResult<number> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const ptr = writeI32Scratch(this.wasm, faces);
    const chId = options.channel === 'uv1' ? 1 : 0;
    const charts = this.wasm.mk_mesh_uv_auto(
      this.handle,
      ptr,
      faces.length,
      options.maxNormalDeviation ?? 45,
      options.respectSharp === false ? 0 : 1,
      options.resolution,
      options.paddingTexels,
      options.rotate === false ? 0 : 1,
      chId,
    );
    this.trackBuffer();
    return charts < 0 ? err(readLastError(this.wasm)) : ok(charts);
  }

  private readBuiltChannels(channelCount: number): RawAttributeChannels | undefined {
    if (channelCount === 0) return undefined;
    const channels: RawAttributeChannels = {};
    const chPtr = this.wasm.mk_scratch_ensure(16);
    for (let i = 0; i < channelCount; i++) {
      this.wasm.mk_mesh_built_channel_meta(this.handle, i, chPtr);
      const chMeta = new Uint32Array(this.wasm.memory.buffer, chPtr, 4);
      const key = CANONICAL_ATTRIBUTE_KEYS[chMeta[0] ?? 0] as AttributeKey;
      const fmt = ATTRIBUTE_FORMATS[chMeta[1] ?? 0] as AttributeFormat;
      const Ctor = formatArrayCtor(fmt);
      const copied = new Uint8Array(
        this.wasm.memory.buffer,
        chMeta[2] ?? 0,
        chMeta[3] ?? 0,
      ).slice();
      channels[key] = new Ctor(copied.buffer);
    }
    return channels;
  }

  private readBuiltLayout(): VertexLayoutDeclaration[] {
    const layoutLen = this.wasm.mk_mesh_built_layout_len(this.handle);
    const layout: VertexLayoutDeclaration[] = [];
    const lPtr = this.wasm.mk_scratch_ensure(8);
    for (let i = 0; i < layoutLen; i++) {
      this.wasm.mk_mesh_built_layout_entry(this.handle, i, lPtr);
      const entry = new Uint32Array(this.wasm.memory.buffer, lPtr, 2);
      layout.push({
        key: CANONICAL_ATTRIBUTE_KEYS[entry[0] ?? 0] as AttributeKey,
        format: ATTRIBUTE_FORMATS[entry[1] ?? 0] as AttributeFormat,
      });
    }
    return layout;
  }

  private readBuiltSubmeshes(submeshCount: number): RawSubmesh[] {
    const submeshes: RawSubmesh[] = [];
    const sPtr = this.wasm.mk_scratch_ensure(20);
    for (let i = 0; i < submeshCount; i++) {
      this.wasm.mk_mesh_built_submesh_meta(this.handle, i, sPtr);
      const sub = new Uint32Array(this.wasm.memory.buffer, sPtr, 5);
      submeshes.push(
        Object.freeze({
          indexOffset: sub[0] ?? 0,
          indexCount: sub[1] ?? 0,
          vertexCount: sub[2] ?? 0,
          topology: PRIMITIVE_TOPOLOGIES[sub[3] ?? 3] as PrimitiveTopology,
          materialSlot: sub[4] ?? 0,
        }),
      );
    }
    return submeshes;
  }

  private readBuiltIndices(
    indexKind: number,
    indexPtr: number,
    indexCount: number,
  ): Uint16Array | Uint32Array | undefined {
    if (indexKind === 1) {
      return new Uint16Array(this.wasm.memory.buffer, indexPtr, indexCount).slice();
    }
    if (indexKind === 2) {
      return new Uint32Array(this.wasm.memory.buffer, indexPtr, indexCount).slice();
    }
    return undefined;
  }

  /** Export directly to engine-agnostic `RawMeshData` (zero FXEM round-trip). */
  toRawMeshData(outputMode: OutputMode = 'interleaved'): KernelResult<RawMeshData> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const status = this.wasm.mk_mesh_build_render(this.handle, outputModeId(outputMode));
    this.trackBuffer();
    if (status !== 0) return err(readLastError(this.wasm));

    const metaPtr = this.wasm.mk_scratch_ensure(64);
    if (this.wasm.mk_mesh_built_meta(this.handle, metaPtr) !== 0) {
      return err(readLastError(this.wasm));
    }
    const metaU32 = new Uint32Array(this.wasm.memory.buffer, metaPtr, 16);
    const vertexCount = metaU32[0] ?? 0;
    const arrayStride = metaU32[1] ?? 0;
    const layoutMask = metaU32[2] ?? 0;
    const interleavedPtr = metaU32[3] ?? 0;
    const interleavedByteLen = metaU32[4] ?? 0;
    const indexKind = metaU32[5] ?? 0;
    const indexPtr = metaU32[6] ?? 0;
    const indexCount = metaU32[7] ?? 0;
    const channelCount = metaU32[8] ?? 0;
    const submeshCount = metaU32[9] ?? 0;
    const aabb = new Float32Array(this.wasm.memory.buffer, metaPtr + 40, 6).slice();
    const interleaved =
      interleavedByteLen > 0
        ? new Float32Array(
            new Uint8Array(this.wasm.memory.buffer, interleavedPtr, interleavedByteLen).slice()
              .buffer,
          )
        : undefined;
    const indices = this.readBuiltIndices(indexKind, indexPtr, indexCount);
    const channels = this.readBuiltChannels(channelCount);
    const layout = this.readBuiltLayout();
    const submeshes = this.readBuiltSubmeshes(submeshCount);

    return ok(
      Object.freeze({
        backend: 'rust' as const,
        outputMode,
        vertexCount,
        arrayStride,
        layoutMask,
        layout: Object.freeze(layout),
        ...(interleaved === undefined ? {} : { interleaved }),
        ...(channels === undefined ? {} : { channels }),
        ...(indices === undefined ? {} : { indices }),
        submeshes: Object.freeze(submeshes),
        materialSlotNames: Object.freeze(['Default']),
        aabb,
      }),
    );
  }

  clone(): KernelResult<RustEditMesh> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    const h = this.wasm.mk_mesh_clone(this.handle);
    this.trackBuffer();
    if (h === 0n) return err(readLastError(this.wasm));
    return ok(new RustEditMesh(this.wasm, h));
  }

  assignFrom(source: RustEditMesh): KernelResult<void> {
    const alive = this.checkAlive();
    if (!alive.ok) return alive;
    if (source.isDisposed) {
      return err(new KernelError('kernel-invalid-handle', 'source', 'source EditMesh is disposed'));
    }
    const status = this.wasm.mk_mesh_assign(this.handle, source.handle);
    this.trackBuffer();
    this.memoryGeneration++;
    return status === 0 ? ok(undefined) : err(readLastError(this.wasm));
  }

  dispose(): void {
    if (this.isDisposedState) return;
    this.isDisposedState = true;
    meshLeakRegistry?.unregister(this.unregisterToken);
    this.wasm.mk_mesh_dispose(this.handle);
    this.handle = 0n;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Create a retained Rust WASM `EditMesh`. Fails closed if WASM has not been initialized. */
export function createRustEditMesh(): KernelResult<RustEditMesh> {
  const wasm = getModelingKernelWasm();
  if (wasm === undefined) {
    return err(
      new KernelError(
        'kernel-capability-unavailable',
        'backend',
        'Rust WASM modeling kernel is not initialized; call initModelingKernelWasmSync() first',
      ),
    );
  }
  const handle = wasm.mk_mesh_create();
  if (handle === 0n) return err(readLastError(wasm));
  return ok(new RustEditMesh(wasm, handle));
}

/** Number of currently live Rust WASM EditMesh handles (for leak detection in tests). */
export function liveRustMeshCount(): number {
  return getModelingKernelWasm()?.mk_live_meshes() ?? 0;
}
