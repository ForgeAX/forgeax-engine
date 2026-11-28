import {
  getModelingKernelWasm,
  type ModelingKernelWasmExports,
} from '@forgeax/modeling-kernel-wasm';
import type { RustEditMesh } from './edit-mesh';
import { err, errorCodeFromId, KernelError, type KernelResult, ok } from './result';
import { RustImageBuffer } from './surface';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function requireWasm(): KernelResult<ModelingKernelWasmExports> {
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
  return ok(wasm);
}

function readError(wasm: ModelingKernelWasmExports): KernelError {
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

const CHANNEL_IDS: Record<string, number> = {
  uv0: 0,
  uv1: 1,
  uv2: 2,
  uv3: 3,
  uv4: 4,
  uv5: 5,
  uv6: 6,
  uv7: 7,
  color: 8,
};

function align4(n: number): number {
  return (n + 3) & ~3;
}

function writeI32(wasm: ModelingKernelWasmExports, base: number, data: ArrayLike<number>): void {
  const v = new Int32Array(wasm.memory.buffer, base, data.length);
  for (let i = 0; i < data.length; i++) v[i] = data[i] ?? 0;
}

function writeU32(wasm: ModelingKernelWasmExports, base: number, data: ArrayLike<number>): void {
  const v = new Uint32Array(wasm.memory.buffer, base, data.length);
  for (let i = 0; i < data.length; i++) v[i] = data[i] ?? 0;
}

function writeF64(wasm: ModelingKernelWasmExports, base: number, data: ArrayLike<number>): void {
  const v = new Float64Array(wasm.memory.buffer, base, data.length);
  for (let i = 0; i < data.length; i++) v[i] = data[i] ?? 0;
}

function writeF32(wasm: ModelingKernelWasmExports, base: number, data: ArrayLike<number>): void {
  const v = new Float32Array(wasm.memory.buffer, base, data.length);
  for (let i = 0; i < data.length; i++) v[i] = data[i] ?? 0;
}

function writeU8(wasm: ModelingKernelWasmExports, base: number, data: ArrayLike<number>): void {
  const v = new Uint8Array(wasm.memory.buffer, base, data.length);
  for (let i = 0; i < data.length; i++) v[i] = data[i] ?? 0;
}

function align8(n: number): number {
  return (n + 7) & ~7;
}

// =========================================================================
// 1. Atlas Dilation & High-to-Low Bake Atoms
// =========================================================================

export interface RustAtlasBleedReport {
  readonly levels: readonly number[];
  readonly protectMip: number;
  readonly protectedBleed: number;
  readonly pass: boolean;
}

export function dilateAtlasRust(options: {
  readonly width: number;
  readonly height: number;
  readonly wrapU?: boolean;
  readonly wrapV?: boolean;
  readonly gutter: number;
  readonly protectMip?: number;
  readonly buffers: readonly Float32Array[];
  readonly categorical: readonly boolean[];
  readonly covered: Uint8Array;
  readonly owner: Int32Array;
  readonly frame: Int32Array;
}): KernelResult<RustAtlasBleedReport> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const { width, height, buffers, categorical, covered, owner, frame } = options;
  const texels = width * height;
  const nBufs = buffers.length;
  const rgbaBytes = nBufs * texels * 16;
  const catBytes = align4(nBufs);
  const covBytes = align4(texels);
  const ownerBytes = texels * 4;
  const frameBytes = texels * 4;
  const metaBytes = 20 * 4;
  const base = wasm.mk_scratch_ensure(
    rgbaBytes + catBytes + covBytes + ownerBytes + frameBytes + metaBytes,
  );
  const rgbaPtr = base;
  const catPtr = rgbaPtr + rgbaBytes;
  const covPtr = catPtr + catBytes;
  const ownerPtr = covPtr + covBytes;
  const framePtr = ownerPtr + ownerBytes;
  const metaPtr = framePtr + frameBytes;

  for (let i = 0; i < nBufs; i++) {
    const b = buffers[i];
    if (b !== undefined) {
      new Float32Array(wasm.memory.buffer, rgbaPtr + i * texels * 16, texels * 4).set(b);
    }
  }
  writeU8(
    wasm,
    catPtr,
    categorical.map((c) => (c ? 1 : 0)),
  );
  writeU8(wasm, covPtr, covered);
  writeI32(wasm, ownerPtr, owner);
  writeI32(wasm, framePtr, frame);

  const st = wasm.mk_atlas_dilate(
    width,
    height,
    options.wrapU ? 1 : 0,
    options.wrapV ? 1 : 0,
    options.gutter,
    options.protectMip ?? -1,
    nBufs,
    rgbaPtr,
    catPtr,
    covPtr,
    ownerPtr,
    framePtr,
    metaPtr,
  );
  if (st !== 0) return err(readError(wasm));

  for (let i = 0; i < nBufs; i++) {
    buffers[i]?.set(new Float32Array(wasm.memory.buffer, rgbaPtr + i * texels * 16, texels * 4));
  }
  covered.set(new Uint8Array(wasm.memory.buffer, covPtr, texels));
  owner.set(new Int32Array(wasm.memory.buffer, ownerPtr, texels));

  const meta = new Uint32Array(wasm.memory.buffer, metaPtr, 20);
  const levelCount = Math.min(16, meta[3] ?? 0);
  const levels: number[] = [];
  for (let i = 0; i < levelCount; i++) levels.push(meta[4 + i] ?? 0);
  return ok({
    protectMip: meta[0] ?? 0,
    protectedBleed: meta[1] ?? 0,
    pass: (meta[2] ?? 0) !== 0,
    levels,
  });
}

export function resolveBakeCageRust(options: {
  readonly basePos: Float64Array;
  readonly baseNorm: Float64Array;
  readonly baseIdx: Uint32Array;
  readonly detailPos: Float64Array;
  readonly detailIdx: Uint32Array;
  readonly offset?: number;
  readonly maxRay?: number;
  readonly dirMode?: 'averaged' | 'shading' | 'face' | 'blend';
  readonly blendDistance?: number;
}): KernelResult<{
  readonly offset: number;
  readonly maxRay: number;
  readonly diagonal: number;
  readonly steepFraction: number;
}> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const bv = options.basePos.length / 3;
  const bt = options.baseIdx.length / 3;
  const dv = options.detailPos.length / 3;
  const dt = options.detailIdx.length / 3;
  const total =
    options.basePos.byteLength +
    options.baseNorm.byteLength +
    options.baseIdx.byteLength +
    options.detailPos.byteLength +
    options.detailIdx.byteLength +
    96;
  const base = align8(wasm.mk_scratch_ensure(total));
  let ptr = base;
  const bPosPtr = ptr;
  writeF64(wasm, bPosPtr, options.basePos);
  ptr += options.basePos.byteLength;
  const bNrmPtr = ptr;
  writeF64(wasm, bNrmPtr, options.baseNorm);
  ptr += options.baseNorm.byteLength;
  const bIdxPtr = ptr;
  writeU32(wasm, bIdxPtr, options.baseIdx);
  ptr = align8(ptr + options.baseIdx.byteLength);
  const dPosPtr = ptr;
  writeF64(wasm, dPosPtr, options.detailPos);
  ptr += options.detailPos.byteLength;
  const dIdxPtr = ptr;
  writeU32(wasm, dIdxPtr, options.detailIdx);
  ptr = align8(ptr + options.detailIdx.byteLength);
  const outPtr = ptr;

  const dm =
    options.dirMode === 'shading'
      ? 1
      : options.dirMode === 'face'
        ? 2
        : options.dirMode === 'blend'
          ? 3
          : 0;
  const st = wasm.mk_bake_resolve_cage(
    bPosPtr,
    bv,
    bNrmPtr,
    bIdxPtr,
    bt,
    dPosPtr,
    dv,
    dIdxPtr,
    dt,
    options.offset ?? -1,
    options.maxRay ?? -1,
    dm,
    options.blendDistance ?? 0.05,
    outPtr,
  );
  if (st !== 0) return err(readError(wasm));
  const out = new Float64Array(wasm.memory.buffer, outPtr, 4);
  return ok({
    offset: out[0] ?? 0,
    maxRay: out[1] ?? 0,
    diagonal: out[2] ?? 0,
    steepFraction: out[3] ?? 0,
  });
}

export const RUST_BAKE_MAP_KINDS = {
  normal: 0,
  normalObject: 1,
  ao: 2,
  height: 3,
  position: 4,
  curvature: 5,
  edgeWear: 6,
  cavity: 7,
  ormh: 8,
  baseColor: 9,
  emissive: 10,
  materialId: 11,
  thickness: 12,
  opacity: 13,
} as const;

export type RustBakeMapKindName = keyof typeof RUST_BAKE_MAP_KINDS;

export interface RustBakeCorrespondCounters {
  readonly rayHits: number;
  readonly primary: number;
  readonly rescued: number;
  readonly extended: number;
  readonly nearest: number;
  readonly missed: number;
  readonly clipped: number;
  readonly coveredTexels: number;
}

const correspondLeakRegistry =
  typeof FinalizationRegistry !== 'undefined'
    ? new FinalizationRegistry<{ wasm: ModelingKernelWasmExports; handle: bigint }>((entry) => {
        entry.wasm.mk_bake_correspond_dispose(entry.handle);
      })
    : undefined;

interface BakeSlotInput {
  readonly baseColor: readonly [number, number, number, number];
  readonly roughness: number;
  readonly metallic: number;
  readonly emissive: readonly [number, number, number];
}

function packBakeSlots(slots: readonly BakeSlotInput[]): Float32Array {
  const slotArr = new Float32Array(slots.length * 9);
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (s === undefined) continue;
    slotArr.set(s.baseColor, i * 9);
    slotArr[i * 9 + 4] = s.roughness;
    slotArr[i * 9 + 5] = s.metallic;
    slotArr.set(s.emissive, i * 9 + 6);
  }
  return slotArr;
}

function collectEvaluatedImages(
  wasm: ModelingKernelWasmExports,
  outHPtr: number,
  maps: readonly RustBakeMapKindName[],
  width: number,
  height: number,
): Record<string, RustImageBuffer> {
  const handles = new BigUint64Array(wasm.memory.buffer, outHPtr, maps.length);
  const images: Record<string, RustImageBuffer> = {};
  for (let i = 0; i < maps.length; i++) {
    const mapName = maps[i];
    const handle = handles[i];
    if (mapName !== undefined && handle !== undefined) {
      images[mapName] = new RustImageBuffer(wasm, handle, width, height, 4);
    }
  }
  return images;
}

function readBakeEvaluationResult(
  wasm: ModelingKernelWasmExports,
  outHPtr: number,
  outRPtr: number,
  maps: readonly RustBakeMapKindName[],
  width: number,
  height: number,
) {
  const ranges = new Float32Array(wasm.memory.buffer, outRPtr, 9);
  const r = (idx: number, fallback: number) => ranges[idx] ?? fallback;
  return {
    images: collectEvaluatedImages(wasm, outHPtr, maps, width, height),
    curvatureRange: r(0, 1),
    heightRange: [r(1, -0.1), r(2, 0.1)] as const,
    positionBounds: {
      min: [r(3, 0), r(4, 0), r(5, 0)] as const,
      max: [r(6, 1), r(7, 1), r(8, 1)] as const,
    },
  };
}

function writeOptionalArray<T extends ArrayLike<number>>(
  wasm: ModelingKernelWasmExports,
  alloc: (len: number, align?: number) => number,
  data: T | undefined,
  byteLen: number,
  align: number,
  writer: (w: ModelingKernelWasmExports, ptr: number, arr: ArrayLike<number>) => void,
): number {
  if (data === undefined) return 0;
  const ptr = alloc(byteLen, align);
  writer(wasm, ptr, data);
  return ptr;
}

function packBakeGroups(
  wasm: ModelingKernelWasmExports,
  gpPtr: number,
  groups: readonly {
    readonly offset: number;
    readonly maxRay: number;
    readonly diagonal: number;
    readonly dirMode?: number;
    readonly clipCheck?: boolean;
  }[],
): void {
  const gp = new Float64Array(wasm.memory.buffer, gpPtr, Math.max(1, groups.length) * 5);
  for (let g = 0; g < groups.length; g++) {
    const gr = groups[g];
    if (gr === undefined) continue;
    gp[g * 5] = gr.offset;
    gp[g * 5 + 1] = gr.maxRay;
    gp[g * 5 + 2] = gr.diagonal;
    gp[g * 5 + 3] = gr.dirMode ?? 0;
    gp[g * 5 + 4] = gr.clipCheck !== false ? 1 : 0;
  }
}

export class RustBakeCorrespondence {
  private handle: bigint;
  private disposed = false;
  private readonly unregisterToken = {};

  constructor(
    private readonly wasm: ModelingKernelWasmExports,
    handle: bigint,
    public readonly width: number,
    public readonly height: number,
    public readonly counters: RustBakeCorrespondCounters,
  ) {
    this.handle = handle;
    correspondLeakRegistry?.register(this, { wasm, handle }, this.unregisterToken);
  }

  evaluate(options: {
    readonly maps: readonly RustBakeMapKindName[];
    readonly slots?: readonly BakeSlotInput[];
    readonly gutter?: number;
    readonly aoSamples?: number;
    readonly aoCone?: number;
    readonly aoDistance?: number;
    readonly aoBias?: number;
  }): KernelResult<{
    readonly images: Readonly<Record<string, RustImageBuffer>>;
    readonly curvatureRange: number;
    readonly heightRange: readonly [number, number];
    readonly positionBounds: {
      readonly min: readonly [number, number, number];
      readonly max: readonly [number, number, number];
    };
  }> {
    if (this.disposed) {
      return err(new KernelError('kernel-invalid-handle', 'correspond', 'handle is disposed'));
    }
    const { maps, slots = [] } = options;
    const mapsBytes = align4(maps.length);
    const slotsBytes = Math.max(4, slots.length * 9 * 4);
    const outHBytes = align8(maps.length * 8 + 8);
    const base = align8(
      this.wasm.mk_scratch_ensure(mapsBytes + slotsBytes + outHBytes + 9 * 4 + 16),
    );
    writeU8(
      this.wasm,
      base,
      maps.map((m) => RUST_BAKE_MAP_KINDS[m]),
    );
    const slotsPtr = base + mapsBytes;
    writeF32(this.wasm, slotsPtr, packBakeSlots(slots));
    const outHPtr = align8(slotsPtr + slotsBytes);
    const outRPtr = outHPtr + outHBytes;

    const st = this.wasm.mk_bake_correspond_eval(
      this.handle,
      base,
      maps.length,
      slotsPtr,
      slots.length,
      options.gutter ?? 8,
      options.aoSamples ?? 16,
      options.aoCone ?? 0.0,
      options.aoDistance ?? 0.0,
      options.aoBias ?? 1e-4,
      outHPtr,
      outRPtr,
    );
    if (st !== 0) return err(readError(this.wasm));
    return ok(readBakeEvaluationResult(this.wasm, outHPtr, outRPtr, maps, this.width, this.height));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    correspondLeakRegistry?.unregister(this.unregisterToken);
    this.wasm.mk_bake_correspond_dispose(this.handle);
    this.handle = 0n;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

export function bakeCorrespondRust(options: {
  readonly width: number;
  readonly height: number;
  readonly samplesPerAxis?: number;
  readonly basePos: Float64Array;
  readonly baseNorm: Float64Array;
  readonly baseTan: Float32Array;
  readonly baseUv: Float32Array;
  readonly baseIdx: Uint32Array;
  readonly baseTriGroup?: Int32Array;
  readonly baseTriIsland?: Int32Array;
  readonly detailPos: Float64Array;
  readonly detailNorm?: Float64Array;
  readonly detailIdx: Uint32Array;
  readonly detailTriGroup?: Int32Array;
  readonly detailTriSlot?: Int32Array;
  readonly detailFloater?: Uint8Array;
  readonly groups: readonly {
    readonly offset: number;
    readonly maxRay: number;
    readonly diagonal: number;
    readonly dirMode?: number;
    readonly clipCheck?: boolean;
  }[];
}): KernelResult<RustBakeCorrespondence> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const bv = options.basePos.length / 3;
  const bt = options.baseIdx.length / 3;
  const dv = options.detailPos.length / 3;
  const dt = options.detailIdx.length / 3;
  const ng = Math.max(1, options.groups.length);

  const bytesNeeded =
    options.basePos.byteLength +
    options.baseNorm.byteLength +
    options.baseTan.byteLength +
    options.baseUv.byteLength +
    options.baseIdx.byteLength +
    bt * 8 +
    options.detailPos.byteLength +
    (options.detailNorm?.byteLength ?? 0) +
    options.detailIdx.byteLength +
    dt * 12 +
    ng * 5 * 8 +
    128;

  let ptr = align8(wasm.mk_scratch_ensure(bytesNeeded));
  const alloc = (len: number, align = 8) => {
    ptr = (ptr + (align - 1)) & ~(align - 1);
    const out = ptr;
    ptr += len;
    return out;
  };
  const req = <T extends ArrayLike<number>>(
    data: T,
    byteLen: number,
    align: number,
    writer: (w: ModelingKernelWasmExports, p: number, arr: ArrayLike<number>) => void,
  ) => writeOptionalArray(wasm, alloc, data, byteLen, align, writer);

  const bpPtr = req(options.basePos, options.basePos.byteLength, 8, writeF64);
  const bnPtr = req(options.baseNorm, options.baseNorm.byteLength, 8, writeF64);
  const btPtr = req(options.baseTan, options.baseTan.byteLength, 4, writeF32);
  const buvPtr = req(options.baseUv, options.baseUv.byteLength, 4, writeF32);
  const biPtr = req(options.baseIdx, options.baseIdx.byteLength, 4, writeU32);
  const bgPtr = writeOptionalArray(wasm, alloc, options.baseTriGroup, bt * 4, 4, writeI32);
  const bislPtr = writeOptionalArray(wasm, alloc, options.baseTriIsland, bt * 4, 4, writeI32);

  const dpPtr = req(options.detailPos, options.detailPos.byteLength, 8, writeF64);
  const dnPtr = writeOptionalArray(
    wasm,
    alloc,
    options.detailNorm,
    options.detailNorm?.byteLength ?? 0,
    8,
    writeF64,
  );
  const diPtr = req(options.detailIdx, options.detailIdx.byteLength, 4, writeU32);
  const dgPtr = writeOptionalArray(wasm, alloc, options.detailTriGroup, dt * 4, 4, writeI32);
  const dsPtr = writeOptionalArray(wasm, alloc, options.detailTriSlot, dt * 4, 4, writeI32);
  const dfPtr = writeOptionalArray(wasm, alloc, options.detailFloater, align4(dt), 4, writeU8);

  const gpPtr = alloc(ng * 5 * 8, 8);
  packBakeGroups(wasm, gpPtr, options.groups);
  const outCntPtr = alloc(32, 4);

  const h = wasm.mk_bake_correspond(
    options.width,
    options.height,
    options.samplesPerAxis ?? 1,
    bpPtr,
    bv,
    bnPtr,
    btPtr,
    buvPtr,
    biPtr,
    bt,
    bgPtr,
    bislPtr,
    dpPtr,
    dv,
    dnPtr,
    diPtr,
    dt,
    dgPtr,
    dsPtr,
    dfPtr,
    options.groups.length,
    gpPtr,
    outCntPtr,
  );
  if (h === 0n) return err(readError(wasm));
  const c = new Uint32Array(wasm.memory.buffer, outCntPtr, 8);
  const cnt = (idx: number) => c[idx] ?? 0;
  return ok(
    new RustBakeCorrespondence(wasm, h, options.width, options.height, {
      rayHits: cnt(0),
      primary: cnt(1),
      rescued: cnt(2),
      extended: cnt(3),
      nearest: cnt(4),
      missed: cnt(5),
      clipped: cnt(6),
      coveredTexels: cnt(7),
    }),
  );
}

// =========================================================================
// 2. EditMesh Extended Operators (Roles/Cleanup/Remesh/Voxel/Lowpoly/Cut/Deform/UV/Skin/Query)
// =========================================================================

export function packPreserveConstraints(c?: {
  readonly boundary?: boolean | 'pin';
  readonly sharp?: boolean | 'pin';
  readonly seam?: boolean | 'pin';
  readonly uvSeams?: boolean | 'pin';
  readonly material?: boolean | 'pin';
  readonly materials?: boolean | 'pin';
  readonly label?: boolean | 'pin';
  readonly labels?: boolean | 'pin';
}): number {
  const lv = (v: boolean | 'pin' | undefined) => (v === false ? 0 : v === 'pin' ? 2 : 1);
  return (
    lv(c?.boundary) |
    (lv(c?.sharp) << 2) |
    (lv(c?.uvSeams ?? c?.seam) << 4) |
    (lv(c?.materials ?? c?.material) << 6) |
    (lv(c?.labels ?? c?.label) << 8)
  );
}

export function rustExtMarkPartRole(
  mesh: RustEditMesh,
  faces: ArrayLike<number>,
  role: 'form' | 'detail' | 'tool',
): KernelResult<number> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const ptr = wasm.mk_scratch_ensure(Math.max(4, faces.length * 4));
  writeI32(wasm, ptr, faces);
  const rid = role === 'detail' ? 1 : role === 'tool' ? 2 : 0;
  const r = wasm.mk_mesh_mark_part_role(mesh.rawHandle, ptr, faces.length, rid);
  mesh.syncAfterExternalWrite();
  return r >= 0 ? ok(r) : err(readError(wasm));
}

export function rustExtMarkFloat(
  mesh: RustEditMesh,
  faces: ArrayLike<number>,
  floating: boolean,
): KernelResult<number> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const ptr = wasm.mk_scratch_ensure(Math.max(4, faces.length * 4));
  writeI32(wasm, ptr, faces);
  const r = wasm.mk_mesh_mark_float(mesh.rawHandle, ptr, faces.length, floating ? 1 : 0);
  mesh.syncAfterExternalWrite();
  return r >= 0 ? ok(r) : err(readError(wasm));
}

export function rustExtMarkCrease(
  mesh: RustEditMesh,
  edges: ArrayLike<number>,
  sharpness: number,
): KernelResult<number> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const ptr = wasm.mk_scratch_ensure(Math.max(4, edges.length * 4));
  writeI32(wasm, ptr, edges);
  const r = wasm.mk_mesh_mark_crease(mesh.rawHandle, ptr, edges.length, sharpness);
  mesh.syncAfterExternalWrite();
  return r >= 0 ? ok(r) : err(readError(wasm));
}

export function rustExtOrient(mesh: RustEditMesh, faces: ArrayLike<number>): KernelResult<number> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const ptr = wasm.mk_scratch_ensure(Math.max(4, faces.length * 4));
  writeI32(wasm, ptr, faces);
  const r = wasm.mk_mesh_orient(mesh.rawHandle, ptr, faces.length);
  mesh.syncAfterExternalWrite();
  return r >= 0 ? ok(r) : err(readError(wasm));
}

export function rustExtTriangulate(
  mesh: RustEditMesh,
  faces: ArrayLike<number>,
): KernelResult<number> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const ptr = wasm.mk_scratch_ensure(Math.max(4, faces.length * 4));
  writeI32(wasm, ptr, faces);
  const r = wasm.mk_mesh_triangulate(mesh.rawHandle, ptr, faces.length);
  mesh.syncAfterExternalWrite();
  return r >= 0 ? ok(r) : err(readError(wasm));
}

export function rustExtDissolve(
  mesh: RustEditMesh,
  edges: ArrayLike<number>,
): KernelResult<{ readonly dissolved: number; readonly merged: number }> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const base = wasm.mk_scratch_ensure(8 + Math.max(4, edges.length * 4));
  writeI32(wasm, base + 8, edges);
  const r = wasm.mk_mesh_dissolve(mesh.rawHandle, base + 8, edges.length, base);
  mesh.syncAfterExternalWrite();
  if (r !== 0) return err(readError(wasm));
  const out = new Uint32Array(wasm.memory.buffer, base, 2);
  return ok({ dissolved: out[0] ?? 0, merged: out[1] ?? 0 });
}

export function rustExtSplitEdges(
  mesh: RustEditMesh,
  edges: ArrayLike<number>,
): KernelResult<number> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const ptr = wasm.mk_scratch_ensure(Math.max(4, edges.length * 4));
  writeI32(wasm, ptr, edges);
  const r = wasm.mk_mesh_split_edges(mesh.rawHandle, ptr, edges.length);
  mesh.syncAfterExternalWrite();
  return r >= 0 ? ok(r) : err(readError(wasm));
}

export function rustExtCleanupPlanar(
  mesh: RustEditMesh,
  faces: ArrayLike<number>,
  tolerance: number,
): KernelResult<{ readonly mergedGroups: number; readonly removedVertices: number }> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const base = wasm.mk_scratch_ensure(8 + Math.max(4, faces.length * 4));
  writeI32(wasm, base + 8, faces);
  const r = wasm.mk_mesh_cleanup_planar(mesh.rawHandle, base + 8, faces.length, tolerance, base);
  mesh.syncAfterExternalWrite();
  if (r !== 0) return err(readError(wasm));
  const out = new Uint32Array(wasm.memory.buffer, base, 2);
  return ok({ mergedGroups: out[0] ?? 0, removedVertices: out[1] ?? 0 });
}

export function rustExtCleanupQuads(
  mesh: RustEditMesh,
  faces: ArrayLike<number>,
  maxAngleDeg = 15,
  maxPlanarity = 0.02,
): KernelResult<number> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const ptr = wasm.mk_scratch_ensure(Math.max(4, faces.length * 4));
  writeI32(wasm, ptr, faces);
  const r = wasm.mk_mesh_cleanup_quads(
    mesh.rawHandle,
    ptr,
    faces.length,
    maxAngleDeg,
    maxPlanarity,
  );
  mesh.syncAfterExternalWrite();
  return r >= 0 ? ok(r) : err(readError(wasm));
}

export function rustExtCleanupSlivers(
  mesh: RustEditMesh,
  faces: ArrayLike<number>,
  width: number,
  tolerance: number,
): KernelResult<{ readonly removed: number; readonly kept: number }> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const base = wasm.mk_scratch_ensure(8 + Math.max(4, faces.length * 4));
  writeI32(wasm, base + 8, faces);
  const r = wasm.mk_mesh_cleanup_slivers(
    mesh.rawHandle,
    base + 8,
    faces.length,
    width,
    tolerance,
    base,
  );
  mesh.syncAfterExternalWrite();
  if (r !== 0) return err(readError(wasm));
  const out = new Uint32Array(wasm.memory.buffer, base, 2);
  return ok({ removed: out[0] ?? 0, kept: out[1] ?? 0 });
}

export function rustExtResolveTJunctions(
  mesh: RustEditMesh,
  distance: number,
): KernelResult<number> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const r = wRes.value.mk_mesh_resolve_t_junctions(mesh.rawHandle, distance);
  mesh.syncAfterExternalWrite();
  return r >= 0 ? ok(r) : err(readError(wRes.value));
}

export function rustExtSimplify(
  mesh: RustEditMesh,
  faces: ArrayLike<number>,
  options: {
    readonly targetFaces?: number;
    readonly maxError?: number;
    readonly constraintBits?: number;
    readonly silhouetteEyes?: readonly (readonly [number, number, number])[];
    readonly silhouetteWeight?: number;
  },
): KernelResult<{ readonly triangles: number; readonly maxError: number }> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const eyes = options.silhouetteEyes ?? [];
  const fBytes = align8(Math.max(4, faces.length * 4));
  const eBytes = align8(Math.max(8, eyes.length * 24));
  const base = align8(wasm.mk_scratch_ensure(fBytes + eBytes + 16));
  writeI32(wasm, base, faces);
  const ePtr = base + fBytes;
  if (eyes.length > 0) {
    const flat: number[] = [];
    for (const e of eyes) flat.push(e[0], e[1], e[2]);
    writeF64(wasm, ePtr, flat);
  }
  const outErrPtr = ePtr + eBytes;
  const tris = wasm.mk_mesh_simplify(
    mesh.rawHandle,
    base,
    faces.length,
    options.targetFaces ?? -1,
    options.maxError ?? -1,
    options.constraintBits ?? packPreserveConstraints(),
    eyes.length > 0 ? ePtr : 0,
    eyes.length,
    options.silhouetteWeight ?? 0,
    outErrPtr,
  );
  mesh.syncAfterExternalWrite();
  if (tris < 0) return err(readError(wasm));
  const errArr = new Float64Array(wasm.memory.buffer, outErrPtr, 1);
  return ok({ triangles: tris, maxError: errArr[0] ?? 0 });
}

export function rustExtRemesh(
  mesh: RustEditMesh,
  faces: ArrayLike<number>,
  options: {
    readonly targetEdgeLength: number;
    readonly iterations?: number;
    readonly smoothWeight?: number;
    readonly constraintBits?: number;
  },
): KernelResult<number> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const ptr = wasm.mk_scratch_ensure(Math.max(4, faces.length * 4));
  writeI32(wasm, ptr, faces);
  const r = wasm.mk_mesh_remesh(
    mesh.rawHandle,
    ptr,
    faces.length,
    options.targetEdgeLength,
    options.iterations ?? 5,
    options.smoothWeight ?? 0.5,
    options.constraintBits ?? packPreserveConstraints(),
  );
  mesh.syncAfterExternalWrite();
  return r >= 0 ? ok(r) : err(readError(wasm));
}

export function rustExtLowpoly(
  mesh: RustEditMesh,
  faces: ArrayLike<number>,
  options: {
    readonly targetFaces: number;
    readonly hardAngle?: number;
    readonly maxError?: number;
    readonly rolesFormOnly?: boolean;
    readonly autoUv?: boolean;
    readonly uvResolution?: number;
    readonly uvPadding?: number;
    readonly preserveGroups?: boolean;
    readonly groupPrefix?: string;
    readonly tolerance?: number;
  },
): KernelResult<{
  readonly triangles: number;
  readonly quads: number;
  readonly components: number;
  readonly charts: number;
  readonly usedVoxelFallback: boolean;
}> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const pref = textEncoder.encode(options.groupPrefix ?? 'part_');
  const fBytes = align4(Math.max(4, faces.length * 4));
  const pBytes = align4(Math.max(4, pref.byteLength));
  const base = wasm.mk_scratch_ensure(fBytes + pBytes + 32);
  writeI32(wasm, base, faces);
  const pPtr = base + fBytes;
  writeU8(wasm, pPtr, pref);
  const outPtr = pPtr + pBytes;
  const r = wasm.mk_mesh_lowpoly(
    mesh.rawHandle,
    base,
    faces.length,
    options.targetFaces,
    options.hardAngle ?? 40,
    options.maxError ?? -1,
    options.rolesFormOnly ? 1 : 0,
    options.autoUv !== false ? 1 : 0,
    options.uvResolution ?? 512,
    options.uvPadding ?? 4,
    options.preserveGroups !== false ? 1 : 0,
    pPtr,
    pref.byteLength,
    options.tolerance ?? 1e-5,
    outPtr,
  );
  mesh.syncAfterExternalWrite();
  if (r !== 0) return err(readError(wasm));
  const out = new Uint32Array(wasm.memory.buffer, outPtr, 5);
  return ok({
    triangles: out[0] ?? 0,
    quads: out[1] ?? 0,
    components: out[2] ?? 0,
    charts: out[3] ?? 0,
    usedVoxelFallback: (out[4] ?? 0) !== 0,
  });
}

export function rustExtShell(
  mesh: RustEditMesh,
  faces: ArrayLike<number>,
  thickness: number,
  direction: 'in' | 'out' | 'both' = 'in',
  attr: { readonly label?: number; readonly material?: number; readonly tag?: number } = {},
): KernelResult<number> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const ptr = wasm.mk_scratch_ensure(Math.max(4, faces.length * 4));
  writeI32(wasm, ptr, faces);
  const d = direction === 'out' ? 1 : direction === 'both' ? 0 : -1;
  const r = wasm.mk_mesh_shell(
    mesh.rawHandle,
    ptr,
    faces.length,
    thickness,
    d,
    attr.label ?? 0,
    attr.material ?? 0,
    attr.tag ?? -1,
  );
  mesh.syncAfterExternalWrite();
  return r >= 0 ? ok(r) : err(readError(wasm));
}

export function rustExtDeformBend(
  mesh: RustEditMesh,
  verts: ArrayLike<number>,
  axis: number,
  toward: number,
  angleDeg: number,
  range?: readonly [number, number],
  origin?: readonly [number, number, number],
): KernelResult<number> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const ptr = wasm.mk_scratch_ensure(Math.max(4, verts.length * 4));
  writeI32(wasm, ptr, verts);
  const r = wasm.mk_mesh_bend(
    mesh.rawHandle,
    ptr,
    verts.length,
    axis,
    toward,
    angleDeg,
    range !== undefined ? 1 : 0,
    range?.[0] ?? 0,
    range?.[1] ?? 0,
    origin !== undefined ? 1 : 0,
    origin?.[0] ?? 0,
    origin?.[1] ?? 0,
    origin?.[2] ?? 0,
  );
  mesh.syncAfterExternalWrite();
  return r >= 0 ? ok(r) : err(readError(wasm));
}

export function rustExtDeformTwist(
  mesh: RustEditMesh,
  verts: ArrayLike<number>,
  axis: number,
  angleDeg: number,
  range?: readonly [number, number],
  origin?: readonly [number, number, number],
): KernelResult<number> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const ptr = wasm.mk_scratch_ensure(Math.max(4, verts.length * 4));
  writeI32(wasm, ptr, verts);
  const r = wasm.mk_mesh_twist(
    mesh.rawHandle,
    ptr,
    verts.length,
    axis,
    angleDeg,
    range !== undefined ? 1 : 0,
    range?.[0] ?? 0,
    range?.[1] ?? 0,
    origin !== undefined ? 1 : 0,
    origin?.[0] ?? 0,
    origin?.[1] ?? 0,
    origin?.[2] ?? 0,
  );
  mesh.syncAfterExternalWrite();
  return r >= 0 ? ok(r) : err(readError(wasm));
}

export function rustExtUvOverlaps(
  mesh: RustEditMesh,
  faces: ArrayLike<number>,
  channel = 'uv0',
): KernelResult<readonly [number, number][]> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const cid = CHANNEL_IDS[channel] ?? 0;
  const ptr = wasm.mk_scratch_ensure(Math.max(4, faces.length * 4));
  writeI32(wasm, ptr, faces);
  const count = wasm.mk_mesh_uv_overlaps(mesh.rawHandle, ptr, faces.length, cid);
  if (count < 0) return err(readError(wasm));
  const outPtr = wasm.mk_scratch_ensure(count * 8);
  const view = new Int32Array(wasm.memory.buffer, outPtr, count * 2);
  const pairs: [number, number][] = [];
  for (let i = 0; i < count; i++) pairs.push([view[i * 2] ?? 0, view[i * 2 + 1] ?? 0]);
  return ok(pairs);
}

export function rustExtSkinBind(
  mesh: RustEditMesh,
  bones: readonly {
    readonly root: readonly [number, number, number];
    readonly tips: readonly (readonly [number, number, number])[];
  }[],
  falloff = 4.0,
  gridRes = 24,
): KernelResult<{ readonly joints: Uint16Array; readonly weights: Float32Array }> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const vhw = mesh.counts().vertexHighWater;
  const totalTips = bones.reduce((s, b) => s + b.tips.length, 0);
  const rootsBytes = bones.length * 24;
  const tipsBytes = align8(Math.max(8, totalTips * 24));
  const tcBytes = align8(Math.max(8, bones.length * 4));
  const ojBytes = align8(Math.max(8, vhw * 4 * 2));
  const owBytes = Math.max(8, vhw * 4 * 4);
  const base = align8(
    wasm.mk_scratch_ensure(rootsBytes + tipsBytes + tcBytes + ojBytes + owBytes + 16),
  );
  const rootsPtr = base;
  const tipsPtr = rootsPtr + rootsBytes;
  const tcPtr = tipsPtr + tipsBytes;
  const ojPtr = tcPtr + tcBytes;
  const owPtr = ojPtr + ojBytes;

  const flatRoots: number[] = [];
  const flatTips: number[] = [];
  const tc: number[] = [];
  for (const b of bones) {
    flatRoots.push(b.root[0], b.root[1], b.root[2]);
    tc.push(b.tips.length);
    for (const t of b.tips) flatTips.push(t[0], t[1], t[2]);
  }
  writeF64(wasm, rootsPtr, flatRoots);
  writeF64(wasm, tipsPtr, flatTips);
  writeU32(wasm, tcPtr, tc);

  const st = wasm.mk_mesh_skin_bind(
    mesh.rawHandle,
    rootsPtr,
    tipsPtr,
    tcPtr,
    bones.length,
    falloff,
    gridRes,
    ojPtr,
    owPtr,
  );
  if (st !== 0) return err(readError(wasm));
  return ok({
    joints: new Uint16Array(wasm.memory.buffer, ojPtr, vhw * 4).slice(),
    weights: new Float32Array(wasm.memory.buffer, owPtr, vhw * 4).slice(),
  });
}

export function rustExtQuality(
  mesh: RustEditMesh,
  faces: ArrayLike<number>,
): KernelResult<{
  readonly vertices: number;
  readonly faces: number;
  readonly boundaryEdges: number;
  readonly nonManifoldEdges: number;
  readonly degenerateFaces: number;
  readonly minEdge: number;
  readonly maxEdge: number;
  readonly maxAspect: number;
}> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const fBytes = align8(Math.max(8, faces.length * 4));
  const base = align8(wasm.mk_scratch_ensure(fBytes + 64 + 8));
  writeI32(wasm, base, faces);
  const outPtr = base + fBytes;
  const st = wasm.mk_mesh_quality(mesh.rawHandle, base, faces.length, outPtr);
  if (st !== 0) return err(readError(wasm));
  const q = new Float64Array(wasm.memory.buffer, outPtr, 8);
  return ok({
    vertices: q[0] ?? 0,
    faces: q[1] ?? 0,
    boundaryEdges: q[2] ?? 0,
    nonManifoldEdges: q[3] ?? 0,
    degenerateFaces: q[4] ?? 0,
    minEdge: q[5] ?? 0,
    maxEdge: q[6] ?? 0,
    maxAspect: q[7] ?? 0,
  });
}

export interface RustAttrInput {
  readonly label?: number;
  readonly material?: number;
  readonly tag?: number;
}

function runIndexOp(
  mesh: RustEditMesh,
  indices: ArrayLike<number>,
  invoke: (wasm: ModelingKernelWasmExports, ptr: number, len: number) => number,
): KernelResult<number> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const ptr = align4(wasm.mk_scratch_ensure(Math.max(4, indices.length * 4) + 4));
  writeI32(wasm, ptr, indices);
  const r = invoke(wasm, ptr, indices.length);
  mesh.syncAfterExternalWrite();
  return r >= 0 ? ok(r) : err(readError(wasm));
}

export function rustExtCleanupTiling(
  mesh: RustEditMesh,
  faces: ArrayLike<number>,
  maxAspect = 4,
  maxError = 0.01,
  iterations = 2,
): KernelResult<number> {
  return runIndexOp(mesh, faces, (wasm, ptr, len) =>
    wasm.mk_mesh_cleanup_tiling(mesh.rawHandle, ptr, len, maxAspect, maxError, iterations),
  );
}

export function rustExtVoxelRemesh(
  mesh: RustEditMesh,
  faces: ArrayLike<number>,
  options: {
    readonly mode: 'fill' | 'offset';
    readonly distance?: number;
    readonly voxelSize: number;
    readonly band?: number;
    readonly label?: number;
    readonly material?: number;
    readonly tag?: number;
  },
): KernelResult<number> {
  return runIndexOp(mesh, faces, (wasm, ptr, len) =>
    wasm.mk_mesh_voxel_remesh(
      mesh.rawHandle,
      ptr,
      len,
      options.mode === 'offset' ? 1 : 0,
      options.distance ?? 0,
      options.voxelSize,
      options.band ?? 3,
      options.label ?? 0,
      options.material ?? 0,
      options.tag ?? -1,
    ),
  );
}

export function rustExtDuplicate(
  mesh: RustEditMesh,
  faces: ArrayLike<number>,
  attr: RustAttrInput = {},
): KernelResult<number> {
  return runIndexOp(mesh, faces, (wasm, ptr, len) =>
    wasm.mk_mesh_duplicate(mesh.rawHandle, ptr, len, attr.label ?? 0, attr.tag ?? -1),
  );
}

export function rustExtDisconnect(
  mesh: RustEditMesh,
  faces: ArrayLike<number>,
): KernelResult<number> {
  return runIndexOp(mesh, faces, (wasm, ptr, len) =>
    wasm.mk_mesh_disconnect(mesh.rawHandle, ptr, len),
  );
}

export function rustExtBridge(
  mesh: RustEditMesh,
  edges: ArrayLike<number>,
  segments = 1,
  attr: RustAttrInput = {},
): KernelResult<number> {
  return runIndexOp(mesh, edges, (wasm, ptr, len) =>
    wasm.mk_mesh_bridge(
      mesh.rawHandle,
      ptr,
      len,
      segments,
      attr.label ?? 0,
      attr.material ?? 0,
      attr.tag ?? -1,
    ),
  );
}

export function rustExtLoopCut(
  mesh: RustEditMesh,
  edges: ArrayLike<number>,
  cuts = 1,
): KernelResult<number> {
  return runIndexOp(mesh, edges, (wasm, ptr, len) =>
    wasm.mk_mesh_loop_cut(mesh.rawHandle, ptr, len, cuts),
  );
}

export function rustExtPlaneCut(
  mesh: RustEditMesh,
  point: readonly [number, number, number],
  normal: readonly [number, number, number],
  options: {
    readonly positiveOnly?: boolean;
    readonly fillHolesCap?: boolean;
    readonly tolerance?: number;
    readonly label?: number;
    readonly material?: number;
    readonly tag?: number;
  } = {},
): KernelResult<number> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const r = wasm.mk_mesh_plane_cut(
    mesh.rawHandle,
    point[0],
    point[1],
    point[2],
    normal[0],
    normal[1],
    normal[2],
    options.positiveOnly ? 1 : 0,
    options.fillHolesCap ? 1 : 0,
    options.tolerance ?? 1e-5,
    options.label ?? 0,
    options.material ?? 0,
    options.tag ?? -1,
  );
  mesh.syncAfterExternalWrite();
  return r >= 0 ? ok(r) : err(readError(wasm));
}

export function rustExtHole(
  mesh: RustEditMesh,
  face: number,
  centers: readonly (readonly [number, number])[],
  diameter: number,
  depth: number,
  segments = 16,
  attr: RustAttrInput = {},
  tolerance = 1e-5,
): KernelResult<number> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const ptr = align8(wasm.mk_scratch_ensure(Math.max(16, centers.length * 16) + 8));
  const flat: number[] = [];
  for (const c of centers) flat.push(c[0], c[1]);
  writeF64(wasm, ptr, flat);
  const r = wasm.mk_mesh_hole(
    mesh.rawHandle,
    face,
    ptr,
    centers.length,
    diameter,
    depth,
    segments,
    attr.label ?? 0,
    attr.material ?? 0,
    attr.tag ?? -1,
    tolerance,
  );
  mesh.syncAfterExternalWrite();
  return r >= 0 ? ok(r) : err(readError(wasm));
}

export function rustExtPolygon(
  mesh: RustEditMesh,
  points: readonly (readonly [number, number])[],
  flip = false,
  attr: RustAttrInput = {},
): KernelResult<number> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const ptr = align8(wasm.mk_scratch_ensure(Math.max(16, points.length * 16) + 8));
  const flat: number[] = [];
  for (const p of points) flat.push(p[0], p[1]);
  writeF64(wasm, ptr, flat);
  const r = wasm.mk_mesh_polygon(
    mesh.rawHandle,
    ptr,
    points.length,
    flip ? 1 : 0,
    attr.label ?? 0,
    attr.material ?? 0,
    attr.tag ?? -1,
  );
  mesh.syncAfterExternalWrite();
  return r >= 0 ? ok(r) : err(readError(wasm));
}

export function rustExtCone(
  mesh: RustEditMesh,
  radius: number,
  height: number,
  radialSegments = 16,
  openEnded = false,
  center: readonly [number, number, number] = [0, 0, 0],
  attr: RustAttrInput = {},
): KernelResult<number> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const r = wasm.mk_mesh_cone(
    mesh.rawHandle,
    radius,
    height,
    radialSegments,
    openEnded ? 1 : 0,
    center[0],
    center[1],
    center[2],
    attr.label ?? 0,
    attr.material ?? 0,
    attr.tag ?? -1,
  );
  mesh.syncAfterExternalWrite();
  return r >= 0 ? ok(r) : err(readError(wasm));
}

export function rustExtExtrudePolygon(
  mesh: RustEditMesh,
  points: readonly (readonly [number, number])[],
  depth: number,
  attr: RustAttrInput = {},
): KernelResult<number> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const ptr = align8(wasm.mk_scratch_ensure(Math.max(16, points.length * 16) + 8));
  const flat: number[] = [];
  for (const p of points) flat.push(p[0], p[1]);
  writeF64(wasm, ptr, flat);
  const r = wasm.mk_mesh_extrude_polygon(
    mesh.rawHandle,
    ptr,
    points.length,
    depth,
    attr.label ?? 0,
    attr.material ?? 0,
    attr.tag ?? -1,
  );
  mesh.syncAfterExternalWrite();
  return r >= 0 ? ok(r) : err(readError(wasm));
}

export function rustExtLoft(
  mesh: RustEditMesh,
  sections: readonly (readonly (readonly [number, number, number])[])[],
  capped = true,
  attr: RustAttrInput = {},
): KernelResult<number> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const flatPts: number[] = [];
  const lens: number[] = [];
  for (const ring of sections) {
    lens.push(ring.length);
    for (const p of ring) flatPts.push(p[0], p[1], p[2]);
  }
  const pBytes = align8(Math.max(8, flatPts.length * 8));
  const lBytes = Math.max(4, lens.length * 4);
  const pPtr = align8(wasm.mk_scratch_ensure(pBytes + lBytes + 8));
  const lPtr = pPtr + pBytes;
  writeF64(wasm, pPtr, flatPts);
  writeU32(wasm, lPtr, lens);
  const r = wasm.mk_mesh_loft(
    mesh.rawHandle,
    pPtr,
    lPtr,
    sections.length,
    capped ? 1 : 0,
    attr.label ?? 0,
    attr.material ?? 0,
    attr.tag ?? -1,
  );
  mesh.syncAfterExternalWrite();
  return r >= 0 ? ok(r) : err(readError(wasm));
}

export function rustExtPipeNetwork(
  mesh: RustEditMesh,
  nodes: readonly (readonly [number, number, number])[],
  edges: readonly (readonly [number, number])[],
  radius: number,
  segments = 8,
  attr: RustAttrInput = {},
): KernelResult<number> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const flatNodes: number[] = [];
  for (const n of nodes) flatNodes.push(n[0], n[1], n[2]);
  const flatEdges: number[] = [];
  for (const e of edges) flatEdges.push(e[0], e[1]);
  const nBytes = align8(Math.max(8, flatNodes.length * 8));
  const eBytes = Math.max(8, flatEdges.length * 4);
  const nPtr = align8(wasm.mk_scratch_ensure(nBytes + eBytes + 8));
  const ePtr = nPtr + nBytes;
  writeF64(wasm, nPtr, flatNodes);
  writeU32(wasm, ePtr, flatEdges);
  const r = wasm.mk_mesh_pipe_network(
    mesh.rawHandle,
    nPtr,
    nodes.length,
    ePtr,
    edges.length,
    radius,
    segments,
    attr.label ?? 0,
    attr.material ?? 0,
    attr.tag ?? -1,
  );
  mesh.syncAfterExternalWrite();
  return r >= 0 ? ok(r) : err(readError(wasm));
}

export function rustExtLift(
  mesh: RustEditMesh,
  positions: Float32Array | ArrayLike<number>,
  indices: Uint32Array | ArrayLike<number>,
  uvs: Float32Array | ArrayLike<number> | undefined,
  creaseAngleDeg = 40,
  attr: RustAttrInput = {},
): KernelResult<number> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const vertCount = Math.floor(positions.length / 3);
  const pBytes = align4(Math.max(4, vertCount * 3 * 4));
  const iBytes = align4(Math.max(4, indices.length * 4));
  const uBytes = uvs ? align4(Math.max(4, vertCount * 2 * 4)) : 0;
  const pPtr = align4(wasm.mk_scratch_ensure(pBytes + iBytes + uBytes + 8));
  const iPtr = pPtr + pBytes;
  const uPtr = uvs ? iPtr + iBytes : 0;
  writeF32(wasm, pPtr, positions);
  writeU32(wasm, iPtr, indices);
  if (uvs) writeF32(wasm, uPtr, uvs);
  const r = wasm.mk_mesh_lift(
    mesh.rawHandle,
    pPtr,
    vertCount,
    iPtr,
    indices.length,
    uPtr,
    creaseAngleDeg,
    attr.label ?? 0,
    attr.material ?? 0,
    attr.tag ?? -1,
  );
  mesh.syncAfterExternalWrite();
  return r >= 0 ? ok(r) : err(readError(wasm));
}

export function rustExtLattice(
  mesh: RustEditMesh,
  verts: ArrayLike<number>,
  counts: readonly [number, number, number],
  offsets: readonly {
    readonly index: readonly [number, number, number];
    readonly offset: readonly [number, number, number];
  }[],
): KernelResult<number> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const flatIdx: number[] = [];
  const flatVec: number[] = [];
  for (const o of offsets) {
    flatIdx.push(o.index[0], o.index[1], o.index[2]);
    flatVec.push(o.offset[0], o.offset[1], o.offset[2]);
  }
  const vecBytes = align8(Math.max(8, flatVec.length * 8));
  const idxBytes = align4(Math.max(4, flatIdx.length * 4));
  const vBytes = align4(Math.max(4, verts.length * 4));
  const vecPtr = align8(wasm.mk_scratch_ensure(vecBytes + idxBytes + vBytes + 8));
  const idxPtr = vecPtr + vecBytes;
  const vPtr = idxPtr + idxBytes;
  writeF64(wasm, vecPtr, flatVec);
  writeU32(wasm, idxPtr, flatIdx);
  writeI32(wasm, vPtr, verts);
  const r = wasm.mk_mesh_lattice(
    mesh.rawHandle,
    vPtr,
    verts.length,
    counts[0],
    counts[1],
    counts[2],
    idxPtr,
    vecPtr,
    offsets.length,
  );
  mesh.syncAfterExternalWrite();
  return r >= 0 ? ok(r) : err(readError(wasm));
}

export function rustExtApplyDraft(
  mesh: RustEditMesh,
  faces: ArrayLike<number>,
  planePoint: readonly [number, number, number],
  planeNormal: readonly [number, number, number],
  angleDeg: number,
): KernelResult<number> {
  return runIndexOp(mesh, faces, (wasm, ptr, len) =>
    wasm.mk_mesh_apply_draft(
      mesh.rawHandle,
      ptr,
      len,
      planePoint[0],
      planePoint[1],
      planePoint[2],
      planeNormal[0],
      planeNormal[1],
      planeNormal[2],
      angleDeg,
    ),
  );
}

export function rustExtSpherize(
  mesh: RustEditMesh,
  verts: ArrayLike<number>,
  factor: number,
  radius = -1,
  center?: readonly [number, number, number],
): KernelResult<number> {
  return runIndexOp(mesh, verts, (wasm, ptr, len) =>
    wasm.mk_mesh_spherize(
      mesh.rawHandle,
      ptr,
      len,
      factor,
      radius,
      center !== undefined ? 1 : 0,
      center?.[0] ?? 0,
      center?.[1] ?? 0,
      center?.[2] ?? 0,
    ),
  );
}

export function rustExtCurveDeform(
  mesh: RustEditMesh,
  verts: ArrayLike<number>,
  path: readonly (readonly [number, number, number])[],
  axis = 2,
  origin?: readonly [number, number, number],
): KernelResult<number> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const flatPath: number[] = [];
  for (const p of path) flatPath.push(p[0], p[1], p[2]);
  const pBytes = align8(Math.max(8, flatPath.length * 8));
  const vBytes = align4(Math.max(4, verts.length * 4));
  const pPtr = align8(wasm.mk_scratch_ensure(pBytes + vBytes + 8));
  const vPtr = pPtr + pBytes;
  writeF64(wasm, pPtr, flatPath);
  writeI32(wasm, vPtr, verts);
  const r = wasm.mk_mesh_curve_deform(
    mesh.rawHandle,
    vPtr,
    verts.length,
    pPtr,
    path.length,
    axis,
    origin !== undefined ? 1 : 0,
    origin?.[0] ?? 0,
    origin?.[1] ?? 0,
    origin?.[2] ?? 0,
  );
  mesh.syncAfterExternalWrite();
  return r >= 0 ? ok(r) : err(readError(wasm));
}

export function rustExtSmooth(
  mesh: RustEditMesh,
  verts: ArrayLike<number>,
  lambda = 0.5,
  mu = -0.53,
  iterations = 1,
  pinBoundary = false,
  pinSharp = false,
): KernelResult<number> {
  return runIndexOp(mesh, verts, (wasm, ptr, len) =>
    wasm.mk_mesh_smooth(
      mesh.rawHandle,
      ptr,
      len,
      lambda,
      mu,
      iterations,
      pinBoundary ? 1 : 0,
      pinSharp ? 1 : 0,
    ),
  );
}

export function rustExtImplicitSmooth(
  mesh: RustEditMesh,
  verts: ArrayLike<number>,
  lambda = 0.5,
  iterations = 1,
  pins: ArrayLike<number> = [],
  pinBoundary = false,
  pinSharp = false,
  preserveVolume = false,
): KernelResult<number> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const vBytes = align4(Math.max(4, verts.length * 4));
  const pBytes = align4(Math.max(4, pins.length * 4));
  const vPtr = align4(wasm.mk_scratch_ensure(vBytes + pBytes + 8));
  const pPtr = vPtr + vBytes;
  writeI32(wasm, vPtr, verts);
  writeI32(wasm, pPtr, pins);
  const r = wasm.mk_mesh_implicit_smooth(
    mesh.rawHandle,
    vPtr,
    verts.length,
    lambda,
    iterations,
    pPtr,
    pins.length,
    pinBoundary ? 1 : 0,
    pinSharp ? 1 : 0,
    preserveVolume ? 1 : 0,
  );
  mesh.syncAfterExternalWrite();
  return r >= 0 ? ok(r) : err(readError(wasm));
}

export function rustExtArap(
  mesh: RustEditMesh,
  verts: ArrayLike<number>,
  constraints: readonly {
    readonly vertex: number;
    readonly position: readonly [number, number, number];
  }[],
  iterations = 8,
): KernelResult<number> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const cIds: number[] = [];
  const cPos: number[] = [];
  for (const c of constraints) {
    cIds.push(c.vertex);
    cPos.push(c.position[0], c.position[1], c.position[2]);
  }
  const posBytes = align8(Math.max(8, cPos.length * 8));
  const idBytes = align4(Math.max(4, cIds.length * 4));
  const vBytes = align4(Math.max(4, verts.length * 4));
  const posPtr = align8(wasm.mk_scratch_ensure(posBytes + idBytes + vBytes + 8));
  const idPtr = posPtr + posBytes;
  const vPtr = idPtr + idBytes;
  writeF64(wasm, posPtr, cPos);
  writeI32(wasm, idPtr, cIds);
  writeI32(wasm, vPtr, verts);
  const r = wasm.mk_mesh_arap(
    mesh.rawHandle,
    vPtr,
    verts.length,
    idPtr,
    posPtr,
    constraints.length,
    iterations,
  );
  mesh.syncAfterExternalWrite();
  return r >= 0 ? ok(r) : err(readError(wasm));
}

export function rustExtShrinkwrap(
  mesh: RustEditMesh,
  verts: ArrayLike<number>,
  targetPositions: Float64Array | ArrayLike<number>,
  targetIndices: Uint32Array | ArrayLike<number>,
  options: {
    readonly direction?: readonly [number, number, number];
    readonly offset?: number;
    readonly maxDistance?: number;
  } = {},
): KernelResult<number> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const targetVertCount = Math.floor(targetPositions.length / 3);
  const targetTriCount = Math.floor(targetIndices.length / 3);
  const tpBytes = align8(Math.max(8, targetVertCount * 3 * 8));
  const tiBytes = align4(Math.max(4, targetTriCount * 3 * 4));
  const vBytes = align4(Math.max(4, verts.length * 4));
  const tpPtr = align8(wasm.mk_scratch_ensure(tpBytes + tiBytes + vBytes + 8));
  const tiPtr = tpPtr + tpBytes;
  const vPtr = tiPtr + tiBytes;
  writeF64(wasm, tpPtr, targetPositions);
  writeU32(wasm, tiPtr, targetIndices);
  writeI32(wasm, vPtr, verts);
  const r = wasm.mk_mesh_shrinkwrap(
    mesh.rawHandle,
    vPtr,
    verts.length,
    tpPtr,
    targetVertCount,
    tiPtr,
    targetTriCount,
    options.direction !== undefined ? 1 : 0,
    options.direction?.[0] ?? 0,
    options.direction?.[1] ?? 0,
    options.direction?.[2] ?? 0,
    options.offset ?? 0,
    options.maxDistance ?? -1,
  );
  mesh.syncAfterExternalWrite();
  return r >= 0 ? ok(r) : err(readError(wasm));
}

export function rustExtUvPlanSeams(
  mesh: RustEditMesh,
  faces: ArrayLike<number>,
  maxAngleDeg = 45,
  respectSharp = true,
): KernelResult<number> {
  return runIndexOp(mesh, faces, (wasm, ptr, len) =>
    wasm.mk_mesh_uv_plan_seams(mesh.rawHandle, ptr, len, maxAngleDeg, respectSharp ? 1 : 0),
  );
}

export function rustExtUvStraighten(
  mesh: RustEditMesh,
  faces: ArrayLike<number>,
  channel = 'uv0',
  maxAngleDeg = 35,
): KernelResult<number> {
  const cid = CHANNEL_IDS[channel] ?? 0;
  return runIndexOp(mesh, faces, (wasm, ptr, len) =>
    wasm.mk_mesh_uv_straighten(mesh.rawHandle, ptr, len, cid, maxAngleDeg),
  );
}

export function rustExtUvLightmap(
  mesh: RustEditMesh,
  resolution = 512,
  paddingTexels = 4,
  channel = 'uv1',
): KernelResult<number> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const cid = CHANNEL_IDS[channel] ?? 1;
  const r = wasm.mk_mesh_uv_lightmap(mesh.rawHandle, resolution, paddingTexels, cid);
  mesh.syncAfterExternalWrite();
  return r >= 0 ? ok(r) : err(readError(wasm));
}

export function rustExtUvTrim(
  mesh: RustEditMesh,
  faces: ArrayLike<number>,
  uRange: readonly [number, number],
  vRange: readonly [number, number],
  tileU = true,
  channel = 'uv0',
): KernelResult<number> {
  const cid = CHANNEL_IDS[channel] ?? 0;
  return runIndexOp(mesh, faces, (wasm, ptr, len) =>
    wasm.mk_mesh_uv_trim(
      mesh.rawHandle,
      ptr,
      len,
      uRange[0],
      uRange[1],
      vRange[0],
      vRange[1],
      tileU ? 1 : 0,
      cid,
    ),
  );
}

export function rustExtUvSwatch(
  mesh: RustEditMesh,
  faces: ArrayLike<number>,
  uRange: readonly [number, number],
  vRange: readonly [number, number],
  channel = 'uv0',
): KernelResult<number> {
  const cid = CHANNEL_IDS[channel] ?? 0;
  return runIndexOp(mesh, faces, (wasm, ptr, len) =>
    wasm.mk_mesh_uv_swatch(
      mesh.rawHandle,
      ptr,
      len,
      uRange[0],
      uRange[1],
      vRange[0],
      vRange[1],
      cid,
    ),
  );
}

export function rustExtHausdorff(
  meshA: RustEditMesh,
  facesA: ArrayLike<number>,
  meshB: RustEditMesh,
  facesB: ArrayLike<number>,
): KernelResult<{ readonly max: number; readonly mean: number }> {
  const wRes = requireWasm();
  if (!wRes.ok) return wRes;
  const wasm = wRes.value;
  const aBytes = align4(Math.max(4, facesA.length * 4));
  const bBytes = align4(Math.max(4, facesB.length * 4));
  const outPtr = align8(wasm.mk_scratch_ensure(16 + aBytes + bBytes + 8));
  const aPtr = outPtr + 16;
  const bPtr = aPtr + aBytes;
  writeI32(wasm, aPtr, facesA);
  writeI32(wasm, bPtr, facesB);
  const st = wasm.mk_mesh_hausdorff(
    meshA.rawHandle,
    aPtr,
    facesA.length,
    meshB.rawHandle,
    bPtr,
    facesB.length,
    outPtr,
  );
  if (st !== 0) return err(readError(wasm));
  const out = new Float64Array(wasm.memory.buffer, outPtr, 2);
  return ok({ max: out[0] ?? 0, mean: out[1] ?? 0 });
}

export function rustExtLiveCorrespondCount(): number {
  return getModelingKernelWasm()?.mk_live_correspondences() ?? 0;
}
