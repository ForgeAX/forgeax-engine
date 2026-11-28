import { err, ok, type Result } from '@forgeax/engine-types';
import {
  createRustEditMesh,
  getModelingKernelWasm,
  KERNEL_CORNER_CHANNELS,
  type KernelError,
  type RustEditMesh,
} from '@forgeax/modeling-kernel';
import { type ModelingError, type ModelingErrorCode, modelingError } from './errors';
import { type CornerChannelName, EditMesh, NONE } from './mesh';
import {
  type CornerChannelView,
  type EditMeshSoaViews,
  type EditMeshStore,
  type KernelPolicy,
  type MeshSnapshotToken,
  TsEditMeshStore,
} from './mesh-store';
import type { Domain, Selector } from './selectors';

const ALIVE = 0x80000000;

export function kernelErrorToModelingError(error: KernelError): ModelingError {
  const codeMap: Readonly<Record<string, ModelingErrorCode>> = {
    'kernel-invalid-argument': 'model-invalid-argument',
    'kernel-invalid-value': 'model-invalid-argument',
    'kernel-invalid-handle': 'model-internal',
    'kernel-precondition': 'model-precondition',
    'kernel-degenerate': 'model-degenerate',
    'kernel-selection-empty': 'model-selection-empty',
    'kernel-selection-cardinality': 'model-selection-cardinality',
    'kernel-work-budget': 'model-work-budget',
    'kernel-cancelled': 'model-cancelled',
    'kernel-capability-unavailable': 'model-precondition',
    'kernel-internal': 'model-internal',
    'kernel-op-no-effect': 'model-op-no-effect',
  };
  const code = codeMap[error.code] ?? 'model-internal';
  return modelingError(code, error.reason, { field: error.field, kernelCode: error.code });
}

/**
 * Rust/WASM-backed `EditMeshStore` implementing the unified storage contract
 * with zero-copy SoA views directly into WASM linear memory.
 */
export class RustEditMeshStore implements EditMeshStore {
  readonly backend = 'rust' as const;
  private nextSnapshotId = 1;
  private readonly snapshots = new Map<number, RustEditMesh>();
  readonly tagNames: string[] = [];
  readonly labelNames: string[] = [''];
  readonly roleNames: string[] = [''];
  readonly materialNames: string[] = ['Default'];
  private readonly tagIndexMap = new Map<string, number>();
  private readonly labelIndexMap = new Map<string, number>([['', 0]]);
  private readonly roleIndexMap = new Map<string, number>([['', 0]]);
  private readonly materialIndexMap = new Map<string, number>([['Default', 0]]);

  readonly rustMesh: RustEditMesh;

  constructor(rustMesh: RustEditMesh) {
    this.rustMesh = rustMesh;
  }

  get topologyStamp(): number {
    return this.rustMesh.counts().topologyStamp;
  }

  get shapeStamp(): number {
    return this.rustMesh.counts().shapeStamp;
  }

  get vertexCount(): number {
    return this.rustMesh.counts().vertexCount;
  }

  get faceCount(): number {
    return this.rustMesh.counts().faceCount;
  }

  get edgeCount(): number {
    return this.rustMesh.counts().edgeCount;
  }

  views(): EditMeshSoaViews {
    return this.rustMesh.views();
  }

  channelViews(name: CornerChannelName): CornerChannelView | undefined {
    return this.rustMesh.channelViews(name);
  }

  bumpShapeStamp(): void {
    // Rust mutators automatically bump shapeStamp; explicit no-op for direct pos writes
    // until a dedicated FFI stamp bump is needed.
  }

  addVertex(x: number, y: number, z: number): number {
    const res = this.rustMesh.addVertex(x, y, z);
    if (!res.ok) throw new RangeError(res.error.reason);
    return res.value;
  }

  removeVertex(v: number): void {
    this.rustMesh.removeVertex(v);
  }

  setPosition(v: number, x: number, y: number, z: number): void {
    this.rustMesh.setPosition(v, x, y, z);
  }

  addFace(loop: readonly number[], material = 0): Result<number, ModelingError> {
    const res = this.rustMesh.addFace(loop, material);
    return res.ok ? ok(res.value) : err(kernelErrorToModelingError(res.error));
  }

  removeFace(f: number): void {
    this.rustMesh.removeFace(f);
  }

  findHalf(a: number, b: number): number {
    return this.rustMesh.findHalf(a, b);
  }

  ensureChannel(_name: CornerChannelName): void {
    // Channels allocate lazily on first setCorner in Rust EditMesh.
  }

  setCorner(name: CornerChannelName, h: number, value: ArrayLike<number>): void {
    this.rustMesh.setCorner(name, h, value);
  }

  internTag(name: string, create: boolean): number {
    const existing = this.tagIndexMap.get(name);
    if (existing !== undefined) return existing;
    if (!create) return -1;
    const idx = this.rustMesh.internTag(name, true);
    if (idx >= 0) {
      if (idx >= this.tagNames.length) this.tagNames[idx] = name;
      this.tagIndexMap.set(name, idx);
    }
    return idx;
  }

  internLabel(name: string): number {
    const existing = this.labelIndexMap.get(name);
    if (existing !== undefined) return existing;
    const idx = this.rustMesh.internLabel(name);
    if (idx >= 0) {
      if (idx >= this.labelNames.length) this.labelNames[idx] = name;
      this.labelIndexMap.set(name, idx);
    }
    return idx;
  }

  internRole(name: string): number {
    const existing = this.roleIndexMap.get(name);
    if (existing !== undefined) return existing;
    const idx = this.rustMesh.internRole(name);
    if (idx >= 0) {
      if (idx >= this.roleNames.length) this.roleNames[idx] = name;
      this.roleIndexMap.set(name, idx);
    }
    return idx;
  }

  internMaterial(name: string): number {
    const existing = this.materialIndexMap.get(name);
    if (existing !== undefined) return existing;
    const idx = this.rustMesh.internMaterial(name);
    if (idx >= 0) {
      if (idx >= this.materialNames.length) this.materialNames[idx] = name;
      this.materialIndexMap.set(name, idx);
    }
    return idx;
  }

  /** Pre-intern all name-table entries from `source` so Rust-side merges stay 1:1 with JS tables. */
  syncNameTablesFrom(source: RustEditMeshStore): void {
    for (const name of source.tagNames) this.internTag(name, true);
    for (let i = 1; i < source.labelNames.length; i++) {
      const name = source.labelNames[i];
      if (name !== undefined && name.length > 0) this.internLabel(name);
    }
    for (let i = 1; i < source.roleNames.length; i++) {
      const name = source.roleNames[i];
      if (name !== undefined && name.length > 0) this.internRole(name);
    }
    for (let i = 1; i < source.materialNames.length; i++) {
      const name = source.materialNames[i];
      if (name !== undefined && name.length > 0) this.internMaterial(name);
    }
  }

  /** Evaluate a pure-data `Selector` directly on the Rust FXSL v1 VM. */
  resolveSelector<D extends Domain>(selector: Selector<D>): Result<number[], ModelingError> {
    const encoded = selector.encode();
    if (!encoded.ok) return encoded;
    const res = this.rustMesh.evalFxsl(encoded.value, true);
    if (!res.ok) return err(kernelErrorToModelingError(res.error));
    return ok(Array.from(res.value));
  }

  /** Evaluate a pure-data `Selector` without cardinality errors (used by `Model.count`). */
  evaluateSelector<D extends Domain>(selector: Selector<D>): Result<number[], ModelingError> {
    const encoded = selector.encode();
    if (!encoded.ok) return encoded;
    const res = this.rustMesh.evalFxsl(encoded.value, false);
    if (!res.ok) return err(kernelErrorToModelingError(res.error));
    return ok(Array.from(res.value));
  }

  takeSnapshot(): MeshSnapshotToken {
    const cloned = this.rustMesh.clone();
    if (!cloned.ok) throw new Error(cloned.error.reason);
    const id = this.nextSnapshotId++;
    this.snapshots.set(id, cloned.value);
    return { id };
  }

  restoreSnapshot(token: MeshSnapshotToken): void {
    const saved = this.snapshots.get(token.id);
    if (saved === undefined) return;
    const res = this.rustMesh.assignFrom(saved);
    if (!res.ok) throw new Error(res.error.reason);
  }

  releaseSnapshot(token: MeshSnapshotToken): void {
    const saved = this.snapshots.get(token.id);
    if (saved === undefined) return;
    saved.dispose();
    this.snapshots.delete(token.id);
  }

  dispose(): void {
    for (const snap of this.snapshots.values()) snap.dispose();
    this.snapshots.clear();
    this.rustMesh.dispose();
  }
}

/** Create an `EditMeshStore` honoring `policy` (`'auto' | 'rust' | 'ts'`). */
export function createEditMeshStore(
  policy: KernelPolicy = 'auto',
): Result<EditMeshStore, ModelingError> {
  if (policy === 'ts') return ok(new TsEditMeshStore());
  const wasm = getModelingKernelWasm();
  if (wasm === undefined) {
    if (policy === 'rust') {
      return err(
        modelingError(
          'model-precondition',
          'Rust WASM modeling kernel is initialized before selecting backend: "rust"',
          { backend: 'rust' },
          'call initModelingKernelWasmSync() or use backend: "auto"',
        ),
      );
    }
    return ok(new TsEditMeshStore());
  }
  const mesh = createRustEditMesh();
  if (!mesh.ok) return err(kernelErrorToModelingError(mesh.error));
  return ok(new RustEditMeshStore(mesh.value));
}

/** Copy a TS `EditMesh` into a fresh `RustEditMeshStore` (lossless topology, attributes & corners). */
export function syncTsToRust(source: EditMesh): Result<RustEditMeshStore, ModelingError> {
  const created = createRustEditMesh();
  if (!created.ok) return err(kernelErrorToModelingError(created.error));
  const store = new RustEditMeshStore(created.value);
  const rust = store.rustMesh;

  for (const name of source.tagNames) store.internTag(name, true);
  for (let i = 1; i < source.labelNames.length; i++) store.internLabel(source.labelNames[i] ?? '');
  for (let i = 1; i < source.roleNames.length; i++) store.internRole(source.roleNames[i] ?? '');
  for (let i = 1; i < source.materialNames.length; i++) {
    store.internMaterial(source.materialNames[i] ?? '');
  }

  const vMap = new Int32Array(source.vertexHighWater).fill(NONE);
  for (const v of source.vertices()) {
    const p = source.position(v);
    const rv = rust.addVertex(p[0], p[1], p[2]);
    if (!rv.ok) {
      store.dispose();
      return err(kernelErrorToModelingError(rv.error));
    }
    vMap[v] = rv.value;
  }

  const channelNames = [...source.channels.keys()];
  const facePairs: [number, number][] = [];
  for (const f of source.faces()) {
    const srcHalves = source.faceHalves(f);
    const loop = srcHalves.map((h) => vMap[source.hVert[h] as number] as number);
    const mat = source.fMaterial[f] as number;
    const rf = rust.addFace(loop, mat);
    if (!rf.ok) {
      store.dispose();
      return err(kernelErrorToModelingError(rf.error));
    }
    facePairs.push([f, rf.value]);
  }

  // Write face metadata directly into WASM linear memory via zero-copy views.
  const views = rust.views();
  const tw = views.tagWords;
  for (const [sf, df] of facePairs) {
    views.fLabel[df] = source.fLabel[sf] as number;
    views.fRole[df] = source.fRole[sf] as number;
    views.fFlags[df] = source.fFlags[sf] as number;
    const copyWords = Math.min(source.tagWords, tw);
    for (let w = 0; w < copyWords; w++) {
      views.fTags[df * tw + w] = source.fTags[sf * source.tagWords + w] as number;
    }
  }

  // Copy edge flags
  for (const e of source.edges()) {
    const ef = source.eFlags[e] as number;
    if (ef === 0) continue;
    const [a, b] = source.edgeVertices(e);
    const rh = rust.findHalf(vMap[a] as number, vMap[b] as number);
    if (rh !== NONE) views.eFlags[rh >> 1] = ef;
  }

  // Copy corner channels
  if (channelNames.length > 0) {
    for (const [sf, df] of facePairs) {
      const srcHalves = source.faceHalves(sf);
      const v0 = rust.views();
      let rh = v0.fHalf[df] as number;
      for (const sh of srcHalves) {
        for (const chName of channelNames) {
          const val = source.corner(chName, sh);
          if (val !== undefined) rust.setCorner(chName, rh, val);
        }
        rh = v0.hNext[rh] as number;
      }
    }
  }

  return ok(store);
}

/** Copy a `RustEditMeshStore`'s live SoA state into an existing TS `EditMesh`. */
export function syncRustToTs(
  source: RustEditMeshStore,
  target: EditMesh,
): Result<void, ModelingError> {
  const next = new EditMesh();
  for (const name of source.tagNames) next.tagIndex(name, true);
  for (let i = 1; i < source.labelNames.length; i++) {
    next.nameIndex(next.labelNames, source.labelNames[i] ?? '');
  }
  for (let i = 1; i < source.roleNames.length; i++) {
    next.nameIndex(next.roleNames, source.roleNames[i] ?? '');
  }
  for (let i = 1; i < source.materialNames.length; i++) {
    next.nameIndex(next.materialNames, source.materialNames[i] ?? '');
  }

  const v = source.views();
  const vMap = new Int32Array(v.vertexHighWater).fill(NONE);
  for (let i = 0; i < v.vertexHighWater; i++) {
    if (((v.vGen[i] ?? 0) & ALIVE) === 0) continue;
    vMap[i] = next.addVertex(v.pos[i * 3] ?? 0, v.pos[i * 3 + 1] ?? 0, v.pos[i * 3 + 2] ?? 0);
  }

  const activeChannels: {
    readonly name: CornerChannelName;
    readonly view: CornerChannelView;
  }[] = [];
  for (const name of KERNEL_CORNER_CHANNELS) {
    const chView = source.channelViews(name);
    if (chView !== undefined) activeChannels.push({ name, view: chView });
  }

  for (let f = 0; f < v.faceHighWater; f++) {
    if (((v.fGen[f] ?? 0) & ALIVE) === 0) continue;
    const start = v.fHalf[f] ?? NONE;
    if (start === NONE) continue;
    const srcHalves: number[] = [];
    const loop: number[] = [];
    let h = start;
    do {
      srcHalves.push(h);
      loop.push(vMap[v.hVert[h] ?? 0] ?? NONE);
      h = v.hNext[h] ?? NONE;
    } while (h !== start && h !== NONE);

    const added = next.addFace(loop, v.fMaterial[f] ?? 0);
    if (!added.ok) return added;
    const df = added.value;
    next.fLabel[df] = v.fLabel[f] ?? 0;
    next.fRole[df] = v.fRole[f] ?? 0;
    next.fFlags[df] = v.fFlags[f] ?? 0;
    const copyWords = Math.min(v.tagWords, next.tagWords);
    for (let w = 0; w < copyWords; w++) {
      next.fTags[df * next.tagWords + w] = v.fTags[f * v.tagWords + w] ?? 0;
    }
    if (activeChannels.length > 0) {
      const dstHalves = next.faceHalves(df);
      for (let i = 0; i < srcHalves.length; i++) {
        const sh = srcHalves[i] ?? 0;
        const dh = dstHalves[i] ?? 0;
        for (const { name, view } of activeChannels) {
          if ((view.set[sh] ?? 0) !== 0) {
            next.setCorner(name, dh, view.values.subarray(sh * view.dim, (sh + 1) * view.dim));
          }
        }
      }
    }
  }

  // Copy edge flags
  const edgeHW = v.halfHighWater >> 1;
  for (let e = 0; e < edgeHW; e++) {
    const ef = v.eFlags[e] ?? 0;
    if (ef === 0) continue;
    const a = v.hVert[e * 2] ?? NONE;
    const b = v.hVert[e * 2 + 1] ?? NONE;
    if (a === NONE || b === NONE) continue;
    const dh = next.findHalf(vMap[a] ?? NONE, vMap[b] ?? NONE);
    if (dh !== NONE) next.eFlags[dh >> 1] = ef;
  }

  target.assign(next);
  return ok(undefined);
}
