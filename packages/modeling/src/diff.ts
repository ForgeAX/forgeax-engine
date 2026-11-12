import { err, ok, type Result } from '@forgeax/engine-types';
import type { ModelingError } from './errors';
import { decodeSnapshot, encodeSnapshot } from './fxem';
import {
  cross,
  dot,
  faceArea,
  faceCentroid,
  faceNormal,
  length,
  sub,
  type Tuple3,
  triangulateLoop,
} from './geom';
import { type EditMesh, NONE } from './mesh';

/** Why two mesh states differ; one entry per fact. */
export type MeshDiffReason =
  | 'count'
  | 'closed'
  | 'volume'
  | 'bounds'
  | 'group'
  | 'tag'
  | 'material'
  | 'face-added'
  | 'face-removed'
  | 'face-moved';

/** A face of one side, located by its canonical (compacted) id. */
export interface DiffElement {
  readonly face: number;
  readonly centroid: Tuple3;
  readonly label?: string;
  readonly role?: string;
}

export interface MeshDifference {
  readonly reason: MeshDiffReason;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly elementA?: DiffElement;
  readonly elementB?: DiffElement;
}

export interface Delta {
  readonly a: number;
  readonly b: number;
  readonly delta: number;
}

/** Faces of one provenance (label and role, or tag set when unlabeled) on both sides. */
export interface ProvenanceDiff {
  readonly label: string;
  readonly role: string;
  readonly tags: readonly string[];
  readonly a: number;
  readonly b: number;
  readonly unchanged: number;
  readonly moved: number;
  readonly added: number;
  readonly removed: number;
}

export interface MeshDiff {
  /** Equal canonical FXEM bytes: no difference at all, including attributes. */
  readonly identical: boolean;
  readonly counts: {
    readonly faces: Delta;
    readonly edges: Delta;
    readonly vertices: Delta;
    readonly triangles: Delta;
    readonly boundaryEdges: Delta;
  };
  readonly closed: { readonly a: boolean; readonly b: boolean };
  /** Signed volume (meaningful when closed) and surface area. */
  readonly volume: Delta;
  readonly area: Delta;
  readonly bounds: {
    readonly a: readonly number[];
    readonly b: readonly number[];
    /** Union of both bounds: pass it as `model.render --frame` so both renders share one camera. */
    readonly frame: readonly number[];
  };
  /** Vertex-to-surface Hausdorff distances (A to B, B to A, and their maximum). */
  readonly hausdorff: {
    readonly ab: number;
    readonly ba: number;
    readonly max: number;
    readonly sampled: boolean;
  };
  readonly faces: {
    readonly unchanged: number;
    readonly moved: number;
    readonly added: number;
    readonly removed: number;
  };
  readonly provenance: readonly ProvenanceDiff[];
  readonly tags: readonly ({ readonly tag: string } & Delta)[];
  readonly materials: readonly ({ readonly material: string } & Delta)[];
  readonly differences: readonly MeshDifference[];
  readonly differencesTotal: number;
}

export interface DiffOptions {
  /** Positions closer than this count as equal (default 1e-5, the model tolerance). */
  readonly tolerance?: number;
  /** Differences listed in `differences` (default 64); the total is always reported. */
  readonly limit?: number;
  /** Point-to-triangle tests per Hausdorff direction before vertices are sampled (default 2e7). */
  readonly work?: number;
}

type Side = EditMesh | Uint8Array;

interface FaceInfo {
  readonly face: number;
  readonly key: string;
  readonly shape: string;
  readonly centroid: Tuple3;
  readonly normal: Tuple3;
  readonly size: number;
}

function canonical(side: Side): Result<EditMesh, ModelingError> {
  if (side instanceof Uint8Array) return decodeSnapshot(side);
  const bytes = encodeSnapshot(side);
  const decoded = decodeSnapshot(bytes);
  return decoded.ok ? ok(decoded.value) : err(decoded.error);
}

function delta(a: number, b: number): Delta {
  return { a, b, delta: b - a };
}

function tagNames(mesh: EditMesh, f: number): string[] {
  return mesh.tagNames.filter((_, t) => mesh.hasTag(f, t));
}

function provenanceOf(mesh: EditMesh, f: number): { label: string; role: string; tags: string[] } {
  return {
    label: mesh.labelNames[mesh.fLabel[f] as number] ?? '',
    role: mesh.roleNames[mesh.fRole[f] as number] ?? '',
    tags: tagNames(mesh, f),
  };
}

function element(mesh: EditMesh, info: FaceInfo): DiffElement {
  const { label, role } = provenanceOf(mesh, info.face);
  return {
    face: info.face,
    centroid: info.centroid,
    ...(label === '' ? {} : { label }),
    ...(role === '' ? {} : { role }),
  };
}

function faceInfos(mesh: EditMesh, tolerance: number): FaceInfo[] {
  const q = (x: number) => Math.round(x / tolerance);
  return mesh.faces().map((f) => {
    const { label, role, tags } = provenanceOf(mesh, f);
    const material = mesh.materialNames[mesh.fMaterial[f] as number] ?? '';
    const points = mesh.faceVertices(f).map((v) => mesh.position(v).map(q).join(','));
    const start = points.indexOf([...points].sort()[0] as string);
    const shape = [...points.slice(start), ...points.slice(0, start)].join('|');
    return {
      face: f,
      key: JSON.stringify([label, role, tags, material]),
      shape,
      centroid: faceCentroid(mesh, f),
      normal: faceNormal(mesh, f),
      size: mesh.fLen[f] as number,
    };
  });
}

interface Matching {
  readonly unchanged: number;
  readonly moved: { a: FaceInfo; b: FaceInfo; distance: number }[];
  readonly added: FaceInfo[];
  readonly removed: FaceInfo[];
}

/**
 * Pair the faces of one provenance: equal shapes are unchanged; the rest pair
 * greedily by nearest centroid among faces with the same corner count (moved);
 * leftovers are removed (A) or added (B).
 */
function match(a: readonly FaceInfo[], b: readonly FaceInfo[]): Matching {
  const byShape = new Map<string, FaceInfo[]>();
  for (const info of b) {
    const list = byShape.get(info.shape);
    if (list === undefined) byShape.set(info.shape, [info]);
    else list.push(info);
  }
  let unchanged = 0;
  const restA: FaceInfo[] = [];
  const used = new Set<number>();
  for (const info of a) {
    const same = byShape.get(info.shape);
    const partner = same?.find((x) => !used.has(x.face));
    if (partner === undefined) restA.push(info);
    else {
      used.add(partner.face);
      unchanged++;
    }
  }
  const restB = b.filter((x) => !used.has(x.face));
  const pairs: { i: number; j: number; distance: number }[] = [];
  if (restA.length * restB.length <= 1_000_000) {
    for (const [i, x] of restA.entries()) {
      for (const [j, y] of restB.entries()) {
        if (x.size !== y.size) continue;
        pairs.push({ i, j, distance: length(sub(x.centroid, y.centroid)) });
      }
    }
  } else {
    const order = (list: readonly FaceInfo[]) =>
      list
        .map((info, index) => ({ info, index }))
        .sort(
          (p, q) =>
            p.info.size - q.info.size ||
            p.info.centroid[0] - q.info.centroid[0] ||
            p.info.centroid[1] - q.info.centroid[1] ||
            p.info.centroid[2] - q.info.centroid[2],
        );
    const sa = order(restA);
    const sb = order(restB);
    for (let k = 0; k < Math.min(sa.length, sb.length); k++) {
      const x = sa[k] as (typeof sa)[number];
      const y = sb[k] as (typeof sb)[number];
      if (x.info.size === y.info.size) {
        pairs.push({
          i: x.index,
          j: y.index,
          distance: length(sub(x.info.centroid, y.info.centroid)),
        });
      }
    }
  }
  pairs.sort((p, q) => p.distance - q.distance || p.i - q.i || p.j - q.j);
  const takenA = new Set<number>();
  const takenB = new Set<number>();
  const moved: Matching['moved'] = [];
  for (const { i, j, distance } of pairs) {
    if (takenA.has(i) || takenB.has(j)) continue;
    takenA.add(i);
    takenB.add(j);
    moved.push({ a: restA[i] as FaceInfo, b: restB[j] as FaceInfo, distance });
  }
  return {
    unchanged,
    moved,
    removed: restA.filter((_, i) => !takenA.has(i)),
    added: restB.filter((_, j) => !takenB.has(j)),
  };
}

function boundsOf(mesh: EditMesh): number[] {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const v of mesh.vertices()) {
    const p = mesh.position(v);
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k] as number, p[k] as number);
      hi[k] = Math.max(hi[k] as number, p[k] as number);
    }
  }
  return mesh.vertexCount === 0 ? [0, 0, 0, 0, 0, 0] : [...lo, ...hi];
}

function triangles(mesh: EditMesh): Tuple3[][] {
  const out: Tuple3[][] = [];
  for (const f of mesh.faces()) {
    const points = mesh.faceVertices(f).map((v) => mesh.position(v));
    const indices = triangulateLoop(points);
    if (indices === undefined) continue;
    for (let i = 0; i < indices.length; i += 3) {
      out.push([0, 1, 2].map((k) => points[indices[i + k] as number] as Tuple3));
    }
  }
  return out;
}

/** Squared distance from `p` to triangle `abc` (Ericson, Real-Time Collision Detection 5.1.5). */
function pointTriangle(p: Tuple3, a: Tuple3, b: Tuple3, c: Tuple3): number {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  const sq = (x: Tuple3) => dot(x, x);
  if (d1 <= 0 && d2 <= 0) return sq(ap);
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return sq(bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return sq(sub(ap, [ab[0] * v, ab[1] * v, ab[2] * v]));
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return sq(cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return sq(sub(ap, [ac[0] * w, ac[1] * w, ac[2] * w]));
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const bc = sub(c, b);
    return sq(sub(bp, [bc[0] * w, bc[1] * w, bc[2] * w]));
  }
  const n = cross(ab, ac);
  const plane = dot(ap, n);
  return (plane * plane) / dot(n, n);
}

/** Largest distance from a vertex of `from` to the surface of `to`, sampling vertices beyond `work`. */
function directed(
  from: EditMesh,
  to: Tuple3[][],
  work: number,
): { distance: number; sampled: boolean } {
  const vertices = from.vertices();
  if (vertices.length === 0) return { distance: 0, sampled: false };
  if (to.length === 0) return { distance: Infinity, sampled: false };
  const stride = Math.max(1, Math.ceil((vertices.length * to.length) / work));
  let worst = 0;
  for (let i = 0; i < vertices.length; i += stride) {
    const p = from.position(vertices[i] as number);
    let best = Infinity;
    for (const t of to) {
      best = Math.min(best, pointTriangle(p, t[0] as Tuple3, t[1] as Tuple3, t[2] as Tuple3));
      if (best === 0) break;
    }
    worst = Math.max(worst, best);
  }
  return { distance: Math.sqrt(worst), sampled: stride > 1 };
}

function signedVolume(mesh: EditMesh): number {
  let volume = 0;
  for (const f of mesh.faces()) {
    const p = mesh.faceVertices(f).map((v) => mesh.position(v));
    for (let i = 1; i + 1 < p.length; i++) {
      volume += dot(p[0] as Tuple3, cross(p[i] as Tuple3, p[i + 1] as Tuple3)) / 6;
    }
  }
  return volume;
}

function boundaryEdges(mesh: EditMesh): number {
  return mesh
    .edges()
    .filter(
      (e) => (mesh.hFace[e * 2] as number) === NONE || (mesh.hFace[e * 2 + 1] as number) === NONE,
    ).length;
}

function countBy(mesh: EditMesh, names: readonly string[], of: (f: number) => number[]): number[] {
  const counts = names.map(() => 0);
  for (const f of mesh.faces()) for (const i of of(f)) counts[i] = (counts[i] as number) + 1;
  return counts;
}

function namedDeltas(
  a: EditMesh,
  b: EditMesh,
  names: (m: EditMesh) => readonly string[],
  of: (m: EditMesh, f: number) => number[],
): { name: string; delta: Delta }[] {
  const ca = countBy(a, names(a), (f) => of(a, f));
  const cb = countBy(b, names(b), (f) => of(b, f));
  const all = [...new Set([...names(a), ...names(b)])].sort();
  return all
    .map((name) => {
      const ia = names(a).indexOf(name);
      const ib = names(b).indexOf(name);
      return {
        name,
        delta: delta(ia < 0 ? 0 : (ca[ia] as number), ib < 0 ? 0 : (cb[ib] as number)),
      };
    })
    .filter((x) => x.delta.a > 0 || x.delta.b > 0);
}

/**
 * Structured difference between two mesh states (sessions, checkpoints or FXEM
 * snapshots; design 11.2 `model.diff`): counts, closedness, volume, area and bounds
 * deltas, per-provenance face matching (unchanged, moved, added, removed), tag and
 * material counts and a vertex-to-surface Hausdorff distance. Both sides are
 * compared in canonical (compacted) form, so face ids and the result do not depend
 * on edit history.
 */
export function diffMeshes(
  sideA: Side,
  sideB: Side,
  options: DiffOptions = {},
): Result<MeshDiff, ModelingError> {
  const tolerance = options.tolerance ?? 1e-5;
  const limit = options.limit ?? 64;
  const work = options.work ?? 2e7;
  const ca = canonical(sideA);
  if (!ca.ok) return ca;
  const cb = canonical(sideB);
  if (!cb.ok) return cb;
  const a = ca.value;
  const b = cb.value;
  const bytesA = encodeSnapshot(a);
  const bytesB = encodeSnapshot(b);
  const identical =
    bytesA.length === bytesB.length && bytesA.every((byte, i) => byte === bytesB[i]);
  const differences: MeshDifference[] = [];
  const triangleCount = (m: EditMesh) =>
    m.faces().reduce((sum, f) => sum + (m.fLen[f] as number) - 2, 0);
  const counts = {
    faces: delta(a.faceCount, b.faceCount),
    edges: delta(a.edgeCount, b.edgeCount),
    vertices: delta(a.vertexCount, b.vertexCount),
    triangles: delta(triangleCount(a), triangleCount(b)),
    boundaryEdges: delta(boundaryEdges(a), boundaryEdges(b)),
  };
  for (const [name, d] of Object.entries(counts)) {
    if (d.delta !== 0) differences.push({ reason: 'count', detail: { count: name, ...d } });
  }
  const closed = {
    a: counts.boundaryEdges.a === 0 && a.faceCount > 0,
    b: counts.boundaryEdges.b === 0 && b.faceCount > 0,
  };
  if (closed.a !== closed.b) differences.push({ reason: 'closed', detail: closed });
  const volume = delta(signedVolume(a), signedVolume(b));
  const area = delta(
    a.faces().reduce((s, f) => s + faceArea(a, f), 0),
    b.faces().reduce((s, f) => s + faceArea(b, f), 0),
  );
  if (Math.abs(volume.delta) > tolerance * Math.max(area.a, area.b, 1e-300)) {
    differences.push({ reason: 'volume', detail: { ...volume, area } });
  }
  const boxA = boundsOf(a);
  const boxB = boundsOf(b);
  const frame = [0, 1, 2]
    .map((k) => Math.min(boxA[k] as number, boxB[k] as number))
    .concat([3, 4, 5].map((k) => Math.max(boxA[k] as number, boxB[k] as number)));
  if (boxA.some((x, k) => Math.abs(x - (boxB[k] as number)) > tolerance)) {
    differences.push({ reason: 'bounds', detail: { a: boxA, b: boxB } });
  }
  const infoA = faceInfos(a, tolerance);
  const infoB = faceInfos(b, tolerance);
  const grouped = (infos: readonly FaceInfo[]) => {
    const map = new Map<string, FaceInfo[]>();
    for (const info of infos) {
      const list = map.get(info.key);
      if (list === undefined) map.set(info.key, [info]);
      else list.push(info);
    }
    return map;
  };
  const byKeyA = grouped(infoA);
  const byKeyB = grouped(infoB);
  const keys = [...new Set([...byKeyA.keys(), ...byKeyB.keys()])].sort();
  const provenance: ProvenanceDiff[] = [];
  const faces = { unchanged: 0, moved: 0, added: 0, removed: 0 };
  const faceFacts: MeshDifference[] = [];
  for (const key of keys) {
    const [label, role, tags] = JSON.parse(key) as [string, string, string[], string];
    const groupA = byKeyA.get(key) ?? [];
    const groupB = byKeyB.get(key) ?? [];
    const m = match(groupA, groupB);
    const row: ProvenanceDiff = {
      label,
      role,
      tags,
      a: groupA.length,
      b: groupB.length,
      unchanged: m.unchanged,
      moved: m.moved.length,
      added: m.added.length,
      removed: m.removed.length,
    };
    provenance.push(row);
    faces.unchanged += m.unchanged;
    faces.moved += m.moved.length;
    faces.added += m.added.length;
    faces.removed += m.removed.length;
    if (row.a !== row.b || m.moved.length + m.added.length + m.removed.length > 0) {
      differences.push({ reason: 'group', detail: { ...row } });
    }
    for (const x of m.removed) {
      faceFacts.push({ reason: 'face-removed', detail: { label, role }, elementA: element(a, x) });
    }
    for (const y of m.added) {
      faceFacts.push({ reason: 'face-added', detail: { label, role }, elementB: element(b, y) });
    }
    for (const pair of m.moved) {
      faceFacts.push({
        reason: 'face-moved',
        detail: {
          label,
          role,
          distance: pair.distance,
          normalDot: dot(pair.a.normal, pair.b.normal),
        },
        elementA: element(a, pair.a),
        elementB: element(b, pair.b),
      });
    }
  }
  const tags = namedDeltas(
    a,
    b,
    (m) => m.tagNames,
    (m, f) => m.tagNames.flatMap((_, t) => (m.hasTag(f, t) ? [t] : [])),
  );
  for (const { name, delta: d } of tags) {
    if (d.delta !== 0) differences.push({ reason: 'tag', detail: { tag: name, ...d } });
  }
  const materials = namedDeltas(
    a,
    b,
    (m) => m.materialNames,
    (m, f) => [m.fMaterial[f] as number],
  );
  for (const { name, delta: d } of materials) {
    if (d.delta !== 0) differences.push({ reason: 'material', detail: { material: name, ...d } });
  }
  const trisA = triangles(a);
  const trisB = triangles(b);
  const ab = directed(a, trisB, work);
  const ba = directed(b, trisA, work);
  for (const fact of faceFacts) differences.push(fact);
  return ok({
    identical,
    counts,
    closed,
    volume,
    area,
    bounds: { a: boxA, b: boxB, frame },
    hausdorff: {
      ab: ab.distance,
      ba: ba.distance,
      max: Math.max(ab.distance, ba.distance),
      sampled: ab.sampled || ba.sampled,
    },
    faces,
    provenance,
    tags: tags.map(({ name, delta: d }) => ({ tag: name, ...d })),
    materials: materials.map(({ name, delta: d }) => ({ material: name, ...d })),
    differences: differences.slice(0, limit),
    differencesTotal: differences.length,
  });
}
