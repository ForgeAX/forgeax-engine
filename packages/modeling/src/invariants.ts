import { CORNER_CHANNEL_DIMENSIONS, type EditMesh, edgeKey, NONE } from './mesh';

/** Kernel invariant families checked by `debugValidate` (design 15). */
export type InvariantCode =
  | 'twin'
  | 'face-loop'
  | 'edge-index'
  | 'dead-reference'
  | 'free-list'
  | 'corner-storage'
  | 'generation';

export interface InvariantViolation {
  readonly code: InvariantCode;
  readonly detail: Readonly<Record<string, unknown>>;
}

/** Slot allocation counts of a mesh at one point in time, for the monotonic check. */
export interface Generations {
  readonly vertices: Uint32Array;
  readonly faces: Uint32Array;
}

const LIMIT = 16;

export function generationsOf(mesh: EditMesh): Generations {
  const vertices = new Uint32Array(mesh.vertexHighWater);
  const faces = new Uint32Array(mesh.faceHighWater);
  for (let v = 0; v < vertices.length; v++) vertices[v] = mesh.vertexGeneration(v);
  for (let f = 0; f < faces.length; f++) faces[f] = mesh.faceGeneration(f);
  return { vertices, faces };
}

/**
 * Check the half-edge invariants of design 15 exhaustively: twin symmetry
 * (`twin(h) = h ^ 1` joins the end of `h` to the start of `next(h)`), closed face
 * loops of at least 3 distinct vertices with consistent `next`/`prev`/`face`/`fLen`,
 * one edge per vertex pair (so no
 * third face can hang on an edge), no dangling references, consistent free lists,
 * corner storage covering every half-edge, and slot generations that never decrease
 * since `since`. An empty list means the mesh satisfies every invariant.
 */
export function debugValidate(mesh: EditMesh, since?: Generations): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  const report = (code: InvariantCode, detail: Record<string, unknown>) => {
    if (out.length < LIMIT) out.push({ code, detail });
  };
  const { edgeIndex, freeVertices, freeEdges, freeFaces } = mesh._bookkeeping();
  const halves = mesh.halfHighWater;
  let aliveEdges = 0;
  for (let e = 0; e * 2 < halves; e++) {
    const a = mesh.hVert[e * 2] as number;
    const b = mesh.hVert[e * 2 + 1] as number;
    if (a === NONE || b === NONE) {
      if (a !== b || mesh.hFace[e * 2] !== NONE || mesh.hFace[e * 2 + 1] !== NONE) {
        report('dead-reference', { edge: e, vertices: [a, b] });
      }
      continue;
    }
    aliveEdges++;
    if (a === b || !mesh.isVertexAlive(a) || !mesh.isVertexAlive(b)) {
      report('dead-reference', { edge: e, vertices: [a, b] });
    }
    if (edgeIndex.get(edgeKey(a, b)) !== e) report('edge-index', { edge: e, vertices: [a, b] });
    if (mesh.hFace[e * 2] === NONE && mesh.hFace[e * 2 + 1] === NONE) {
      report('dead-reference', { edge: e, faces: 'none' });
    }
  }
  if (edgeIndex.size !== aliveEdges) {
    report('edge-index', { indexed: edgeIndex.size, edges: aliveEdges });
  }
  let faceHalves = 0;
  for (let f = 0; f < mesh.faceHighWater; f++) {
    if (!mesh.isFaceAlive(f)) continue;
    const start = mesh.fHalf[f] as number;
    if (start < 0 || start >= halves) {
      report('face-loop', { face: f, start });
      continue;
    }
    let h = start;
    let length = 0;
    const visited = new Set<number>();
    do {
      length++;
      const v = mesh.hVert[h] as number;
      if (visited.has(v)) report('face-loop', { face: f, repeatedVertex: v });
      visited.add(v);
      const next = mesh.hNext[h] as number;
      if (mesh.hFace[h] !== f || next < 0 || mesh.hPrev[next] !== h) {
        report('face-loop', { face: f, half: h });
        break;
      }
      if (mesh.hVert[h ^ 1] !== mesh.hVert[next]) report('twin', { face: f, half: h });
      if (!mesh.isVertexAlive(mesh.hVert[h] as number)) {
        report('dead-reference', { face: f, half: h, vertex: mesh.hVert[h] });
      }
      h = next;
    } while (h !== start && length <= halves);
    if (length !== mesh.fLen[f] || length < 3) {
      report('face-loop', { face: f, length, fLen: mesh.fLen[f] });
    }
    faceHalves += length;
  }
  let owned = 0;
  for (let h = 0; h < halves; h++) {
    const f = mesh.hFace[h] as number;
    if (f === NONE) continue;
    owned++;
    if (!mesh.isFaceAlive(f)) report('dead-reference', { half: h, face: f });
  }
  if (owned !== faceHalves) report('face-loop', { halvesWithFace: owned, inLoops: faceHalves });
  const freeCheck = (
    list: readonly number[],
    kind: string,
    dead: (id: number) => boolean,
    highWater: number,
  ) => {
    const seen = new Set<number>();
    for (const id of list) {
      if (seen.has(id) || id < 0 || id >= highWater || !dead(id)) {
        report('free-list', { kind, id });
      }
      seen.add(id);
    }
    return seen.size;
  };
  const freeV = freeCheck(
    freeVertices,
    'vertex',
    (v) => !mesh.isVertexAlive(v),
    mesh.vertexHighWater,
  );
  const freeF = freeCheck(freeFaces, 'face', (f) => !mesh.isFaceAlive(f), mesh.faceHighWater);
  const freeE = freeCheck(freeEdges, 'edge', (e) => !mesh.isEdgeAlive(e), halves / 2);
  if (mesh.vertices().length + freeV !== mesh.vertexHighWater) {
    report('free-list', { kind: 'vertex', free: freeV, highWater: mesh.vertexHighWater });
  }
  if (mesh.faces().length + freeF !== mesh.faceHighWater) {
    report('free-list', { kind: 'face', free: freeF, highWater: mesh.faceHighWater });
  }
  if (aliveEdges + freeE !== halves / 2) {
    report('free-list', { kind: 'edge', free: freeE, edges: halves / 2 });
  }
  for (const [name, channel] of mesh.channels) {
    const dim = CORNER_CHANNEL_DIMENSIONS[name];
    if (
      channel.dim !== dim ||
      channel.set.length < halves ||
      channel.values.length < halves * dim
    ) {
      report('corner-storage', { channel: name, set: channel.set.length, halves });
    }
  }
  if (mesh.fTags.length < mesh.faceHighWater * mesh.tagWords) {
    report('corner-storage', { tags: mesh.fTags.length, faces: mesh.faceHighWater });
  }
  if (since !== undefined) {
    for (let v = 0; v < Math.min(since.vertices.length, mesh.vertexHighWater); v++) {
      if (mesh.vertexGeneration(v) < (since.vertices[v] as number)) {
        report('generation', { vertex: v });
      }
    }
    for (let f = 0; f < Math.min(since.faces.length, mesh.faceHighWater); f++) {
      if (mesh.faceGeneration(f) < (since.faces[f] as number)) report('generation', { face: f });
    }
    if (mesh.vertexHighWater < since.vertices.length || mesh.faceHighWater < since.faces.length) {
      report('generation', { highWater: 'decreased' });
    }
  }
  return out;
}

let checking = false;

/**
 * Make every session run `debugValidate` after each successful operation and throw
 * on a violation (a kernel bug, never an author error). Test setups enable it; it
 * costs a full mesh scan per operation.
 */
export function checkInvariants(enabled: boolean): void {
  checking = enabled;
}

/** @internal */
export function invariantChecksEnabled(): boolean {
  return checking;
}
