import type { Result } from '@forgeax/engine-types';
import type { ModelingError } from './errors';
import { type CornerChannelName, EditMesh } from './mesh';

/** Execution backend policy shared by modeling sessions and operators. */
export type KernelPolicy = 'auto' | 'rust' | 'ts';

/** Opaque handle to a point-in-time mesh snapshot owned by an EditMeshStore. */
export interface MeshSnapshotToken {
  readonly id: number;
}

/** Zero-copy view of one per-corner attribute channel (uv0..uv7 / color). */
export interface CornerChannelView {
  readonly dim: number;
  readonly values: Float32Array;
  readonly set: Uint8Array;
}

/**
 * Zero-copy SoA views over the editable half-edge mesh.
 *
 * Views stay valid until a topology mutator triggers backing reallocation
 * (signaled by `memoryGeneration` advancing). Pure geometry loops may hoist
 * `pos` once; topology loops must re-read `store.views()` after growth.
 */
export interface EditMeshSoaViews {
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

/**
 * Unified storage abstraction for editable half-edge meshes.
 *
 * Both `TsEditMeshStore` (pure TS) and `RustEditMeshStore` (WASM/Native linear
 * memory) implement this contract so retained TS operators can execute
 * zero-copy directly against either backing without FXEM round-trips.
 */
export interface EditMeshStore {
  readonly backend: 'rust' | 'ts';
  readonly topologyStamp: number;
  readonly shapeStamp: number;
  readonly vertexCount: number;
  readonly faceCount: number;
  readonly edgeCount: number;

  views(): EditMeshSoaViews;
  channelViews(name: CornerChannelName): CornerChannelView | undefined;
  bumpShapeStamp(): void;

  addVertex(x: number, y: number, z: number): number;
  removeVertex(v: number): void;
  setPosition(v: number, x: number, y: number, z: number): void;
  addFace(loop: readonly number[], material?: number): Result<number, ModelingError>;
  removeFace(f: number): void;
  findHalf(a: number, b: number): number;
  ensureChannel(name: CornerChannelName): void;
  setCorner(name: CornerChannelName, h: number, value: ArrayLike<number>): void;

  internTag(name: string, create: boolean): number;
  internLabel(name: string): number;
  internRole(name: string): number;
  internMaterial(name: string): number;

  takeSnapshot(): MeshSnapshotToken;
  restoreSnapshot(token: MeshSnapshotToken): void;
  releaseSnapshot(token: MeshSnapshotToken): void;
  dispose(): void;
}

/** Pure TypeScript EditMeshStore backing (full TS fallback and differential baseline). */
export class TsEditMeshStore implements EditMeshStore {
  readonly backend = 'ts' as const;
  private memoryGeneration = 0;
  private nextSnapshotId = 1;
  private readonly snapshots = new Map<number, EditMesh>();

  readonly mesh: EditMesh;

  constructor(mesh: EditMesh = new EditMesh()) {
    this.mesh = mesh;
  }

  get topologyStamp(): number {
    return this.mesh.topologyStamp;
  }

  get shapeStamp(): number {
    return this.mesh.shapeStamp;
  }

  get vertexCount(): number {
    return this.mesh.vertexCount;
  }

  get faceCount(): number {
    return this.mesh.faceCount;
  }

  get edgeCount(): number {
    return this.mesh.edgeCount;
  }

  views(): EditMeshSoaViews {
    const m = this.mesh;
    return {
      memoryGeneration: this.memoryGeneration,
      vertexHighWater: m.vertexHighWater,
      halfHighWater: m.halfHighWater,
      faceHighWater: m.faceHighWater,
      tagWords: m.tagWords,
      pos: m.pos,
      vGen: m.vGen,
      hVert: m.hVert,
      hNext: m.hNext,
      hPrev: m.hPrev,
      hFace: m.hFace,
      eFlags: m.eFlags,
      fHalf: m.fHalf,
      fLen: m.fLen,
      fGen: m.fGen,
      fMaterial: m.fMaterial,
      fLabel: m.fLabel,
      fRole: m.fRole,
      fFlags: m.fFlags,
      fTags: m.fTags,
    };
  }

  channelViews(name: CornerChannelName): CornerChannelView | undefined {
    const channel = this.mesh.channels.get(name);
    if (channel === undefined) return undefined;
    return {
      dim: channel.dim,
      values: channel.values,
      set: channel.set,
    };
  }

  bumpShapeStamp(): void {
    this.mesh.shapeStamp++;
  }

  addVertex(x: number, y: number, z: number): number {
    const prevBuf = this.mesh.pos.buffer;
    const v = this.mesh.addVertex(x, y, z);
    if (this.mesh.pos.buffer !== prevBuf) this.memoryGeneration++;
    return v;
  }

  removeVertex(v: number): void {
    this.mesh.removeVertex(v);
  }

  setPosition(v: number, x: number, y: number, z: number): void {
    this.mesh.setPosition(v, x, y, z);
  }

  addFace(loop: readonly number[], material = 0): Result<number, ModelingError> {
    const prevH = this.mesh.hVert.buffer;
    const prevF = this.mesh.fHalf.buffer;
    const res = this.mesh.addFace(loop, material);
    if (this.mesh.hVert.buffer !== prevH || this.mesh.fHalf.buffer !== prevF) {
      this.memoryGeneration++;
    }
    return res;
  }

  removeFace(f: number): void {
    this.mesh.removeFace(f);
  }

  findHalf(a: number, b: number): number {
    return this.mesh.findHalf(a, b);
  }

  ensureChannel(name: CornerChannelName): void {
    this.mesh.channel(name);
  }

  setCorner(name: CornerChannelName, h: number, value: ArrayLike<number>): void {
    this.mesh.setCorner(name, h, value);
  }

  internTag(name: string, create: boolean): number {
    const prevBuf = this.mesh.fTags.buffer;
    const idx = this.mesh.tagIndex(name, create);
    if (this.mesh.fTags.buffer !== prevBuf) this.memoryGeneration++;
    return idx;
  }

  internLabel(name: string): number {
    return this.mesh.nameIndex(this.mesh.labelNames, name);
  }

  internRole(name: string): number {
    return this.mesh.nameIndex(this.mesh.roleNames, name);
  }

  internMaterial(name: string): number {
    return this.mesh.nameIndex(this.mesh.materialNames, name);
  }

  takeSnapshot(): MeshSnapshotToken {
    const id = this.nextSnapshotId++;
    this.snapshots.set(id, this.mesh.clone());
    return { id };
  }

  restoreSnapshot(token: MeshSnapshotToken): void {
    const saved = this.snapshots.get(token.id);
    if (saved === undefined) return;
    this.mesh.assign(saved);
    this.memoryGeneration++;
  }

  releaseSnapshot(token: MeshSnapshotToken): void {
    this.snapshots.delete(token.id);
  }

  dispose(): void {
    this.snapshots.clear();
  }
}
