// Zero-allocation binary FXK1 SceneDelta encoder (bit-identical with Rust kernel-core::scene).

import type { LightId, MaterialId, MeshId, RenderObjectId, TextureId } from './handles.js';

export const SCENE_DELTA_MAGIC = 0x4658_4b31; // "FXK1"
export const SCENE_DELTA_VERSION = 1;
export const SCENE_DELTA_HEADER_BYTES = 64;

export const DELTA_FLAG_BASELINE = 1 << 0;
export const DELTA_FLAG_TEMPORAL_RESET = 1 << 1;
export const DELTA_FLAG_CLEAR_SCENE = 1 << 2;

export const OP_UPSERT_OBJECTS = 0x01;
export const OP_REMOVE_OBJECTS = 0x02;
export const OP_SET_TRANSFORMS = 0x03;
export const OP_SET_SKIN_JOINTS = 0x04;
export const OP_SET_DRAW_PARAMS = 0x05;
export const OP_UPDATE_MATERIAL_PARAMS = 0x06;
export const OP_UPDATE_MATERIAL_BINDINGS = 0x07;
export const OP_SET_LIGHTS = 0x08;
export const OP_SET_ENVIRONMENT = 0x09;
export const OP_SET_INSTANCES = 0x0a;

export const OBJ_FLAG_VISIBLE = 1 << 0;
export const OBJ_FLAG_CAST_SHADOW = 1 << 1;
export const OBJ_FLAG_RECEIVE_SHADOW = 1 << 2;
export const OBJ_FLAG_FRUSTUM_CULLED = 1 << 3;
export const OBJ_FLAG_TRANSPARENT = 1 << 4;
export const OBJ_FLAG_MASKED = 1 << 5;
export const OBJ_FLAG_GPU_DRIVEN = 1 << 6;

export const LIGHT_KIND_DIRECTIONAL = 0;
export const LIGHT_KIND_POINT = 1;
export const LIGHT_KIND_SPOT = 2;

export const UPSERT_RECORD_WORDS = 14;
export const LIGHT_RECORD_WORDS = 16;

export interface UpsertObjectInput {
  readonly objectId: RenderObjectId;
  readonly meshId: MeshId;
  readonly submeshStart?: number;
  readonly submeshCount?: number;
  readonly materialId: MaterialId;
  readonly layerMask?: number;
  readonly objFlags?: number;
  readonly skinSlot?: number;
  readonly queue?: number;
  readonly entityOrder?: number;
  readonly localBoundsMin: readonly [number, number, number];
  readonly localBoundsMax: readonly [number, number, number];
}

export interface LightInput {
  readonly lightId: LightId;
  readonly kind: 0 | 1 | 2;
  readonly castShadow: boolean;
  readonly cascadeCount?: number;
  readonly layerMask?: number;
  readonly range?: number;
  readonly position: readonly [number, number, number];
  readonly intensity: number;
  readonly direction: readonly [number, number, number];
  readonly outerConeCos?: number;
  readonly color: readonly [number, number, number];
}

export interface EnvironmentInput {
  readonly skylightColor: readonly [number, number, number];
  readonly skylightIntensity: number;
  readonly groundColor: readonly [number, number, number];
  readonly fogMode: number;
  readonly fogDensity: number;
  readonly fogHeightFalloff: number;
  readonly fogNear: number;
  readonly fogFar: number;
  readonly iblTextureId: TextureId | 0;
}

/**
 * Reusable zero-allocation FXK1 binary writer.
 * Can write directly into an owned ArrayBuffer OR a WASM linear memory slice.
 */
export class SceneDeltaWriter {
  private buffer: ArrayBuffer;
  private u8: Uint8Array;
  private dv: DataView;
  private byteCursor = SCENE_DELTA_HEADER_BYTES;
  private opCount = 0;
  private externalResize?: (minBytes: number) => Uint8Array;

  constructor(initialBytes = 64 * 1024) {
    this.buffer = new ArrayBuffer(initialBytes);
    this.u8 = new Uint8Array(this.buffer);
    this.dv = new DataView(this.buffer);
  }

  /** Rebinds this writer onto an external backing view (e.g. WASM linear memory). */
  bindExternal(view: Uint8Array, resize: (minBytes: number) => Uint8Array): void {
    this.buffer = view.buffer as ArrayBuffer;
    this.u8 = view;
    this.dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
    this.externalResize = resize;
  }

  reset(
    epoch: number,
    revision: number,
    baseRevision: number,
    flags: number,
    elapsedSeconds = 0,
    deltaSeconds = 1 / 60,
    sampleTimeSeconds = elapsedSeconds,
    sortConfigBits = 0,
  ): this {
    this.ensureCapacity(SCENE_DELTA_HEADER_BYTES);
    this.dv.setUint32(0, SCENE_DELTA_MAGIC, true);
    this.dv.setUint32(4, SCENE_DELTA_VERSION, true);
    this.dv.setUint32(8, epoch >>> 0, true);
    this.dv.setUint32(12, revision >>> 0, true);
    this.dv.setUint32(16, baseRevision >>> 0, true);
    this.dv.setUint32(20, flags >>> 0, true);
    this.dv.setUint32(24, 0, true); // opCount patched in finish()
    this.dv.setUint32(28, 0, true); // payloadBytes patched in finish()
    this.dv.setFloat64(32, elapsedSeconds, true);
    this.dv.setFloat64(40, deltaSeconds, true);
    this.dv.setFloat64(48, sampleTimeSeconds, true);
    this.dv.setUint32(56, sortConfigBits >>> 0, true);
    this.dv.setUint32(60, 0, true);
    this.byteCursor = SCENE_DELTA_HEADER_BYTES;
    this.opCount = 0;
    return this;
  }

  private ensureCapacity(minBytes: number): void {
    if (minBytes <= this.u8.byteLength) return;
    if (this.externalResize !== undefined) {
      const next = this.externalResize(minBytes);
      this.buffer = next.buffer as ArrayBuffer;
      this.u8 = next;
      this.dv = new DataView(next.buffer, next.byteOffset, next.byteLength);
      return;
    }
    let nextLen = this.u8.byteLength || 4096;
    while (nextLen < minBytes) nextLen *= 2;
    const nextBuf = new ArrayBuffer(nextLen);
    const nextU8 = new Uint8Array(nextBuf);
    nextU8.set(this.u8.subarray(0, this.byteCursor));
    this.buffer = nextBuf;
    this.u8 = nextU8;
    this.dv = new DataView(nextBuf);
  }

  upsertObjects(objects: readonly UpsertObjectInput[]): this {
    const count = objects.length;
    if (count === 0) return this;
    const bytes = 8 + count * UPSERT_RECORD_WORDS * 4;
    this.ensureCapacity(this.byteCursor + bytes);
    let p = this.byteCursor;
    this.dv.setUint32(p, OP_UPSERT_OBJECTS, true);
    this.dv.setUint32(p + 4, count >>> 0, true);
    p += 8;
    for (let i = 0; i < count; i++) {
      const o = objects[i] as UpsertObjectInput;
      this.dv.setUint32(p, o.objectId >>> 0, true);
      this.dv.setUint32(p + 4, o.meshId >>> 0, true);
      this.dv.setUint32(
        p + 8,
        ((((o.submeshStart ?? 0) & 0xffff) << 16) | ((o.submeshCount ?? 1) & 0xffff)) >>> 0,
        true,
      );
      this.dv.setUint32(p + 12, o.materialId >>> 0, true);
      this.dv.setUint32(p + 16, (o.layerMask ?? 0xffff_ffff) >>> 0, true);
      this.dv.setUint32(
        p + 20,
        (o.objFlags ?? OBJ_FLAG_VISIBLE | OBJ_FLAG_CAST_SHADOW | OBJ_FLAG_FRUSTUM_CULLED) >>> 0,
        true,
      );
      this.dv.setUint32(p + 24, (o.skinSlot ?? 0) >>> 0, true);
      this.dv.setUint32(
        p + 28,
        ((((o.queue ?? 1000) & 0xffff) << 16) | ((o.entityOrder ?? 0) & 0xffff)) >>> 0,
        true,
      );
      this.dv.setFloat32(p + 32, o.localBoundsMin[0], true);
      this.dv.setFloat32(p + 36, o.localBoundsMin[1], true);
      this.dv.setFloat32(p + 40, o.localBoundsMin[2], true);
      this.dv.setFloat32(p + 44, o.localBoundsMax[0], true);
      this.dv.setFloat32(p + 48, o.localBoundsMax[1], true);
      this.dv.setFloat32(p + 52, o.localBoundsMax[2], true);
      p += UPSERT_RECORD_WORDS * 4;
    }
    this.byteCursor = p;
    this.opCount += 1;
    return this;
  }

  removeObjects(objectIds: ArrayLike<number>): this {
    const count = objectIds.length;
    if (count === 0) return this;
    const bytes = 8 + count * 4;
    this.ensureCapacity(this.byteCursor + bytes);
    let p = this.byteCursor;
    this.dv.setUint32(p, OP_REMOVE_OBJECTS, true);
    this.dv.setUint32(p + 4, count >>> 0, true);
    p += 8;
    for (let i = 0; i < count; i++) {
      this.dv.setUint32(p, (objectIds[i] ?? 0) >>> 0, true);
      p += 4;
    }
    this.byteCursor = p;
    this.opCount += 1;
    return this;
  }

  /** Bulk writes column-major 4x4 matrices (`matrices.length >= count * 16`). */
  setTransforms(
    objectIds: ArrayLike<number>,
    matrices: Float32Array,
    count = objectIds.length,
  ): this {
    if (count === 0) return this;
    const bytes = 8 + count * 4 + count * 64;
    this.ensureCapacity(this.byteCursor + bytes);
    let p = this.byteCursor;
    this.dv.setUint32(p, OP_SET_TRANSFORMS, true);
    this.dv.setUint32(p + 4, count >>> 0, true);
    p += 8;
    for (let i = 0; i < count; i++) {
      this.dv.setUint32(p, (objectIds[i] ?? 0) >>> 0, true);
      p += 4;
    }
    const srcBytes = new Uint8Array(matrices.buffer, matrices.byteOffset, count * 64);
    this.u8.set(srcBytes, p);
    this.byteCursor = p + count * 64;
    this.opCount += 1;
    return this;
  }

  /** Streams packed column-major mat4x4 joint matrices (`matrices.length >= jointCount * 16`). */
  setSkinJoints(
    jointOffset: number,
    matrices: Float32Array,
    jointCount = Math.floor(matrices.length / 16),
  ): this {
    if (jointCount <= 0) return this;
    const payloadBytes = 8 + jointCount * 64;
    this.ensureCapacity(this.byteCursor + 8 + payloadBytes);
    let p = this.byteCursor;
    this.dv.setUint32(p, OP_SET_SKIN_JOINTS, true);
    this.dv.setUint32(p + 4, payloadBytes >>> 0, true);
    this.dv.setUint32(p + 8, jointOffset >>> 0, true);
    this.dv.setUint32(p + 12, jointCount >>> 0, true);
    p += 16;
    const srcBytes = new Uint8Array(matrices.buffer, matrices.byteOffset, jointCount * 64);
    this.u8.set(srcBytes, p);
    this.byteCursor = p + jointCount * 64;
    this.opCount += 1;
    return this;
  }

  /** Bulk writes 8-float per-object draw params (`params.length >= count * 8`). */
  setDrawParams(
    objectIds: ArrayLike<number>,
    params: Float32Array,
    count = objectIds.length,
  ): this {
    if (count === 0) return this;
    const bytes = 8 + count * 36;
    this.ensureCapacity(this.byteCursor + bytes);
    let p = this.byteCursor;
    this.dv.setUint32(p, OP_SET_DRAW_PARAMS, true);
    this.dv.setUint32(p + 4, count >>> 0, true);
    p += 8;
    for (let i = 0; i < count; i++) {
      this.dv.setUint32(p, (objectIds[i] ?? 0) >>> 0, true);
      const base = i * 8;
      for (let k = 0; k < 8; k++) {
        this.dv.setFloat32(p + 4 + k * 4, params[base + k] ?? 0, true);
      }
      p += 36;
    }
    this.byteCursor = p;
    this.opCount += 1;
    return this;
  }

  updateMaterialParams(materialId: MaterialId, byteOffset: number, payload: Uint8Array): this {
    const byteLen = payload.byteLength;
    const aligned = (byteLen + 3) & ~3;
    const total = 16 + aligned;
    this.ensureCapacity(this.byteCursor + total);
    let p = this.byteCursor;
    this.dv.setUint32(p, OP_UPDATE_MATERIAL_PARAMS, true);
    this.dv.setUint32(p + 4, 1, true);
    this.dv.setUint32(p + 8, materialId >>> 0, true);
    this.dv.setUint32(p + 12, (((byteLen & 0xffff) << 16) | (byteOffset & 0xffff)) >>> 0, true);
    p += 16;
    this.u8.set(payload, p);
    for (let z = byteLen; z < aligned; z++) this.u8[p + z] = 0;
    this.byteCursor = p + aligned;
    this.opCount += 1;
    return this;
  }

  setLights(lights: readonly LightInput[]): this {
    const count = lights.length;
    const bytes = 8 + count * LIGHT_RECORD_WORDS * 4;
    this.ensureCapacity(this.byteCursor + bytes);
    let p = this.byteCursor;
    this.dv.setUint32(p, OP_SET_LIGHTS, true);
    this.dv.setUint32(p + 4, count >>> 0, true);
    p += 8;
    for (let i = 0; i < count; i++) {
      const l = lights[i] as LightInput;
      this.dv.setUint32(p, l.lightId >>> 0, true);
      this.dv.setUint32(
        p + 4,
        ((l.kind & 0xff) |
          ((l.castShadow ? 1 : 0) << 8) |
          (((l.cascadeCount ?? 1) & 0xff) << 16)) >>>
          0,
        true,
      );
      this.dv.setUint32(p + 8, (l.layerMask ?? 0xffff_ffff) >>> 0, true);
      this.dv.setFloat32(p + 12, l.range ?? Number.POSITIVE_INFINITY, true);
      this.dv.setFloat32(p + 16, l.position[0], true);
      this.dv.setFloat32(p + 20, l.position[1], true);
      this.dv.setFloat32(p + 24, l.position[2], true);
      this.dv.setFloat32(p + 28, l.intensity, true);
      this.dv.setFloat32(p + 32, l.direction[0], true);
      this.dv.setFloat32(p + 36, l.direction[1], true);
      this.dv.setFloat32(p + 40, l.direction[2], true);
      this.dv.setFloat32(p + 44, l.outerConeCos ?? 0.5, true);
      this.dv.setFloat32(p + 48, l.color[0], true);
      this.dv.setFloat32(p + 52, l.color[1], true);
      this.dv.setFloat32(p + 56, l.color[2], true);
      this.dv.setUint32(p + 60, 0, true);
      p += LIGHT_RECORD_WORDS * 4;
    }
    this.byteCursor = p;
    this.opCount += 1;
    return this;
  }

  setEnvironment(env: EnvironmentInput): this {
    this.ensureCapacity(this.byteCursor + 72);
    let p = this.byteCursor;
    this.dv.setUint32(p, OP_SET_ENVIRONMENT, true);
    this.dv.setUint32(p + 4, 1, true);
    p += 8;
    this.dv.setFloat32(p, env.skylightColor[0], true);
    this.dv.setFloat32(p + 4, env.skylightColor[1], true);
    this.dv.setFloat32(p + 8, env.skylightColor[2], true);
    this.dv.setFloat32(p + 12, env.skylightIntensity, true);
    this.dv.setFloat32(p + 16, env.groundColor[0], true);
    this.dv.setFloat32(p + 20, env.groundColor[1], true);
    this.dv.setFloat32(p + 24, env.groundColor[2], true);
    this.dv.setUint32(p + 28, env.fogMode >>> 0, true);
    this.dv.setFloat32(p + 32, env.fogDensity, true);
    this.dv.setFloat32(p + 36, env.fogHeightFalloff, true);
    this.dv.setFloat32(p + 40, env.fogNear, true);
    this.dv.setFloat32(p + 44, env.fogFar, true);
    this.dv.setUint32(p + 48, env.iblTextureId >>> 0, true);
    this.dv.setUint32(p + 52, 0, true);
    this.dv.setUint32(p + 56, 0, true);
    this.dv.setUint32(p + 60, 0, true);
    this.byteCursor = p + 64;
    this.opCount += 1;
    return this;
  }

  finish(): Uint8Array {
    const payloadBytes = this.byteCursor - SCENE_DELTA_HEADER_BYTES;
    this.dv.setUint32(24, this.opCount >>> 0, true);
    this.dv.setUint32(28, payloadBytes >>> 0, true);
    return this.u8.subarray(0, this.byteCursor);
  }

  get byteLength(): number {
    return this.byteCursor;
  }
}
