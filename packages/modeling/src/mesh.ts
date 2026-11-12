import { err, ok, type Result } from '@forgeax/engine-types';
import { pushAll, replaceAll } from './arrays';
import { type ModelingError, modelingError } from './errors';

/** Absent element reference in every topology array. */
export const NONE = -1;

/** Edge intent flags. They record author intent and are never written by derivation. */
export const EDGE_SHARP = 1;
export const EDGE_SEAM = 2;

/** Face flags. */
export const FACE_MIRRORED = 1;
/** Edge treatment (a bevel's round or chamfer, a surface blend band): not panel skin. */
export const FACE_EDGE_ROUND = 2;

/** Corner channels share one closed vocabulary that maps onto runtime vertex slots. */
export type CornerChannelName =
  | 'uv0'
  | 'uv1'
  | 'uv2'
  | 'uv3'
  | 'uv4'
  | 'uv5'
  | 'uv6'
  | 'uv7'
  | 'color';

export const CORNER_CHANNEL_DIMENSIONS: Readonly<Record<CornerChannelName, number>> = {
  uv0: 2,
  uv1: 2,
  uv2: 2,
  uv3: 2,
  uv4: 2,
  uv5: 2,
  uv6: 2,
  uv7: 2,
  color: 4,
};

interface CornerChannel {
  readonly dim: number;
  values: Float32Array;
  set: Uint8Array;
}

const ALIVE = 0x80000000;
const MAX_VERTICES = 1 << 26;

function grow<T extends Float64Array | Float32Array | Int32Array | Uint32Array | Uint8Array>(
  array: T,
  length: number,
  fill?: number,
): T {
  if (array.length >= length) return array;
  let capacity = Math.max(16, array.length);
  while (capacity < length) capacity *= 2;
  const next = new (array.constructor as new (n: number) => T)(capacity);
  next.set(array);
  if (fill !== undefined) next.fill(fill, array.length);
  return next;
}

function comparePositions(mesh: EditMesh, ha: number, hb: number): number {
  const a = (mesh.hVert[ha] as number) * 3;
  const b = (mesh.hVert[hb] as number) * 3;
  for (let i = 0; i < 3; i++) {
    const d = (mesh.pos[a + i] as number) - (mesh.pos[b + i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

export function edgeKey(a: number, b: number): number {
  return a < b ? a * MAX_VERTICES + b : b * MAX_VERTICES + a;
}

/** The two vertices of an `edgeKey`, smaller first. */
export function edgeEnds(key: number): [number, number] {
  const b = key % MAX_VERTICES;
  return [(key - b) / MAX_VERTICES, b];
}

/**
 * Editable manifold polygon mesh: paired half-edges (twin = h ^ 1, edge = h >> 1),
 * n-gon faces and per-corner channels. A corner is a face half-edge; its value
 * belongs to face hFace[h] at vertex hVert[h]. Arrays are struct-of-arrays and
 * grow by doubling so a compacted mesh transfers as plain buffers.
 */
export class EditMesh {
  vertexHighWater = 0;
  halfHighWater = 0;
  faceHighWater = 0;

  pos = new Float64Array(0);
  vGen = new Uint32Array(0);

  hVert = new Int32Array(0);
  hNext = new Int32Array(0);
  hPrev = new Int32Array(0);
  hFace = new Int32Array(0);
  eFlags = new Uint8Array(0);

  fHalf = new Int32Array(0);
  fLen = new Int32Array(0);
  fGen = new Uint32Array(0);
  fMaterial = new Int32Array(0);
  fLabel = new Int32Array(0);
  fRole = new Int32Array(0);
  fFlags = new Uint8Array(0);
  fTags = new Uint32Array(0);
  tagWords = 1;

  readonly channels = new Map<CornerChannelName, CornerChannel>();
  readonly tagNames: string[] = [];
  readonly labelNames: string[] = [''];
  readonly roleNames: string[] = [''];
  readonly materialNames: string[] = ['Default'];

  topologyStamp = 0;
  shapeStamp = 0;

  private readonly edgeIndex = new Map<number, number>();
  private readonly freeVertices: number[] = [];
  private readonly freeEdges: number[] = [];
  private readonly freeFaces: number[] = [];

  get vertexCount(): number {
    return this.vertexHighWater - this.freeVertices.length;
  }

  get faceCount(): number {
    return this.faceHighWater - this.freeFaces.length;
  }

  get edgeCount(): number {
    return this.halfHighWater / 2 - this.freeEdges.length;
  }

  isVertexAlive(v: number): boolean {
    return v >= 0 && v < this.vertexHighWater && ((this.vGen[v] as number) & ALIVE) !== 0;
  }

  isFaceAlive(f: number): boolean {
    return f >= 0 && f < this.faceHighWater && ((this.fGen[f] as number) & ALIVE) !== 0;
  }

  isEdgeAlive(e: number): boolean {
    return e >= 0 && e * 2 < this.halfHighWater && (this.hVert[e * 2] as number) !== NONE;
  }

  addVertex(x: number, y: number, z: number): number {
    const reused = this.freeVertices.pop();
    if (reused === undefined && this.vertexHighWater >= MAX_VERTICES) {
      throw new RangeError(
        `EditMesh holds at most ${MAX_VERTICES} vertices (edge keys pack two ids)`,
      );
    }
    const v = reused ?? this.vertexHighWater++;
    this.pos = grow(this.pos, (v + 1) * 3);
    this.vGen = grow(this.vGen, v + 1);
    this.pos[v * 3] = x;
    this.pos[v * 3 + 1] = y;
    this.pos[v * 3 + 2] = z;
    this.vGen[v] = (((this.vGen[v] as number) & ~ALIVE) + 1) | ALIVE;
    this.shapeStamp++;
    return v;
  }

  /** Remove a vertex that no face references. */
  removeVertex(v: number): void {
    if (!this.isVertexAlive(v)) return;
    this.vGen[v] = (this.vGen[v] as number) & ~ALIVE;
    this.freeVertices.push(v);
  }

  setPosition(v: number, x: number, y: number, z: number): void {
    this.pos[v * 3] = x;
    this.pos[v * 3 + 1] = y;
    this.pos[v * 3 + 2] = z;
    this.shapeStamp++;
  }

  /** Half-edge from a to b, or NONE. */
  findHalf(a: number, b: number): number {
    const e = this.edgeIndex.get(edgeKey(a, b));
    if (e === undefined) return NONE;
    return (this.hVert[e * 2] as number) === a ? e * 2 : e * 2 + 1;
  }

  /** Check whether a loop can become a face without violating the manifold rules. */
  canAddFace(loop: readonly number[]): Result<void, ModelingError> {
    if (loop.length < 3) {
      return err(modelingError('model-degenerate', 'a face needs at least 3 vertices', { loop }));
    }
    const seen = new Set<number>();
    for (const v of loop) {
      if (!this.isVertexAlive(v)) {
        return err(modelingError('model-precondition', 'face vertices must exist', { vertex: v }));
      }
      if (seen.has(v)) {
        return err(modelingError('model-degenerate', 'a face must not repeat a vertex', { loop }));
      }
      seen.add(v);
    }
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i] as number;
      const b = loop[(i + 1) % loop.length] as number;
      const h = this.findHalf(a, b);
      if (h !== NONE && (this.hFace[h] as number) !== NONE) {
        return err(
          modelingError(
            'model-precondition',
            'each directed edge is used by at most one face (manifold, consistently oriented)',
            { edge: [a, b], face: this.hFace[h] },
            'the new face would overlap an existing face or disagree with its orientation',
          ),
        );
      }
    }
    return ok(undefined);
  }

  addFace(loop: readonly number[], material = 0): Result<number, ModelingError> {
    const allowed = this.canAddFace(loop);
    if (!allowed.ok) return allowed;
    const reused = this.freeFaces.pop();
    const f = reused ?? this.faceHighWater++;
    this.ensureFaceCapacity(f + 1);
    const halves: number[] = [];
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i] as number;
      const b = loop[(i + 1) % loop.length] as number;
      let h = this.findHalf(a, b);
      if (h === NONE) h = this.createEdge(a, b);
      halves.push(h);
    }
    for (let i = 0; i < halves.length; i++) {
      const h = halves[i] as number;
      this.hFace[h] = f;
      this.hNext[h] = halves[(i + 1) % halves.length] as number;
      this.hPrev[h] = halves[(i + halves.length - 1) % halves.length] as number;
      for (const channel of this.channels.values()) channel.set[h] = 0;
    }
    this.fHalf[f] = halves[0] as number;
    this.fLen[f] = loop.length;
    this.fGen[f] = (((this.fGen[f] as number) & ~ALIVE) + 1) | ALIVE;
    this.fMaterial[f] = material;
    this.fLabel[f] = 0;
    this.fRole[f] = 0;
    this.fFlags[f] = 0;
    this.fTags.fill(0, f * this.tagWords, (f + 1) * this.tagWords);
    this.topologyStamp++;
    return ok(f);
  }

  removeFace(f: number): void {
    if (!this.isFaceAlive(f)) return;
    const start = this.fHalf[f] as number;
    let h = start;
    const halves: number[] = [];
    do {
      halves.push(h);
      h = this.hNext[h] as number;
    } while (h !== start);
    for (const half of halves) {
      this.hFace[half] = NONE;
      this.hNext[half] = NONE;
      this.hPrev[half] = NONE;
      const twin = half ^ 1;
      if ((this.hFace[twin] as number) === NONE) this.releaseEdge(half >> 1);
    }
    this.fGen[f] = (this.fGen[f] as number) & ~ALIVE;
    this.freeFaces.push(f);
    this.topologyStamp++;
  }

  faceHalves(f: number): number[] {
    const start = this.fHalf[f] as number;
    const out: number[] = [];
    let h = start;
    do {
      out.push(h);
      h = this.hNext[h] as number;
    } while (h !== start);
    return out;
  }

  faceVertices(f: number): number[] {
    return this.faceHalves(f).map((h) => this.hVert[h] as number);
  }

  /** Alive faces in ascending id order. */
  faces(): number[] {
    const out: number[] = [];
    for (let f = 0; f < this.faceHighWater; f++) if (this.isFaceAlive(f)) out.push(f);
    return out;
  }

  /** Alive edges in ascending id order. */
  edges(): number[] {
    const out: number[] = [];
    for (let e = 0; e * 2 < this.halfHighWater; e++) if (this.isEdgeAlive(e)) out.push(e);
    return out;
  }

  vertices(): number[] {
    const out: number[] = [];
    for (let v = 0; v < this.vertexHighWater; v++) if (this.isVertexAlive(v)) out.push(v);
    return out;
  }

  edgeVertices(e: number): [number, number] {
    return [this.hVert[e * 2] as number, this.hVert[e * 2 + 1] as number];
  }

  isBoundaryEdge(e: number): boolean {
    return (this.hFace[e * 2] as number) === NONE || (this.hFace[e * 2 + 1] as number) === NONE;
  }

  position(v: number): [number, number, number] {
    return [
      this.pos[v * 3] as number,
      this.pos[v * 3 + 1] as number,
      this.pos[v * 3 + 2] as number,
    ];
  }

  /**
   * Read-only view of the index and free lists, for `debugValidate`.
   * @internal
   */
  _bookkeeping(): {
    readonly edgeIndex: ReadonlyMap<number, number>;
    readonly freeVertices: readonly number[];
    readonly freeEdges: readonly number[];
    readonly freeFaces: readonly number[];
  } {
    return {
      edgeIndex: this.edgeIndex,
      freeVertices: this.freeVertices,
      freeEdges: this.freeEdges,
      freeFaces: this.freeFaces,
    };
  }

  /** Allocation count of a vertex slot (increments on every reuse). */
  vertexGeneration(v: number): number {
    return (this.vGen[v] as number) & ~ALIVE;
  }

  /** Allocation count of a face slot (increments on every reuse). */
  faceGeneration(f: number): number {
    return (this.fGen[f] as number) & ~ALIVE;
  }

  // ---- names -------------------------------------------------------------

  tagIndex(name: string, create: boolean): number {
    let index = this.tagNames.indexOf(name);
    if (index >= 0 || !create) return index;
    index = this.tagNames.length;
    this.tagNames.push(name);
    if (index >= this.tagWords * 32) this.reserveTagWords(this.tagWords + 1);
    return index;
  }

  hasTag(f: number, tag: number): boolean {
    const word = this.fTags[f * this.tagWords + (tag >> 5)] as number;
    return (word & (1 << (tag & 31))) !== 0;
  }

  addTag(f: number, tag: number): void {
    const slot = f * this.tagWords + (tag >> 5);
    this.fTags[slot] = (this.fTags[slot] as number) | (1 << (tag & 31));
  }

  /** Copy face attributes from this mesh's face to a face of `target` (same name tables). */
  copyFaceAttributesTo(from: number, target: EditMesh, to: number): void {
    target.fMaterial[to] = this.fMaterial[from] as number;
    target.fLabel[to] = this.fLabel[from] as number;
    target.fRole[to] = this.fRole[from] as number;
    target.fFlags[to] = this.fFlags[from] as number;
    for (let w = 0; w < Math.min(this.tagWords, target.tagWords); w++) {
      target.fTags[to * target.tagWords + w] = this.fTags[from * this.tagWords + w] as number;
    }
  }

  nameIndex(names: string[], name: string): number {
    let index = names.indexOf(name);
    if (index < 0) {
      index = names.length;
      names.push(name);
    }
    return index;
  }

  // ---- corner channels -----------------------------------------------------

  channel(name: CornerChannelName): CornerChannel {
    let channel = this.channels.get(name);
    if (channel === undefined) {
      const dim = CORNER_CHANNEL_DIMENSIONS[name];
      channel = {
        dim,
        values: new Float32Array(this.hVert.length * dim),
        set: new Uint8Array(this.hVert.length),
      };
      this.channels.set(name, channel);
    }
    return channel;
  }

  setCorner(name: CornerChannelName, h: number, value: ArrayLike<number>): void {
    const channel = this.channel(name);
    for (let i = 0; i < channel.dim; i++) channel.values[h * channel.dim + i] = value[i] as number;
    channel.set[h] = 1;
  }

  /** Corner value, or undefined when the corner has no value in the channel. */
  corner(name: CornerChannelName, h: number): Float32Array | undefined {
    const channel = this.channels.get(name);
    if (channel === undefined || (channel.set[h] as number) === 0) return undefined;
    return channel.values.subarray(h * channel.dim, (h + 1) * channel.dim);
  }

  // ---- whole-mesh copies -----------------------------------------------------

  clone(): EditMesh {
    const copy = new EditMesh();
    copy.vertexHighWater = this.vertexHighWater;
    copy.halfHighWater = this.halfHighWater;
    copy.faceHighWater = this.faceHighWater;
    copy.pos = this.pos.slice();
    copy.vGen = this.vGen.slice();
    copy.hVert = this.hVert.slice();
    copy.hNext = this.hNext.slice();
    copy.hPrev = this.hPrev.slice();
    copy.hFace = this.hFace.slice();
    copy.eFlags = this.eFlags.slice();
    copy.fHalf = this.fHalf.slice();
    copy.fLen = this.fLen.slice();
    copy.fGen = this.fGen.slice();
    copy.fMaterial = this.fMaterial.slice();
    copy.fLabel = this.fLabel.slice();
    copy.fRole = this.fRole.slice();
    copy.fFlags = this.fFlags.slice();
    copy.fTags = this.fTags.slice();
    copy.tagWords = this.tagWords;
    for (const [name, channel] of this.channels) {
      copy.channels.set(name, {
        dim: channel.dim,
        values: channel.values.slice(),
        set: channel.set.slice(),
      });
    }
    pushAll(copy.tagNames, this.tagNames);
    replaceAll(copy.labelNames, this.labelNames);
    replaceAll(copy.roleNames, this.roleNames);
    replaceAll(copy.materialNames, this.materialNames);
    copy.topologyStamp = this.topologyStamp;
    copy.shapeStamp = this.shapeStamp;
    for (const [key, value] of this.edgeIndex) copy.edgeIndex.set(key, value);
    // Loops, not spreads: a large edit frees more ids than a call can take as arguments.
    for (const v of this.freeVertices) copy.freeVertices.push(v);
    for (const e of this.freeEdges) copy.freeEdges.push(e);
    for (const f of this.freeFaces) copy.freeFaces.push(f);
    return copy;
  }

  /** Replace this mesh's state with another mesh (used to restore snapshots). */
  assign(source: EditMesh): void {
    const copy = source.clone();
    Object.assign(this, copy);
    (this as unknown as { edgeIndex: Map<number, number> }).edgeIndex = copy.edgeIndex;
    (this as unknown as { freeVertices: number[] }).freeVertices = copy.freeVertices;
    (this as unknown as { freeEdges: number[] }).freeEdges = copy.freeEdges;
    (this as unknown as { freeFaces: number[] }).freeFaces = copy.freeFaces;
  }

  /**
   * Canonical dense copy: faces keep ascending id order, vertices are numbered by
   * first use, edges by creation during the rebuild and unreferenced vertices are
   * dropped. The result is independent of edit history.
   */
  compact(): { mesh: EditMesh; vertexMap: Int32Array; faceMap: Int32Array } {
    const out = new EditMesh();
    const alive = this.faces();
    const prune = (names: readonly string[], used: (i: number) => boolean, keepFirst: boolean) => {
      const remap = new Int32Array(names.length).fill(0);
      const kept: string[] = [];
      for (let i = 0; i < names.length; i++) {
        if ((keepFirst && i === 0) || used(i)) {
          remap[i] = kept.length;
          kept.push(names[i] as string);
        }
      }
      return { remap, kept };
    };
    const usedOf = (field: Int32Array) => {
      const set = new Set<number>();
      for (const f of alive) set.add(field[f] as number);
      return (i: number) => set.has(i);
    };
    const labels = prune(this.labelNames, usedOf(this.fLabel), true);
    const roles = prune(this.roleNames, usedOf(this.fRole), true);
    const materials = prune(this.materialNames, usedOf(this.fMaterial), true);
    const tags = prune(this.tagNames, (t) => alive.some((f) => this.hasTag(f, t)), false);
    pushAll(out.tagNames, tags.kept);
    replaceAll(out.labelNames, labels.kept);
    replaceAll(out.roleNames, roles.kept);
    replaceAll(out.materialNames, materials.kept);
    out.reserveTagWords(Math.max(1, Math.ceil(tags.kept.length / 32)));
    const vertexMap = new Int32Array(this.vertexHighWater).fill(NONE);
    const faceMap = new Int32Array(this.faceHighWater).fill(NONE);
    const ordered = this.canonicalLoops(alive);
    for (const { face: f, halves: src } of ordered) {
      const loop = src
        .map((h) => this.hVert[h] as number)
        .map((v) => {
          let mapped = vertexMap[v] as number;
          if (mapped === NONE) {
            mapped = out.addVertex(...this.position(v));
            vertexMap[v] = mapped;
          }
          return mapped;
        });
      const added = out.addFace(loop);
      if (!added.ok) continue;
      const g = added.value;
      faceMap[f] = g;
      out.fMaterial[g] = materials.remap[this.fMaterial[f] as number] as number;
      out.fLabel[g] = labels.remap[this.fLabel[f] as number] as number;
      out.fRole[g] = roles.remap[this.fRole[f] as number] as number;
      out.fFlags[g] = this.fFlags[f] as number;
      for (let t = 0; t < this.tagNames.length; t++) {
        if (this.hasTag(f, t)) out.addTag(g, tags.remap[t] as number);
      }
      const dst = out.faceHalves(g);
      for (let i = 0; i < src.length; i++) {
        const from = src[i] as number;
        const to = dst[i] as number;
        for (const [name, channel] of this.channels) {
          if ((channel.set[from] as number) === 0) continue;
          out.setCorner(
            name,
            to,
            channel.values.subarray(from * channel.dim, (from + 1) * channel.dim),
          );
        }
      }
    }
    for (const e of this.edges()) {
      const flags = this.eFlags[e] as number;
      if (flags === 0) continue;
      const [a, b] = this.edgeVertices(e);
      const h = out.findHalf(vertexMap[a] as number, vertexMap[b] as number);
      if (h !== NONE) out.eFlags[h >> 1] = flags;
    }
    return { mesh: out, vertexMap, faceMap };
  }

  /**
   * Content-defined face order: every loop starts at its lexicographically
   * smallest vertex position and loops sort by their position sequences, so the
   * order does not depend on id reuse or edit history.
   */
  private canonicalLoops(
    faces: readonly number[],
  ): { face: number; halves: number[]; key: number[] }[] {
    const keyed = faces.map((face) => {
      const halves = this.faceHalves(face);
      let start = 0;
      for (let i = 1; i < halves.length; i++) {
        if (comparePositions(this, halves[i] as number, halves[start] as number) < 0) start = i;
      }
      const rotated = [...halves.slice(start), ...halves.slice(0, start)];
      const key = rotated.flatMap((h) => this.position(this.hVert[h] as number));
      return { face, halves: rotated, key };
    });
    keyed.sort((a, b) => {
      const n = Math.min(a.key.length, b.key.length);
      for (let i = 0; i < n; i++) {
        const d = (a.key[i] as number) - (b.key[i] as number);
        if (d !== 0) return d;
      }
      return a.key.length - b.key.length || a.face - b.face;
    });
    return keyed;
  }

  // ---- internals ---------------------------------------------------------------

  private createEdge(a: number, b: number): number {
    const reused = this.freeEdges.pop();
    const e = reused ?? this.halfHighWater / 2;
    if (reused === undefined) this.halfHighWater += 2;
    const h = e * 2;
    this.hVert = grow(this.hVert, h + 2, NONE);
    this.hNext = grow(this.hNext, h + 2, NONE);
    this.hPrev = grow(this.hPrev, h + 2, NONE);
    this.hFace = grow(this.hFace, h + 2, NONE);
    this.eFlags = grow(this.eFlags, e + 1);
    for (const channel of this.channels.values()) {
      channel.values = grow(channel.values, (h + 2) * channel.dim);
      channel.set = grow(channel.set, h + 2);
    }
    this.hVert[h] = a;
    this.hVert[h + 1] = b;
    this.hFace[h] = NONE;
    this.hFace[h + 1] = NONE;
    this.eFlags[e] = 0;
    this.edgeIndex.set(edgeKey(a, b), e);
    return h;
  }

  private releaseEdge(e: number): void {
    const a = this.hVert[e * 2] as number;
    const b = this.hVert[e * 2 + 1] as number;
    this.edgeIndex.delete(edgeKey(a, b));
    this.hVert[e * 2] = NONE;
    this.hVert[e * 2 + 1] = NONE;
    this.eFlags[e] = 0;
    this.freeEdges.push(e);
  }

  private ensureFaceCapacity(count: number): void {
    this.fHalf = grow(this.fHalf, count, NONE);
    this.fLen = grow(this.fLen, count);
    this.fGen = grow(this.fGen, count);
    this.fMaterial = grow(this.fMaterial, count);
    this.fLabel = grow(this.fLabel, count);
    this.fRole = grow(this.fRole, count);
    this.fFlags = grow(this.fFlags, count);
    this.fTags = grow(this.fTags, count * this.tagWords);
  }

  /** Grow per-face tag storage to `words` 32-bit words. */
  reserveTagWords(words: number): void {
    if (words <= this.tagWords) return;
    const capacity = Math.max(this.fHalf.length, this.faceHighWater);
    const next = new Uint32Array(capacity * words);
    for (let f = 0; f < this.faceHighWater; f++) {
      for (let w = 0; w < this.tagWords; w++) {
        next[f * words + w] = this.fTags[f * this.tagWords + w] as number;
      }
    }
    this.fTags = next;
    this.tagWords = words;
  }
}
