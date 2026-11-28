import {
  getModelingKernelWasm,
  type ModelingKernelWasmExports,
} from '@forgeax/modeling-kernel-wasm';
import {
  ATTRIBUTE_FORMATS,
  type AttributeFormat,
  type AttributeKey,
  type AttributeTypedArray,
  CANONICAL_ATTRIBUTE_KEYS,
  defaultFormatForKey,
  formatArrayCtor,
  formatByteLength,
  formatComponentCount,
  inferAttributeFormat,
  type KernelBackendPolicy,
  type OutputMode,
  PRIMITIVE_TOPOLOGIES,
  type PrimitiveTopology,
  type RawAttributeChannels,
  type RawMeshData,
  type RawSubmesh,
  type VertexLayoutDeclaration,
} from './layout';
import { err, errorCodeFromId, KernelError, type KernelResult, ok } from './result';

const textDecoder = new TextDecoder();

function readLastWasmError(wasm: ModelingKernelWasmExports): KernelError {
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

const builderLeakRegistry =
  typeof FinalizationRegistry !== 'undefined'
    ? new FinalizationRegistry<{ wasm: ModelingKernelWasmExports; handle: bigint }>((entry) => {
        entry.wasm.mk_builder_dispose(entry.handle);
      })
    : undefined;

export interface KernelSubmeshInput {
  readonly indexOffset?: number;
  readonly indexCount?: number;
  readonly vertexCount?: number;
  readonly topology?: PrimitiveTopology;
  readonly materialSlot?: number;
}

export interface KernelMeshSection {
  readonly materialSlot: number;
  readonly attributes?: RawAttributeChannels;
  readonly indices?: ArrayLike<number>;
}

export interface KernelMeshBuilderOptions {
  /** Attribute channels to pre-allocate in zero-copy staging buffers. */
  readonly layout: readonly (AttributeKey | VertexLayoutDeclaration)[];
  readonly materialSlotNames?: readonly string[];
  readonly vertexCapacity?: number;
  readonly indexCapacity?: number;
  readonly backend?: KernelBackendPolicy;
}

export interface KernelMeshSectionsOptions {
  readonly sections: readonly KernelMeshSection[];
  readonly materialSlotNames?: readonly string[];
  readonly backend?: KernelBackendPolicy;
}

export interface KernelBuildOptions {
  readonly outputMode?: OutputMode;
  /** Release the retained staging handle automatically after build (default false). */
  readonly dispose?: boolean;
}

export interface AllocatedVertexViews {
  readonly baseVertex: number;
  readonly count: number;
  readonly channels: Readonly<RawAttributeChannels>;
}

export interface AllocatedIndexView {
  readonly indexOffset: number;
  readonly indices: Uint32Array;
}

/**
 * Zero-copy staging MeshBuilder backed by either the Rust WASM linear memory
 * arena or a pure TS staging implementation (`backend: 'auto' | 'rust' | 'ts'`).
 */
export interface KernelMeshBuilder {
  readonly backend: 'rust' | 'ts';
  readonly disposed: boolean;
  /** Reserve `count` contiguous vertices in linear memory and return direct writable views. */
  allocateVertices(count: number): KernelResult<AllocatedVertexViews>;
  /** Reserve `count` u32 indices in linear memory and return a direct writable Uint32Array view. */
  allocateIndices(count: number): KernelResult<AllocatedIndexView>;
  /** Validate and rebase section-local indices in place inside staging memory. */
  rebaseSectionIndices(
    indexOffset: number,
    indexCount: number,
    baseVertex: number,
    localVertexCount: number,
    sectionIndex: number,
  ): KernelResult<void>;
  /** Register one draw range. */
  addSubmesh(submesh: KernelSubmeshInput): KernelResult<void>;
  /** Validate, complete stock normals/uv/tangents, pack, and emit RawMeshData. */
  build(options?: KernelBuildOptions): KernelResult<RawMeshData>;
  dispose(): void;
  [Symbol.dispose](): void;
}

function normalizeDeclarations(
  layout: readonly (AttributeKey | VertexLayoutDeclaration)[],
): KernelResult<VertexLayoutDeclaration[]> {
  if (layout.length === 0) {
    return err(
      new KernelError('kernel-invalid-value', 'layout', 'at least one attribute is required'),
    );
  }
  const seen = new Set<AttributeKey>();
  const out: VertexLayoutDeclaration[] = [];
  for (const item of layout) {
    const key = typeof item === 'string' ? item : item.key;
    const format = typeof item === 'string' ? defaultFormatForKey(item) : item.format;
    if (!CANONICAL_ATTRIBUTE_KEYS.includes(key)) {
      return err(new KernelError('kernel-invalid-value', 'layout', `unknown attribute key ${key}`));
    }
    if (seen.has(key)) {
      return err(new KernelError('kernel-invalid-value', key, 'duplicate attribute key'));
    }
    seen.add(key);
    out.push({ key, format });
  }
  out.sort(
    (a, b) => CANONICAL_ATTRIBUTE_KEYS.indexOf(a.key) - CANONICAL_ATTRIBUTE_KEYS.indexOf(b.key),
  );
  if (!seen.has('position')) {
    return err(
      new KernelError('kernel-invalid-value', 'attributes.position', 'position is required'),
    );
  }
  return ok(out);
}

function validateMaterialSlots(names: readonly string[] | undefined): KernelResult<string[]> {
  const slots = names === undefined ? ['Default'] : [...names];
  if (slots.length === 0) {
    return err(
      new KernelError(
        'kernel-invalid-value',
        'materialSlots',
        'at least one material slot is required',
      ),
    );
  }
  const seen = new Set<string>();
  for (let i = 0; i < slots.length; i++) {
    const trimmed = slots[i]?.trim() ?? '';
    if (trimmed.length === 0 || seen.has(trimmed)) {
      return err(
        new KernelError(
          'kernel-invalid-value',
          `materialSlots[${i}]`,
          'must be non-empty and unique',
        ),
      );
    }
    seen.add(trimmed);
  }
  return ok(slots);
}

function outputModeCode(mode: OutputMode): number {
  return mode === 'separate' ? 0 : mode === 'interleaved' ? 1 : 2;
}

// ---- Rust WASM zero-copy builder ----------------------------------------------------------

class RustKernelMeshBuilder implements KernelMeshBuilder {
  readonly backend = 'rust' as const;
  private handle: bigint;
  private isDisposed = false;
  private readonly unregisterToken = {};

  constructor(
    private readonly wasm: ModelingKernelWasmExports,
    private readonly declarations: readonly VertexLayoutDeclaration[],
    private readonly materialSlotNames: readonly string[],
    handle: bigint,
  ) {
    this.handle = handle;
    builderLeakRegistry?.register(this, { wasm, handle }, this.unregisterToken);
  }

  get disposed(): boolean {
    return this.isDisposed;
  }

  allocateVertices(count: number): KernelResult<AllocatedVertexViews> {
    if (this.isDisposed) {
      return err(new KernelError('kernel-invalid-handle', 'handle', 'builder has been disposed'));
    }
    if (!Number.isInteger(count) || count <= 0) {
      return err(
        new KernelError(
          'kernel-invalid-value',
          'attributes.position',
          'count must be an integer > 0',
        ),
      );
    }
    const scratchPtr = this.wasm.mk_scratch_ensure(this.declarations.length * 4);
    const baseVertex = this.wasm.mk_builder_alloc_verts(this.handle, count, scratchPtr);
    if (baseVertex < 0) return err(readLastWasmError(this.wasm));

    // Re-read memory.buffer AFTER allocation in case WASM memory grew.
    const ptrs = new Uint32Array(this.wasm.memory.buffer, scratchPtr, this.declarations.length);
    const channels: RawAttributeChannels = {};
    for (let i = 0; i < this.declarations.length; i++) {
      const decl = this.declarations[i] as VertexLayoutDeclaration;
      const ptr = ptrs[i] as number;
      const Ctor = formatArrayCtor(decl.format);
      const elemCount = count * formatComponentCount(decl.format);
      channels[decl.key] = new Ctor(this.wasm.memory.buffer, ptr, elemCount);
    }
    return ok({ baseVertex, count, channels });
  }

  allocateIndices(count: number): KernelResult<AllocatedIndexView> {
    if (this.isDisposed) {
      return err(new KernelError('kernel-invalid-handle', 'handle', 'builder has been disposed'));
    }
    if (!Number.isInteger(count) || count < 0) {
      return err(
        new KernelError('kernel-invalid-value', 'indices', 'count must be an integer >= 0'),
      );
    }
    const scratchPtr = this.wasm.mk_scratch_ensure(4);
    const indexOffset = this.wasm.mk_builder_alloc_indices(this.handle, count, scratchPtr);
    if (indexOffset < 0) return err(readLastWasmError(this.wasm));
    const ptr = new Uint32Array(this.wasm.memory.buffer, scratchPtr, 1)[0] as number;
    const indices = new Uint32Array(this.wasm.memory.buffer, ptr, count);
    return ok({ indexOffset, indices });
  }

  rebaseSectionIndices(
    indexOffset: number,
    indexCount: number,
    baseVertex: number,
    localVertexCount: number,
    sectionIndex: number,
  ): KernelResult<void> {
    if (this.isDisposed) {
      return err(new KernelError('kernel-invalid-handle', 'handle', 'builder has been disposed'));
    }
    const status = this.wasm.mk_builder_rebase_section(
      this.handle,
      indexOffset,
      indexCount,
      baseVertex,
      localVertexCount,
      sectionIndex,
    );
    return status === 0 ? ok(undefined) : err(readLastWasmError(this.wasm));
  }

  addSubmesh(submesh: KernelSubmeshInput): KernelResult<void> {
    if (this.isDisposed) {
      return err(new KernelError('kernel-invalid-handle', 'handle', 'builder has been disposed'));
    }
    const topology = submesh.topology ?? 'triangle-list';
    const topoId = PRIMITIVE_TOPOLOGIES.indexOf(topology);
    if (topoId < 0) {
      return err(
        new KernelError('kernel-invalid-value', 'submeshes.topology', 'invalid primitive topology'),
      );
    }
    const flags =
      (submesh.indexOffset !== undefined ? 1 : 0) |
      (submesh.indexCount !== undefined ? 2 : 0) |
      (submesh.vertexCount !== undefined ? 4 : 0) |
      (submesh.materialSlot !== undefined ? 8 : 0);
    const status = this.wasm.mk_builder_add_submesh(
      this.handle,
      flags,
      submesh.indexOffset ?? 0,
      submesh.indexCount ?? 0,
      submesh.vertexCount ?? 0,
      topoId,
      submesh.materialSlot ?? 0,
    );
    return status === 0 ? ok(undefined) : err(readLastWasmError(this.wasm));
  }

  build(options: KernelBuildOptions = {}): KernelResult<RawMeshData> {
    if (this.isDisposed) {
      return err(new KernelError('kernel-invalid-handle', 'handle', 'builder has been disposed'));
    }
    const outputMode = options.outputMode ?? 'interleaved';
    const status = this.wasm.mk_builder_build(this.handle, outputModeCode(outputMode));
    if (status !== 0) return err(readLastWasmError(this.wasm));

    const metaPtr = this.wasm.mk_scratch_ensure(64);
    if (this.wasm.mk_builder_built_meta(this.handle, metaPtr) !== 0) {
      return err(readLastWasmError(this.wasm));
    }
    const metaU32 = new Uint32Array(this.wasm.memory.buffer, metaPtr, 16);
    const metaF32 = new Float32Array(this.wasm.memory.buffer, metaPtr + 40, 6);
    const vertexCount = metaU32[0] as number;
    const arrayStride = metaU32[1] as number;
    const layoutMask = metaU32[2] as number;
    const interleavedPtr = metaU32[3] as number;
    const interleavedByteLen = metaU32[4] as number;
    const indexKind = metaU32[5] as number;
    const indexPtr = metaU32[6] as number;
    const indexCount = metaU32[7] as number;
    const channelCount = metaU32[8] as number;
    const submeshCount = metaU32[9] as number;
    const aabb = metaF32.slice();

    // Copy final owned outputs out of WASM linear memory once (safe against future memory.grow).
    let interleaved: Float32Array | undefined;
    if (interleavedByteLen > 0) {
      const bytes = new Uint8Array(
        this.wasm.memory.buffer,
        interleavedPtr,
        interleavedByteLen,
      ).slice();
      interleaved = new Float32Array(bytes.buffer);
    }

    let indices: Uint16Array | Uint32Array | undefined;
    if (indexKind === 1) {
      indices = new Uint16Array(this.wasm.memory.buffer, indexPtr, indexCount).slice();
    } else if (indexKind === 2) {
      indices = new Uint32Array(this.wasm.memory.buffer, indexPtr, indexCount).slice();
    }

    let channels: RawAttributeChannels | undefined;
    if (channelCount > 0) {
      channels = {};
      const chPtr = this.wasm.mk_scratch_ensure(16);
      for (let i = 0; i < channelCount; i++) {
        this.wasm.mk_builder_built_channel_meta(this.handle, i, chPtr);
        const chMeta = new Uint32Array(this.wasm.memory.buffer, chPtr, 4);
        const key = CANONICAL_ATTRIBUTE_KEYS[chMeta[0] as number] as AttributeKey;
        const fmt = ATTRIBUTE_FORMATS[chMeta[1] as number] as AttributeFormat;
        const ptr = chMeta[2] as number;
        const byteLen = chMeta[3] as number;
        const Ctor = formatArrayCtor(fmt);
        const copied = new Uint8Array(this.wasm.memory.buffer, ptr, byteLen).slice();
        channels[key] = new Ctor(copied.buffer);
      }
    }

    const layoutLen = this.wasm.mk_builder_built_layout_len(this.handle);
    const layout: VertexLayoutDeclaration[] = [];
    const lPtr = this.wasm.mk_scratch_ensure(8);
    for (let i = 0; i < layoutLen; i++) {
      this.wasm.mk_builder_built_layout_entry(this.handle, i, lPtr);
      const entry = new Uint32Array(this.wasm.memory.buffer, lPtr, 2);
      layout.push({
        key: CANONICAL_ATTRIBUTE_KEYS[entry[0] as number] as AttributeKey,
        format: ATTRIBUTE_FORMATS[entry[1] as number] as AttributeFormat,
      });
    }

    const submeshes: RawSubmesh[] = [];
    const sPtr = this.wasm.mk_scratch_ensure(20);
    for (let i = 0; i < submeshCount; i++) {
      this.wasm.mk_builder_built_submesh_meta(this.handle, i, sPtr);
      const sub = new Uint32Array(this.wasm.memory.buffer, sPtr, 5);
      submeshes.push(
        Object.freeze({
          indexOffset: sub[0] as number,
          indexCount: sub[1] as number,
          vertexCount: sub[2] as number,
          topology: PRIMITIVE_TOPOLOGIES[sub[3] as number] as PrimitiveTopology,
          materialSlot: sub[4] as number,
        }),
      );
    }

    if (options.dispose === true) this.dispose();

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
        materialSlotNames: Object.freeze([...this.materialSlotNames]),
        aabb,
      }),
    );
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    builderLeakRegistry?.unregister(this.unregisterToken);
    this.wasm.mk_builder_dispose(this.handle);
    this.handle = 0n;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

// ---- Pure TS switchable fallback builder (matching exact Rust semantics) ------------------

function growBytes(buf: Uint8Array, required: number): Uint8Array {
  if (buf.byteLength >= required) return buf;
  let cap = Math.max(64, buf.byteLength);
  while (cap < required) cap *= 2;
  const next = new Uint8Array(cap);
  next.set(buf);
  return next;
}

function accumulateTriangleNormal(
  positions: Float32Array,
  normals: Float32Array,
  a: number,
  b: number,
  c: number,
): void {
  const ax = positions[a] as number;
  const ay = positions[a + 1] as number;
  const az = positions[a + 2] as number;
  const e1x = (positions[b] as number) - ax;
  const e1y = (positions[b + 1] as number) - ay;
  const e1z = (positions[b + 2] as number) - az;
  const e2x = (positions[c] as number) - ax;
  const e2y = (positions[c + 1] as number) - ay;
  const e2z = (positions[c + 2] as number) - az;
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  for (const o of [a, b, c]) {
    normals[o] = (normals[o] as number) + nx;
    normals[o + 1] = (normals[o + 1] as number) + ny;
    normals[o + 2] = (normals[o + 2] as number) + nz;
  }
}

function areaWeightedNormalsTs(positions: Float32Array, tris: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let k = 0; k + 2 < tris.length; k += 3) {
    accumulateTriangleNormal(
      positions,
      normals,
      (tris[k] as number) * 3,
      (tris[k + 1] as number) * 3,
      (tris[k + 2] as number) * 3,
    );
  }
  for (let o = 0; o < normals.length; o += 3) {
    const x = normals[o] as number;
    const y = normals[o + 1] as number;
    const z = normals[o + 2] as number;
    const len = Math.hypot(x, y, z);
    if (len > 1e-12 && Number.isFinite(len)) {
      normals[o] = x / len;
      normals[o + 1] = y / len;
      normals[o + 2] = z / len;
    } else {
      normals[o] = 0;
      normals[o + 1] = 0;
      normals[o + 2] = 1;
    }
  }
  return normals;
}

function orthogonalUnitAxis(nx: number, ny: number, nz: number): readonly [number, number, number] {
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  let rx = 1;
  let ry = 0;
  let rz = 0;
  if (ax > ay && ax > az) {
    rx = 0;
    ry = 1;
  } else if (ay > ax && ay > az) {
    rx = 0;
    rz = 1;
  }
  const ox = ny * rz - nz * ry;
  const oy = nz * rx - nx * rz;
  const oz = nx * ry - ny * rx;
  const l = Math.hypot(ox, oy, oz) || 1;
  return [ox / l, oy / l, oz / l];
}

function accumulateTriangleTangents(
  positions: Float32Array,
  uvs: Float32Array,
  tris: Uint32Array,
  accumT: Float32Array,
  accumSign: Float32Array,
): number {
  let valid = 0;
  for (let k = 0; k + 2 < tris.length; k += 3) {
    const i0 = tris[k] as number;
    const i1 = tris[k + 1] as number;
    const i2 = tris[k + 2] as number;
    const p0x = positions[i0 * 3] as number;
    const p0y = positions[i0 * 3 + 1] as number;
    const p0z = positions[i0 * 3 + 2] as number;
    const dp1x = (positions[i1 * 3] as number) - p0x;
    const dp1y = (positions[i1 * 3 + 1] as number) - p0y;
    const dp1z = (positions[i1 * 3 + 2] as number) - p0z;
    const dp2x = (positions[i2 * 3] as number) - p0x;
    const dp2y = (positions[i2 * 3 + 1] as number) - p0y;
    const dp2z = (positions[i2 * 3 + 2] as number) - p0z;
    const du1 = (uvs[i1 * 2] as number) - (uvs[i0 * 2] as number);
    const dv1 = (uvs[i1 * 2 + 1] as number) - (uvs[i0 * 2 + 1] as number);
    const du2 = (uvs[i2 * 2] as number) - (uvs[i0 * 2] as number);
    const dv2 = (uvs[i2 * 2 + 1] as number) - (uvs[i0 * 2 + 1] as number);
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-8) continue;
    const cx = dp1y * dp2z - dp1z * dp2y;
    const cy = dp1z * dp2x - dp1x * dp2z;
    const cz = dp1x * dp2y - dp1y * dp2x;
    const area = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
    if (area < 1e-8) continue;
    valid++;
    const inv = 1 / det;
    const tx = inv * (dv2 * dp1x - dv1 * dp2x) * area;
    const ty = inv * (dv2 * dp1y - dv1 * dp2y) * area;
    const tz = inv * (dv2 * dp1z - dv1 * dp2z) * area;
    const sw = area * (det >= 0 ? 1 : -1);
    for (const v of [i0, i1, i2]) {
      accumT[v * 3] = (accumT[v * 3] as number) + tx;
      accumT[v * 3 + 1] = (accumT[v * 3 + 1] as number) + ty;
      accumT[v * 3 + 2] = (accumT[v * 3 + 2] as number) + tz;
      accumSign[v] = (accumSign[v] as number) + sw;
    }
  }
  return valid;
}

function fallbackTangentsFromNormals(normals: Float32Array, vcount: number): Float32Array {
  const out = new Float32Array(vcount * 4);
  for (let v = 0; v < vcount; v++) {
    const nx = normals[v * 3] as number;
    const ny = normals[v * 3 + 1] as number;
    const nz = normals[v * 3 + 2] as number;
    const useX = Math.abs(nx) > Math.abs(nz);
    const tx = useX ? -ny : 0;
    const ty = useX ? nx : -nz;
    const tz = useX ? 0 : ny;
    const l = Math.hypot(tx, ty, tz) || 1;
    out[v * 4] = tx / l;
    out[v * 4 + 1] = ty / l;
    out[v * 4 + 2] = tz / l;
    out[v * 4 + 3] = 1;
  }
  return out;
}

function computeTangentsTs(
  positions: Float32Array,
  normals: Float32Array,
  uvs: Float32Array,
  tris: Uint32Array,
): Float32Array {
  const vcount = positions.length / 3;
  const accumT = new Float32Array(vcount * 3);
  const accumSign = new Float32Array(vcount);
  const valid = accumulateTriangleTangents(positions, uvs, tris, accumT, accumSign);
  if (valid === 0) return fallbackTangentsFromNormals(normals, vcount);

  const out = new Float32Array(vcount * 4);
  for (let v = 0; v < vcount; v++) {
    const nx = normals[v * 3] as number;
    const ny = normals[v * 3 + 1] as number;
    const nz = normals[v * 3 + 2] as number;
    let tx = accumT[v * 3] as number;
    let ty = accumT[v * 3 + 1] as number;
    let tz = accumT[v * 3 + 2] as number;
    const tLen = Math.hypot(tx, ty, tz);
    if (tLen < 1e-8) {
      [tx, ty, tz] = orthogonalUnitAxis(nx, ny, nz);
    } else {
      tx /= tLen;
      ty /= tLen;
      tz /= tLen;
    }
    const d = tx * nx + ty * ny + tz * nz;
    let gx = tx - d * nx;
    let gy = ty - d * ny;
    let gz = tz - d * nz;
    const gl = Math.hypot(gx, gy, gz);
    if (gl < 1e-8) {
      [gx, gy, gz] = orthogonalUnitAxis(nx, ny, nz);
    } else {
      gx /= gl;
      gy /= gl;
      gz /= gl;
    }
    out[v * 4] = gx;
    out[v * 4 + 1] = gy;
    out[v * 4 + 2] = gz;
    out[v * 4 + 3] = (accumSign[v] as number) >= 0 ? 1 : -1;
  }
  return out;
}

class TsKernelMeshBuilder implements KernelMeshBuilder {
  readonly backend = 'ts' as const;
  private isDisposed = false;
  private vertexCount = 0;
  private indexCount = 0;
  private readonly buffers: Map<AttributeKey, { format: AttributeFormat; bytes: Uint8Array }>;
  private indexBuf: Uint32Array;
  private readonly submeshes: KernelSubmeshInput[] = [];

  constructor(
    private readonly declarations: readonly VertexLayoutDeclaration[],
    private readonly materialSlotNames: readonly string[],
    vertexCapacity: number,
    indexCapacity: number,
  ) {
    this.buffers = new Map();
    for (const d of declarations) {
      this.buffers.set(d.key, {
        format: d.format,
        bytes: new Uint8Array(Math.max(16, vertexCapacity) * formatByteLength(d.format)),
      });
    }
    this.indexBuf = new Uint32Array(Math.max(16, indexCapacity));
  }

  get disposed(): boolean {
    return this.isDisposed;
  }

  allocateVertices(count: number): KernelResult<AllocatedVertexViews> {
    if (this.isDisposed) {
      return err(new KernelError('kernel-invalid-handle', 'handle', 'builder has been disposed'));
    }
    if (!Number.isInteger(count) || count <= 0) {
      return err(
        new KernelError(
          'kernel-invalid-value',
          'attributes.position',
          'count must be an integer > 0',
        ),
      );
    }
    const baseVertex = this.vertexCount;
    const next = baseVertex + count;
    const channels: RawAttributeChannels = {};
    for (const d of this.declarations) {
      const entry = this.buffers.get(d.key);
      if (entry === undefined) continue;
      const bLen = formatByteLength(d.format);
      entry.bytes = growBytes(entry.bytes, next * bLen);
      const Ctor = formatArrayCtor(d.format);
      channels[d.key] = new Ctor(
        entry.bytes.buffer,
        baseVertex * bLen,
        count * formatComponentCount(d.format),
      );
    }
    this.vertexCount = next;
    return ok({ baseVertex, count, channels });
  }

  allocateIndices(count: number): KernelResult<AllocatedIndexView> {
    if (this.isDisposed) {
      return err(new KernelError('kernel-invalid-handle', 'handle', 'builder has been disposed'));
    }
    if (!Number.isInteger(count) || count < 0) {
      return err(
        new KernelError('kernel-invalid-value', 'indices', 'count must be an integer >= 0'),
      );
    }
    const indexOffset = this.indexCount;
    const next = indexOffset + count;
    if (this.indexBuf.length < next) {
      let cap = Math.max(16, this.indexBuf.length);
      while (cap < next) cap *= 2;
      const grown = new Uint32Array(cap);
      grown.set(this.indexBuf.subarray(0, this.indexCount));
      this.indexBuf = grown;
    }
    this.indexCount = next;
    return ok({ indexOffset, indices: this.indexBuf.subarray(indexOffset, next) });
  }

  rebaseSectionIndices(
    indexOffset: number,
    indexCount: number,
    baseVertex: number,
    localVertexCount: number,
    sectionIndex: number,
  ): KernelResult<void> {
    if (this.isDisposed) {
      return err(new KernelError('kernel-invalid-handle', 'handle', 'builder has been disposed'));
    }
    for (let i = 0; i < indexCount; i++) {
      const v = this.indexBuf[indexOffset + i] as number;
      if (v >= localVertexCount) {
        return err(
          new KernelError(
            'kernel-invalid-value',
            `sections[${sectionIndex}].indices[${i}]`,
            `must reference one of this section's ${localVertexCount} vertices`,
          ),
        );
      }
      this.indexBuf[indexOffset + i] = v + baseVertex;
    }
    return ok(undefined);
  }

  addSubmesh(submesh: KernelSubmeshInput): KernelResult<void> {
    if (this.isDisposed) {
      return err(new KernelError('kernel-invalid-handle', 'handle', 'builder has been disposed'));
    }
    this.submeshes.push({ ...submesh });
    return ok(undefined);
  }

  private validateIndices(activeIndices: Uint32Array, vcount: number): KernelResult<number> {
    let maxIdx = 0;
    for (let i = 0; i < this.indexCount; i++) {
      const idx = activeIndices[i] as number;
      if (idx >= vcount) {
        return err(
          new KernelError(
            'kernel-invalid-value',
            'indices',
            `indices[${i}] must be less than vertexCount (${vcount})`,
          ),
        );
      }
      if (idx > maxIdx) maxIdx = idx;
    }
    return ok(maxIdx);
  }

  private hasValidSubmeshNumbers(
    indexOffset: number,
    subIndexCount: number,
    subVertexCount: number,
    materialSlot: number,
    vcount: number,
  ): boolean {
    const intsOk =
      Number.isInteger(indexOffset) &&
      Number.isInteger(subIndexCount) &&
      Number.isInteger(subVertexCount) &&
      Number.isInteger(materialSlot);
    if (!intsOk) return false;
    return (
      indexOffset >= 0 &&
      subIndexCount >= 0 &&
      subVertexCount >= 0 &&
      subVertexCount <= vcount &&
      materialSlot >= 0 &&
      materialSlot < this.materialSlotNames.length
    );
  }

  private validateSubmeshEntry(
    s: KernelSubmeshInput,
    i: number,
    vcount: number,
  ): KernelResult<RawSubmesh> {
    const indexOffset = s.indexOffset ?? 0;
    const subIndexCount = s.indexCount ?? this.indexCount;
    const subVertexCount = s.vertexCount ?? vcount;
    const topology = s.topology ?? 'triangle-list';
    const materialSlot = s.materialSlot ?? i;
    if (!PRIMITIVE_TOPOLOGIES.includes(topology)) {
      return err(
        new KernelError(
          'kernel-invalid-value',
          `submeshes[${i}].topology`,
          'must be a WebGPU primitive topology',
        ),
      );
    }
    if (
      !this.hasValidSubmeshNumbers(indexOffset, subIndexCount, subVertexCount, materialSlot, vcount)
    ) {
      return err(
        new KernelError(
          'kernel-invalid-value',
          `submeshes[${i}]`,
          'range and material slot are invalid',
        ),
      );
    }
    if (this.indexCount === 0 && (indexOffset !== 0 || subIndexCount !== 0)) {
      return err(
        new KernelError(
          'kernel-invalid-value',
          `submeshes[${i}]`,
          'non-indexed meshes use indexOffset=0 and indexCount=0',
        ),
      );
    }
    if (this.indexCount > 0 && indexOffset + subIndexCount > this.indexCount) {
      return err(
        new KernelError(
          'kernel-invalid-value',
          `submeshes[${i}]`,
          'index range exceeds the accumulated index buffer',
        ),
      );
    }
    if (this.indexCount === 0 && (topology === 'line-strip' || topology === 'triangle-strip')) {
      return err(
        new KernelError(
          'kernel-invalid-value',
          `submeshes[${i}].topology`,
          'strip topology requires an index buffer',
        ),
      );
    }
    return ok(
      Object.freeze({
        indexOffset,
        indexCount: subIndexCount,
        vertexCount: subVertexCount,
        topology,
        materialSlot,
      }),
    );
  }

  private resolveSubmeshes(vcount: number): KernelResult<RawSubmesh[]> {
    if (this.submeshes.length === 0) {
      return ok([
        Object.freeze({
          indexOffset: 0,
          indexCount: this.indexCount,
          vertexCount: vcount,
          topology: 'triangle-list' as const,
          materialSlot: 0,
        }),
      ]);
    }
    const submeshes: RawSubmesh[] = [];
    for (let i = 0; i < this.submeshes.length; i++) {
      const s = this.submeshes[i];
      if (s === undefined) continue;
      const entry = this.validateSubmeshEntry(s, i, vcount);
      if (!entry.ok) return entry;
      submeshes.push(entry.value);
    }
    return ok(submeshes);
  }

  private copyValidatedChannels(
    vcount: number,
  ): KernelResult<Map<AttributeKey, { format: AttributeFormat; array: AttributeTypedArray }>> {
    const channels = new Map<
      AttributeKey,
      { format: AttributeFormat; array: AttributeTypedArray }
    >();
    for (const [key, entry] of this.buffers) {
      const Ctor = formatArrayCtor(entry.format);
      const byteLen = vcount * formatByteLength(entry.format);
      const arr = new Ctor(entry.bytes.slice(0, byteLen).buffer);
      if (arr instanceof Float32Array) {
        for (let i = 0; i < arr.length; i++) {
          if (!Number.isFinite(arr[i])) {
            return err(new KernelError('kernel-invalid-value', key, `${key}[${i}] must be finite`));
          }
        }
      }
      channels.set(key, { format: entry.format, array: arr });
    }
    return ok(channels);
  }

  private collectTriangles(
    submeshes: readonly RawSubmesh[],
    activeIndices: Uint32Array,
    vcount: number,
  ): Uint32Array {
    const tris: number[] = [];
    const at = (p: number) => (this.indexCount === 0 ? p : (activeIndices[p] as number));
    for (const s of submeshes) {
      const first = this.indexCount === 0 ? 0 : s.indexOffset;
      const cnt = this.indexCount === 0 ? s.vertexCount : s.indexCount;
      if (s.topology === 'triangle-list') {
        for (let k = 0; k + 2 < cnt; k += 3) {
          tris.push(at(first + k), at(first + k + 1), at(first + k + 2));
        }
      } else if (s.topology === 'triangle-strip') {
        appendTriangleStrip(tris, first, cnt, vcount, at);
      }
    }
    return Uint32Array.from(tris);
  }

  build(options: KernelBuildOptions = {}): KernelResult<RawMeshData> {
    if (this.isDisposed) {
      return err(new KernelError('kernel-invalid-handle', 'handle', 'builder has been disposed'));
    }
    const outputMode = options.outputMode ?? 'interleaved';
    const vcount = this.vertexCount;
    if (vcount === 0) {
      return err(
        new KernelError('kernel-invalid-value', 'attributes', 'at least one vertex is required'),
      );
    }
    const activeIndices = this.indexBuf.subarray(0, this.indexCount);
    const maxIdxRes = this.validateIndices(activeIndices, vcount);
    if (!maxIdxRes.ok) return maxIdxRes;
    const submeshesRes = this.resolveSubmeshes(vcount);
    if (!submeshesRes.ok) return submeshesRes;
    const channelsRes = this.copyValidatedChannels(vcount);
    if (!channelsRes.ok) return channelsRes;

    const channels = channelsRes.value;
    const posEntry = channels.get('position');
    if (posEntry === undefined) {
      return err(
        new KernelError('kernel-invalid-value', 'attributes.position', 'position is required'),
      );
    }
    const positions = posEntry.array as Float32Array;
    const submeshes = submeshesRes.value;
    if (shouldDeriveVertexFrames(channels, submeshes)) {
      const triArr = this.collectTriangles(submeshes, activeIndices, vcount);
      if (triArr.length > 0) {
        populateDerivedVertexFrames(channels, positions, triArr, vcount);
      }
    }

    const { layout, stride, mask } = buildChannelLayoutMeta(channels);
    const interleaved =
      outputMode === 'interleaved' || outputMode === 'interleaved-with-channels'
        ? packInterleavedChannels(channels, layout, vcount, stride)
        : undefined;
    const outChannels =
      outputMode === 'separate' || outputMode === 'interleaved-with-channels'
        ? collectSeparateChannels(channels, layout)
        : undefined;
    const indices =
      this.indexCount === 0
        ? undefined
        : maxIdxRes.value <= 0xffff
          ? new Uint16Array(activeIndices)
          : activeIndices.slice();
    const aabb = computePositionAabb(positions);

    if (options.dispose === true) this.dispose();

    return ok(
      Object.freeze({
        backend: 'ts' as const,
        outputMode,
        vertexCount: vcount,
        arrayStride: stride,
        layoutMask: mask,
        layout: Object.freeze(layout),
        ...(interleaved === undefined ? {} : { interleaved }),
        ...(outChannels === undefined ? {} : { channels: outChannels }),
        ...(indices === undefined ? {} : { indices }),
        submeshes: Object.freeze(submeshes),
        materialSlotNames: Object.freeze([...this.materialSlotNames]),
        aabb,
      }),
    );
  }

  dispose(): void {
    this.isDisposed = true;
    this.buffers.clear();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Create a zero-copy staging MeshBuilder (`backend: 'auto' | 'rust' | 'ts'`). */
export function createKernelMeshBuilder(
  options: KernelMeshBuilderOptions,
): KernelResult<KernelMeshBuilder> {
  const decls = normalizeDeclarations(options.layout);
  if (!decls.ok) return decls;
  const slots = validateMaterialSlots(options.materialSlotNames);
  if (!slots.ok) return slots;

  const policy = options.backend ?? 'auto';
  const wasm = policy === 'ts' ? undefined : getModelingKernelWasm();
  if (policy === 'rust' && wasm === undefined) {
    return err(
      new KernelError(
        'kernel-capability-unavailable',
        'backend',
        'Rust WASM modeling kernel is not initialized; call initModelingKernelWasmSync() first or use backend: "auto"',
      ),
    );
  }

  if (wasm !== undefined) {
    const pairCount = decls.value.length;
    const ptr = wasm.mk_scratch_ensure(pairCount * 2);
    const bytes = new Uint8Array(wasm.memory.buffer, ptr, pairCount * 2);
    for (let i = 0; i < pairCount; i++) {
      const d = decls.value[i];
      if (d === undefined) continue;
      bytes[i * 2] = CANONICAL_ATTRIBUTE_KEYS.indexOf(d.key);
      bytes[i * 2 + 1] = ATTRIBUTE_FORMATS.indexOf(d.format);
    }
    const handle = wasm.mk_builder_create(
      ptr,
      pairCount,
      slots.value.length,
      options.vertexCapacity ?? 0,
      options.indexCapacity ?? 0,
    );
    if (handle === 0n) return err(readLastWasmError(wasm));
    return ok(new RustKernelMeshBuilder(wasm, decls.value, slots.value, handle));
  }

  return ok(
    new TsKernelMeshBuilder(
      decls.value,
      slots.value,
      options.vertexCapacity ?? 0,
      options.indexCapacity ?? 0,
    ),
  );
}

function appendTriangleStrip(
  tris: number[],
  first: number,
  cnt: number,
  vcount: number,
  at: (p: number) => number,
): void {
  let start = 0;
  for (let k = 0; k + 2 < cnt; k++) {
    const a = at(first + k);
    const b = at(first + k + 1);
    const c = at(first + k + 2);
    if (a >= vcount || b >= vcount || c >= vcount) {
      start = k + 1;
      continue;
    }
    if (a === b || b === c || a === c) continue;
    if ((k - start) % 2 === 0) tris.push(a, b, c);
    else tris.push(b, a, c);
  }
}

function shouldDeriveVertexFrames(
  channels: ReadonlyMap<AttributeKey, { format: AttributeFormat; array: AttributeTypedArray }>,
  submeshes: readonly RawSubmesh[],
): boolean {
  const hasTris = submeshes.some(
    (s) => s.topology === 'triangle-list' || s.topology === 'triangle-strip',
  );
  return (
    hasTris &&
    !channels.has('tangentFrame') &&
    !(channels.has('normal') && channels.has('uv') && channels.has('tangent'))
  );
}

function populateDerivedVertexFrames(
  channels: Map<AttributeKey, { format: AttributeFormat; array: AttributeTypedArray }>,
  positions: Float32Array,
  triArr: Uint32Array,
  vcount: number,
): void {
  const authoredNormal = channels.get('normal')?.array as Float32Array | undefined;
  let unitNormals: Float32Array;
  if (authoredNormal === undefined) {
    unitNormals = areaWeightedNormalsTs(positions, triArr);
    channels.set('normal', { format: 'float32x3', array: unitNormals });
  } else {
    unitNormals = authoredNormal.slice();
    let derived: Float32Array | undefined;
    for (let o = 0; o < unitNormals.length; o += 3) {
      const nx = unitNormals[o] as number;
      const ny = unitNormals[o + 1] as number;
      const nz = unitNormals[o + 2] as number;
      const l = Math.hypot(nx, ny, nz);
      if (l > 1e-12 && Number.isFinite(l)) {
        unitNormals[o] = nx / l;
        unitNormals[o + 1] = ny / l;
        unitNormals[o + 2] = nz / l;
      } else {
        derived ??= areaWeightedNormalsTs(positions, triArr);
        unitNormals.set(derived.subarray(o, o + 3), o);
      }
    }
  }
  let uvArr = channels.get('uv')?.array as Float32Array | undefined;
  if (uvArr === undefined) {
    uvArr = new Float32Array(vcount * 2);
    channels.set('uv', { format: 'float32x2', array: uvArr });
  }
  if (!channels.has('tangent')) {
    channels.set('tangent', {
      format: 'float32x4',
      array: computeTangentsTs(positions, unitNormals, uvArr, triArr),
    });
  }
}

function buildChannelLayoutMeta(
  channels: ReadonlyMap<AttributeKey, { format: AttributeFormat; array: AttributeTypedArray }>,
): { readonly layout: VertexLayoutDeclaration[]; readonly stride: number; readonly mask: number } {
  let stride = 0;
  let mask = 0;
  const layout: VertexLayoutDeclaration[] = [];
  for (let i = 0; i < CANONICAL_ATTRIBUTE_KEYS.length; i++) {
    const k = CANONICAL_ATTRIBUTE_KEYS[i] as AttributeKey;
    const ch = channels.get(k);
    if (ch === undefined) continue;
    layout.push({ key: k, format: ch.format });
    stride += formatByteLength(ch.format);
    mask |= 1 << i;
  }
  return { layout, stride, mask };
}

function packInterleavedChannels(
  channels: ReadonlyMap<AttributeKey, { format: AttributeFormat; array: AttributeTypedArray }>,
  layout: readonly VertexLayoutDeclaration[],
  vcount: number,
  stride: number,
): Float32Array {
  const outBytes = new Uint8Array(vcount * stride);
  let offset = 0;
  for (const d of layout) {
    const ch = channels.get(d.key);
    if (ch === undefined) continue;
    const arr = ch.array;
    const srcBytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    const bLen = formatByteLength(d.format);
    for (let v = 0; v < vcount; v++) {
      outBytes.set(srcBytes.subarray(v * bLen, (v + 1) * bLen), v * stride + offset);
    }
    offset += bLen;
  }
  return new Float32Array(outBytes.buffer);
}

function collectSeparateChannels(
  channels: ReadonlyMap<AttributeKey, { format: AttributeFormat; array: AttributeTypedArray }>,
  layout: readonly VertexLayoutDeclaration[],
): RawAttributeChannels {
  const outChannels: RawAttributeChannels = {};
  for (const d of layout) {
    const ch = channels.get(d.key);
    if (ch !== undefined) outChannels[d.key] = ch.array;
  }
  return outChannels;
}

function computePositionAabb(positions: Float32Array): Float32Array {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] as number;
    const y = positions[i + 1] as number;
    const z = positions[i + 2] as number;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return new Float32Array([minX, minY, minZ, maxX, maxY, maxZ]);
}

interface PlannedSectionPart {
  readonly sectionIndex: number;
  readonly materialSlot: number;
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly attributes?: RawAttributeChannels;
  readonly indices?: ArrayLike<number>;
}

function inferSectionLayout(
  attributes: RawAttributeChannels,
  sectionIndex: number,
  vCount: number,
): KernelResult<VertexLayoutDeclaration[]> {
  const secLayout: VertexLayoutDeclaration[] = [];
  for (const k of CANONICAL_ATTRIBUTE_KEYS) {
    const arr = attributes[k];
    if (arr === undefined) continue;
    const fmt = inferAttributeFormat(k, arr);
    if (fmt === undefined) {
      return err(
        new KernelError(
          'kernel-invalid-value',
          `sections[${sectionIndex}].attributes.${k}`,
          'invalid attribute storage',
        ),
      );
    }
    if (arr.length !== vCount * formatComponentCount(fmt)) {
      return err(
        new KernelError(
          'kernel-invalid-value',
          `sections[${sectionIndex}].attributes.${k}`,
          'attribute length mismatch',
        ),
      );
    }
    secLayout.push({ key: k, format: fmt });
  }
  return ok(secLayout);
}

function layoutsEqual(
  a: readonly VertexLayoutDeclaration[],
  b: readonly VertexLayoutDeclaration[],
): boolean {
  return (
    a.length === b.length &&
    a.every((e, idx) => e.key === b[idx]?.key && e.format === b[idx]?.format)
  );
}

function planSingleSection(
  sec: KernelMeshSectionsOptions['sections'][number],
  i: number,
  slotCount: number,
): KernelResult<{
  readonly part: PlannedSectionPart;
  readonly layout?: VertexLayoutDeclaration[];
}> {
  if (
    !Number.isInteger(sec.materialSlot) ||
    sec.materialSlot < 0 ||
    sec.materialSlot >= slotCount
  ) {
    return err(
      new KernelError(
        'kernel-invalid-value',
        `sections[${i}].materialSlot`,
        'invalid material slot',
      ),
    );
  }
  if (sec.attributes === undefined && sec.indices === undefined) {
    return ok({
      part: { sectionIndex: i, materialSlot: sec.materialSlot, vertexCount: 0, indexCount: 0 },
    });
  }
  if (
    sec.attributes === undefined ||
    sec.indices === undefined ||
    sec.indices.length === 0 ||
    sec.indices.length % 3 !== 0
  ) {
    return err(
      new KernelError(
        'kernel-invalid-value',
        `sections[${i}]`,
        'geometry sections require attributes and a non-empty triangle list',
      ),
    );
  }
  const pos = sec.attributes.position;
  if (!(pos instanceof Float32Array) || pos.length === 0 || pos.length % 3 !== 0) {
    return err(
      new KernelError(
        'kernel-invalid-value',
        `sections[${i}].attributes.position`,
        'position must be a non-empty Float32Array multiple of 3',
      ),
    );
  }
  const vCount = pos.length / 3;
  const secLayoutRes = inferSectionLayout(sec.attributes, i, vCount);
  if (!secLayoutRes.ok) return secLayoutRes;
  return ok({
    part: {
      sectionIndex: i,
      materialSlot: sec.materialSlot,
      vertexCount: vCount,
      indexCount: sec.indices.length,
      attributes: sec.attributes,
      indices: sec.indices,
    },
    layout: secLayoutRes.value,
  });
}

function appendPlannedSection(
  builder: KernelMeshBuilder,
  part: PlannedSectionPart,
  layout: readonly VertexLayoutDeclaration[],
  runningIndexOffset: number,
): KernelResult<number> {
  if (part.vertexCount === 0) {
    const added = builder.addSubmesh({
      indexOffset: runningIndexOffset,
      indexCount: 0,
      vertexCount: 0,
      topology: 'triangle-list',
      materialSlot: part.materialSlot,
    });
    return added.ok ? ok(runningIndexOffset) : added;
  }
  const verts = builder.allocateVertices(part.vertexCount);
  if (!verts.ok) return verts;
  if (part.attributes !== undefined) {
    for (const decl of layout) {
      const dst = verts.value.channels[decl.key];
      const src = part.attributes[decl.key];
      if (dst !== undefined && src !== undefined) (dst as Float32Array).set(src as Float32Array);
    }
  }
  const idxs = builder.allocateIndices(part.indexCount);
  if (!idxs.ok) return idxs;
  const srcIdx = part.indices;
  if (srcIdx === undefined) return ok(runningIndexOffset);
  for (let k = 0; k < part.indexCount; k++) {
    const val = srcIdx[k];
    if (val === undefined || !Number.isInteger(val) || val < 0 || val > 0xffffffff) {
      return err(
        new KernelError(
          'kernel-invalid-value',
          `sections[${part.sectionIndex}].indices[${k}]`,
          'index must be a non-negative integer',
        ),
      );
    }
    idxs.value.indices[k] = val;
  }
  const rebased = builder.rebaseSectionIndices(
    idxs.value.indexOffset,
    part.indexCount,
    verts.value.baseVertex,
    part.vertexCount,
    part.sectionIndex,
  );
  if (!rebased.ok) return rebased;
  const added = builder.addSubmesh({
    indexOffset: idxs.value.indexOffset,
    indexCount: part.indexCount,
    vertexCount: part.vertexCount,
    topology: 'triangle-list',
    materialSlot: part.materialSlot,
  });
  return added.ok ? ok(runningIndexOffset + part.indexCount) : added;
}

/** Assemble independent triangle sections with section-local indices in one pass. */
export function buildKernelMeshSections(
  options: KernelMeshSectionsOptions,
  buildOptions: KernelBuildOptions = {},
): KernelResult<RawMeshData> {
  const slots = validateMaterialSlots(options.materialSlotNames);
  if (!slots.ok) return slots;
  if (!Array.isArray(options.sections) || options.sections.length === 0) {
    return err(
      new KernelError('kernel-invalid-value', 'sections', 'at least one section is required'),
    );
  }

  let layout: VertexLayoutDeclaration[] | undefined;
  let totalVerts = 0;
  let totalIndices = 0;
  const planned: PlannedSectionPart[] = [];

  for (let i = 0; i < options.sections.length; i++) {
    const sec = options.sections[i];
    if (sec === undefined) continue;
    const res = planSingleSection(sec, i, slots.value.length);
    if (!res.ok) return res;
    const secLayout = res.value.layout;
    if (secLayout !== undefined) {
      if (layout === undefined) {
        layout = secLayout;
      } else if (!layoutsEqual(layout, secLayout)) {
        return err(
          new KernelError(
            'kernel-invalid-value',
            `sections[${i}].attributes`,
            'all sections must share channels and formats',
          ),
        );
      }
    }
    totalVerts += res.value.part.vertexCount;
    totalIndices += res.value.part.indexCount;
    planned.push(res.value.part);
  }

  if (layout === undefined) {
    return err(
      new KernelError(
        'kernel-invalid-value',
        'sections',
        'at least one section must contain geometry',
      ),
    );
  }

  const builderRes = createKernelMeshBuilder({
    layout,
    materialSlotNames: slots.value,
    vertexCapacity: totalVerts,
    indexCapacity: totalIndices,
    ...(options.backend === undefined ? {} : { backend: options.backend }),
  });
  if (!builderRes.ok) return builderRes;
  const builder = builderRes.value;
  try {
    let runningIndexOffset = 0;
    for (const part of planned) {
      const next = appendPlannedSection(builder, part, layout, runningIndexOffset);
      if (!next.ok) return next;
      runningIndexOffset = next.value;
    }
    return builder.build({ ...buildOptions, dispose: true });
  } finally {
    builder.dispose();
  }
}

/** Number of currently live Rust WASM MeshBuilder handles (for leak detection in tests). */
export function liveRustBuilderCount(): number {
  return getModelingKernelWasm()?.mk_live_builders() ?? 0;
}

/** Encode an orthonormal tangent frame into 32 bits via the Rust WASM kernel. */
export function encodeTangentFrame32Rust(
  nx: number,
  ny: number,
  nz: number,
  tx: number,
  ty: number,
  tz: number,
  handedness: number,
): KernelResult<number> {
  const wasm = getModelingKernelWasm();
  if (wasm === undefined) {
    return err(
      new KernelError(
        'kernel-capability-unavailable',
        'backend',
        'Rust WASM modeling kernel is not initialized',
      ),
    );
  }
  const ptr = wasm.mk_scratch_ensure(4);
  const status = wasm.mk_encode_tangent_frame32(nx, ny, nz, tx, ty, tz, handedness, ptr);
  if (status !== 0) return err(readLastWasmError(wasm));
  return ok(new Uint32Array(wasm.memory.buffer, ptr, 1)[0] as number);
}

/** Decode a 32-bit packed tangent frame via the Rust WASM kernel. */
export function decodeTangentFrame32Rust(word: number): KernelResult<Float32Array> {
  const wasm = getModelingKernelWasm();
  if (wasm === undefined) {
    return err(
      new KernelError(
        'kernel-capability-unavailable',
        'backend',
        'Rust WASM modeling kernel is not initialized',
      ),
    );
  }
  const ptr = wasm.mk_scratch_ensure(28);
  wasm.mk_decode_tangent_frame32(word >>> 0, ptr);
  return ok(new Float32Array(wasm.memory.buffer, ptr, 7).slice());
}
