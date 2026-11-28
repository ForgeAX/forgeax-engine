import {
  computeTangentVec4,
  createMeshBuilder,
  deriveVertexLayoutProjection,
  unpackInterleavedVertexAttributes,
} from '@forgeax/engine-geometry';
import {
  err,
  type MeshAsset,
  ok,
  type Result,
  type VertexAttributeMap,
} from '@forgeax/engine-types';
import { maxOf, pushAll } from './arrays';
import { TriangleBvh } from './compute/bvh';
import { flagSharpness } from './crease';
import { atan2, cos, hypot3 } from './dmath';
import { type ModelingError, modelingError } from './errors';
import { type ExportTopology, weldedTopology } from './export-topology';
import { decodeSnapshot } from './fxem';
import {
  add,
  cross,
  dot,
  faceNormal,
  length,
  normalize,
  scale,
  sub,
  type Tuple3,
  triangulateLoop,
} from './geom';
import { type CornerChannelName, type EditMesh, NONE } from './mesh';
import { type NurbsSurface, surfaceDerivatives, surfaceDomain } from './nurbs';
import type { OpDiagnostic } from './ops';
import { type SurfaceContract, surfaceDiagnostics } from './surface-contract';

/**
 * Export normal mode. `weighted` weighs each face by corner angle x area (mid-poly hard
 * surface); with `bevelBorrow` (degrees) faces smaller than a fifth of the largest face of
 * their normal group drop out of it wherever such a large face lies within that angle, so
 * large faces stay exactly flat and bevels interpolate between their neighbours' normals;
 * `faceWeight` multiplies the weight of faces carrying a tag. `transfer` takes each
 * render vertex's normal from the nearest point of a source mesh (FXEM snapshot) that
 * faces the same side, exported with `sourceNormals` (default smooth);
 * vertices split only at sharp edges.
 */
export type NormalMode = NormalShading & {
  /**
   * `'seams'`: a seam-bounded split for baked assets. An edge the shading would harden stays
   * smooth unless uv0 is discontinuous across it, so no hard edge lies inside a UV island and
   * the baked normal map carries the crease (default: split wherever the shading hardens).
   */
  readonly split?: 'seams';
};

/** The shading rule of a `NormalMode`. */
type NormalShading =
  | { readonly mode: 'smooth' }
  | { readonly mode: 'flat' }
  | {
      readonly mode: 'weighted';
      readonly bevelBorrow?: number;
      readonly faceWeight?: Readonly<Record<string, number>>;
    }
  | { readonly mode: 'autoSmooth'; readonly angle: number }
  /**
   * Exact patch normals: a corner of an `m.surface` face (its patch-name tag and `uv1`)
   * within `SURFACE_TOLERANCE` of its patch takes the patch normal; corners sharing a vertex
   * across a smooth edge take their mean when every corner's patch normal agrees within 1
   * degree; any other corner takes the default `weighted` normal.
   */
  | { readonly mode: 'surface' }
  | {
      readonly mode: 'transfer';
      readonly from: Uint8Array;
      readonly sourceNormals?: Exclude<NormalMode, { readonly mode: 'transfer' }>;
    };

/**
 * Bits of `edgeKinds`. `boundary`: one face. `seam`: uv0 is discontinuous across the edge
 * (an island border; `EDGE_SEAM` stays the author's request). `hard`: export normals split
 * across it. `crease`: a finite crease level. `smooth`: an interior edge that is not hard (G1).
 */
export const EDGE_KIND = { boundary: 1, seam: 2, hard: 4, crease: 8, smooth: 16 } as const;

/** A face smaller than this fraction of its normal group's largest face borrows (bevelBorrow). */
const BEVEL_AREA_RATIO = 0.2;

/** Channels exported to runtime slots: corner channel name -> MeshAsset attribute key. */
const EXPORT_SLOTS: readonly (readonly [CornerChannelName, keyof VertexAttributeMap])[] = [
  ['uv0', 'uv'],
  ['uv1', 'uv1'],
  ['uv2', 'uv2'],
  ['uv3', 'uv3'],
  ['uv4', 'uv4'],
  ['uv5', 'uv5'],
  ['uv6', 'uv6'],
  ['uv7', 'uv7'],
  ['color', 'color'],
];

/** A triangle within this many f32 steps of collapsing is a sliver, not a defect. */
const F32_SLIVER_STEPS = 4;
/** Spacing of f32 values relative to their magnitude (2^-23). */
const F32_EPSILON = 1.1920928955078125e-7;

export interface ExportOptions {
  readonly normals?: NormalMode;
  /** Report `topology` of the source mesh welded at distance 0 (default off). */
  readonly checkTopology?: boolean;
  /** Report the P2-S1 surface contract findings in `diagnostics` (the export is unchanged). */
  readonly surface?: SurfaceContract;
  /**
   * The session's recorded patches, for `{ mode: 'surface' }`.
   * @internal
   */
  readonly surfaces?: readonly { readonly name: string; readonly surface: NurbsSurface }[];
  /**
   * The channel holding the patch domain (default `uv1`; BK56 moves it with `uv.lightmap`).
   * @internal
   */
  readonly domain?: CornerChannelName;
}

/** Largest distance between a vertex and its patch point for an exact surface normal (m). */
const SURFACE_TOLERANCE = 2e-5;

export interface ExportReport {
  readonly faces: number;
  readonly triangles: number;
  /** Vertices after splitting by normal group and corner values (the GPU count). */
  readonly gpuVertices: number;
  readonly materialSlots: readonly string[];
  readonly aabb: readonly [number, number, number, number, number, number];
  /** Triangles dropped because they are thinner than the f32 grid at their coordinates. */
  readonly slivers: number;
  /** With `checkTopology`: free and non-manifold edges and components of the source faces. */
  readonly topology?: ExportTopology;
  /** With `{ mode: 'surface' }`: render vertices with an exact patch normal, and all of them. */
  readonly exactNormals?: readonly [number, number];
  /** With `{ mode: 'surface' }` once `uv.lightmap` moved the patch domain: the MeshAsset attribute that holds it (pass it to `surfaceField` as `domain`). */
  readonly normalDomain?: CornerChannelName;
  /**
   * With `{ mode: 'surface' }`: an `info` when the session records patches but no render
   * vertex lies on them (the recorded patches stay where `m.surface` built them, so a later
   * translate or rotate leaves every vertex off its patch and all normals weighted; `mirror`
   * records the reflected patches).
   */
  readonly diagnostics?: readonly OpDiagnostic[];
}

/** One clip a rig export wrote. */
export interface ClipReport {
  readonly name: string;
  /** Source key: `animation-clip/<key>/<name>`. */
  readonly key: string;
  readonly loop: boolean;
  readonly duration: number;
  /** Samples per channel. */
  readonly frames: number;
}

/**
 * Author attributes of an export beside its GPU buffers (BK47): the provenance maps from render
 * elements to the compacted source mesh, and that mesh's per-face and per-edge tables, so
 * consumers re-attach tags, label, role, part role, sharp, seam and crease without any GPU
 * attribute. Ids are compacted (history-independent, the FXEM order). Every table is an owned
 * copy: writing to one never changes the session or a later export.
 */
export interface ExportSidecar {
  /** Render vertex -> source corner (compacted half-edge id). */
  readonly vertexCorner: Int32Array;
  /** Render triangle -> source face (compacted face id). */
  readonly triangleFace: Int32Array;
  /**
   * Three per render triangle: the source edge of side k (corner k to corner k + 1), or -1 for
   * a diagonal inside its face.
   */
  readonly triangleEdge: Int32Array;
  /** Per source face: label index into `labelNames`. */
  readonly faceLabel: Int32Array;
  /** Per source face: geometric role index into `roleNames`. */
  readonly faceRole: Int32Array;
  /** Per source face: the face flag byte (mirrored, edge round, part role). */
  readonly faceFlags: Uint8Array;
  /** Per source face: `tagWords` words of tag bits (bit t = `tagNames[t]`). */
  readonly faceTags: Uint32Array;
  readonly tagWords: number;
  /** Per source edge: the intent byte (sharp, seam, crease level; see `flagSharpness`). */
  readonly edgeFlags: Uint8Array;
  readonly tagNames: readonly string[];
  readonly labelNames: readonly string[];
  readonly roleNames: readonly string[];
}

export interface ExportResult {
  readonly mesh: MeshAsset;
  readonly report: ExportReport;
  readonly sidecar: ExportSidecar;
}

export class UnionFind {
  readonly parent: Int32Array;
  constructor(size: number) {
    this.parent = new Int32Array(size);
    for (let i = 0; i < size; i++) this.parent[i] = i;
  }
  find(i: number): number {
    let root = i;
    while ((this.parent[root] as number) !== root) root = this.parent[root] as number;
    let node = i;
    while ((this.parent[node] as number) !== root) {
      const next = this.parent[node] as number;
      this.parent[node] = root;
      node = next;
    }
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (ra < rb) this.parent[rb] = ra;
    else this.parent[ra] = rb;
  }
}

/** UV coordinates closer than this are one corner value. */
const UV_EPSILON = 1e-6;

function sameUv(a: Float32Array | undefined, b: Float32Array | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return (
    Math.abs((a[0] as number) - (b[0] as number)) <= UV_EPSILON &&
    Math.abs((a[1] as number) - (b[1] as number)) <= UV_EPSILON
  );
}

/**
 * Whether uv0 is continuous across interior edge `e` (false without uv0).
 * @internal
 */
export function uvContinuous(mesh: EditMesh, e: number): boolean {
  const h = e * 2;
  const t = h + 1;
  // Corner (A, origin of h) meets (B, origin of next(t)); (A, end of h) meets (B, origin of t).
  return (
    sameUv(mesh.corner('uv0', h), mesh.corner('uv0', mesh.hNext[t] as number)) &&
    sameUv(mesh.corner('uv0', mesh.hNext[h] as number), mesh.corner('uv0', t))
  );
}

/**
 * Whether export normals are shared across edge `e` under `normals` (no infinite crease, both
 * faces present, within the autoSmooth angle; under `split: 'seams'` also every edge inside a
 * UV island). The hard-edge definition shared by the export normal groups, the bake checks and
 * `edgeKinds` (which is this query over every edge).
 * @internal
 */
export function smoothAcross(mesh: EditMesh, e: number, normals: NormalMode): boolean {
  const a = mesh.hFace[e * 2] as number;
  const b = mesh.hFace[e * 2 + 1] as number;
  if (a === NONE || b === NONE) return false;
  if (shadedSmooth(mesh, e, a, b, normals)) return true;
  return normals.split === 'seams' && uvContinuous(mesh, e);
}

function shadedSmooth(mesh: EditMesh, e: number, a: number, b: number, normals: NormalMode) {
  if (normals.mode === 'flat') return false;
  if (flagSharpness(mesh.eFlags[e] as number) === Infinity) return false;
  if (normals.mode !== 'autoSmooth') return true;
  const cosine = dot(faceNormal(mesh, a), faceNormal(mesh, b));
  return cosine >= cos((normals.angle * Math.PI) / 180) - 1e-12;
}

/**
 * Whether `value` is a valid `respectSharp`: a boolean or a `NormalMode` object.
 * @internal
 */
export function isRespectSharp(value: unknown): value is boolean | NormalMode {
  if (typeof value === 'boolean') return true;
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { mode?: unknown }).mode === 'string'
  );
}

/**
 * Whether the shading of `normals` hardens interior edge `e`, before any `split`: the hard
 * edges a UV planner given `respectSharp: NormalMode` cuts, so its islands bound them.
 * @internal
 */
export function shadingHard(mesh: EditMesh, e: number, normals: NormalMode): boolean {
  const a = mesh.hFace[e * 2] as number;
  const b = mesh.hFace[e * 2 + 1] as number;
  return a !== NONE && b !== NONE && !shadedSmooth(mesh, e, a, b, normals);
}

/**
 * The derived per-edge classification (`EDGE_KIND` bits, indexed by edge id) under the
 * export normal mode, for inspection and tests: the export normal groups and the UV planners
 * read its single-edge queries (`smoothAcross`, `shadingHard`). Simplify, remesh and lowpoly run
 * before any UV exists and still read the author `EDGE_SHARP` flag directly; the table is
 * observational for them. Computed at use and never written back: edge flags stay author intent.
 */
export function edgeKinds(mesh: EditMesh, normals: NormalMode): Uint8Array {
  const kinds = new Uint8Array(mesh.halfHighWater >> 1);
  for (const e of mesh.edges()) {
    const level = flagSharpness(mesh.eFlags[e] as number);
    let kind = level > 0 && level !== Infinity ? EDGE_KIND.crease : 0;
    if ((mesh.hFace[e * 2] as number) === NONE || (mesh.hFace[e * 2 + 1] as number) === NONE) {
      kind |= EDGE_KIND.boundary;
    } else {
      if (!uvContinuous(mesh, e)) kind |= EDGE_KIND.seam;
      kind |= smoothAcross(mesh, e, normals) ? EDGE_KIND.smooth : EDGE_KIND.hard;
    }
    kinds[e] = kind;
  }
  return kinds;
}

function cornerAngle(mesh: EditMesh, h: number): number {
  const pos = mesh.pos;
  const vp = (mesh.hVert[h] as number) * 3;
  const vn = (mesh.hVert[mesh.hNext[h] as number] as number) * 3;
  const vr = (mesh.hVert[mesh.hPrev[h] as number] as number) * 3;
  const px = pos[vp] as number,
    py = pos[vp + 1] as number,
    pz = pos[vp + 2] as number;
  let ux = (pos[vn] as number) - px,
    uy = (pos[vn + 1] as number) - py,
    uz = (pos[vn + 2] as number) - pz;
  const ul = hypot3(ux, uy, uz);
  if (ul > 0) {
    ux /= ul;
    uy /= ul;
    uz /= ul;
  } else {
    ux = 0;
    uy = 0;
    uz = 0;
  }
  let vx = (pos[vr] as number) - px,
    vy = (pos[vr + 1] as number) - py,
    vz = (pos[vr + 2] as number) - pz;
  const vl = hypot3(vx, vy, vz);
  if (vl > 0) {
    vx /= vl;
    vy /= vl;
    vz /= vl;
  } else {
    vx = 0;
    vy = 0;
    vz = 0;
  }
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  return atan2(hypot3(cx, cy, cz), ux * vx + uy * vy + uz * vz);
}

/**
 * The transfer field: nearest point of the source's exported surface that faces the same
 * side as the reference normal (any point when none does), its interpolated normal.
 */
function transferSource(
  normals: Extract<NormalMode, { readonly mode: 'transfer' }>,
): Result<(p: Tuple3, reference: Tuple3) => Tuple3, ModelingError> {
  const decoded = decodeSnapshot(normals.from);
  if (!decoded.ok) return decoded;
  const sourceNormals = normals.sourceNormals ?? { mode: 'smooth' };
  if ((sourceNormals as NormalMode).mode === 'transfer') {
    return err(
      modelingError('model-invalid-argument', 'transfer.sourceNormals is not a transfer', {}),
    );
  }
  const source = exportMesh(decoded.value, { normals: sourceNormals });
  if (!source.ok) return source;
  const attributes = unpackInterleavedVertexAttributes(
    source.value.mesh.vertices,
    deriveVertexLayoutProjection(source.value.mesh.attributes),
  ) as Record<string, Float32Array> | undefined;
  const indices = source.value.mesh.indices;
  const position = attributes?.position;
  const normal = attributes?.normal;
  if (position === undefined || normal === undefined || indices === undefined) {
    return err(
      modelingError('model-degenerate', 'the transfer source exports positions and normals', {}),
    );
  }
  const bvh = new TriangleBvh(position, indices);
  const triangles = indices.length / 3;
  const faceN = new Float64Array(triangles * 3);
  const corner = (t: number, k: number): Tuple3 => {
    const i = indices[t * 3 + k] as number;
    return [
      position[i * 3] as number,
      position[i * 3 + 1] as number,
      position[i * 3 + 2] as number,
    ];
  };
  for (let t = 0; t < triangles; t++) {
    const a = corner(t, 0);
    faceN.set(normalize(cross(sub(corner(t, 1), a), sub(corner(t, 2), a))), t * 3);
  }
  return ok((p, reference) => {
    const near = (bvh.nearest(
      p,
      (t) =>
        (faceN[t * 3] as number) * reference[0] +
          (faceN[t * 3 + 1] as number) * reference[1] +
          (faceN[t * 3 + 2] as number) * reference[2] >
        0,
    ) ?? bvh.nearest(p)) as NonNullable<ReturnType<TriangleBvh['nearest']>>;
    const w = [1 - near.u - near.v, near.u, near.v];
    const out: Tuple3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const i = indices[near.triangle * 3 + k] as number;
      for (let c = 0; c < 3; c++)
        out[c] = (out[c] as number) + (w[k] as number) * (normal[i * 3 + c] as number);
    }
    return normalize(out);
  });
}

/**
 * Export a compacted mesh to an immutable MeshAsset. Normals derive from sharp
 * edges and the normal mode; render vertices split exactly on the integer tuple
 * (vertex, normal group, corner value bits), never on a distance threshold.
 */
export function exportMesh(
  mesh: EditMesh,
  options: ExportOptions = {},
): Result<ExportResult, ModelingError> {
  const normals = options.normals ?? { mode: 'smooth' };
  if (normals.split !== undefined && (normals.split !== 'seams' || normals.mode === 'flat')) {
    return err(
      modelingError(
        'model-invalid-argument',
        "normals.split is 'seams' (not with flat) or absent",
        { split: normals.split, mode: normals.mode },
        "flat shading hardens every edge, so there is nothing for a seam-bounded split to soften: drop split, or use mode 'autoSmooth'",
      ),
    );
  }
  if (normals.mode === 'autoSmooth' && !(normals.angle >= 0 && normals.angle <= 180)) {
    return err(
      modelingError('model-invalid-argument', 'autoSmooth angle is within [0, 180]', {
        angle: normals.angle,
      }),
    );
  }
  if (normals.mode === 'weighted') {
    const borrow = normals.bevelBorrow;
    if (borrow !== undefined && !(borrow >= 0 && borrow <= 180)) {
      return err(
        modelingError('model-invalid-argument', 'weighted bevelBorrow is within [0, 180] degrees', {
          bevelBorrow: borrow,
        }),
      );
    }
    for (const [tag, weight] of Object.entries(normals.faceWeight ?? {})) {
      if (!(weight >= 0 && Number.isFinite(weight))) {
        return err(
          modelingError('model-invalid-argument', 'faceWeight values are finite and non-negative', {
            tag,
            weight,
          }),
        );
      }
    }
  }
  let transfer: ((p: Tuple3, reference: Tuple3) => Tuple3) | undefined;
  if (normals.mode === 'transfer') {
    const source = transferSource(normals);
    if (!source.ok) return source;
    transfer = source.value;
  }
  const faces = mesh.faces();
  if (faces.length === 0) {
    return err(modelingError('model-precondition', 'the mesh has at least one face to export', {}));
  }
  const exported = EXPORT_SLOTS.filter(([name]) => mesh.channels.has(name));
  for (const [name] of exported) {
    const missing = faces.filter((f) =>
      mesh.faceHalves(f).some((h) => mesh.corner(name, h) === undefined),
    );
    if (missing.length > 0) {
      return err(
        modelingError(
          'model-precondition',
          `every face has ${name} values before export`,
          { channel: name, missingFaces: missing.length, firstFace: missing[0] },
          name === 'uv0'
            ? "topology edits leave new faces without UVs; call m.uv.project({ mode: 'box', scale }) after the last topology edit"
            : `write ${name} on every face or remove the channel`,
        ),
      );
    }
  }
  const uvChannel = exported.find(([name]) => name === 'uv0');
  if (uvChannel === undefined) {
    return err(
      modelingError(
        'model-precondition',
        'the mesh has uv0 values (tangents and the standard pipeline need UVs)',
        {},
        "call m.uv.project({ mode: 'box', scale }) before finish",
      ),
    );
  }

  // Precompute face unit normals & areas in flat Float64Arrays (zero per-face Map/Tuple3 overhead)
  const faceNormalF64 = new Float64Array(mesh.faceHighWater * 3);
  const faceAreaF64 = new Float64Array(mesh.faceHighWater);
  const vPos = mesh.pos;
  const hVert = mesh.hVert;
  const hNext = mesh.hNext;
  const hFace = mesh.hFace;
  const fHalf = mesh.fHalf;
  for (let fi = 0; fi < faces.length; fi++) {
    const f = faces[fi] as number;
    const h0 = fHalf[f] as number;
    let nx = 0,
      ny = 0,
      nz = 0;
    let h = h0;
    do {
      const hn = hNext[h] as number;
      const a3 = (hVert[h] as number) * 3;
      const b3 = (hVert[hn] as number) * 3;
      const ax = vPos[a3] as number,
        ay = vPos[a3 + 1] as number,
        az = vPos[a3 + 2] as number;
      const bx = vPos[b3] as number,
        by = vPos[b3 + 1] as number,
        bz = vPos[b3 + 2] as number;
      nx += (ay - by) * (az + bz);
      ny += (az - bz) * (ax + bx);
      nz += (ax - bx) * (ay + by);
      h = hn;
    } while (h !== h0);
    const len = hypot3(nx, ny, nz);
    faceAreaF64[f] = 0.5 * len;
    if (len > 0) {
      const inv = 1 / len;
      faceNormalF64[f * 3] = nx * inv;
      faceNormalF64[f * 3 + 1] = ny * inv;
      faceNormalF64[f * 3 + 2] = nz * inv;
    }
  }

  const groups = new UnionFind(mesh.halfHighWater);
  const seamSplit = normals.split === 'seams';
  const seamUv = mesh.channel('uv0').values;
  const autoSmoothCos =
    normals.mode === 'autoSmooth' ? cos((normals.angle * Math.PI) / 180) - 1e-12 : 0;
  for (const e of mesh.edges()) {
    const a = hFace[e * 2] as number;
    const b = hFace[e * 2 + 1] as number;
    if (a === NONE || b === NONE || normals.mode === 'flat') continue;
    let smooth = flagSharpness(mesh.eFlags[e] as number) !== Infinity;
    if (smooth && normals.mode === 'autoSmooth') {
      const a3 = a * 3;
      const b3 = b * 3;
      smooth =
        (faceNormalF64[a3] as number) * (faceNormalF64[b3] as number) +
          (faceNormalF64[a3 + 1] as number) * (faceNormalF64[b3 + 1] as number) +
          (faceNormalF64[a3 + 2] as number) * (faceNormalF64[b3 + 2] as number) >=
        autoSmoothCos;
    }
    const h = e * 2;
    const t = h + 1;
    if (!smooth) {
      if (!seamSplit) continue;
      const hn = hNext[h] as number;
      const tn = hNext[t] as number;
      if (
        (seamUv[h * 2] as number) !== (seamUv[tn * 2] as number) ||
        (seamUv[h * 2 + 1] as number) !== (seamUv[tn * 2 + 1] as number) ||
        (seamUv[t * 2] as number) !== (seamUv[hn * 2] as number) ||
        (seamUv[t * 2 + 1] as number) !== (seamUv[hn * 2 + 1] as number)
      ) {
        continue;
      }
    }
    groups.union(h, hNext[t] as number);
    groups.union(hNext[h] as number, t);
  }
  const groupNormalF64 = new Float64Array(mesh.halfHighWater * 3);
  const groupHasNormal = new Uint8Array(mesh.halfHighWater);
  const tagWeight =
    normals.mode === 'weighted' && normals.faceWeight !== undefined
      ? Object.entries(normals.faceWeight).map(
          ([tag, weight]) => [mesh.tagNames.indexOf(tag), weight] as const,
        )
      : [];
  const faceWeight = (f: number) => {
    let w = 1;
    for (const [tag, weight] of tagWeight) if (tag >= 0 && mesh.hasTag(f, tag)) w *= weight;
    return w;
  };
  const borrow =
    normals.mode === 'weighted' && normals.bevelBorrow !== undefined
      ? cos((normals.bevelBorrow * Math.PI) / 180)
      : undefined;
  const needAreaWeight = normals.mode === 'weighted' || normals.mode === 'surface';
  // Per group: contributing faces with their weighted normal, area and unit normal.
  const members =
    borrow !== undefined ? new Map<number, { n: Tuple3; w: number; area: number }[]>() : undefined;
  for (let fi = 0; fi < faces.length; fi++) {
    const f = faces[fi] as number;
    const f3 = f * 3;
    const fnx = faceNormalF64[f3] as number,
      fny = faceNormalF64[f3 + 1] as number,
      fnz = faceNormalF64[f3 + 2] as number;
    const area = faceAreaF64[f] as number;
    const fw = needAreaWeight ? area * faceWeight(f) : 1;
    const h0 = fHalf[f] as number;
    let h = h0;
    do {
      const root = groups.find(h);
      const weight = normals.mode === 'flat' ? 1 : cornerAngle(mesh, h) * fw;
      if (members !== undefined) {
        let list = members.get(root);
        if (list === undefined) {
          list = [];
          members.set(root, list);
        }
        list.push({ n: [fnx, fny, fnz], w: weight, area });
      } else {
        const r3 = root * 3;
        groupNormalF64[r3] = (groupNormalF64[r3] as number) + fnx * weight;
        groupNormalF64[r3 + 1] = (groupNormalF64[r3 + 1] as number) + fny * weight;
        groupNormalF64[r3 + 2] = (groupNormalF64[r3 + 2] as number) + fnz * weight;
        groupHasNormal[root] = 1;
      }
      h = hNext[h] as number;
    } while (h !== h0);
  }
  if (borrow !== undefined && members !== undefined) {
    for (const [root, list] of members) {
      const largest = maxOf(list.map((m) => m.area));
      const large = list.filter((m) => m.area >= BEVEL_AREA_RATIO * largest);
      let sx = 0,
        sy = 0,
        sz = 0;
      for (const m of list) {
        // A small face next to a large face within the borrow angle takes that face's normal.
        if (m.area < BEVEL_AREA_RATIO * largest && large.some((l) => dot(l.n, m.n) >= borrow))
          continue;
        sx += m.n[0] * m.w;
        sy += m.n[1] * m.w;
        sz += m.n[2] * m.w;
      }
      const r3 = root * 3;
      groupNormalF64[r3] = sx;
      groupNormalF64[r3 + 1] = sy;
      groupNormalF64[r3 + 2] = sz;
      groupHasNormal[root] = 1;
    }
  }

  let exactNormal: Map<number, Tuple3> | undefined;
  if (normals.mode === 'surface') {
    const faceNormalsMap = new Map<number, Tuple3>();
    for (let fi = 0; fi < faces.length; fi++) {
      const f = faces[fi] as number;
      faceNormalsMap.set(f, [
        faceNormalF64[f * 3] as number,
        faceNormalF64[f * 3 + 1] as number,
        faceNormalF64[f * 3 + 2] as number,
      ]);
    }
    exactNormal = surfaceNormals(mesh, faces, faceNormalsMap, groups, options);
  }

  // Render vertices with the same source vertex form a chain; a corner joins the one
  // with its normal group and equal corner values (-0 equals 0, NaN equals NaN).
  const vertexCorner: number[] = [];
  const renderGroup: number[] = [];
  const sameVertexNext: number[] = [];
  const firstRender = new Int32Array(mesh.vertexHighWater).fill(NONE);
  const cornerChannels = exported.map(([name]) => mesh.channel(name));
  const sameValues = (a: number, b: number): boolean => {
    for (const { dim, values } of cornerChannels) {
      for (let i = 0; i < dim; i++) {
        const x = values[a * dim + i] as number;
        const y = values[b * dim + i] as number;
        if (x !== y && !(Number.isNaN(x) && Number.isNaN(y))) return false;
      }
    }
    return true;
  };
  // A tangent frame is per vertex, so a corner also joins only a vertex of its face's uv0
  // handedness: a welded mirror seam keeps one frame per side (MikkTSpace splits there too).
  // A face without uv area (sign 0) joins either side.
  const renderSign: number[] = [];
  const renderOf = (h: number, sign: number): number => {
    const v = mesh.hVert[h] as number;
    const group = groups.find(h);
    for (let r = firstRender[v] as number; r !== NONE; r = sameVertexNext[r] as number) {
      const other = renderSign[r] as number;
      if (sign !== 0 && other !== 0 && other !== sign) continue;
      if (renderGroup[r] === group && sameValues(vertexCorner[r] as number, h)) {
        if (other === 0) renderSign[r] = sign;
        return r;
      }
    }
    const index = vertexCorner.length;
    vertexCorner.push(h);
    renderGroup.push(group);
    renderSign.push(sign);
    sameVertexNext.push(firstRender[v] as number);
    firstRender[v] = index;
    return index;
  };
  const uvValues = mesh.channel('uv0').values;
  const uvHandedness = (halves: readonly number[]): number => {
    let area = 0;
    for (const [k, h] of halves.entries()) {
      const g = halves[(k + 1) % halves.length] as number;
      area +=
        (uvValues[h * 2] as number) * (uvValues[g * 2 + 1] as number) -
        (uvValues[g * 2] as number) * (uvValues[h * 2 + 1] as number);
    }
    return Math.sign(area);
  };

  const facesByMaterial = new Map<number, number[]>();
  for (let fi = 0; fi < faces.length; fi++) {
    const f = faces[fi] as number;
    const mat = mesh.fMaterial[f] as number;
    let bucket = facesByMaterial.get(mat);
    if (bucket === undefined) {
      bucket = [];
      facesByMaterial.set(mat, bucket);
    }
    bucket.push(f);
  }
  const slotOrder = [...facesByMaterial.keys()].sort((a, b) => a - b);
  const indices: number[] = [];
  const triangleFace: number[] = [];
  const triangleEdge: number[] = [];
  const submeshes: { indexOffset: number; indexCount: number; materialSlot: number }[] = [];
  const halvesScratch: number[] = [];
  for (const [slotIndex, material] of slotOrder.entries()) {
    const start = indices.length;
    const slotFaces = facesByMaterial.get(material) as number[];
    for (let fi = 0; fi < slotFaces.length; fi++) {
      const f = slotFaces[fi] as number;
      halvesScratch.length = 0;
      const h0 = fHalf[f] as number;
      let h = h0;
      do {
        halvesScratch.push(h);
        h = hNext[h] as number;
      } while (h !== h0);
      const nHalves = halvesScratch.length;
      const sign = uvHandedness(halvesScratch);
      if (nHalves === 3) {
        const hA = halvesScratch[0] as number;
        const hB = halvesScratch[1] as number;
        const hC = halvesScratch[2] as number;
        indices.push(renderOf(hA, sign), renderOf(hB, sign), renderOf(hC, sign));
        triangleEdge.push(hA >> 1, hB >> 1, hC >> 1);
        triangleFace.push(f);
        continue;
      }
      const loopPts: Tuple3[] = new Array(nHalves);
      for (let k = 0; k < nHalves; k++) {
        const v3 = (hVert[halvesScratch[k] as number] as number) * 3;
        loopPts[k] = [vPos[v3] as number, vPos[v3 + 1] as number, vPos[v3 + 2] as number];
      }
      const local = triangulateLoop(loopPts);
      if (local === undefined) {
        return err(
          modelingError(
            'model-degenerate',
            'every face can be triangulated by ear clipping in its best-fit plane',
            { face: f },
            'the face overlaps itself in its best-fit plane; split or rebuild it',
          ),
        );
      }
      for (let i = 0; i < local.length; i += 3) {
        for (let j = 0; j < 3; j++) {
          const a = local[i + j] as number;
          const ha = halvesScratch[a] as number;
          indices.push(renderOf(ha, sign));
          const b = local[i + ((j + 1) % 3)] as number;
          triangleEdge.push((a + 1) % nHalves === b ? ha >> 1 : NONE);
        }
        triangleFace.push(f);
      }
    }
    submeshes.push({
      indexOffset: start,
      indexCount: indices.length - start,
      materialSlot: slotIndex,
    });
  }

  const count = vertexCorner.length;
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const channelData = new Map<CornerChannelName, Float32Array>();
  const channelOutPairs: {
    readonly dim: number;
    readonly src: Float32Array;
    readonly dst: Float32Array;
  }[] = [];
  for (const [name] of exported) {
    const dim = name === 'color' ? 4 : 2;
    const dst = new Float32Array(count * dim);
    channelData.set(name, dst);
    channelOutPairs.push({ dim, src: mesh.channel(name).values, dst });
  }
  let exactCount = 0;
  for (let i = 0; i < count; i++) {
    const h = vertexCorner[i] as number;
    const v3 = (hVert[h] as number) * 3;
    const px = vPos[v3] as number,
      py = vPos[v3 + 1] as number,
      pz = vPos[v3 + 2] as number;
    const i3 = i * 3;
    position[i3] = px;
    position[i3 + 1] = py;
    position[i3 + 2] = pz;
    const root = groups.find(h);
    const exact = exactNormal?.get(root);
    let nx: number, ny: number, nz: number;
    if (exact !== undefined) {
      exactCount++;
      nx = exact[0];
      ny = exact[1];
      nz = exact[2];
    } else if (groupHasNormal[root] !== 0) {
      const r3 = root * 3;
      nx = groupNormalF64[r3] as number;
      ny = groupNormalF64[r3 + 1] as number;
      nz = groupNormalF64[r3 + 2] as number;
    } else {
      const f = hFace[h] as number;
      if (f !== NONE) {
        nx = faceNormalF64[f * 3] as number;
        ny = faceNormalF64[f * 3 + 1] as number;
        nz = faceNormalF64[f * 3 + 2] as number;
      } else {
        nx = 0;
        ny = 1;
        nz = 0;
      }
    }
    const nl = hypot3(nx, ny, nz);
    if (nl > 0) {
      nx /= nl;
      ny /= nl;
      nz /= nl;
    } else {
      nx = 0;
      ny = 0;
      nz = 0;
    }
    if (transfer !== undefined) {
      const tn = transfer([px, py, pz], [nx, ny, nz]);
      normal[i3] = tn[0];
      normal[i3 + 1] = tn[1];
      normal[i3 + 2] = tn[2];
    } else {
      normal[i3] = nx;
      normal[i3 + 1] = ny;
      normal[i3 + 2] = nz;
    }
    for (let ci = 0; ci < channelOutPairs.length; ci++) {
      const ch = channelOutPairs[ci] as {
        readonly dim: number;
        readonly src: Float32Array;
        readonly dst: Float32Array;
      };
      const dim = ch.dim;
      const srcOff = h * dim;
      const dstOff = i * dim;
      for (let d = 0; d < dim; d++) ch.dst[dstOff + d] = ch.src[srcOff + d] as number;
    }
  }

  // A triangle thinner than the f32 grid at its own coordinates (a sliver of a valid face
  // far from the origin) can collapse or flip once positions are rounded. It covers less
  // than one representable step, so it is dropped and counted; any other inversion is a
  // real defect and fails.
  const slivers = new Set<number>();
  const triTotal = indices.length / 3;
  for (let t = 0; t < triTotal; t++) {
    const i0 = (indices[t * 3] as number) * 3;
    const i1 = (indices[t * 3 + 1] as number) * 3;
    const i2 = (indices[t * 3 + 2] as number) * 3;
    const ax = position[i0] as number,
      ay = position[i0 + 1] as number,
      az = position[i0 + 2] as number;
    const e1x = (position[i1] as number) - ax,
      e1y = (position[i1 + 1] as number) - ay,
      e1z = (position[i1 + 2] as number) - az;
    const e2x = (position[i2] as number) - ax,
      e2y = (position[i2 + 1] as number) - ay,
      e2z = (position[i2 + 2] as number) - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const face = triangleFace[t] as number;
    const f3 = face * 3;
    if (
      nx * (faceNormalF64[f3] as number) +
        ny * (faceNormalF64[f3 + 1] as number) +
        nz * (faceNormalF64[f3 + 2] as number) >
      0
    ) {
      continue;
    }
    const corners = [
      indices[t * 3] as number,
      indices[t * 3 + 1] as number,
      indices[t * 3 + 2] as number,
    ];
    const exact = corners.map((i) => mesh.position(hVert[vertexCorner[i] as number] as number)) as [
      Tuple3,
      Tuple3,
      Tuple3,
    ];
    const longest = Math.max(
      length(sub(exact[1], exact[0])),
      length(sub(exact[2], exact[1])),
      length(sub(exact[0], exact[2])),
    );
    const altitude =
      longest > 0 ? length(cross(sub(exact[1], exact[0]), sub(exact[2], exact[0]))) / longest : 0;
    const reach = maxOf(exact.flatMap((p) => p.map(Math.abs)));
    if (altitude <= F32_SLIVER_STEPS * reach * F32_EPSILON) {
      slivers.add(t);
      continue;
    }
    return err(
      modelingError('model-degenerate', 'no triangle collapses or inverts after f32 conversion', {
        face,
        triangle: t,
        at: scale(add(add(exact[0], exact[1]), exact[2]), 1 / 3),
        vertices: exact,
        altitude,
      }),
    );
  }
  if (slivers.size > 0) {
    const kept: number[] = [];
    const keptFaces: number[] = [];
    const keptEdges: number[] = [];
    for (const submesh of submeshes) {
      const offset = kept.length;
      for (
        let t = submesh.indexOffset / 3;
        t < (submesh.indexOffset + submesh.indexCount) / 3;
        t++
      ) {
        if (slivers.has(t)) continue;
        kept.push(
          indices[t * 3] as number,
          indices[t * 3 + 1] as number,
          indices[t * 3 + 2] as number,
        );
        keptFaces.push(triangleFace[t] as number);
        keptEdges.push(
          triangleEdge[t * 3] as number,
          triangleEdge[t * 3 + 1] as number,
          triangleEdge[t * 3 + 2] as number,
        );
      }
      submesh.indexOffset = offset;
      submesh.indexCount = kept.length - offset;
    }
    indices.length = 0;
    for (const i of kept) indices.push(i);
    triangleFace.length = 0;
    for (const f of keptFaces) triangleFace.push(f);
    triangleEdge.length = 0;
    for (const e of keptEdges) triangleEdge.push(e);
  }
  const triangles = indices.length / 3;

  const indexArray = count <= 0xffff ? new Uint16Array(indices) : new Uint32Array(indices);
  const uv = channelData.get('uv0') as Float32Array;
  const tangent = computeTangentVec4(position, normal, uv, indexArray);
  if (!tangent.ok) {
    return err(
      modelingError('model-degenerate', 'tangents can be derived from positions, normals and UVs', {
        cause: tangent.error.code,
      }),
    );
  }
  const attributes: Record<string, Float32Array> = { position, normal, tangent: tangent.value };
  for (const [name, key] of exported) attributes[key] = channelData.get(name) as Float32Array;
  const slotNames = slotOrder.map((m) => mesh.materialNames[m] as string);
  const built = createMeshBuilder({
    attributes: attributes as VertexAttributeMap,
    indices: indexArray,
    submeshes,
    materialSlots: slotNames.map((slotName) => ({ slotName })),
  }).build();
  if (!built.ok) {
    return err(
      modelingError('model-degenerate', 'the exported buffers form a valid MeshAsset', {
        cause: built.error.code,
        detail: built.error.detail,
      }),
    );
  }
  const aabb = built.value.aabb;
  const box: [number, number, number, number, number, number] = aabb
    ? ([aabb[0], aabb[1], aabb[2], aabb[3], aabb[4], aabb[5]].map((x) => x as number) as [
        number,
        number,
        number,
        number,
        number,
        number,
      ])
    : [0, 0, 0, 0, 0, 0];
  const diagnostics: OpDiagnostic[] = [];
  if (exactNormal !== undefined && exactCount === 0 && (options.surfaces ?? []).length > 0) {
    diagnostics.push({
      severity: 'info',
      message:
        'no render vertex lies on a recorded patch: every normal is weighted (a transform after m.surface leaves the patches behind)',
      detail: { patches: (options.surfaces ?? []).length, vertices: count },
    });
  }
  if (options.surface !== undefined)
    pushAll(diagnostics, surfaceDiagnostics(mesh, options.surface));
  return ok({
    mesh: built.value,
    report: {
      faces: faces.length,
      triangles,
      gpuVertices: count,
      slivers: slivers.size,
      ...(options.checkTopology === true ? { topology: weldedTopology(mesh, faces) } : {}),
      ...(exactNormal === undefined ? {} : { exactNormals: [exactCount, count] as const }),
      ...(exactNormal === undefined || (options.domain ?? 'uv1') === 'uv1'
        ? {}
        : { normalDomain: options.domain as CornerChannelName }),
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
      materialSlots: slotNames,
      aabb: box,
    },
    sidecar: sidecarOf(mesh, vertexCorner, triangleFace, triangleEdge),
  });
}

function sidecarOf(
  mesh: EditMesh,
  vertexCorner: readonly number[],
  triangleFace: readonly number[],
  triangleEdge: readonly number[],
): ExportSidecar {
  const faces = mesh.faceHighWater;
  return {
    vertexCorner: Int32Array.from(vertexCorner),
    triangleFace: Int32Array.from(triangleFace),
    triangleEdge: Int32Array.from(triangleEdge),
    faceLabel: mesh.fLabel.slice(0, faces),
    faceRole: mesh.fRole.slice(0, faces),
    faceFlags: mesh.fFlags.slice(0, faces),
    faceTags: mesh.fTags.slice(0, faces * mesh.tagWords),
    tagWords: mesh.tagWords,
    edgeFlags: mesh.eFlags.slice(0, mesh.halfHighWater >> 1),
    tagNames: [...mesh.tagNames],
    labelNames: [...mesh.labelNames],
    roleNames: [...mesh.roleNames],
  };
}

/** Suffix of the patch `m.mirror` records for each recorded patch (then `.k` if taken). */
export const MIRROR_SUFFIX = '.mirror';
const RECORDED_SUFFIX = /\.(\d+|mirror)$/;

/** Largest angle between the exact normals averaged into one group (G1 across a seam), degrees. */
const SEAM_ANGLE = 1;
const SEAM_COSINE = cos((SEAM_ANGLE * Math.PI) / 180);
/** Parameter step toward the interior for the limit normal at a degenerate point. */
const LIMIT_STEP = 1e-6;

/** A tangent pair spanning less than this fraction of its squared speed is degenerate. */
const DEGENERATE = 1e-8;

/** Unit normal at normalized (s, t), or undefined where the tangents (nearly) collapse. */
function regularNormal(surface: NurbsSurface, s: number, t: number): Tuple3 | undefined {
  const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
  const d = surfaceDerivatives(surface, u0 + (u1 - u0) * s, v0 + (v1 - v0) * t, 1);
  const su = scale((d[1] as Tuple3[])[0] as Tuple3, u1 - u0);
  const sv = scale((d[0] as Tuple3[])[1] as Tuple3, v1 - v0);
  const n = cross(su, sv);
  return length(n) > DEGENERATE * (dot(su, su) + dot(sv, sv)) ? normalize(n) : undefined;
}

/**
 * Normal of a patch at (s, t), or at a degenerate point (a pole, a zero-speed line) its
 * limit from the interior: the one-sided normals beside it, when they agree within
 * `SEAM_ANGLE`. Rounding leaves an exact pole a noisy cross product, not a zero one.
 */
export function exactPatchNormal(surface: NurbsSurface, s: number, t: number): Tuple3 | undefined {
  const m = regularNormal(surface, s, t);
  if (m !== undefined) return m;
  const sides: Tuple3[] = [];
  for (const [ds, dt] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    const a = s + ds * LIMIT_STEP;
    const b = t + dt * LIMIT_STEP;
    if (a < 0 || a > 1 || b < 0 || b > 1) continue;
    const n = regularNormal(surface, a, b);
    if (n !== undefined) sides.push(n);
  }
  const first = sides[0];
  if (first === undefined) return undefined;
  if (sides.some((n) => dot(n, first) < SEAM_COSINE)) return undefined;
  return normalize(sides.reduce(add, [0, 0, 0] as Tuple3));
}

/**
 * Tag indices of a recorded patch name. Names may carry `.k` suffixes that make repeated patch
 * names unique and `.mirror` suffixes of reflected patches; faces keep the tag of the name they
 * started with.
 */
export function patchTags(mesh: EditMesh, recorded: string): number[] {
  const tags: number[] = [];
  for (let name = recorded, base = ''; ; name = base) {
    tags.push(mesh.tagIndex(name, false));
    base = name.replace(RECORDED_SUFFIX, '');
    if (base === name) break;
  }
  return tags;
}

/**
 * Exact normals per normal group (a vertex's smooth corner fan): the mean of its corners'
 * patch normals (the limit normal at a degenerate point), each oriented to its face's side.
 * The orientation makes reflected patches exact too: a mirror reverses the parameter
 * orientation, so su x sv of a `.mirror` patch points inward, and the face normal turns it. Each corner is judged on the
 * candidate patch nearest its vertex at its domain channel (`uv1` unless BK56 moved it). A corner off that patch (a T-junction or
 * weld moved the vertex from its `uv1` point) does not contribute, but its patch normal there
 * must still agree: the vertex stands in for that point too. A group is absent (it takes the
 * weighted normal) with a corner of a face on no recorded patch, with no corner on its patch,
 * with a corner where the patch has no normal (a cone point, whose one-sided normals differ),
 * or whose normals differ by more than `SEAM_ANGLE` (a crease across a smooth edge, or a fan
 * welded across a normal jump).
 */
function surfaceNormals(
  mesh: EditMesh,
  faces: readonly number[],
  faceNormals: ReadonlyMap<number, Tuple3>,
  groups: UnionFind,
  options: ExportOptions,
): Map<number, Tuple3> {
  const domain = options.domain ?? 'uv1';
  const patches = (options.surfaces ?? []).map((p) => ({
    surface: p.surface,
    tags: patchTags(mesh, p.name),
  }));
  const failed = new Set<number>();
  const found = new Map<number, Tuple3[]>();
  const constraints = new Map<number, Tuple3[]>();
  const push = (map: Map<number, Tuple3[]>, root: number, n: Tuple3) => {
    const list = map.get(root);
    if (list === undefined) map.set(root, [n]);
    else list.push(n);
  };
  const hasDomain = mesh.channels.has(domain);
  for (const f of faces) {
    const candidates = patches.filter((p) => p.tags.some((t) => t >= 0 && mesh.hasTag(f, t)));
    const n = faceNormals.get(f) as Tuple3;
    for (const h of mesh.faceHalves(f)) {
      const root = groups.find(h);
      if (failed.has(root)) continue;
      if (candidates.length === 0 || !hasDomain) {
        failed.add(root);
        continue;
      }
      const st = mesh.corner(domain, h);
      if (st === undefined) continue;
      const s = st[0] as number;
      const t = st[1] as number;
      if (!(s >= -1e-9 && s <= 1 + 1e-9 && t >= -1e-9 && t <= 1 + 1e-9)) continue;
      const p = mesh.position(mesh.hVert[h] as number);
      let nearest: NurbsSurface | undefined;
      let offset = Number.POSITIVE_INFINITY;
      for (const { surface } of candidates) {
        const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
        const q = (
          surfaceDerivatives(surface, u0 + (u1 - u0) * s, v0 + (v1 - v0) * t, 0)[0] as Tuple3[]
        )[0] as Tuple3;
        const d = length(sub(q, p));
        if (d < offset) {
          offset = d;
          nearest = surface;
        }
      }
      const m = exactPatchNormal(
        nearest as NurbsSurface,
        Math.min(1, Math.max(0, s)),
        Math.min(1, Math.max(0, t)),
      );
      if (m === undefined) {
        failed.add(root);
        continue;
      }
      push(
        offset > SURFACE_TOLERANCE ? constraints : found,
        root,
        dot(m, n) < 0 ? scale(m, -1) : m,
      );
    }
  }
  const out = new Map<number, Tuple3>();
  for (const [root, list] of found) {
    if (failed.has(root)) continue;
    const all = [...list, ...(constraints.get(root) ?? [])];
    const consistent = all.every((a) => all.every((b) => dot(a, b) >= SEAM_COSINE));
    if (consistent) out.set(root, list.reduce(add, [0, 0, 0] as Tuple3));
  }
  return out;
}
