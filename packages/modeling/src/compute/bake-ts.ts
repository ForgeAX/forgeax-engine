import {
  deriveVertexLayoutProjection,
  unpackInterleavedVertexAttributes,
} from '@forgeax/engine-geometry';
import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, minOf } from '../arrays';
import { fromBase64 } from '../base64';
import { atan2, cos, sin } from '../dmath';
import { type ModelingError, modelingError } from '../errors';
import { exportMesh, type NormalMode } from '../finish';
import { decodeSnapshot } from '../fxem';
import { cross, dot, length, newell, normalize, sub, type Tuple3 } from '../geom';
import { type EditMesh, NONE } from '../mesh';
import { decodeSrgb } from '../texture';
import {
  averagedNormals,
  averagedPart,
  type BaseTriangles,
  baseTriangles,
  CAGE_FLOOR,
  type CornerSource,
  cageOf,
  directionOf,
  FACING_MIN,
  type FaceGroups,
  faceGroups,
  HardEdges,
  rayDirection,
  resolveCage,
  steepFraction,
  taggedFaces,
} from './bake-cage';
import {
  clipClusters,
  FINDING_KIND,
  FindingLog,
  mergeFindings,
  type StrayPart,
  strayClusters,
} from './bake-findings';
import { TS_BACKEND_IDENTITY } from './boolean-ts';
import { TriangleBvh } from './bvh';
import type {
  BackendOutput,
  BakeCage,
  BakeDirection,
  BakeHandedness,
  BakeJobNormals,
  BakeJobParams,
  BakeMapKind,
  BakeSlot,
  BakeStack,
  ComputeBackend,
  ComputeJobKind,
  ComputeJobRequest,
  WorkMeter,
} from './job';

export const BAKE_MAP_KINDS: readonly BakeMapKind[] = [
  'normal',
  'normalObject',
  'ao',
  'curvature',
  'cavity',
  'edgeWear',
  'height',
  'position',
  'thickness',
  'opacity',
  'ormh',
  'materialId',
  'baseColor',
  'emissive',
  'resample',
];
/** Maps whose value derives from curvature (texture-space on the texture target). */
const CURVATURE_MAPS: readonly BakeMapKind[] = ['curvature', 'cavity', 'edgeWear'];
/** Texels per side of a bake tile. */
export const BAKE_TILE = 32;
/**
 * Cosine of the largest turn (60 degrees) from the base normal an averaged cage hit keeps
 * unchecked: beyond it the hit is on a neighbouring face of a hard-cornered detail (a
 * cylinder cap seen from the side texels) rather than a bevel, which turns at most 45.
 */
const OWN_SIDE_COS = 0.5;
/** Default occlusion reach: this fraction of the group diagonal, at most `AO_MAX` meters. */
const AO_DIAGONAL = 0.1;
const AO_MAX = 0.5;
/** Default thickness reach as a fraction of the group diagonal. */
const THICKNESS_DIAGONAL = 0.1;
/** Node visits per work unit. */
const VISITS_PER_UNIT = 8;

/** Material-id colors in slot order (linear RGB), cycled past the end. */
export const MATERIAL_ID_PALETTE: readonly (readonly [number, number, number])[] = [
  [0.9, 0.12, 0.1],
  [0.1, 0.65, 0.15],
  [0.12, 0.25, 0.9],
  [0.95, 0.8, 0.1],
  [0.75, 0.15, 0.8],
  [0.1, 0.8, 0.8],
  [0.95, 0.45, 0.1],
  [0.5, 0.5, 0.5],
];

/** An exported triangle surface: the exact vertex data the Renderer receives. */
export interface BakeSurface {
  readonly position: Float32Array;
  readonly normal: Float32Array;
  /** computeTangentVec4 output: xyz and handedness w per vertex. */
  readonly tangent: Float32Array;
  readonly uv: Float32Array;
  readonly indices: Uint32Array;
  /** Render vertex -> FXEM half-edge. */
  readonly vertexCorner: Int32Array;
  /** Render triangle -> material slot index (in `slots`). */
  readonly triangleSlot: Int32Array;
  /** Render triangle -> FXEM face. */
  readonly triangleFace: Int32Array;
  readonly slots: readonly string[];
}

/**
 * Export a mesh as the Renderer sees it (`exportMesh` with `normals`) and read its
 * vertex buffer back, so tangents are exactly the computeTangentVec4 frame shaders use.
 * `normals` is a NormalMode or its job-params form (a transfer source as base64).
 */
export function bakeSurface(
  mesh: EditMesh,
  normals: NormalMode | BakeJobNormals,
): Result<BakeSurface, ModelingError> {
  let mode: NormalMode;
  if (normals.mode !== 'transfer') {
    mode = normals;
  } else if (typeof normals.from !== 'string') {
    mode = { ...normals, from: normals.from };
  } else {
    const from = fromBase64(normals.from);
    if (from === undefined) {
      return err(
        modelingError(
          'model-invalid-argument',
          'a transfer source in job params is base64 FXEM',
          {},
        ),
      );
    }
    mode = { ...normals, from };
  }
  const exported = exportMesh(mesh, { normals: mode });
  if (!exported.ok) return exported;
  const asset = exported.value.mesh;
  const attributes = unpackInterleavedVertexAttributes(
    asset.vertices,
    deriveVertexLayoutProjection(asset.attributes),
  ) as Record<string, Float32Array> | undefined;
  if (
    attributes?.position === undefined ||
    attributes.normal === undefined ||
    attributes.tangent === undefined ||
    attributes.uv === undefined ||
    asset.indices === undefined
  ) {
    return err(
      modelingError(
        'model-degenerate',
        'the exported mesh carries position, normal, tangent, uv',
        {},
      ),
    );
  }
  const slots = exported.value.report.materialSlots;
  const slotIndex = new Map(slots.map((name, i) => [name, i]));
  const triangleSlot = Int32Array.from(exported.value.triangleFace, (f) => {
    const name = mesh.materialNames[mesh.fMaterial[f] as number] as string;
    return slotIndex.get(name) as number;
  });
  return ok({
    position: attributes.position,
    normal: attributes.normal,
    tangent: attributes.tangent,
    uv: attributes.uv,
    indices: Uint32Array.from(asset.indices),
    vertexCorner: exported.value.vertexCorner,
    triangleSlot,
    triangleFace: Int32Array.from(exported.value.triangleFace),
    slots,
  });
}

/** Planar uv0 per face (its dominant normal axis) where a detail mesh has none: tangents only. */
function ensureUv(mesh: EditMesh): void {
  const complete = mesh
    .faces()
    .every((f) => mesh.faceHalves(f).every((h) => mesh.corner('uv0', h) !== undefined));
  if (complete) return;
  for (const f of mesh.faces()) {
    const halves = mesh.faceHalves(f);
    const n = newell(halves.map((h) => mesh.position(mesh.hVert[h] as number)));
    const a = n.map(Math.abs) as Tuple3;
    const [i, j] = a[0] >= a[1] && a[0] >= a[2] ? [1, 2] : a[1] >= a[2] ? [2, 0] : [0, 1];
    for (const h of halves) {
      const p = mesh.position(mesh.hVert[h] as number);
      mesh.setCorner('uv0', h, [p[i] as number, p[j] as number]);
    }
  }
}

/**
 * Mean curvature per FXEM vertex (1 / m, convex positive): the mean over its edges of
 * the normal curvature 2 n . (p - q) / |p - q|^2 with area-weighted vertex normals.
 */
function vertexCurvature(mesh: EditMesh): Float64Array {
  const normals: Tuple3[] = Array.from({ length: mesh.vertexHighWater }, () => [0, 0, 0]);
  for (const f of mesh.faces()) {
    const vs = mesh.faceVertices(f);
    const n = newell(vs.map((v) => mesh.position(v)));
    for (const v of vs) {
      const m = normals[v] as Tuple3;
      normals[v] = [m[0] + n[0], m[1] + n[1], m[2] + n[2]];
    }
  }
  const sum = new Float64Array(mesh.vertexHighWater);
  const count = new Float64Array(mesh.vertexHighWater);
  for (const e of mesh.edges()) {
    const a = mesh.hVert[e * 2] as number;
    const b = mesh.hVert[e * 2 + 1] as number;
    const d = sub(mesh.position(a), mesh.position(b));
    const l2 = dot(d, d);
    if (!(l2 > 0)) continue;
    for (const [v, s] of [
      [a, 1],
      [b, -1],
    ] as const) {
      const n = normalize(normals[v] as Tuple3);
      sum[v] = (sum[v] as number) + (s * 2 * dot(n, d)) / l2;
      count[v] = (count[v] as number) + 1;
    }
  }
  return sum.map((s, v) => ((count[v] as number) > 0 ? s / (count[v] as number) : 0));
}

const fract = (x: number) => x - Math.floor(x);

/** Integer hash of a sample index to [0, 1). */
function hash(x: number, y: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function radicalInverse(i: number): number {
  let bits = i >>> 0;
  bits = ((bits << 16) | (bits >>> 16)) >>> 0;
  bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0;
  bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0;
  bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0;
  bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0;
  return bits / 4294967296;
}

/** `count` cosine-distributed directions around +z within the cone of cosine `cone` to the tangent plane. */
function coneRays(count: number, cone: number): Float64Array {
  const rays = new Float64Array(count * 3);
  for (let k = 0; k < count; k++) {
    const r = Math.sqrt(((k + 0.5) / count) * cone * cone);
    const phi = 2 * Math.PI * radicalInverse(k);
    rays.set([r * cos(phi), r * sin(phi), Math.sqrt(1 - r * r)], k * 3);
  }
  return rays;
}

/** Integer hash of a lattice point and seed to [0, 1). */
function hash3(x: number, y: number, z: number, seed: number): number {
  let h =
    Math.imul(x | 0, 0x27d4eb2d) ^
    Math.imul(y | 0, 0x165667b1) ^
    Math.imul(z | 0, 0x9e3779b1) ^
    Math.imul(seed | 0, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Trilinear value noise of a world point with lattice spacing `scale` meters, in [0, 1). */
function valueNoise3(p: Tuple3, scale: number, seed: number): number {
  const x = p[0] / scale;
  const y = p[1] / scale;
  const z = p[2] / scale;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const fz = smooth(z - iz);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const plane = (k: number) =>
    lerp(
      lerp(hash3(ix, iy, k, seed), hash3(ix + 1, iy, k, seed), fx),
      lerp(hash3(ix, iy + 1, k, seed), hash3(ix + 1, iy + 1, k, seed), fx),
      fy,
    );
  return lerp(plane(iz), plane(iz + 1), fz);
}

/** Orthonormal tangent pair of a unit normal (helper axis = smallest component). */
function basis(n: Tuple3): [Tuple3, Tuple3] {
  const a = n.map(Math.abs) as Tuple3;
  const helper: Tuple3 =
    a[0] <= a[1] && a[0] <= a[2] ? [1, 0, 0] : a[1] <= a[2] ? [0, 1, 0] : [0, 0, 1];
  const e1 = normalize(cross(helper, n));
  return [e1, cross(n, e1)];
}

/** One bake group's detail BVHs, resolved cage, direction and statistics. */
export interface GroupBake {
  readonly id: string;
  readonly offset: number;
  readonly maxRay: number;
  readonly direction: BakeDirection;
  /** Every detail triangle of the group (correspondence); `map` turns local into detail triangles. */
  readonly bvh: TriangleBvh;
  readonly map: Int32Array;
  /** Non-floater triangles (height under floaters, occluders). */
  readonly solid: TriangleBvh;
  readonly solidMap: Int32Array;
  readonly triangles: number;
  /** Occlusion and thickness reach in meters. */
  readonly aoDistance: number;
  readonly thicknessDistance: number;
  /** Detail area fraction the rays cannot see (V3). */
  readonly steep: number;
  /**
   * Detail triangles of connected parts hovering off the base farther than the parts that
   * touch it rise (audit A3, floaters excluded): 1 per such triangle, empty when there are none.
   */
  readonly stray: Uint8Array;
  /** Hovering parts and the smallest gap (meters) between one of them and the base. */
  readonly strayParts: number;
  readonly strayGap: number;
  /** Per hovering part, in part order, and per detail triangle its part (-1: none). */
  readonly strayInfo: readonly StrayPart[];
  readonly strayIndex: Int32Array;
  samples: number;
  rayHits: number;
  nearest: number;
  /** Samples with facing detail outside the cage span along their ray (audit A1). */
  clipped: number;
  /** Samples whose correspondence landed on a hovering part (audit A3). */
  strayHits: number;
}

/** Per-group counters in sampling order (BakeRows.counts holds GROUP_COUNTERS per group). */
const GROUP_COUNTERS = 5;

function counters(g: GroupBake): number[] {
  return [g.samples, g.rayHits, g.nearest, g.clipped, g.strayHits];
}

function subsetBvh(
  surface: { readonly position: ArrayLike<number>; readonly indices: ArrayLike<number> },
  triangles: readonly number[],
): { bvh: TriangleBvh; map: Int32Array } {
  const local = new Uint32Array(triangles.length * 3);
  for (const [i, t] of triangles.entries()) {
    for (let k = 0; k < 3; k++) local[i * 3 + k] = surface.indices[t * 3 + k] as number;
  }
  return { bvh: new TriangleBvh(surface.position, local), map: Int32Array.from(triangles) };
}

/** The correspondence and evaluators shared by the texture and vertex targets. */
/** Fraction of the encoded height range above which two stacked samples' heights conflict (V5). */
const STACK_HEIGHT = 0.02;
/** Angle (degrees) above which two stacked samples' tangent-space normals conflict (V5). */
const STACK_ANGLE = 5;

/** Inverse of the shaders' applyTBN: n0 = N, t0 = T orthogonalized, b0 = cross(n0, t0) * w. */
function tangentNormal(nd: Tuple3, n: Tuple3, frame: readonly [Tuple3, number]): Tuple3 {
  const [t, w] = frame;
  let t0 = sub(t, [n[0] * dot(t, n), n[1] * dot(t, n), n[2] * dot(t, n)]);
  if (!(length(t0) > 0)) t0 = basis(n)[0];
  t0 = normalize(t0);
  const b = cross(n, t0);
  const handed = w === 0 ? 1 : w;
  return normalize([dot(nd, t0), dot(nd, b) / handed, dot(nd, n)]);
}

export class Baker {
  readonly curvature: Float64Array;
  readonly maps: readonly BakeMapKind[];
  /** Occluders of every non-excluded group (ao.scope 'all'). */
  private readonly shared: TriangleBvh | undefined;
  private readonly bvhs: TriangleBvh[];
  /** Cosine-distributed directions in the cone 90 - bias around +z. */
  private readonly rays: Float64Array;
  /** Cosine-distributed directions over the whole hemisphere around +z (thickness). */
  private readonly inward: Float64Array;
  /** Resolved `BakeSlot` per detail material slot, colors linear, emission over `emissiveScale`. */
  private readonly slotSurface: readonly ResolvedSlot[];
  /** Detail point and unit shading normal of the last evaluated sample. */
  lastPoint: Tuple3 = [0, 0, 0];
  lastNormal: Tuple3 = [0, 0, 1];
  /** Whether the last sample's ray found the detail (no nearest-point fallback). */
  lastHit = false;
  /** Base face of the sample about to be evaluated, for the located findings. */
  face = -1;
  /** Located cage clips and samples on hovering parts since the last drain. */
  readonly findings: FindingLog;
  /** Unit geometric normal per detail triangle. */
  private readonly faceNormal: Float64Array;
  private readonly eps: number;
  private reported = 0;

  readonly detail: BakeSurface;
  readonly params: BakeJobParams;
  readonly texture:
    | { readonly width: number; readonly height: number; readonly data: Uint8Array }
    | undefined;
  readonly groups: readonly GroupBake[];
  readonly floater: Uint8Array;

  constructor(
    detail: BakeSurface,
    detailMesh: EditMesh,
    params: BakeJobParams,
    texture:
      | { readonly width: number; readonly height: number; readonly data: Uint8Array }
      | undefined,
    diagonal: number,
    groups: readonly GroupBake[],
    floater: Uint8Array,
    sharedTriangles: readonly number[] | undefined,
  ) {
    this.detail = detail;
    this.params = params;
    this.texture = texture;
    this.groups = groups;
    this.floater = floater;
    this.findings = new FindingLog(diagonal);
    this.shared =
      sharedTriangles === undefined ? undefined : subsetBvh(detail, sharedTriangles).bvh;
    this.bvhs = [
      ...groups.flatMap((g) => (g.solid === g.bvh ? [g.bvh] : [g.bvh, g.solid])),
      ...(this.shared === undefined ? [] : [this.shared]),
    ];
    const triangles = detail.indices.length / 3;
    this.faceNormal = new Float64Array(triangles * 3);
    for (let t = 0; t < triangles; t++) {
      const [a, b, c] = [0, 1, 2].map((k) => {
        const i = detail.indices[t * 3 + k] as number;
        return [0, 1, 2].map((j) => detail.position[i * 3 + j] as number) as Tuple3;
      }) as [Tuple3, Tuple3, Tuple3];
      this.faceNormal.set(normalize(cross(sub(b, a), sub(c, a))), t * 3);
    }
    const perVertex = vertexCurvature(detailMesh);
    this.curvature = Float64Array.from(
      { length: detail.position.length / 3 },
      (_, r) => perVertex[detailMesh.hVert[detail.vertexCorner[r] as number] as number] as number,
    );
    this.maps = params.maps;
    this.rays = coneRays(params.ao.rays, cos((params.ao.bias / 180) * Math.PI));
    this.inward = coneRays(params.thickness.rays, 1);
    const scale = emissiveScale(params.slots);
    this.slotSurface = detail.slots.map((slot) => resolveSlot(params.slots, slot, scale));
    this.eps = diagonal * 1e-5;
  }

  get nodes(): number {
    return this.bvhs.reduce((n, b) => n + b.nodes, 0);
  }

  get rayHits(): number {
    return this.groups.reduce((n, g) => n + g.rayHits, 0);
  }

  get nearest(): number {
    return this.groups.reduce((n, g) => n + g.nearest, 0);
  }

  /**
   * Work since the last call, in units. The remainder is dropped, so each call (one per
   * tile or vertex) counts only its own visits and any split of the rows across Workers
   * sums to the serial count.
   */
  work(): number {
    const visits = this.bvhs.reduce((n, b) => n + b.visits, 0);
    const units = Math.floor((visits - this.reported) / VISITS_PER_UNIT);
    this.reported = visits;
    return units;
  }

  private interpolate(
    attribute: ArrayLike<number>,
    width: number,
    t: number,
    u: number,
    v: number,
  ) {
    const out = new Array<number>(width).fill(0);
    const w = [1 - u - v, u, v];
    for (let k = 0; k < 3; k++) {
      const i = this.detail.indices[t * 3 + k] as number;
      for (let c = 0; c < width; c++)
        out[c] = (out[c] as number) + (w[k] as number) * (attribute[i * width + c] as number);
    }
    return out;
  }

  /**
   * The detail point a ray from the cage finds: along -c from `offset` outside p within
   * `maxRay`, only detail triangles facing c (within 84 degrees, so a ray beside a thin
   * rim or along a notch does not pick up a far side or a grazing wall); on a miss the
   * nearest facing point of the group. Returns the detail triangle and barycentrics.
   */
  private correspond(
    p: Tuple3,
    c: Tuple3,
    group: GroupBake,
    solid: boolean,
  ): { tri: number; u: number; v: number; q: Tuple3; hit: boolean } | undefined {
    const bvh = solid ? group.solid : group.bvh;
    const map = solid ? group.solidMap : group.map;
    if (map.length === 0) return undefined;
    const origin: Tuple3 = [
      p[0] + c[0] * group.offset,
      p[1] + c[1] * group.offset,
      p[2] + c[2] * group.offset,
    ];
    const facing = (local: number) => {
      const t = map[local] as number;
      return (
        (this.faceNormal[t * 3] as number) * c[0] +
          (this.faceNormal[t * 3 + 1] as number) * c[1] +
          (this.faceNormal[t * 3 + 2] as number) * c[2] >
        FACING_MIN
      );
    };
    const hit = bvh.raycast(origin, [-c[0], -c[1], -c[2]], group.maxRay, false, facing);
    if (hit !== undefined) {
      return {
        tri: map[hit.triangle] as number,
        u: hit.u,
        v: hit.v,
        q: [origin[0] - c[0] * hit.t, origin[1] - c[1] * hit.t, origin[2] - c[2] * hit.t],
        hit: true,
      };
    }
    const near = (bvh.nearest(p, facing) ?? bvh.nearest(p)) as NonNullable<
      ReturnType<TriangleBvh['nearest']>
    >;
    const tri = map[near.triangle] as number;
    return {
      tri,
      u: near.u,
      v: near.v,
      q: this.interpolate(this.detail.position, 3, tri, near.u, near.v) as Tuple3,
      hit: false,
    };
  }

  /**
   * Audit A1: whether facing detail lies outside the cage span along the cage ray at P: within
   * `maxRay` beyond the ray's start (the start sits inside a feature, so the ray found a
   * surface under it or nothing), or, when the ray found nothing, within `maxRay` past its
   * end (a hole deeper than the cage). Either way the bake silently lost that detail.
   * V2 = share of misses; cage-clip = detail outside the cage span (not duplicates).
   * A clip also measures how far the detail reaches beyond the span (`excess`) and its
   * outermost detail triangle, with extra rays that the work meter does not count.
   */
  private clippedAt(
    p: Tuple3,
    c: Tuple3,
    group: GroupBake,
    hit: boolean,
  ):
    | { kind: typeof FINDING_KIND.above | typeof FINDING_KIND.below; excess: number; tri: number }
    | undefined {
    const map = group.map;
    if (map.length === 0) return undefined;
    const facing = (local: number) => {
      const t = map[local] as number;
      return (
        (this.faceNormal[t * 3] as number) * c[0] +
          (this.faceNormal[t * 3 + 1] as number) * c[1] +
          (this.faceNormal[t * 3 + 2] as number) * c[2] >
        FACING_MIN
      );
    };
    const origin: Tuple3 = [
      p[0] + c[0] * group.offset,
      p[1] + c[1] * group.offset,
      p[2] + c[2] * group.offset,
    ];
    const outward: Tuple3 = [-c[0], -c[1], -c[2]];
    // The any-hit ray decides; the outermost triangle is the first hit of the reverse ray.
    const clip = (
      from: Tuple3,
      direction: Tuple3,
      kind: typeof FINDING_KIND.above | typeof FINDING_KIND.below,
    ) => {
      const first = group.bvh.raycast(from, direction, group.maxRay, true, facing);
      if (first === undefined) return undefined;
      const visits = group.bvh.visits;
      const far: Tuple3 = [
        from[0] + direction[0] * group.maxRay,
        from[1] + direction[1] * group.maxRay,
        from[2] + direction[2] * group.maxRay,
      ];
      const back = group.bvh.raycast(
        far,
        [-direction[0], -direction[1], -direction[2]],
        group.maxRay,
        false,
        facing,
      );
      group.bvh.visits = visits;
      const outer = back ?? { ...first, t: group.maxRay - first.t };
      return { kind, excess: group.maxRay - outer.t, tri: map[outer.triangle] as number };
    };
    const above = clip(origin, c, FINDING_KIND.above);
    if (above !== undefined || hit) return above;
    const end: Tuple3 = [
      origin[0] - c[0] * group.maxRay,
      origin[1] - c[1] * group.maxRay,
      origin[2] - c[2] * group.maxRay,
    ];
    return clip(end, outward, FINDING_KIND.below);
  }

  private normalAt(found: { tri: number; u: number; v: number }): Tuple3 {
    return normalize(
      this.interpolate(this.detail.normal, 3, found.tri, found.u, found.v) as Tuple3,
    );
  }

  /**
   * The detail point for base point P (normal N) along the ray C: the cage ray, or under an
   * averaged direction the base-normal ray when the cage ray reaches a neighbouring face.
   */
  private find(
    p: Tuple3,
    n: Tuple3,
    cage: Tuple3,
    group: GroupBake,
    averaged: boolean,
  ): { found: NonNullable<ReturnType<Baker['correspond']>>; c: Tuple3 } {
    let c = cage;
    let found = this.correspond(p, c, group, false) as NonNullable<ReturnType<Baker['correspond']>>;
    // An averaged cage ray at a hard rim can reach a neighbouring face of the detail first;
    // past OWN_SIDE_COS the base-normal ray decides if it finds a surface closer to it.
    if (averaged && found.hit && this.params.rawCage !== true) {
      const turned = dot(this.normalAt(found), n);
      if (turned < OWN_SIDE_COS) {
        const own = this.correspond(p, n, group, false);
        if (own?.hit === true && dot(this.normalAt(own), n) > turned) {
          found = own;
          c = n;
        }
      }
    }
    return { found, c };
  }

  /**
   * The tangent-space normal and the height (along the ray) `evaluate` bakes at P, without
   * AO, other maps or group counters: the V5 check re-derives both for every triangle
   * stacked on a sample.
   */
  stackSample(
    p: Tuple3,
    n: Tuple3,
    cage: Tuple3,
    frame: readonly [Tuple3, number],
    g: number,
    averaged: boolean,
  ): { readonly normal: Tuple3; readonly height: number } {
    const { found, c } = this.find(p, n, cage, this.groups[g] as GroupBake, averaged);
    const nd = normalize(
      this.interpolate(this.detail.normal, 3, found.tri, found.u, found.v) as Tuple3,
    );
    return { normal: tangentNormal(nd, n, frame), height: dot(sub(found.q, p), c) };
  }

  /**
   * Evaluate every map at a base point P with unit shading normal N and unit ray
   * direction C in group `g`; `frame` is the base tangent (xyz) and handedness for the
   * tangent-space normal, absent for object space. Writes four channels per map into
   * `out` (normal: unit vector; height and curvature: raw values in channel 0).
   */
  evaluate(
    p: Tuple3,
    n: Tuple3,
    cage: Tuple3,
    frame: readonly [Tuple3, number] | undefined,
    g: number,
    sampleIndex: number,
    out: Float64Array,
    averaged: boolean,
  ): void {
    const group = this.groups[g] as GroupBake;
    group.samples++;
    const { found, c } = this.find(p, n, cage, group, averaged);
    if (found.hit) group.rayHits++;
    else group.nearest++;
    const clip = this.clippedAt(p, cage, group, found.hit);
    if (clip !== undefined) {
      group.clipped++;
      this.findings.clip(
        g,
        clip.kind,
        p,
        this.face,
        this.detail.triangleFace[clip.tri] as number,
        clip.excess,
      );
    }
    if (group.stray[found.tri] === 1) {
      group.strayHits++;
      this.findings.stray(g, group.strayIndex[found.tri] as number, this.face);
    }
    const { tri, u, v, q } = found;
    const nd = normalize(this.interpolate(this.detail.normal, 3, tri, u, v) as Tuple3);
    this.lastPoint = q;
    this.lastNormal = nd;
    this.lastHit = found.hit;
    let ao: number | undefined;
    let height: number | undefined;
    const occlusion = () => {
      ao ??= this.occlusion(q, nd, sampleIndex, group);
      return ao;
    };
    const heightOf = () => {
      if (height === undefined) {
        // Floaters stand off the surface: the height is the solid detail under them.
        const solid = this.floater[tri] === 1 ? this.correspond(p, c, group, true) : found;
        height = solid === undefined ? 0 : dot(sub(solid.q, p), c);
      }
      return height;
    };
    for (const [m, kind] of this.maps.entries()) {
      const o = m * 4;
      switch (kind) {
        case 'normal': {
          const tn = frame === undefined ? nd : tangentNormal(nd, n, frame);
          out.set([tn[0], tn[1], tn[2], 1], o);
          break;
        }
        case 'normalObject':
          out.set([nd[0], nd[1], nd[2], 1], o);
          break;
        case 'height':
          out.set([heightOf(), 0, 0, 1], o);
          break;
        case 'position':
          out.set([q[0], q[1], q[2], 1], o);
          break;
        case 'curvature':
        case 'cavity':
        case 'edgeWear': {
          const noise = this.params.edgeWear.noise;
          out.set(
            [
              this.interpolate(this.curvature, 1, tri, u, v)[0] as number,
              valueNoise3(q, noise.scale, noise.seed),
              0,
              1,
            ],
            o,
          );
          break;
        }
        case 'thickness':
          out.set([this.thickness(q, nd, sampleIndex, group), 0, 0, 1], o);
          break;
        case 'opacity': {
          const alpha = this.slotOf(tri).baseColor[3] as number;
          out.set([found.hit ? alpha : 0, 0, 0, 1], o);
          break;
        }
        case 'ormh': {
          const surface = this.slotOf(tri);
          out.set([occlusion(), surface.roughness, surface.metallic, heightOf()], o);
          break;
        }
        case 'baseColor':
          out.set(this.slotOf(tri).baseColor, o);
          break;
        case 'emissive': {
          const e = this.slotOf(tri).emissive;
          out.set([e[0] as number, e[1] as number, e[2] as number, 1], o);
          break;
        }
        case 'materialId': {
          const color = MATERIAL_ID_PALETTE[
            (this.detail.triangleSlot[tri] as number) % MATERIAL_ID_PALETTE.length
          ] as readonly number[];
          out.set([color[0] as number, color[1] as number, color[2] as number, 1], o);
          break;
        }
        case 'ao':
          out.set([occlusion(), 0, 0, 1], o);
          break;
        case 'resample': {
          const [s, r] = this.interpolate(this.detail.uv, 2, tri, u, v) as [number, number];
          out.set(this.sampleTexture(s, r), o);
          break;
        }
      }
    }
  }

  private slotOf(tri: number): ResolvedSlot {
    return this.slotSurface[this.detail.triangleSlot[tri] as number] as ResolvedSlot;
  }

  /** A ray set turned about the normal per sample, in the frame of n. */
  private turned(rays: Float64Array, k: number, n: Tuple3, sampleIndex: number): Tuple3 {
    const [e1, e2] = basis(n);
    const turn = 2 * Math.PI * hash(sampleIndex, 7);
    const c = cos(turn);
    const s = sin(turn);
    const x0 = rays[k * 3] as number;
    const y0 = rays[k * 3 + 1] as number;
    const z = rays[k * 3 + 2] as number;
    const x = x0 * c - y0 * s;
    const y = x0 * s + y0 * c;
    return [
      e1[0] * x + e2[0] * y + n[0] * z,
      e1[1] * x + e2[1] * y + n[1] * z,
      e1[2] * x + e2[2] * y + n[2] * z,
    ];
  }

  /**
   * Unoccluded fraction of cosine-distributed rays within the bias cone (1 = open). With
   * linear attenuation an occluder at distance t weighs 1 - t / reach, so far occluders
   * fade out; the floor plane occludes like geometry.
   */
  private occlusion(q: Tuple3, n: Tuple3, sampleIndex: number, group: GroupBake): number {
    const start: Tuple3 = [q[0] + n[0] * this.eps, q[1] + n[1] * this.eps, q[2] + n[2] * this.eps];
    const count = this.params.ao.rays;
    const reach = group.aoDistance;
    const linear = this.params.ao.attenuation === 'linear';
    const floor = this.params.ao.floor;
    let occluded = 0;
    for (let k = 0; k < count; k++) {
      const dir = this.turned(this.rays, k, n, sampleIndex);
      let t = Infinity;
      if (floor !== undefined && dir[1] < 0) {
        const f = (floor - start[1]) / dir[1];
        if (f > 0 && f <= reach) t = f;
      }
      if (!linear && t < Infinity) {
        occluded++;
        continue;
      }
      for (const bvh of [group.solid, this.shared]) {
        if (bvh === undefined) continue;
        const hit = bvh.raycast(start, dir, Math.min(reach, t), !linear);
        if (hit !== undefined) t = Math.min(t, hit.t);
        if (!linear && t < Infinity) break;
      }
      if (t < Infinity) occluded += linear ? 1 - t / reach : 1;
    }
    return 1 - occluded / count;
  }

  /**
   * Mean of min(t, reach) / reach over cosine-distributed rays into the detail from q
   * (0 = paper thin, 1 = at least `reach` thick).
   */
  private thickness(q: Tuple3, n: Tuple3, sampleIndex: number, group: GroupBake): number {
    const back: Tuple3 = [-n[0], -n[1], -n[2]];
    const start: Tuple3 = [
      q[0] + back[0] * this.eps,
      q[1] + back[1] * this.eps,
      q[2] + back[2] * this.eps,
    ];
    const count = this.params.thickness.rays;
    const reach = group.thicknessDistance;
    let sum = 0;
    for (let k = 0; k < count; k++) {
      const hit = group.bvh.raycast(start, this.turned(this.inward, k, back, sampleIndex), reach);
      sum += hit === undefined ? 1 : hit.t / reach;
    }
    return sum / count;
  }

  private sampleTexture(s: number, t: number): number[] {
    const tex = this.texture as NonNullable<Baker['texture']>;
    const x = fract(s) * tex.width - 0.5;
    const y = fract(t) * tex.height - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const at = (i: number, j: number, c: number) => {
      const xi = ((i % tex.width) + tex.width) % tex.width;
      const yj = ((j % tex.height) + tex.height) % tex.height;
      return (tex.data[(yj * tex.width + xi) * 4 + c] as number) / 255;
    };
    return [0, 1, 2, 3].map((c) => {
      const a = at(x0, y0, c) * (1 - fx) + at(x0 + 1, y0, c) * fx;
      const b = at(x0, y0 + 1, c) * (1 - fx) + at(x0 + 1, y0 + 1, c) * fx;
      return a * (1 - fy) + b * fy;
    });
  }
}

/** A `BakeSlot` with every field filled in: base color linear, emission over the map's scale. */
interface ResolvedSlot {
  readonly baseColor: readonly number[];
  readonly roughness: number;
  readonly metallic: number;
  readonly emissive: readonly number[];
}

const slotEntry = (slots: Readonly<Record<string, BakeSlot>>, name: string) =>
  Object.hasOwn(slots, name) ? slots[name] : undefined;

/**
 * The surface of material slot `name`: its entry, then `'*'`, then the defaults (white
 * opaque, roughness 0.5, metallic 0, no emission, intensity 1), emission divided by `scale`.
 * @internal
 */
export function resolveSlot(
  slots: Readonly<Record<string, BakeSlot>>,
  name: string,
  scale: number,
): ResolvedSlot {
  const a = slotEntry(slots, name);
  const b = slotEntry(slots, '*');
  const color = a?.baseColor ?? b?.baseColor ?? [1, 1, 1, 1];
  const emissive = a?.emissive ?? b?.emissive ?? [0, 0, 0];
  const intensity = a?.emissiveIntensity ?? b?.emissiveIntensity ?? 1;
  return {
    baseColor: [decodeSrgb(color[0]), decodeSrgb(color[1]), decodeSrgb(color[2]), color[3]],
    roughness: a?.roughness ?? b?.roughness ?? 0.5,
    metallic: a?.metallic ?? b?.metallic ?? 0,
    emissive: emissive.map((e) => Math.min(1, (e * intensity) / scale)),
  };
}

/**
 * The emissive map's scale: the largest emission (max channel x intensity) of any slot
 * entry, at least 1, so the brightest slot stores 1.
 * @internal
 */
export function emissiveScale(slots: Readonly<Record<string, BakeSlot>>): number {
  let peak = 1;
  for (const name of Object.keys(slots)) {
    const a = slotEntry(slots, name);
    const b = slotEntry(slots, '*');
    const emissive = a?.emissive ?? b?.emissive ?? [0, 0, 0];
    const intensity = a?.emissiveIntensity ?? b?.emissiveIntensity ?? 1;
    peak = Math.max(peak, ...emissive.map((e) => e * intensity));
  }
  return peak;
}

/** What raw values map to [0, 1] by: height range, position bounds and mask thresholds. */
export interface Encoding {
  readonly heightRange: readonly [number, number];
  readonly positionBounds: { readonly min: Tuple3; readonly max: Tuple3 };
  readonly params: BakeJobParams;
}

const smoothstep = (lo: number, hi: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

/** Stored value of a texel no sample reached, per map. */
function background(kind: BakeMapKind, params: BakeJobParams): readonly number[] {
  switch (kind) {
    case 'normal':
    case 'normalObject':
      return [0.5, 0.5, 1, 1];
    case 'ao':
    case 'thickness':
      return [1, 1, 1, 1];
    case 'opacity':
      return [0, 0, 0, 0];
    case 'ormh': {
      const fallback = resolveSlot(params.slots, '*', 1);
      return [1, fallback.roughness, fallback.metallic, 0.5];
    }
    case 'baseColor':
      return [...resolveSlot(params.slots, '*', 1).baseColor];
    case 'emissive':
      return [0, 0, 0, 1];
    case 'cavity':
    case 'edgeWear':
    case 'materialId':
    case 'resample':
      return [0, 0, 0, 1];
    case 'height':
    case 'curvature':
    case 'position':
      return [0.5, 0.5, 0.5, 1];
  }
}

/**
 * Raw values -> stored [0, 1] channels: curvature (and its masks) by its 95th
 * percentile, height by the height range, positions by their bounds. Returns the
 * curvature range.
 */
function encodeMaps(
  maps: readonly BakeMapKind[],
  values: readonly Float64Array[],
  weight: Float64Array,
  encoding: Encoding,
): number {
  let range = 0;
  const m = maps.findIndex((kind) => CURVATURE_MAPS.includes(kind));
  if (m >= 0) {
    const mags: number[] = [];
    for (let i = 0; i < weight.length; i++) {
      if ((weight[i] as number) > 0)
        mags.push(Math.abs((values[m] as Float64Array)[i * 4] as number));
    }
    mags.sort((a, b) => a - b);
    range = mags.length > 0 ? (mags[Math.floor((mags.length - 1) * 0.95)] as number) : 0;
    if (!(range > 0)) range = 1;
  }
  const [inner, outer] = encoding.heightRange;
  const toHeight = (h: number) => Math.max(0, Math.min(1, (h - inner) / (outer - inner)));
  const { min, max } = encoding.positionBounds;
  const { edgeWear, cavity } = encoding.params;
  for (const [k, kind] of maps.entries()) {
    const v = values[k] as Float64Array;
    for (let i = 0; i < weight.length; i++) {
      const o = i * 4;
      if (!((weight[i] as number) > 0)) {
        v.set(background(kind, encoding.params), o);
        continue;
      }
      switch (kind) {
        case 'normal':
        case 'normalObject': {
          const n = normalize([v[o] as number, v[o + 1] as number, v[o + 2] as number]);
          v.set([n[0] * 0.5 + 0.5, n[1] * 0.5 + 0.5, n[2] * 0.5 + 0.5, 1], o);
          break;
        }
        case 'height': {
          const h = toHeight(v[o] as number);
          v.set([h, h, h, 1], o);
          break;
        }
        case 'position': {
          for (let c = 0; c < 3; c++) {
            const extent = (max[c] as number) - (min[c] as number);
            v[o + c] = extent > 0 ? ((v[o + c] as number) - (min[c] as number)) / extent : 0.5;
          }
          v[o + 3] = 1;
          break;
        }
        case 'curvature': {
          const c = Math.max(0, Math.min(1, 0.5 + (0.5 * (v[o] as number)) / range));
          v.set([c, c, c, 1], o);
          break;
        }
        case 'edgeWear': {
          const wear =
            smoothstep(edgeWear.range[0], edgeWear.range[1], (v[o] as number) / range) *
            (1 - edgeWear.noise.amount * (v[o + 1] as number));
          v.set([wear, wear, wear, 1], o);
          break;
        }
        case 'cavity': {
          const c = smoothstep(cavity.range[0], cavity.range[1], -(v[o] as number) / range);
          v.set([c, c, c, 1], o);
          break;
        }
        case 'ao':
        case 'thickness':
        case 'opacity': {
          const a = v[o] as number;
          v.set([a, a, a, kind === 'opacity' ? a : 1], o);
          break;
        }
        case 'ormh':
          v[o + 3] = toHeight(v[o + 3] as number);
          break;
        case 'materialId':
        case 'baseColor':
        case 'emissive':
        case 'resample':
          break;
      }
    }
  }
  return range;
}

/**
 * Texture-space mean curvature (1 / m, convex positive) of the detail seen through each
 * texel: the mean over its 4-neighbors of the same chart of (n_j - n_i) . (q_j - q_i) /
 * |q_j - q_i|^2, from the corresponding detail points q and shading normals n. Creases
 * with split normals and fillets alike; flat regions are exactly 0. Across joined
 * borders the neighbors continue, shifted by the period where one is given.
 */
function textureCurvature(
  point: Float64Array,
  normal: Float64Array,
  weight: Float64Array,
  island: Int32Array,
  grid: Grid,
  wrap: BakeJobParams['wrap'],
): Float64Array {
  const { w, h } = grid;
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!((weight[i] as number) > 0)) continue;
      let sum = 0;
      let count = 0;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const xx = x + dx;
        const yy = y + dy;
        const j = neighbor(xx, yy, grid);
        if (j < 0 || !((weight[j] as number) > 0) || island[j] !== island[i]) continue;
        // A neighbour across a periodic border is the next period's copy.
        const shift: Tuple3 = [0, 0, 0];
        for (const [axis, value, n] of [
          [wrap?.u, xx, w],
          [wrap?.v, yy, h],
        ] as const) {
          if (typeof axis !== 'object') continue;
          const turns = value < 0 ? -1 : value >= n ? 1 : 0;
          for (let c = 0; c < 3; c++) shift[c] = (shift[c] as number) + turns * (axis[c] as number);
        }
        const dq: Tuple3 = [0, 1, 2].map(
          (c) => (point[j * 3 + c] as number) + (shift[c] as number) - (point[i * 3 + c] as number),
        ) as Tuple3;
        const l2 = dot(dq, dq);
        if (!(l2 > 0)) continue;
        const dn: Tuple3 = [0, 1, 2].map(
          (c) => (normal[j * 3 + c] as number) - (normal[i * 3 + c] as number),
        ) as Tuple3;
        sum += dot(dn, dq) / l2;
        count++;
      }
      out[i] = count > 0 ? sum / count : 0;
    }
  }
  return out;
}

/** Atlas texels: `w` x `h`, rows follow v; `u` / `v` join opposite borders (wrap). */
export interface Grid {
  readonly w: number;
  readonly h: number;
  readonly u: boolean;
  readonly v: boolean;
}

/** The atlas grid of a texture bake: `resolution` (square or [width, height]) and its wrap. */
export function gridOf(params: BakeJobParams): Grid {
  const r = params.resolution;
  const [w, h] = typeof r === 'number' ? [r, r] : r;
  return { w, h, u: params.wrap?.u !== undefined, v: params.wrap?.v !== undefined };
}

/** Texel index of (x, y), wrapped across joined borders, else -1 outside the atlas. */
function neighbor(x: number, y: number, grid: Grid): number {
  const { w, h } = grid;
  const xx = grid.u ? (x + w) % w : x;
  const yy = grid.v ? (y + h) % h : y;
  return xx < 0 || yy < 0 || xx >= w || yy >= h ? -1 : yy * w + xx;
}

/** Whether sampling sums detail points and normals: curvature maps, or AO denoise guidance. */
function guided(params: BakeJobParams): boolean {
  if (params.filter === 'bspline') return true;
  return params.maps.some(
    (kind) =>
      CURVATURE_MAPS.includes(kind) ||
      (params.ao.denoise > 0 && (kind === 'ao' || kind === 'ormh')),
  );
}

/**
 * Edge-aware AO denoise (channel 0): each texel averages its chart's texels within
 * `radius` with a (1 - d^2 / (radius + 1)^2)^2 kernel times max(0, n_i . n_j)^8 of their
 * detail normals, so
 * sampling noise smooths while creases (where normals turn) keep their occlusion step.
 */
function denoise(
  values: Float64Array,
  normal: Float64Array,
  weight: Float64Array,
  island: Int32Array,
  grid: Grid,
  radius: number,
): void {
  const source = Float64Array.from({ length: weight.length }, (_, i) => values[i * 4] as number);
  const reach2 = (radius + 1) * (radius + 1);
  for (let y = 0; y < grid.h; y++) {
    for (let x = 0; x < grid.w; x++) {
      const i = y * grid.w + x;
      if (!((weight[i] as number) > 0)) continue;
      let sum = 0;
      let total = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const j = neighbor(x + dx, y + dy, grid);
          if (j < 0 || !((weight[j] as number) > 0) || island[j] !== island[i]) continue;
          let agree = 0;
          for (let c = 0; c < 3; c++)
            agree += (normal[i * 3 + c] as number) * (normal[j * 3 + c] as number);
          if (!(agree > 0)) continue;
          const a2 = agree * agree;
          const a4 = a2 * a2;
          const fall = 1 - (dx * dx + dy * dy) / reach2;
          if (!(fall > 0)) continue;
          const w = fall * fall * a4 * a4;
          sum += w * (source[j] as number);
          total += w;
        }
      }
      if (total > 0) values[i * 4] = sum / total;
    }
  }
}

/** Cosine of the detail-normal turn (20 degrees) between texels that the B-spline does not blend (a crease). */
const CREASE_COS = 0.9396926207859084;

/**
 * Cubic B-spline (1, 4, 1) / 6 weights of a 3 x 3 neighborhood, renormalized within a
 * chart and among texels whose detail normals turn by less than 20 degrees (audit A13: a
 * blend across a chamfer crease bent it by 9.5 degrees).
 */
function filterBspline(
  maps: readonly BakeMapKind[],
  values: Float64Array[],
  weight: Float64Array,
  island: Int32Array,
  grid: Grid,
  normal: Float64Array,
): void {
  const w1 = [1, 4, 1];
  for (const [k, kind] of maps.entries()) {
    if (kind === 'materialId') continue;
    const src = values[k] as Float64Array;
    const dst = new Float64Array(src);
    for (let y = 0; y < grid.h; y++) {
      for (let x = 0; x < grid.w; x++) {
        const i = y * grid.w + x;
        if (!((weight[i] as number) > 0)) continue;
        const acc = [0, 0, 0, 0];
        let total = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const j = neighbor(x + dx, y + dy, grid);
            if (j < 0 || !((weight[j] as number) > 0) || island[j] !== island[i]) continue;
            // Texels without a ray hit (an opacity layer's misses) carry no normal and blend as before.
            let agree = 0;
            let ni = 0;
            let nj = 0;
            for (let c = 0; c < 3; c++) {
              const a = normal[i * 3 + c] as number;
              const b = normal[j * 3 + c] as number;
              agree += a * b;
              ni += a * a;
              nj += b * b;
            }
            if (j !== i && ni > 0.5 && nj > 0.5 && agree < CREASE_COS) continue;
            const w = (w1[dx + 1] as number) * (w1[dy + 1] as number);
            total += w;
            for (let c = 0; c < 4; c++)
              acc[c] = (acc[c] as number) + w * (src[j * 4 + c] as number);
          }
        }
        for (let c = 0; c < 4; c++) dst[i * 4 + c] = (acc[c] as number) / total;
      }
    }
    values[k] = dst;
  }
}

/** Owner of a texel no chart reaches (background). */
const UNOWNED = -1;
/** Owner of a gutter texel that averages two or more charts. */
const MIXED = -2;

/**
 * Grow every map `gutter` texels (or until the atlas is full) past its charts: each new
 * texel averages its covered 8-neighbors and inherits their chart in `owner` (MIXED when
 * they disagree). Each ring is found from the previous one, so a fill costs one visit
 * per texel.
 */
function dilate(
  values: Float64Array[],
  covered: Uint8Array,
  owner: Int32Array,
  grid: Grid,
  gutter: number,
): void {
  const texels = grid.w * grid.h;
  const seen = new Int32Array(texels).fill(-1);
  let frontier: number[] = [];
  for (let i = 0; i < texels; i++) if (covered[i] === 1) frontier.push(i);
  for (let pass = 0; pass < gutter && frontier.length > 0; pass++) {
    const fresh: number[] = [];
    for (const i of frontier) {
      const x = i % grid.w;
      const y = (i - x) / grid.w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const j = neighbor(x + dx, y + dy, grid);
          if (j < 0 || covered[j] === 1 || seen[j] === pass) continue;
          seen[j] = pass;
          fresh.push(j);
        }
      }
    }
    fresh.sort((a, b) => a - b);
    for (const i of fresh) {
      const x = i % grid.w;
      const y = (i - x) / grid.w;
      let chart = UNOWNED;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const j = neighbor(x + dx, y + dy, grid);
          if (j < 0 || covered[j] !== 1) continue;
          const o = owner[j] as number;
          chart = chart === UNOWNED ? o : chart === o ? chart : MIXED;
        }
      }
      owner[i] = chart;
    }
    for (const v of values) {
      for (const i of fresh) {
        const x = i % grid.w;
        const y = (i - x) / grid.w;
        const acc = [0, 0, 0, 0];
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const j = neighbor(x + dx, y + dy, grid);
            if (j < 0 || covered[j] !== 1) continue;
            n++;
            for (let c = 0; c < 4; c++) acc[c] = (acc[c] as number) + (v[j * 4 + c] as number);
          }
        }
        for (let c = 0; c < 4; c++) v[i * 4 + c] = (acc[c] as number) / n;
      }
    }
    for (const i of fresh) covered[i] = 1;
    frontier = fresh;
  }
}

/**
 * Mip bleed (V4): per level 1.., the 2^level blocks of the box mip chain that hold a
 * chart texel and also a texel of another chart, a mixed gutter texel or background.
 */
export function mipBleed(owner: Int32Array, chart: Uint8Array, grid: Grid): number[] {
  const out: number[] = [];
  let w = grid.w;
  let h = grid.h;
  let own = Int32Array.from(owner);
  let has = Uint8Array.from(chart);
  while (w > 1 || h > 1) {
    const lw = Math.max(1, w >> 1);
    const lh = Math.max(1, h >> 1);
    const next = new Int32Array(lw * lh);
    const nextHas = new Uint8Array(lw * lh);
    let bleeding = 0;
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) {
        let o: number | undefined;
        let any = 0;
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ] as const) {
          const sx = Math.min(w - 1, x * 2 + dx);
          const sy = Math.min(h - 1, y * 2 + dy);
          const value = own[sy * w + sx] as number;
          o = o === undefined || o === value ? value : MIXED;
          any |= has[sy * w + sx] as number;
        }
        const merged = (o as number) === UNOWNED && any === 1 ? MIXED : (o as number);
        next[y * lw + x] = merged;
        nextHas[y * lw + x] = any;
        if (any === 1 && merged < 0) bleeding++;
      }
    }
    out.push(bleeding);
    own = next;
    has = nextHas;
    w = lw;
    h = lh;
  }
  return out;
}

/** Charts of the base atlas: render triangles joined through shared render vertices. */
function triangleIslands(surface: BakeSurface): Int32Array {
  const vertices = surface.position.length / 3;
  const parent = Int32Array.from({ length: vertices }, (_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] as number;
    while (parent[i] !== r) {
      const next = parent[i] as number;
      parent[i] = r;
      i = next;
    }
    return r;
  };
  const triangles = surface.indices.length / 3;
  for (let t = 0; t < triangles; t++) {
    const a = find(surface.indices[t * 3] as number);
    for (let k = 1; k < 3; k++) {
      const b = find(surface.indices[t * 3 + k] as number);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  }
  return Int32Array.from({ length: triangles }, (_, t) => find(surface.indices[t * 3] as number));
}

function invalidDirection(direction: BakeDirection, target: string): string | undefined {
  if (direction === 'averaged' || direction === 'shading') return undefined;
  if (target === 'vertex') return "vertex bakes cast along 'averaged' or 'shading' normals";
  if (direction === 'face') return undefined;
  if (typeof direction !== 'object' || direction === null) {
    return "direction is 'averaged', 'shading', 'face', { face: tag } or { blend: meters }";
  }
  if ('face' in direction) {
    return typeof direction.face === 'string' && direction.face.length > 0
      ? undefined
      : 'direction.face is a tag name';
  }
  return direction.blend > 0 && Number.isFinite(direction.blend)
    ? undefined
    : 'direction.blend is a positive number of meters';
}

function invalidCage(cage: Partial<BakeCage>): string | undefined {
  const offset = cage.offset;
  if (offset !== undefined && offset !== 'auto' && !(offset >= 0 && Number.isFinite(offset))) {
    return "cage.offset is 'auto' or a non-negative number of meters";
  }
  const maxRay = cage.maxRay;
  if (maxRay !== undefined && maxRay !== 'auto' && !(maxRay > 0 && Number.isFinite(maxRay))) {
    return "cage.maxRay is 'auto' or a positive number of meters";
  }
  return undefined;
}

function invalidParams(params: BakeJobParams, inputs: number): ModelingError | undefined {
  const bad = (expected: string, detail: Record<string, unknown>) =>
    modelingError('model-invalid-argument', expected, detail);
  if (params.maps.length === 0 || params.maps.some((m) => !BAKE_MAP_KINDS.includes(m))) {
    return bad(`maps lists one or more of ${BAKE_MAP_KINDS.join(', ')}`, { maps: params.maps });
  }
  if (new Set(params.maps).size !== params.maps.length) {
    return bad('maps has no duplicates', { maps: params.maps });
  }
  if (params.target !== 'texture' && params.target !== 'vertex') {
    return bad("target is 'texture' or 'vertex'", { target: params.target });
  }
  const side = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 4096;
  const resolution = params.resolution;
  const square = typeof resolution === 'number';
  if (
    params.target === 'texture' &&
    !(square
      ? side(resolution)
      : Array.isArray(resolution) && resolution.length === 2 && resolution.every(side))
  ) {
    return bad('resolution is an integer in [1, 4096] or [width, height] of such', {
      resolution,
    });
  }
  const cages: [string | undefined, Partial<BakeCage>][] = [[undefined, params.cage]];
  const directions: [string | undefined, BakeDirection][] = [[undefined, params.direction]];
  for (const name of ['groupPrefix', 'floater'] as const) {
    const tag = params.tags?.[name];
    if (tag !== undefined && !(typeof tag === 'string' && tag.length > 0)) {
      return bad(`tags.${name} is a non-empty tag`, { tags: params.tags });
    }
  }
  for (const [id, own] of Object.entries(params.groups ?? {})) {
    if (own.cage !== undefined) cages.push([id, own.cage]);
    if (own.direction !== undefined) directions.push([id, own.direction]);
  }
  for (const [group, cage] of cages) {
    const why = invalidCage(cage);
    if (why !== undefined) return bad(why, { group, cage });
  }
  for (const [group, direction] of directions) {
    const why = invalidDirection(direction, params.target);
    if (why !== undefined) return bad(why, { group, direction });
  }
  if (
    params.gutter !== 'fill' &&
    (!Number.isInteger(params.gutter) || params.gutter < 0 || params.gutter > 64)
  ) {
    return bad("gutter is 'fill' or an integer in [0, 64]", { gutter: params.gutter });
  }
  if (!Number.isInteger(params.protectMip) || params.protectMip < 0 || params.protectMip > 12) {
    return bad('protectMip is an integer in [0, 12]', { protectMip: params.protectMip });
  }
  if (![1, 4, 9, 16].includes(params.samples)) {
    return bad('samples is 1, 4, 9 or 16', { samples: params.samples });
  }
  if (params.filter !== 'bspline' && params.filter !== 'none') {
    return bad("filter is 'bspline' or 'none'", { filter: params.filter });
  }
  const ao = params.ao;
  if (!Number.isInteger(ao.rays) || ao.rays < 1 || ao.rays > 1024) {
    return bad('ao.rays is an integer in [1, 1024]', { rays: ao.rays });
  }
  if (!(ao.bias >= 0 && ao.bias < 90))
    return bad('ao.bias is in [0, 90) degrees', { bias: ao.bias });
  const meters = (v: unknown) => typeof v === 'number' && v > 0 && Number.isFinite(v);
  const unit = (v: unknown) => typeof v === 'number' && v >= 0 && v <= 1;
  if (ao.distance !== 'auto' && !meters(ao.distance)) {
    return bad("ao.distance is 'auto' or a positive number of meters", { distance: ao.distance });
  }
  if (ao.attenuation !== 'linear' && ao.attenuation !== 'none') {
    return bad("ao.attenuation is 'linear' or 'none'", { attenuation: ao.attenuation });
  }
  if (!(Number.isInteger(ao.denoise) && ao.denoise >= 0 && ao.denoise <= 8)) {
    return bad('ao.denoise is an integer texel radius in [0, 8]', { denoise: ao.denoise });
  }
  if (ao.floor !== undefined && !Number.isFinite(ao.floor)) {
    return bad('ao.floor is a finite height in meters', { floor: ao.floor });
  }
  const { height, thickness, slots, edgeWear, cavity, opacity, wrap } = params;
  if (height.bits !== 8 && height.bits !== 16) {
    return bad('height.bits is 8 or 16', { bits: height.bits });
  }
  if (
    height.range !== undefined &&
    !(
      Array.isArray(height.range) &&
      height.range.length === 2 &&
      height.range.every(Number.isFinite) &&
      (height.range[0] as number) < (height.range[1] as number)
    )
  ) {
    return bad('height.range is [inner, outer] meters with inner < outer', { range: height.range });
  }
  if (params.position.bounds !== 'box' && params.position.bounds !== 'sphere') {
    return bad("position.bounds is 'box' or 'sphere'", { bounds: params.position.bounds });
  }
  if (!Number.isInteger(thickness.rays) || thickness.rays < 1 || thickness.rays > 1024) {
    return bad('thickness.rays is an integer in [1, 1024]', { rays: thickness.rays });
  }
  if (thickness.distance !== 'auto' && !meters(thickness.distance)) {
    return bad("thickness.distance is 'auto' or a positive number of meters", {
      distance: thickness.distance,
    });
  }
  for (const [slot, surface] of Object.entries(slots)) {
    const color = (c: unknown, n: number, ok: (x: unknown) => boolean) =>
      c === undefined || (Array.isArray(c) && c.length === n && c.every(ok));
    if (
      surface === null ||
      typeof surface !== 'object' ||
      !(surface.roughness === undefined || unit(surface.roughness)) ||
      !(surface.metallic === undefined || unit(surface.metallic)) ||
      !color(surface.baseColor, 4, unit) ||
      !color(surface.emissive, 3, (x) => typeof x === 'number' && x >= 0 && Number.isFinite(x)) ||
      !(
        surface.emissiveIntensity === undefined ||
        (surface.emissiveIntensity >= 0 && Number.isFinite(surface.emissiveIntensity))
      )
    ) {
      return bad(
        'a slot has roughness and metallic in [0, 1], baseColor 4 channels in [0, 1], emissive 3 channels >= 0 and emissiveIntensity >= 0',
        { slot, surface },
      );
    }
  }
  for (const [name, pair] of [
    ['edgeWear.range', edgeWear.range],
    ['cavity.range', cavity.range],
  ] as const) {
    if (
      !(
        Array.isArray(pair) &&
        pair.length === 2 &&
        pair.every(Number.isFinite) &&
        pair[0] < pair[1]
      )
    ) {
      return bad(`${name} is [low, high] with low < high`, { [name]: pair });
    }
  }
  if (
    !meters(edgeWear.noise.scale) ||
    !unit(edgeWear.noise.amount) ||
    !Number.isInteger(edgeWear.noise.seed)
  ) {
    return bad('edgeWear.noise is { scale > 0 meters, amount in [0, 1], integer seed }', {
      noise: edgeWear.noise,
    });
  }
  if (!(opacity.cutoff > 0 && opacity.cutoff < 1)) {
    return bad('opacity.cutoff is in (0, 1)', { cutoff: opacity.cutoff });
  }
  for (const axis of ['u', 'v'] as const) {
    const value = wrap?.[axis];
    if (value === undefined || value === true) continue;
    const vector =
      Array.isArray(value) && value.length === 3 && value.every((c) => Number.isFinite(c));
    if (!vector || !(length(value) > 0)) {
      return bad(`wrap.${axis} is true or a non-zero world period vector`, { wrap });
    }
  }
  if (wrap !== undefined && params.target !== 'texture') {
    return bad('wrap applies to the texture target', { wrap });
  }
  if (ao.scope !== 'group' && ao.scope !== 'all') {
    return bad("ao.scope is 'group' or 'all'", { scope: ao.scope });
  }
  if (!Array.isArray(ao.exclude) || ao.exclude.some((id) => typeof id !== 'string')) {
    return bad('ao.exclude lists group ids', { exclude: ao.exclude });
  }
  const resample = params.maps.includes('resample');
  if (resample !== (inputs === 3)) {
    return bad('a resample bake takes the detail texture as a third input, other bakes two', {
      inputs,
      maps: params.maps,
    });
  }
  return undefined;
}

/** Bounding box diagonal of xyz position lists (the bake's distance scale). */
export function diagonalOf(...positions: ArrayLike<number>[]): number {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of positions) {
    for (let i = 0; i < p.length; i++) {
      const c = i % 3;
      lo[c] = Math.min(lo[c] as number, p[i] as number);
      hi[c] = Math.max(hi[c] as number, p[i] as number);
    }
  }
  let sum = 0;
  for (let c = 0; c < 3; c++) {
    const d = (hi[c] as number) - (lo[c] as number);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function encodeFloats(values: Float64Array): Uint8Array {
  return new Uint8Array(Float32Array.from(values).buffer);
}

/**
 * The detail repeated at -1, 0 and +1 periods along each axis with a period (up to nine
 * copies), so rays and occlusion near a tile border see the neighbouring tiles.
 */
function tiledSurface(
  surface: BakeSurface,
  u: Tuple3 | undefined,
  v: Tuple3 | undefined,
): BakeSurface {
  const vertices = surface.position.length / 3;
  const copies: [number, number][] = [];
  const span = (axis: Tuple3 | undefined) => (axis === undefined ? [0] : [-1, 0, 1]);
  for (const j of span(v)) for (const i of span(u)) copies.push([i, j]);
  const zero: Tuple3 = [0, 0, 0];
  const position = new Float32Array(vertices * 3 * copies.length);
  const indices = new Uint32Array(surface.indices.length * copies.length);
  for (const [k, [i, j]] of copies.entries()) {
    for (let r = 0; r < vertices; r++) {
      for (let c = 0; c < 3; c++) {
        position[(k * vertices + r) * 3 + c] =
          (surface.position[r * 3 + c] as number) +
          i * ((u ?? zero)[c] as number) +
          j * ((v ?? zero)[c] as number);
      }
    }
    for (let x = 0; x < surface.indices.length; x++)
      indices[k * surface.indices.length + x] = (surface.indices[x] as number) + k * vertices;
  }
  const repeat = <T extends Float32Array | Int32Array>(a: T, make: (n: number) => T): T => {
    const out = make(a.length * copies.length);
    for (let k = 0; k < copies.length; k++) out.set(a, k * a.length);
    return out;
  };
  return {
    position,
    normal: repeat(surface.normal, (n) => new Float32Array(n)),
    tangent: repeat(surface.tangent, (n) => new Float32Array(n)),
    uv: repeat(surface.uv, (n) => new Float32Array(n)),
    indices,
    vertexCorner: repeat(surface.vertexCorner, (n) => new Int32Array(n)),
    triangleSlot: repeat(surface.triangleSlot, (n) => new Int32Array(n)),
    triangleFace: repeat(surface.triangleFace, (n) => new Int32Array(n)),
    slots: surface.slots,
  };
}

/** Bounds the position map normalizes by: the box, or the cube around the bounding sphere. */
function positionBounds(
  positions: ArrayLike<number>,
  bounds: 'box' | 'sphere',
): { min: Tuple3; max: Tuple3 } {
  const min: Tuple3 = [Infinity, Infinity, Infinity];
  const max: Tuple3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    const c = i % 3;
    min[c] = Math.min(min[c] as number, positions[i] as number);
    max[c] = Math.max(max[c] as number, positions[i] as number);
  }
  if (bounds === 'box') return { min, max };
  const center: Tuple3 = [0, 1, 2].map(
    (c) => ((min[c] as number) + (max[c] as number)) / 2,
  ) as Tuple3;
  const radius = length(sub(max, min)) / 2;
  return {
    min: center.map((c) => c - radius) as Tuple3,
    max: center.map((c) => c + radius) as Tuple3,
  };
}

/** Area-weighted (Newell) vertex normals of a mesh, unwelded: the vertex target's shading normals. */
function vertexNormals(mesh: EditMesh): Tuple3[] {
  const normals: Tuple3[] = Array.from({ length: mesh.vertexHighWater }, () => [0, 0, 0]);
  for (const f of mesh.faces()) {
    const vs = mesh.faceVertices(f);
    const n = newell(vs.map((v) => mesh.position(v)));
    for (const v of vs) {
      const m = normals[v] as Tuple3;
      normals[v] = [m[0] + n[0], m[1] + n[1], m[2] + n[2]];
    }
  }
  return normals.map((n) => normalize(n));
}

/** Fan triangles of every base face, on FXEM vertices (the vertex target's cage estimate). */
function fanSource(mesh: EditMesh, normals: readonly Tuple3[]): CornerSource {
  const indices: number[] = [];
  const triangleFace: number[] = [];
  for (const f of mesh.faces()) {
    const vs = mesh.faceVertices(f);
    for (let i = 1; i + 1 < vs.length; i++) {
      indices.push(vs[0] as number, vs[i] as number, vs[i + 1] as number);
      triangleFace.push(f);
    }
  }
  return {
    indices,
    position: mesh.pos,
    triangleFace,
    vertex: (r) => r,
    shading: (r) => normals[r] as Tuple3,
  };
}

function renderSource(mesh: EditMesh, surface: BakeSurface): CornerSource {
  return {
    indices: surface.indices,
    position: surface.position,
    triangleFace: surface.triangleFace,
    vertex: (r) => mesh.hVert[surface.vertexCorner[r] as number] as number,
    shading: (r) => [
      surface.normal[r * 3] as number,
      surface.normal[r * 3 + 1] as number,
      surface.normal[r * 3 + 2] as number,
    ],
  };
}

/**
 * Everything a bake derives from its inputs before sampling: surfaces, groups with their
 * resolved cages and BVHs, the direction field and, on the texture target, the atlas
 * charts and tile bins. Tile rows read it only, so every Worker that prepares the same
 * request samples exactly like the serial job.
 */
export interface PreparedBake {
  readonly params: BakeJobParams;
  readonly baker: Baker;
  readonly groups: readonly GroupBake[];
  readonly base: EditMesh;
  readonly detailSlots: readonly string[];
  readonly detailTriangles: number;
  readonly baseFaceGroup: FaceGroups;
  readonly directions: readonly BakeDirection[];
  readonly vertexShading: readonly Tuple3[];
  readonly triangles: BaseTriangles;
  readonly hard: HardEdges | undefined;
  readonly encoding: Encoding;
  /** Texture target: the exported base, its chart per triangle and triangles per tile. */
  readonly atlas?: {
    readonly surface: BakeSurface;
    readonly islands: Int32Array;
    readonly tiles: number;
    readonly bins: readonly (readonly number[])[];
  };
}

/** Sampled tile rows of a texture bake: per-texel sums of the rows' texels, in row order. */
export interface BakeRows {
  /** Tile rows (32 texel rows each) in the order their texels follow. */
  readonly rows: readonly number[];
  /** Per map: four summed channels per texel. */
  readonly sums: readonly Float64Array[];
  readonly weight: Float64Array;
  readonly island: Int32Array;
  /** Summed detail points and shading normals (curvature maps), else empty. */
  readonly point: Float64Array;
  readonly normal: Float64Array;
  /** With an opacity map: ray-hit samples per texel (the other maps sum only those), else empty. */
  readonly hits: Float64Array;
  /** Per group: samples, ray hits, nearest-point fallbacks, cage clips (audit A1) and samples on hovering parts (audit A3). */
  readonly counts: Float64Array;
  /** Located cage clips and samples on hovering parts, FINDING_WIDTH numbers per record. */
  readonly findings: Float64Array;
  /**
   * V5: stacked samples, conflicts, largest angle (degrees), first conflicting texel and its
   * base face (-1: none), largest height gap (m); then samples on base triangles of mixed
   * tangent handedness and the first one's base face (-1: none).
   */
  readonly stack: Float64Array;
}

/**
 * Audit A3: connected detail parts (welded through their source vertices, floaters excluded)
 * that hover off the base. A part's gap is the smallest distance of its corners to the
 * group's base; the parts within CAGE_FLOOR of the diagonal of the closest one are
 * attached, and their largest corner distance is the relief. A part whose gap exceeds
 * that relief floats above everything that touches the base: a foreign part the cage
 * caught (or an untagged floater).
 */
function hovering(
  base: BaseTriangles,
  baseTris: readonly number[],
  detail: BakeSurface,
  detailTris: readonly number[],
  floater: Uint8Array,
  vertexOf: Int32Array,
): {
  stray: Uint8Array;
  strayParts: number;
  strayGap: number;
  strayInfo: readonly StrayPart[];
  strayIndex: Int32Array;
} {
  const none = {
    stray: new Uint8Array(0),
    strayParts: 0,
    strayGap: 0,
    strayInfo: [],
    strayIndex: new Int32Array(0),
  };
  const solid = detailTris.filter((t) => floater[t] === 0);
  if (baseTris.length === 0 || solid.length === 0) return none;
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r) as number;
    let y = x;
    while (y !== r) {
      const next = parent.get(y) as number;
      parent.set(y, r);
      y = next;
    }
    return r;
  };
  for (const t of solid) {
    const a = find(vertexOf[detail.indices[t * 3] as number] as number);
    for (let k = 1; k < 3; k++) {
      const b = find(vertexOf[detail.indices[t * 3 + k] as number] as number);
      if (a !== b) parent.set(b, a);
    }
  }
  const bvh = subsetBvh(base, baseTris).bvh;
  const near = new Map<number, number>();
  const distance = (r: number) => {
    let d = near.get(r);
    if (d === undefined) {
      const p = [0, 1, 2].map((c) => detail.position[r * 3 + c] as number) as Tuple3;
      const q = bvh.nearest(p);
      d = q === undefined ? 0 : Math.sqrt(q.distanceSquared);
      near.set(r, d);
    }
    return d;
  };
  const gap = new Map<number, number>();
  const far = new Map<number, number>();
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (const t of solid) {
    const part = find(vertexOf[detail.indices[t * 3] as number] as number);
    for (let k = 0; k < 3; k++) {
      const r = detail.indices[t * 3 + k] as number;
      const d = distance(r);
      gap.set(part, Math.min(gap.get(part) ?? Infinity, d));
      far.set(part, Math.max(far.get(part) ?? 0, d));
      lo = lo.map((x, c) => Math.min(x, detail.position[r * 3 + c] as number));
      hi = hi.map((x, c) => Math.max(x, detail.position[r * 3 + c] as number));
    }
  }
  if (gap.size < 2) return none;
  const touch = CAGE_FLOOR * length(sub(hi as Tuple3, lo as Tuple3));
  const closest = minOf(gap.values());
  let relief = 0;
  for (const [part, g] of gap)
    if (g <= closest + touch) relief = Math.max(relief, far.get(part) as number);
  const strays = new Set([...gap].filter(([, g]) => g > relief + touch).map(([part]) => part));
  if (strays.size === 0) return none;
  const stray = new Uint8Array(detail.indices.length / 3);
  const tris = new Map<number, number[]>();
  for (const t of solid) {
    const part = find(vertexOf[detail.indices[t * 3] as number] as number);
    if (!strays.has(part)) continue;
    stray[t] = 1;
    const own = tris.get(part);
    if (own === undefined) tris.set(part, [t]);
    else own.push(t);
  }
  const parts = [...tris.values()].map((own) => {
    const faces = [...new Set(own.map((t) => detail.triangleFace[t] as number))].sort(
      (a, b) => a - b,
    );
    const corners = own.flatMap((t) => [0, 1, 2].map((k) => detail.indices[t * 3 + k] as number));
    const axis = (c: number) => corners.map((r) => detail.position[r * 3 + c] as number);
    return {
      tris: own,
      info: {
        gap: minOf(corners.map(distance)),
        faces,
        bounds: {
          min: [0, 1, 2].map((c) => minOf(axis(c))) as unknown as Tuple3,
          max: [0, 1, 2].map((c) => maxOf(axis(c))) as unknown as Tuple3,
        },
      },
    };
  });
  parts.sort((a, b) => (a.info.faces[0] as number) - (b.info.faces[0] as number));
  const strayIndex = new Int32Array(stray.length).fill(-1);
  for (const [i, part] of parts.entries()) for (const t of part.tris) strayIndex[t] = i;
  return {
    stray,
    strayParts: strays.size,
    strayGap: minOf([...strays].map((part) => gap.get(part) as number)),
    strayInfo: parts.map((part) => part.info),
    strayIndex,
  };
}

/** Texel rows [y0, y1) of tile row `ty`. */
function rowSpan(ty: number, height: number): [number, number] {
  return [ty * BAKE_TILE, Math.min(height, (ty + 1) * BAKE_TILE)];
}

/** Validate the request and derive everything sampling reads (see `PreparedBake`). */
export function prepareBake(
  request: ComputeJobRequest<'bake'>,
  work: WorkMeter,
): Result<PreparedBake, ModelingError> {
  const params = request.params;
  const invalid = invalidParams(params, request.inputs.length);
  if (invalid !== undefined) return err(invalid);
  const base = decodeSnapshot(request.inputs[0] as Uint8Array);
  if (!base.ok) return base;
  const detail = decodeSnapshot(request.inputs[1] as Uint8Array);
  if (!detail.ok) return detail;
  const texture =
    params.resample === undefined || request.inputs[2] === undefined
      ? undefined
      : { ...params.resample, data: request.inputs[2] };
  if (
    texture !== undefined &&
    (!(texture.width >= 1 && texture.height >= 1) ||
      texture.data.length !== texture.width * texture.height * 4)
  ) {
    return err(
      modelingError('model-invalid-argument', 'the resample texels are width x height x 4 bytes', {
        width: texture.width,
        height: texture.height,
        bytes: texture.data.length,
      }),
    );
  }
  if (params.maps.includes('resample')) {
    const complete = detail.value
      .faces()
      .every((f) =>
        detail.value.faceHalves(f).every((h) => detail.value.corner('uv0', h) !== undefined),
      );
    if (!complete) {
      return err(
        modelingError(
          'model-precondition',
          'a resample bake reads the detail uv0 on every face',
          {},
          'unwrap or project the detail before baking its texture',
        ),
      );
    }
  }
  ensureUv(detail.value);
  const detailSurface = bakeSurface(detail.value, params.detailNormals);
  if (!detailSurface.ok) return detailSurface;
  const bounds = positionBounds(detailSurface.value.position, params.position.bounds);
  const ds =
    typeof params.wrap?.u === 'object' || typeof params.wrap?.v === 'object'
      ? tiledSurface(
          detailSurface.value,
          typeof params.wrap?.u === 'object' ? params.wrap.u : undefined,
          typeof params.wrap?.v === 'object' ? params.wrap.v : undefined,
        )
      : detailSurface.value;
  let baseSurface: BakeSurface | undefined;
  if (params.target === 'texture') {
    const surface = bakeSurface(base.value, params.baseNormals);
    if (!surface.ok) {
      const cause = surface.error;
      return err(
        modelingError(
          cause.code,
          cause.expected,
          { ...cause.detail, input: 'base' },
          'give the base complete uv0 (m.uv.auto or m.uv.unwrap + m.uv.pack) before baking',
        ),
      );
    }
    baseSurface = surface.value;
  }

  // Groups: one id list over both meshes, in id order.
  const prefix = params.tags?.groupPrefix;
  const baseGroups = faceGroups(base.value, prefix, 'base');
  if (!baseGroups.ok) return baseGroups;
  const detailGroups = faceGroups(detail.value, prefix, 'detail');
  if (!detailGroups.ok) return detailGroups;
  const ids = [...new Set([...baseGroups.value.ids, ...detailGroups.value.ids])].sort();
  const idIndex = new Map(ids.map((id, g) => [id, g]));
  const global = (local: FaceGroups) =>
    Int32Array.from(local.face, (g) =>
      g === NONE ? NONE : (idIndex.get(local.ids[g] as string) as number),
    );
  const baseFaceGroup: FaceGroups = { ids, face: global(baseGroups.value) };
  const detailFaceGroup = global(detailGroups.value);
  const directions = ids.map((id) => directionOf(params, id));

  const vertexShading = params.target === 'vertex' ? vertexNormals(base.value) : [];
  const source =
    baseSurface === undefined
      ? fanSource(base.value, vertexShading)
      : renderSource(base.value, baseSurface);
  const triangles = baseTriangles(base.value, source, baseFaceGroup, directions);
  const blend = Math.max(
    0,
    ...directions.map((d) => (typeof d === 'object' && 'blend' in d ? d.blend : 0)),
  );
  const hard = blend > 0 ? new HardEdges(base.value, source, baseFaceGroup, blend) : undefined;

  const floaterFace = taggedFaces(detail.value, params.tags?.floater);
  const detailTriangles = ds.indices.length / 3;
  const floater = Uint8Array.from(ds.triangleFace, (f) => floaterFace[f] as number);
  const baseTris: number[][] = ids.map(() => []);
  for (let t = 0; t < triangles.group.length; t++)
    (baseTris[triangles.group[t] as number] as number[]).push(t);
  const detailTris: number[][] = ids.map(() => []);
  for (let t = 0; t < detailTriangles; t++) {
    (detailTris[detailFaceGroup[ds.triangleFace[t] as number] as number] as number[]).push(t);
  }
  const detailVertex = Int32Array.from(ds.vertexCorner, (h) => detail.value.hVert[h] as number);
  const groups: GroupBake[] = [];
  for (const [g, id] of ids.entries()) {
    const own = detailTris[g] as number[];
    if ((baseTris[g] as number[]).length > 0 && own.length === 0) {
      return err(
        modelingError(
          'model-precondition',
          'every bake group of the base has detail faces',
          { group: id, prefix },
          prefix === undefined
            ? 'give the bake a detail mesh'
            : `tag the detail faces of this part ${prefix}${id}`,
        ),
      );
    }
    const cage = resolveCage(
      cageOf(params, id),
      id,
      triangles,
      baseTris[g] as number[],
      ds,
      own,
      directions[g] as BakeDirection,
      hard,
    );
    if (!cage.ok) return cage;
    const all = subsetBvh(ds, own);
    const solidTris = own.filter((t) => floater[t] === 0);
    const solid = solidTris.length === own.length ? all : subsetBvh(ds, solidTris);
    const reach = (setting: number | 'auto', auto: number) => (setting === 'auto' ? auto : setting);
    const steep = steepFraction(
      triangles,
      baseTris[g] as number[],
      ds,
      own.filter((t) => floater[t] === 0),
      directions[g] as BakeDirection,
      hard,
    );
    groups.push({
      id,
      steep,
      offset: cage.value.offset,
      maxRay: cage.value.maxRay,
      aoDistance: reach(params.ao.distance, Math.min(AO_DIAGONAL * cage.value.diagonal, AO_MAX)),
      thicknessDistance: reach(params.thickness.distance, THICKNESS_DIAGONAL * cage.value.diagonal),
      direction: directions[g] as BakeDirection,
      bvh: all.bvh,
      map: all.map,
      solid: solid.bvh,
      solidMap: solid.map,
      triangles: own.length,
      ...hovering(triangles, baseTris[g] as number[], ds, own, floater, detailVertex),
      samples: 0,
      rayHits: 0,
      nearest: 0,
      clipped: 0,
      strayHits: 0,
    });
  }
  const shared =
    params.ao.scope === 'all'
      ? ids.flatMap((id, g) =>
          params.ao.exclude.includes(id)
            ? []
            : (detailTris[g] as number[]).filter((t) => floater[t] === 0),
        )
      : undefined;
  const symmetric = Math.max(
    ...groups.map((g) => Math.max(g.offset, g.maxRay - g.offset)),
    Number.MIN_VALUE,
  );
  const heightRange: readonly [number, number] = params.height.range ?? [-symmetric, symmetric];
  const encoding: Encoding = { heightRange, positionBounds: bounds, params };
  const basePositions = base.value.vertices().flatMap((v) => base.value.position(v));
  const diagonal = diagonalOf(basePositions, ds.position);
  const baker = new Baker(ds, detail.value, params, texture, diagonal, groups, floater, shared);
  if (!work.spend(Math.ceil(baker.nodes / 4) + 1)) return err(work.failure as ModelingError);
  let atlas: PreparedBake['atlas'];
  if (baseSurface !== undefined) {
    const b = baseSurface;
    const { w, h } = gridOf(params);
    const tiles = Math.ceil(w / BAKE_TILE);
    const tileRows = Math.ceil(h / BAKE_TILE);
    const bins: number[][] = Array.from({ length: tiles * tileRows }, () => []);
    const count = b.indices.length / 3;
    for (let t = 0; t < count; t++) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (let k = 0; k < 3; k++) {
        const i = b.indices[t * 3 + k] as number;
        xs.push((b.uv[i * 2] as number) * w);
        ys.push((b.uv[i * 2 + 1] as number) * h);
      }
      const x0 = Math.max(0, Math.floor(minOf(xs) / BAKE_TILE));
      const x1 = Math.min(tiles - 1, Math.floor(maxOf(xs) / BAKE_TILE));
      const y0 = Math.max(0, Math.floor(minOf(ys) / BAKE_TILE));
      const y1 = Math.min(tileRows - 1, Math.floor(maxOf(ys) / BAKE_TILE));
      for (let ty = y0; ty <= y1; ty++)
        for (let tx = x0; tx <= x1; tx++) (bins[ty * tiles + tx] as number[]).push(t);
    }
    atlas = { surface: b, islands: triangleIslands(b), tiles, bins };
  }
  return ok({
    params,
    baker,
    groups,
    base: base.value,
    detailSlots: ds.slots,
    detailTriangles,
    baseFaceGroup,
    directions,
    vertexShading,
    triangles,
    hard,
    encoding,
    ...(atlas === undefined ? {} : { atlas }),
  });
}

/** Tile rows of a prepared texture bake, in the order given (any order and split gives the same texels). */
export function bakeRows(
  prepared: PreparedBake,
  rows: readonly number[],
  work: WorkMeter,
): Result<BakeRows, ModelingError> {
  const { params, baker, groups, triangles, directions, hard } = prepared;
  const { surface: b, islands, tiles, bins } = prepared.atlas as NonNullable<PreparedBake['atlas']>;
  const maps = params.maps;
  const { w: width, h: height } = gridOf(params);
  const grid = Math.round(Math.sqrt(params.samples));
  const texels = rows.reduce((n, ty) => {
    const [y0, y1] = rowSpan(ty, height);
    return n + (y1 - y0) * width;
  }, 0);
  const sums = maps.map(() => new Float64Array(texels * 4));
  const curving = guided(params);
  const pointSum = new Float64Array(curving ? texels * 3 : 0);
  const normalSum = new Float64Array(curving ? texels * 3 : 0);
  const weight = new Float64Array(texels);
  const island = new Int32Array(texels).fill(NONE);
  // Under an opacity map a miss is a transparent sample: only hits feed the other maps.
  const opacity = maps.indexOf('opacity');
  const hits = new Float64Array(opacity >= 0 ? texels : 0);
  const before = groups.map(counters);
  const sample = new Float64Array(maps.length * 4);
  const uvOf = (t: number, k: number): [number, number] => {
    const i = b.indices[t * 3 + k] as number;
    return [(b.uv[i * 2] as number) * width, (b.uv[i * 2 + 1] as number) * height];
  };
  const attr = (a: Float32Array, width: number, t: number, w: readonly number[], c: number) => {
    let s = 0;
    for (let k = 0; k < 3; k++)
      s += (w[k] as number) * (a[(b.indices[t * 3 + k] as number) * width + c] as number);
    return s;
  };
  // V5: a later triangle on a claimed sub-sample re-derives its normal and height there;
  // a sampled triangle whose corners disagree on tangent handedness has no frame (seam).
  const perTexel = grid * grid;
  const [inner, outer] = prepared.encoding.heightRange;
  const heightTolerance = STACK_HEIGHT * (outer - inner);
  const stack = [0, 0, 0, -1, -1, 0, 0, -1];
  const mixed = (t: number) => {
    let sign = 0;
    for (let k = 0; k < 3; k++) {
      const w = b.tangent[(b.indices[t * 3 + k] as number) * 4 + 3] as number;
      const own = w < 0 ? -1 : 1;
      if (sign !== 0 && own !== sign) return true;
      sign = own;
    }
    return false;
  };
  const surfaceAt = (t: number, w: readonly number[]) => {
    const g = triangles.group[t] as number;
    const direction = directions[g] as BakeDirection;
    const pos = [0, 1, 2].map((c) => attr(b.position, 3, t, w, c)) as Tuple3;
    const nrm = normalize([0, 1, 2].map((c) => attr(b.normal, 3, t, w, c)) as Tuple3);
    const tan = [0, 1, 2].map((c) => attr(b.tangent, 4, t, w, c)) as Tuple3;
    const hand = attr(b.tangent, 4, t, w, 3);
    const ray = direction === 'shading' ? nrm : rayDirection(triangles, t, w, direction, pos, hard);
    return {
      g,
      pos,
      nrm,
      tan,
      hand,
      ray,
      averaged: averagedPart(triangles, t, direction, pos, hard),
    };
  };
  const stackSample = (t: number, px: number, py: number) => {
    const [p0, p1, p2] = [0, 1, 2].map((k) => uvOf(t, k)) as [
      [number, number],
      [number, number],
      [number, number],
    ];
    const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
    const w1 = ((px - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (py - p0[1])) / area;
    const w2 = ((p1[0] - p0[0]) * (py - p0[1]) - (px - p0[0]) * (p1[1] - p0[1])) / area;
    const at = surfaceAt(t, [1 - w1 - w2, w1, w2]);
    return baker.stackSample(at.pos, at.nrm, at.ray, [at.tan, at.hand], at.g, at.averaged);
  };
  let base = 0;
  for (const ty of rows) {
    const [y0, y1] = rowSpan(ty, height);
    const claimed = new Uint16Array((y1 - y0) * width);
    const claimant = new Int32Array((y1 - y0) * width * perTexel);
    for (let tx = 0; tx < tiles; tx++) {
      for (const t of bins[ty * tiles + tx] as number[]) {
        const [p0, p1, p2] = [0, 1, 2].map((k) => uvOf(t, k)) as [
          [number, number],
          [number, number],
          [number, number],
        ];
        const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
        if (area === 0) continue;
        const xs = [p0[0], p1[0], p2[0]];
        const ys = [p0[1], p1[1], p2[1]];
        const xa = Math.max(tx * BAKE_TILE, Math.floor(minOf(xs)));
        const xb = Math.min((tx + 1) * BAKE_TILE - 1, width - 1, Math.floor(maxOf(xs)));
        const ya = Math.max(y0, Math.floor(minOf(ys)));
        const yb = Math.min(y1 - 1, Math.floor(maxOf(ys)));
        for (let y = ya; y <= yb; y++) {
          for (let x = xa; x <= xb; x++) {
            const local = (y - y0) * width + x;
            const i = base + local;
            const texel = y * width + x;
            for (let s = 0; s < perTexel; s++) {
              const taken = ((claimed[local] as number) & (1 << s)) !== 0;
              const px = x + ((s % grid) + 0.5) / grid;
              const py = y + (Math.floor(s / grid) + 0.5) / grid;
              const w1 = ((px - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (py - p0[1])) / area;
              const w2 = ((p1[0] - p0[0]) * (py - p0[1]) - (px - p0[0]) * (p1[1] - p0[1])) / area;
              const w0 = 1 - w1 - w2;
              if (w0 < 0 || w1 < 0 || w2 < 0) continue;
              if (taken) {
                // Only a strict interior overlap stacks: a shared chart edge is not a stack.
                if (w0 > 0 && w1 > 0 && w2 > 0) {
                  const first = claimant[local * perTexel + s] as number;
                  const a = stackSample(first, px, py);
                  const c = stackSample(t, px, py);
                  const angle =
                    (atan2(length(cross(a.normal, c.normal)), dot(a.normal, c.normal)) * 180) /
                    Math.PI;
                  const gap = Math.abs(a.height - c.height);
                  stack[0] = (stack[0] as number) + 1;
                  stack[5] = Math.max(stack[5] as number, gap);
                  if (angle > STACK_ANGLE || gap > heightTolerance) {
                    stack[1] = (stack[1] as number) + 1;
                    if (stack[3] === -1 || texel < (stack[3] as number)) {
                      stack[3] = texel;
                      stack[4] = b.triangleFace[t] as number;
                    }
                  }
                  stack[2] = Math.max(stack[2] as number, angle);
                }
                continue;
              }
              claimed[local] = (claimed[local] as number) | (1 << s);
              claimant[local * perTexel + s] = t;
              if (mixed(t)) {
                stack[6] = (stack[6] as number) + 1;
                const face = b.triangleFace[t] as number;
                if (stack[7] === -1 || face < (stack[7] as number)) stack[7] = face;
              }
              const at = surfaceAt(t, [w0, w1, w2]);
              baker.face = b.triangleFace[t] as number;
              baker.evaluate(
                at.pos,
                at.nrm,
                at.ray,
                [at.tan, at.hand],
                at.g,
                texel * 16 + s,
                sample,
                at.averaged,
              );
              const opaque = opacity < 0 || baker.lastHit;
              if (opacity >= 0 && opaque) hits[i] = (hits[i] as number) + 1;
              for (const [k] of maps.entries()) {
                if (!opaque && k !== opacity) continue;
                const sum = sums[k] as Float64Array;
                for (let c = 0; c < 4; c++)
                  sum[i * 4 + c] = (sum[i * 4 + c] as number) + (sample[k * 4 + c] as number);
              }
              weight[i] = (weight[i] as number) + 1;
              if (island[i] === NONE) island[i] = islands[t] as number;
              if (curving && opaque) {
                for (let c = 0; c < 3; c++) {
                  pointSum[i * 3 + c] =
                    (pointSum[i * 3 + c] as number) + (baker.lastPoint[c] as number);
                  normalSum[i * 3 + c] =
                    (normalSum[i * 3 + c] as number) + (baker.lastNormal[c] as number);
                }
              }
            }
          }
        }
      }
      if (!work.spend(1 + baker.work())) return err(work.failure as ModelingError);
    }
    base += (y1 - y0) * width;
  }
  const counts = new Float64Array(groups.length * GROUP_COUNTERS);
  for (const [g, group] of groups.entries()) {
    const was = before[g] as number[];
    counts.set(
      counters(group).map((x, k) => x - (was[k] as number)),
      g * GROUP_COUNTERS,
    );
  }
  return ok({
    rows: [...rows],
    sums,
    weight,
    island,
    point: pointSum,
    normal: normalSum,
    hits,
    counts,
    findings: baker.findings.drain(),
    stack: Float64Array.from(stack),
  });
}

/** Every tile row of a texture bake, in order. */
export function allRows(params: BakeJobParams): number[] {
  return Array.from({ length: Math.ceil(gridOf(params).h / BAKE_TILE) }, (_, ty) => ty);
}

/** The vertex target: one sample per (vertex, group) pair, expanded to corners. */
function bakeVertices(
  prepared: PreparedBake,
  work: WorkMeter,
): Result<{ values: Float64Array[]; covered: number; curvatureRange: number }, ModelingError> {
  const {
    params,
    baker,
    base: mesh,
    baseFaceGroup,
    directions,
    vertexShading,
    encoding,
  } = prepared;
  const maps = params.maps;
  const ids = baseFaceGroup.ids;
  const sample = new Float64Array(maps.length * 4);
  const averaged = averagedNormals(mesh, baseFaceGroup.face);
  const halves = mesh.faces().flatMap((f) => mesh.faceHalves(f));
  // One sample per (vertex, group) pair, in corner order of first use.
  const pairs = new Map<number, number>();
  const pairOf: number[] = [];
  const samplesAt: [number, number, number][] = [];
  for (const h of halves) {
    const v = mesh.hVert[h] as number;
    const g = baseFaceGroup.face[mesh.hFace[h] as number] as number;
    const key = v * ids.length + g;
    let k = pairs.get(key);
    if (k === undefined) {
      k = samplesAt.length;
      pairs.set(key, k);
      samplesAt.push([v, g, mesh.hFace[h] as number]);
    }
    pairOf.push(k);
  }
  const count = samplesAt.length;
  const vertexValues = maps.map(() => new Float64Array(count * 4));
  const weight = new Float64Array(count).fill(1);
  for (const [k, [v, g, face]] of samplesAt.entries()) {
    const shading = vertexShading[v] as Tuple3;
    baker.face = face;
    const c = directions[g] === 'shading' ? shading : averaged(v, g);
    baker.evaluate(
      mesh.position(v),
      shading,
      c,
      undefined,
      g,
      k,
      sample,
      directions[g] === 'averaged',
    );
    for (const [m] of maps.entries())
      (vertexValues[m] as Float64Array).set(sample.subarray(m * 4, m * 4 + 4), k * 4);
    if (!work.spend(1 + baker.work())) return err(work.failure as ModelingError);
  }
  const curvatureRange = encodeMaps(maps, vertexValues, weight, encoding);
  const values = maps.map((_, m) => {
    const out = new Float64Array(halves.length * 4);
    for (const [i, k] of pairOf.entries()) {
      out.set((vertexValues[m] as Float64Array).subarray(k * 4, k * 4 + 4), i * 4);
    }
    return out;
  });
  return ok({ values, covered: count, curvatureRange });
}

/**
 * Assemble the texture target from sampled rows (any split, any order): average the
 * samples, measure texture-space curvature, filter, encode, fill the gutter and measure
 * mip bleed. Equal rows give equal bytes however they were split across Workers.
 */
function finishTexture(
  prepared: PreparedBake,
  parts: readonly BakeRows[],
): Result<
  {
    values: Float64Array[];
    covered: number;
    curvatureRange: number;
    bleed: number[];
    stack: BakeStack;
    handedness: BakeHandedness;
  },
  ModelingError
> {
  const { params, encoding } = prepared;
  const maps = params.maps;
  const grid = gridOf(params);
  const texels = grid.w * grid.h;
  const sums: Float64Array[] = maps.map(() => new Float64Array(texels * 4));
  const curving = guided(params);
  const pointSum = new Float64Array(curving ? texels * 3 : 0);
  const normalSum = new Float64Array(curving ? texels * 3 : 0);
  const weight = new Float64Array(texels);
  const island = new Int32Array(texels).fill(NONE);
  const opacity = maps.indexOf('opacity');
  const hits = new Float64Array(opacity >= 0 ? texels : 0);
  const stack = { samples: 0, conflicts: 0, maxAngle: 0, maxHeight: 0, face: -1 };
  const handedness = { samples: 0, face: -1 };
  let firstTexel = -1;
  for (const part of parts) {
    const [samples, conflicts, maxAngle, texel, face, maxHeight, mixedSamples, mixedFace] =
      part.stack;
    stack.samples += samples as number;
    stack.conflicts += conflicts as number;
    stack.maxAngle = Math.max(stack.maxAngle, maxAngle as number);
    stack.maxHeight = Math.max(stack.maxHeight, maxHeight as number);
    handedness.samples += mixedSamples as number;
    if (
      (mixedFace as number) >= 0 &&
      (handedness.face === -1 || (mixedFace as number) < handedness.face)
    )
      handedness.face = mixedFace as number;
    if ((texel as number) >= 0 && (firstTexel < 0 || (texel as number) < firstTexel)) {
      firstTexel = texel as number;
      stack.face = face as number;
    }
    let offset = 0;
    for (const ty of part.rows) {
      const [y0, y1] = rowSpan(ty, grid.h);
      const n = (y1 - y0) * grid.w;
      const at = y0 * grid.w;
      for (const [k] of maps.entries()) {
        (sums[k] as Float64Array).set(
          (part.sums[k] as Float64Array).subarray(offset * 4, (offset + n) * 4),
          at * 4,
        );
      }
      weight.set(part.weight.subarray(offset, offset + n), at);
      island.set(part.island.subarray(offset, offset + n), at);
      if (opacity >= 0) hits.set(part.hits.subarray(offset, offset + n), at);
      if (curving) {
        pointSum.set(part.point.subarray(offset * 3, (offset + n) * 3), at * 3);
        normalSum.set(part.normal.subarray(offset * 3, (offset + n) * 3), at * 3);
      }
      offset += n;
    }
  }
  let covered = 0;
  for (let i = 0; i < texels; i++) if ((weight[i] as number) > 0) covered++;
  if (covered === 0) {
    return err(
      modelingError(
        'model-precondition',
        'the base uv0 covers at least one texel of the [0, 1] atlas',
        { resolution: params.resolution },
        'pack the base UVs into [0, 1] (m.uv.pack or m.uv.auto) before baking',
      ),
    );
  }
  // The opacity map covers its charts; the others only where rays hit, and the gutter
  // fills the transparent texels from the hits around them (C-404 nets).
  const layers: { kinds: number[]; weight: Float64Array }[] =
    opacity < 0
      ? [{ kinds: maps.map((_, k) => k), weight }]
      : [
          { kinds: [opacity], weight },
          { kinds: maps.map((_, k) => k).filter((k) => k !== opacity), weight: hits },
        ];
  let curvatureRange = 0;
  const chart = Uint8Array.from(weight, (w) => (w > 0 ? 1 : 0));
  let owner: Int32Array = Int32Array.from(island);
  const fill = Math.max(grid.w, grid.h);
  for (const layer of layers) {
    if (layer.kinds.length === 0) continue;
    const kinds = layer.kinds.map((k) => maps[k] as BakeMapKind);
    const values = layer.kinds.map((k) => sums[k] as Float64Array);
    const lw = layer.weight;
    for (let i = 0; i < texels; i++) {
      const w = lw[i] as number;
      if (!(w > 0)) continue;
      for (const v of values)
        for (let c = 0; c < 4; c++) v[i * 4 + c] = (v[i * 4 + c] as number) / w;
    }
    const point = new Float64Array(pointSum);
    const normal = new Float64Array(normalSum);
    for (let i = 0; i < (curving ? texels : 0); i++) {
      const w = lw[i] as number;
      if (!(w > 0)) continue;
      normal.set(
        normalize([
          normal[i * 3] as number,
          normal[i * 3 + 1] as number,
          normal[i * 3 + 2] as number,
        ]),
        i * 3,
      );
      for (let c = 0; c < 3; c++) point[i * 3 + c] = (point[i * 3 + c] as number) / w;
    }
    if (params.ao.denoise > 0) {
      for (const [j, kind] of kinds.entries()) {
        if (kind === 'ao' || kind === 'ormh') {
          denoise(values[j] as Float64Array, normal, lw, island, grid, params.ao.denoise);
        }
      }
    }
    if (curving && kinds.some((kind) => CURVATURE_MAPS.includes(kind))) {
      const curvature = textureCurvature(point, normal, lw, island, grid, params.wrap);
      for (const [j, kind] of kinds.entries()) {
        if (!CURVATURE_MAPS.includes(kind)) continue;
        const v = values[j] as Float64Array;
        for (let i = 0; i < texels; i++) v[i * 4] = curvature[i] as number;
      }
    }
    if (params.filter === 'bspline') filterBspline(kinds, values, lw, island, grid, normal);
    curvatureRange = Math.max(curvatureRange, encodeMaps(kinds, values, lw, encoding));
    const mask = Uint8Array.from(lw, (w) => (w > 0 ? 1 : 0));
    const layerOwner = Int32Array.from(island, (o, i) => ((lw[i] as number) > 0 ? o : UNOWNED));
    dilate(values, mask, layerOwner, grid, params.gutter === 'fill' ? fill : params.gutter);
    for (const [j, k] of layer.kinds.entries()) sums[k] = values[j] as Float64Array;
    if (layer.weight === weight) owner = layerOwner;
  }
  return ok({
    values: sums,
    covered,
    curvatureRange,
    bleed: mipBleed(owner, chart, grid),
    stack,
    handedness,
  });
}

/**
 * The job output of a prepared bake: the texture target from its sampled rows (`parts`,
 * which together hold every tile row once), the vertex target sampled here.
 */
export function finishBake(
  prepared: PreparedBake,
  parts: readonly BakeRows[],
  work: WorkMeter,
): Result<BackendOutput<'bake'>, ModelingError> {
  const { params, groups, baker, encoding, hard } = prepared;
  const counts = new Float64Array(groups.length * GROUP_COUNTERS);
  let findings: Float64Array[] = [];
  let result: {
    values: Float64Array[];
    covered: number;
    curvatureRange: number;
    bleed?: number[];
    stack?: BakeStack;
    handedness?: BakeHandedness;
  };
  if (params.target === 'vertex') {
    const before = groups.map(counters);
    const vertex = bakeVertices(prepared, work);
    if (!vertex.ok) return vertex;
    result = vertex.value;
    findings = [baker.findings.drain()];
    for (const [g, group] of groups.entries()) {
      const was = before[g] as number[];
      counts.set(
        counters(group).map((x, k) => x - (was[k] as number)),
        g * GROUP_COUNTERS,
      );
    }
  } else {
    const texture = finishTexture(prepared, parts);
    if (!texture.ok) return texture;
    result = texture.value;
    findings = parts.map((part) => part.findings);
    for (const part of parts) {
      for (let i = 0; i < counts.length; i++)
        counts[i] = (counts[i] as number) + (part.counts[i] as number);
    }
  }
  const { values, covered, curvatureRange } = result;
  const bleed = result.bleed ?? [];
  const stack = result.stack ?? { samples: 0, conflicts: 0, maxAngle: 0, maxHeight: 0, face: -1 };
  const handedness = result.handedness ?? { samples: 0, face: -1 };
  const heightRange = encoding.heightRange;
  const merged = mergeFindings(findings);
  const groupReports = groups.map((g, k) => ({
    id: g.id,
    offset: g.offset,
    maxRay: g.maxRay,
    samples: counts[k * GROUP_COUNTERS] as number,
    rayHits: counts[k * GROUP_COUNTERS + 1] as number,
    nearest: counts[k * GROUP_COUNTERS + 2] as number,
    clipped: counts[k * GROUP_COUNTERS + 3] as number,
    clipClusters: clipClusters(merged, k),
    stray: {
      parts: g.strayParts,
      gap: g.strayGap,
      samples: counts[k * GROUP_COUNTERS + 4] as number,
      clusters: strayClusters(merged, k, g.strayInfo),
    },
    detailTriangles: g.triangles,
    aoDistance: g.aoDistance,
    thicknessDistance: g.thicknessDistance,
    steepArea: g.steep,
  }));
  const rayHits = groupReports.reduce((n, g) => n + g.rayHits, 0);
  const nearest = groupReports.reduce((n, g) => n + g.nearest, 0);
  const samples = rayHits + nearest;
  const sampled = groupReports.filter((g) => g.samples > 0);
  const protectedBleed = bleed.slice(0, params.protectMip).reduce((n, b) => n + b, 0);
  return ok({
    status: 'ok',
    outputs: values.map(encodeFloats),
    provenance: {
      covered,
      rayHits,
      nearest,
      groups: groupReports,
      materials: prepared.detailSlots.map((slot, i) => ({
        slot,
        color: [...(MATERIAL_ID_PALETTE[i % MATERIAL_ID_PALETTE.length] as readonly number[])],
      })),
      curvatureRange,
      heightRange,
      positionBounds: encoding.positionBounds,
      emissiveScale: emissiveScale(params.slots),
      bleed,
      stack,
      handedness,
    },
    metrics: {
      covered,
      coverage: params.target === 'texture' ? covered / (gridOf(params).w * gridOf(params).h) : 1,
      samples,
      rayHits,
      nearest,
      rayHitRatio: samples > 0 ? rayHits / samples : 0,
      groups: sampled.length,
      minGroupRayHitRatio:
        sampled.length > 0 ? minOf(sampled.map((g) => g.rayHits / g.samples)) : 0,
      heightInner: heightRange[0],
      heightOuter: heightRange[1],
      hardEdges: hard?.count ?? 0,
      protectMip: params.protectMip,
      protectedBleed,
      aoRays: params.maps.includes('ao') ? params.ao.rays : 0,
      bvhNodes: baker.nodes,
      detailTriangles: prepared.detailTriangles,
      baseTriangles: prepared.atlas === undefined ? 0 : prepared.atlas.surface.indices.length / 3,
      curvatureRange,
    },
    locations: [],
  });
}

/**
 * The bake job (groups and cage): one
 * correspondence pass maps each base sample (uv0 texels of the exported base, or base
 * vertices) to the detail of its bake group - a ray from the cage (`offset` outside along
 * the direction field) inward within `maxRay`, the nearest detail point on a miss - and
 * feeds every requested evaluator. Texels are processed in 32 x 32 tiles, filtered with a
 * cubic B-spline inside their chart and grown into a gutter. Outputs: per map,
 * little-endian f32 RGBA per texel (row-major, v down the rows) or per base corner (FXEM
 * face order). `bakeRows` samples any subset of tile rows, so Workers can split a bake.
 */
export function runBakeJob(
  request: ComputeJobRequest<'bake'>,
  work: WorkMeter,
): Result<BackendOutput<'bake'>, ModelingError> {
  const prepared = prepareBake(request, work);
  if (!prepared.ok) return prepared;
  if (request.params.target === 'vertex') return finishBake(prepared.value, [], work);
  const rows = bakeRows(prepared.value, allRows(request.params), work);
  if (!rows.ok) return rows;
  return finishBake(prepared.value, [rows.value], work);
}

/**
 * @internal The bake job's phases for Workers that sample tile rows of one request
 * (`bakeMapsParallel`): `prepare` once, `rows` for any subset of `all(params)`.
 */
export const bakePhases = { prepare: prepareBake, rows: bakeRows, all: allRows } as const;

/** TypeScript baseline of the bake job: single-threaded BVH rays on the CPU. */
export const tsBakeBackend: ComputeBackend = {
  name: 'ts',
  identity: TS_BACKEND_IDENTITY,
  supports: (kind: ComputeJobKind) => kind === 'bake',
  quality: () => 'baseline',
  run(request, work) {
    return runBakeJob(request as ComputeJobRequest<'bake'>, work) as never;
  },
};
