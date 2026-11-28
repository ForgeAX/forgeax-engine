import { err, ok, type Result } from '@forgeax/engine-types';
import { maxOf, minOf } from './arrays';
import {
  type ComputeBackend,
  type ComputeJobKind,
  type ComputeJobParams,
  type ComputeJobResult,
  type ComputePolicy,
  runComputeJob,
  type UnwrapMethod,
  type UvPinRule,
} from './compute/job';
import { tsUvBackend } from './compute/uv-backend';
import { type PartList, partDensities, partList } from './compute/uv-parts';
import { decodeCornerUvs, measureUv, orientation } from './compute/uv-ts';
import { cos } from './dmath';
import { type ModelingError, modelingError } from './errors';
import { isRespectSharp, type NormalMode, shadingHard, UnionFind } from './finish';
import { decodeSnapshot, encodeSnapshot } from './fxem';
import { cross, dot, length, newell, normalize, sub, type Tuple3, triangulateLoop } from './geom';
import { EDGE_SEAM, EDGE_SHARP, type EditMesh, NONE } from './mesh';
import { mirrorPairs } from './mirror-pairing';
import type { Model } from './model';
import type { OpDiagnostic, RoleCounts } from './ops';
import { orient2d } from './predicates';
import type { EdgeSelector } from './selectors';
import type { TrimRegion } from './trim';
import { uvOverlapPairs } from './uv-overlap';

export type UvChannel = 'uv0' | 'uv1';

/** Seam source of an unwrap: marked seams, marked seams plus sharp edges, or marked seams plus a selection. */
export type SeamSource = 'marked' | 'sharp' | EdgeSelector;

export interface UnwrapOptions {
  /** 'lscm' (default): per-island least-squares conformal map; 'expmap': geodesic polar coordinates for small patches. */
  readonly method?: UnwrapMethod;
  /** Where to cut (default 'marked': edges flagged by `markSeam`). */
  readonly seams?: SeamSource;
  /** LSCM pins (default 'boundary': the farthest-apart pair on the longest boundary loop). */
  readonly pins?: UvPinRule;
  readonly channel?: UvChannel;
  /**
   * Relative residual of the CGLS fallback (default 1e-9). LSCM solves each island
   * directly; CGLS takes an island whose envelope exceeds the direct limit.
   */
  readonly tolerance?: number;
  /** Iteration cap of the CGLS fallback. */
  readonly maxIterations?: number;
  /**
   * `'slim'`: refine every island that is not a rectified grid by SLIM
   *, flip-free minimization of the symmetric Dirichlet energy that
   * penalizes stretch and compression alike. An island keeps the refined layout only
   * if it has no flipped triangle, a lower energy, no more self-overlap and no wider
   * texel density spread than the unwrap; a folded disk restarts from its Tutte
   * embedding. The info diagnostic reports `refined`, `refineRejected`,
   * `refineIterations`, `energyBefore` / `energyAfter` (4 is isometric) and `overlaps`.
   * Default: off, the unwrap is unchanged.
   */
  readonly refine?: 'slim';
  readonly compute?: ComputePolicy;
  /** Work units for the job (default: the session budget). */
  readonly budget?: number;
}

/** Island spacing: texels, or `{ mips: k }` for 2^(k+1) texels (separate charts down to mip k). */
export type UvPadding = number | { readonly mips: number };

/** Texels of the smallest mip level the default protection keeps free of bleeding. */
const PROTECT_TEXELS = 128;

/**
 * The one default of mip protection: the largest k with resolution / 2^k >= 128,
 * so charts and regions stay apart down to the 128-texel level. Bake `protectMip` and
 * trim-sheet padding (`{ mips: k }`) default to it.
 * @internal Options default through it; authors never pass it.
 */
export function defaultProtectMip(resolution: number): number {
  let k = 0;
  while (resolution / (1 << (k + 1)) >= PROTECT_TEXELS) k++;
  return k;
}

/** Padding in texels: `{ mips: k }` is 2^(k+1); NaN when malformed. */
export function paddingTexels(padding: UvPadding): number {
  if (typeof padding === 'number') return padding;
  const k = padding?.mips;
  return Number.isInteger(k) && k >= 0 && k <= 10 ? 1 << (k + 1) : Number.NaN;
}

const byTag = ([a]: readonly [string, unknown], [b]: readonly [string, unknown]) =>
  a < b ? -1 : a > b ? 1 : 0;

export interface PackOptions {
  /** Square atlas size in texels; padding and the texel density metric refer to it. */
  readonly resolution: number;
  /**
   * Texels between islands (half of it at the atlas border), or `{ mips: k }` for
   * 2^(k+1) texels, so islands stay apart down to mip k.
   */
  readonly padding: UvPadding;
  /**
   * Reorient islands to their minimal bounding rectangle and allow quarter turns
   * (default true); `{ step: 45 }` also tries eighth turns (raster only).
   */
  readonly rotate?: boolean | { readonly step: 90 | 45 };
  /**
   * Island orientation when `rotate` is on. `'straight'` (default): the dominant boundary direction on
   * an axis when enough of the boundary agrees, else the minimal rectangle. `'minimal'`: the minimal
   * rectangle only. `'worldUp'`: world +Y projected onto the island points to +v (the area-weighted mean
   * over its faces; wood grain, brushed metal) and no island is turned afterwards, so the pack only
   * translates them; an island whose mean projection is under 0.2 of unit (a floor) keeps `'straight'`.
   */
  readonly orient?: 'minimal' | 'straight' | 'worldUp';
  /** Scale islands to their 3D area before packing, for one texel density (default true). */
  readonly normalize?: boolean;
  /**
   * 'skyline' (default): bounding rectangles on a skyline; 'raster': conservative cell
   * masks (atlas cells of at most 512 per side), so small islands fill holes and the
   * concave parts of large ones.
   */
  readonly method?: 'skyline' | 'raster';
  /**
   * Congruent islands (same triangles, same shape up to quarter turns) share one placement and identical UVs.
   * `'mirrored'` also stacks the island of every `FACE_MIRRORED` copy onto the island of the faces it reflects
   * (`mirror` makes them; paired by position), each paired vertex taking its partner's UV: the copy's triangles
   * come out inverted, which is the mirror image. Copies without a partner keep their own texels and are counted
   * in `unpaired`; pairs whose material or tags differ are warned about. Plan with `uv.plan({ mirror: 'mirrored' })` so both halves are cut alike.
   */
  readonly stack?: boolean | 'mirrored';
  /**
   * Round every island's bounding rectangle to whole texels, so axis-aligned island edges sit
   * on pixel boundaries (an island that would stretch more than 6% on an axis is only
   * translated). Use it with a small atlas, where texel-exact trim-sheet edges matter.
   */
  readonly snap?: boolean;
  /**
   * Regular layout (raster only): face tags naming the parts. Islands whose faces mostly carry
   * one tag share one rectangular atlas region; regions split the atlas by guillotine cuts
   * proportional to their islands' area, largest part first, so a part reads as one block.
   */
  readonly groups?: readonly string[];
  /**
   * With `groups`: 'tight' also tries, per cut, the smallest region that holds the first side
   * (binary search; about 7x slower, spends at most half of the work budget left when it starts
   * and then falls back to the proportional layout, so the result can depend on `budget`). Default 'proportional'.
   */
  readonly fill?: 'proportional' | 'tight';
  /**
   * Several atlases in one call (raster only; at most 64): tile `t` is the unit cell
   * `(t mod across, floor(t / across))` of the channel, so `floor(uv)` names the tile (an S1
   * material zone when the tile is a zone). `by: 'group'` packs each `groups` entry into its own
   * tile (tile = its index in `groups`); `by: 'zone'` places each `groups` tag in the cell
   * `zones[tag]` (every part needs a cell; `validate({ surface: { zones } })` then passes);
   * `by: 'fit'` fills tile 0 first, in priority then size order, and spills the rest to the next
   * tiles (one sub-atlas per tile when `groups` is given). A part that does not fit a tile fails
   * `model-precondition` with `detail.tile` and `detail.achievable`. `down` defaults to the rows
   * the parts need (`fit`: 1). Stacked islands must stay inside their leader's tile.
   */
  readonly tiles?: {
    readonly across: number;
    readonly down?: number;
    readonly by: 'group' | 'zone' | 'fit';
    readonly zones?: Readonly<Record<string, readonly [number, number]>>;
  };
  /**
   * Face tag -> priority (raster only). An island whose faces mostly carry the tag is placed before
   * lower priorities, and with a `density.target` and tolerance the highest priority keeps the target
   * density while the others may drop to its floor. Unlisted islands rank 0; equal priority keeps
   * the area order. Absent: byte-identical to a pack without it.
   */
  readonly priority?: Readonly<Record<string, number>>;
  /**
   * Pack at `target` texels per meter instead of the largest scale that fits; the scale
   * may drop to target x (1 - tolerance) (default 0) before `model-precondition`, which
   * names the density that does fit (`achievable`). Without `target` the base density is the
   * largest that fits. With `normalize: false`, `target` is the mean density of the layout.
   * `parts` (needs `normalize`): face tag -> multiplier above 0, so an island whose faces mostly
   * carry the tag (the first of the sorted tags on a tie) is packed at multiplier x the base
   * density (1 = base; 2 = twice the texels per meter); the packed base is then the one common
   * scale that fits. `validate({ texelDensity: { parts } })` checks the same table.
   */
  readonly density?: {
    readonly target?: number;
    readonly tolerance?: number;
    readonly parts?: Readonly<Record<string, number>>;
  };
  /**
   * Passes (integer 0 to 8, default 0 = off) that repair UV overlap left by the layout: triangle
   * pairs of different faces that overlap in the packed channel (the exact `validate` predicate)
   * have every edge of their faces cut, those faces are flattened on their own and the atlas is
   * packed again. No seam flag is written; the info diagnostic reports `overlaps` left and
   * `overlapPasses` used. Overlap with faces of `with` sessions is not seen.
   */
  readonly resolveOverlaps?: number;
  /**
   * Other sessions sharing the atlas: their islands (every face) are packed too,
   * and only this session's UVs are written. Pass the same list to each session, this
   * one included, for one shared layout; a list without this session puts it first.
   */
  readonly with?: readonly Model[];
  readonly channel?: UvChannel;
  readonly compute?: ComputePolicy;
  readonly budget?: number;
}

export interface AutoUvOptions {
  /** Initial farthest-point patches before merging; the chart count never exceeds it (default 100). */
  readonly maxCharts?: number;
  /** Largest area-weighted mean area distortion of a merged chart (default 1.5). */
  readonly maxDistortion?: number;
  /** Largest angle in degrees between the average normals of two merging charts (default 45). */
  readonly maxNormalDeviation?: number;
  /**
   * Hard edges are chart boundaries and seams (default true): `true` takes edges flagged sharp, a
   * `NormalMode` the edges its shading hardens (`edgeKinds` hard); marked seams always are.
   */
  readonly respectSharp?: boolean | NormalMode;
  /** Per-chart flattening (default 'lscm'). */
  readonly method?: UnwrapMethod;
  /** `'slim'`: SLIM-refine every chart after the flattening, behind the `UnwrapOptions.refine` gate (default off). */
  readonly refine?: 'slim';
  /** Square atlas size in texels for the pack. */
  readonly resolution: number;
  /** Texels between charts in the pack, or `{ mips: k }` (see `PackOptions.padding`). */
  readonly padding: UvPadding;
  /** The uv.pack options of the same names; absent ones keep their uv.pack defaults. */
  readonly pack?: Pick<PackOptions, 'method' | 'rotate' | 'orient' | 'stack' | 'snap' | 'density'>;
  readonly channel?: UvChannel;
  readonly compute?: ComputePolicy;
  readonly budget?: number;
}

/** Session facts a UV job needs: tolerance and the compute policy context. */
export interface UvContext {
  readonly tolerance: number;
  readonly policy: ComputePolicy;
  readonly native?: ComputeBackend;
  readonly signal?: { readonly aborted: boolean };
  readonly budget?: number;
}

/**
 * The job's view of a face subset: a copy holding only `faces`, canonicalized, with
 * a map from each session corner to the job corner it became.
 */
function jobMesh(
  mesh: EditMesh,
  faces: readonly number[],
  prepare: (copy: EditMesh) => void,
): Result<{ bytes: Uint8Array; job: EditMesh; corner: Map<number, number> }, ModelingError> {
  const copy = mesh.clone();
  const keep = new Set(faces);
  for (const f of copy.faces()) if (!keep.has(f)) copy.removeFace(f);
  prepare(copy);
  const { mesh: canonical, faceMap, vertexMap } = copy.compact();
  const bytes = encodeSnapshot(canonical);
  const decoded = decodeSnapshot(bytes);
  if (!decoded.ok) return decoded;
  const job = decoded.value;
  const corner = new Map<number, number>();
  for (const f of faces) {
    const halves = mesh.faceHalves(f);
    const target = job.faceHalves(faceMap[f] as number);
    const first = vertexMap[mesh.hVert[halves[0] as number] as number] as number;
    const offset = target.findIndex((h) => job.hVert[h] === first);
    for (const [i, h] of halves.entries()) {
      corner.set(h, target[(i + offset) % target.length] as number);
    }
  }
  return ok({ bytes, job, corner });
}

function runJob<K extends ComputeJobKind>(
  kind: K,
  bytes: Uint8Array | readonly Uint8Array[],
  params: ComputeJobParams[K],
  context: UvContext,
  options: { readonly compute?: ComputePolicy; readonly budget?: number },
): Result<ComputeJobResult<K>, ModelingError> {
  const budget = options.budget ?? context.budget;
  const inputs = bytes instanceof Uint8Array ? [bytes] : [...bytes];
  return runComputeJob({ kind, inputs, params }, tsUvBackend, {
    policy: options.compute ?? context.policy,
    ...(context.native === undefined ? {} : { native: context.native }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(budget === undefined ? {} : { budget }),
  });
}

/**
 * Soft effect assertion of every uv.* operation: faces whose UV triangles have zero
 * (or inverted) area in the written channel.
 */
function checkWritten(
  mesh: EditMesh,
  faces: readonly number[],
  channel: UvChannel,
  op: string,
  diagnostics: OpDiagnostic[],
  mirrored: ReadonlySet<number> = new Set(),
  reflected: ReadonlySet<number> = new Set(),
): number[] {
  let flat = 0;
  let flipped = 0;
  const reflectedInverted: number[] = [];
  for (const f of faces) {
    const halves = mesh.faceHalves(f);
    const indices = triangulateLoop(halves.map((h) => mesh.position(mesh.hVert[h] as number)));
    if (indices === undefined) continue;
    let zero = false;
    let inverted = false;
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map(
        (k) => mesh.corner(channel, halves[indices[i + k] as number] as number) as Float32Array,
      ) as [Float32Array, Float32Array, Float32Array];
      const turn = orient2d(
        a[0] as number,
        a[1] as number,
        b[0] as number,
        b[1] as number,
        c[0] as number,
        c[1] as number,
      );
      if (turn === 0) zero = true;
      if (turn < 0) inverted = true;
    }
    if (zero) flat++;
    if (reflected.has(f)) {
      if (inverted) reflectedInverted.push(f);
    } else if (inverted !== mirrored.has(f)) flipped++;
  }
  if (flat > 0 || flipped > 0) {
    diagnostics.push({
      severity: 'warn',
      message: `${op}: ${flat} face(s) have zero-area and ${flipped} face(s) inverted UV triangles; add seams or check the faces for slivers`,
      detail: { zeroArea: flat, flipped },
    });
  }
  return reflectedInverted;
}

function summary(report: ComputeJobResult['report']) {
  return {
    backend: report.backend,
    backendIdentity: report.backendIdentity,
    quality: report.quality,
    cacheKey: report.cacheKey,
    metrics: report.metrics,
  };
}

const ISLAND_DETAIL_LIMIT = 32;
/**
 * Area distortion (max of rho, 1 / rho) from which an unwrapped island is reported: a
 * texel density that varies more than 2x along one axis within the island.
 */
const DISTORTION_WARN = 4;
/** Area distortion from which a rectified island is reported: a grid that is not straight. */
const RECTIFY_WARN = 1.25;

/**
 * Unwrap faces per island: islands are cut by seams (and the selection boundary),
 * corners split into UV elements around each vertex, each island is flattened by
 * LSCM (pinned, solved through solve.sparse) or ExpMap, normalized to its 3D area
 * (1 UV unit = 1 m), oriented to its minimal bounding rectangle and laid out side by
 * side. Pack afterwards to fit an atlas.
 */
export function unwrapUv(
  mesh: EditMesh,
  faces: readonly number[],
  options: UnwrapOptions,
  seamEdges: readonly number[],
  context: UvContext,
  diagnostics: OpDiagnostic[],
  start?: 'expmap',
): Result<RoleCounts, ModelingError> {
  const method = options.method ?? 'lscm';
  if (method !== 'lscm' && method !== 'expmap' && method !== 'rectify') {
    return err(
      modelingError('model-invalid-argument', "method is 'lscm', 'expmap' or 'rectify'", {
        method,
      }),
    );
  }
  if (options.refine !== undefined && options.refine !== 'slim') {
    return err(
      modelingError('model-invalid-argument', "refine is 'slim' when given", {
        refine: options.refine,
      }),
    );
  }
  const pins = options.pins ?? 'boundary';
  if (pins !== 'boundary' && pins !== 'extent') {
    return err(modelingError('model-invalid-argument', "pins is 'boundary' or 'extent'", { pins }));
  }
  const channel = options.channel ?? 'uv0';
  const seams = options.seams ?? 'marked';
  const extra = new Set(seamEdges);
  const prepared = jobMesh(mesh, faces, (copy) => {
    copy.channels.clear();
    for (const e of copy.edges()) {
      const flags = copy.eFlags[e] as number;
      const cut =
        (flags & EDGE_SEAM) !== 0 ||
        (seams === 'sharp' && (flags & EDGE_SHARP) !== 0) ||
        extra.has(e);
      copy.eFlags[e] = cut ? EDGE_SEAM : 0;
    }
  });
  if (!prepared.ok) return prepared;
  const { bytes, job, corner } = prepared.value;
  const result = runJob(
    'uv.unwrap',
    bytes,
    {
      method,
      pins,
      tolerance: options.tolerance ?? 1e-9,
      ...(options.maxIterations === undefined ? {} : { maxIterations: options.maxIterations }),
      ...(start === undefined ? {} : { start }),
      ...(options.refine === undefined ? {} : { refine: options.refine }),
    },
    context,
    options,
  );
  if (!result.ok) return result;
  const values = decodeCornerUvs(job, result.value.outputs[0] as Uint8Array);
  for (const [h, target] of corner) mesh.setCorner(channel, h, values.get(target) as number[]);
  checkWritten(mesh, faces, channel, 'uv.unwrap', diagnostics);
  const islands = result.value.provenance.islands;
  const sessionFace = new Map<number, number>();
  for (const [h, target] of corner) {
    const f = mesh.hFace[h] as number;
    const g = job.hFace[target] as number;
    if (!sessionFace.has(g)) sessionFace.set(g, f);
  }
  const firstFace = new Map<number, number>();
  for (const [g, island] of result.value.provenance.faceIsland.entries()) {
    if (!firstFace.has(island)) firstFace.set(island, sessionFace.get(g) as number);
  }
  const distorted = islands
    .map((island, index) => ({ index, face: firstFace.get(index) as number, island }))
    .filter(({ island }) => island.areaDistortion >= DISTORTION_WARN);
  if (distorted.length > 0) {
    diagnostics.push({
      severity: 'warn',
      message: `uv.unwrap: ${distorted.length} island(s) are heavily distorted (area distortion >= ${DISTORTION_WARN}); add seams that shorten them or cut non-developable parts (pockets, bumps) into their own islands`,
      detail: {
        islands: distorted.slice(0, ISLAND_DETAIL_LIMIT).map(({ index, face, island }) => ({
          island: index,
          face,
          faces: island.faces,
          stretchL2: island.stretchL2,
          areaDistortion: island.areaDistortion,
        })),
      },
    });
  }
  if (method === 'rectify') {
    const bent = islands
      .map((island, index) => ({ index, face: firstFace.get(index) as number, island }))
      .filter(({ island }) => island.areaDistortion >= RECTIFY_WARN);
    if (bent.length > 0) {
      diagnostics.push({
        severity: 'warn',
        message: `uv.unwrap (rectify): ${bent.length} island(s) do not develop as straight grids (area distortion >= ${RECTIFY_WARN}); unwrap them with lscm or cut their curved parts off`,
        detail: {
          islands: bent.slice(0, ISLAND_DETAIL_LIMIT).map(({ index, face, island }) => ({
            island: index,
            face,
            areaDistortion: island.areaDistortion,
          })),
        },
      });
    }
  }
  const metrics = result.value.report.metrics;
  if (options.refine !== undefined) {
    const overlapping = islands.filter((island) => (island.overlaps ?? 0) > 0);
    if (overlapping.length > 0) {
      diagnostics.push({
        severity: 'warn',
        message: `uv.unwrap (slim): ${metrics.overlaps as number} triangle pair(s) overlap in UV inside ${overlapping.length} island(s); refinement keeps a layout only when it overlaps no more than its start, so add seams that cut these islands open`,
        detail: {
          overlaps: metrics.overlaps as number,
          islands: overlapping.slice(0, ISLAND_DETAIL_LIMIT).map((island) => ({
            island: islands.indexOf(island),
            face: firstFace.get(islands.indexOf(island)) as number,
            faces: island.faces,
            overlaps: island.overlaps as number,
          })),
        },
      });
    }
  }
  diagnostics.push({
    severity: 'info',
    message: `uv.unwrap (${method}${options.refine === undefined ? '' : ` + ${options.refine} refine: ${metrics.refined as number} refined, ${(metrics.refineRejected as number) + (metrics.refineUnavailable as number)} kept`}) flattened ${islands.length} island(s) on the ${result.value.report.backend} backend (${result.value.report.quality})`,
    detail: {
      ...summary(result.value.report),
      islands: islands.slice(0, ISLAND_DETAIL_LIMIT),
    },
  });
  return ok({ unwrapped: faces.length });
}

/**
 * Pack the UV islands of `faces` (connected components of equal corner values) into
 * one square atlas: optional minimal-rectangle orientation, skyline placement with
 * quarter turns, and a binary search for the largest common scale that fits.
 */
export function packUv(
  mesh: EditMesh,
  faces: readonly number[],
  options: PackOptions,
  context: UvContext,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const passes = options.resolveOverlaps ?? 0;
  if (!Number.isInteger(passes) || passes < 0 || passes > MAX_OVERLAP_PASSES) {
    return err(
      modelingError(
        'model-invalid-argument',
        `resolveOverlaps is an integer in [0, ${MAX_OVERLAP_PASSES}]`,
        { resolveOverlaps: options.resolveOverlaps },
      ),
    );
  }
  if (passes === 0) return packOnce(mesh, faces, options, context, diagnostics);
  const channel = options.channel ?? 'uv0';
  let scratch: OpDiagnostic[] = [];
  let packed = packOnce(mesh, faces, options, context, scratch);
  let pairs = packed.ok ? uvOverlapPairs(mesh, faces, channel) : [];
  const before = scratch.find((d) => d.severity === 'info')?.detail?.metrics as
    | { islands?: number; texelsPerMeter?: number }
    | undefined;
  let used = 0;
  while (packed.ok && pairs.length > 0 && used < passes) {
    used++;
    const split = new Set<number>(pairs.flat());
    const cuts = new Set<number>();
    for (const f of split) for (const h of mesh.faceHalves(f)) cuts.add(h >> 1);
    const flattened = unwrapUv(
      mesh,
      [...split].sort((a, b) => a - b),
      {
        method: 'lscm',
        seams: 'marked',
        ...(options.channel === undefined ? {} : { channel: options.channel }),
        ...(options.compute === undefined ? {} : { compute: options.compute }),
        ...(options.budget === undefined ? {} : { budget: options.budget }),
      },
      [...cuts].sort((a, b) => a - b),
      context,
      [],
    );
    if (!flattened.ok) return flattened;
    scratch = [];
    packed = packOnce(mesh, faces, options, context, scratch);
    pairs = packed.ok ? uvOverlapPairs(mesh, faces, channel) : [];
  }
  if (!packed.ok) return packed;
  for (const d of scratch) {
    diagnostics.push(
      d.severity === 'info'
        ? {
            ...d,
            detail: {
              ...d.detail,
              overlaps: pairs.length,
              overlapPasses: used,
              islandsBefore: before?.islands,
              texelsPerMeterBefore: before?.texelsPerMeter,
            },
          }
        : d,
    );
  }
  if (pairs.length > 0) {
    diagnostics.push({
      severity: 'warn',
      message: `uv.pack: ${pairs.length} triangle pair(s) still overlap in UV after ${used} repair pass(es); raise resolveOverlaps or add seams that cut these faces`,
      detail: {
        overlaps: pairs.length,
        overlapPasses: used,
        faces: pairs.slice(0, ISLAND_DETAIL_LIMIT),
      },
    });
  }
  return packed;
}

/** Most repair passes `resolveOverlaps` accepts. */
const MAX_OVERLAP_PASSES = 8;

function packOnce(
  mesh: EditMesh,
  faces: readonly number[],
  options: PackOptions,
  context: UvContext,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const channel = options.channel ?? 'uv0';
  for (const name of ['resolution', 'padding'] as const) {
    const value = name === 'padding' ? paddingTexels(options.padding) : options.resolution;
    if (!Number.isFinite(value)) {
      return err(
        modelingError(
          'model-invalid-argument',
          name === 'padding'
            ? 'padding is a finite number of texels or { mips: k } with k an integer in [0, 10]'
            : `${name} is a finite number`,
          { [name]: options[name] },
        ),
      );
    }
  }
  for (const f of faces) {
    const h = mesh.faceHalves(f).find((half) => mesh.corner(channel, half) === undefined);
    if (h !== undefined) {
      return err(
        modelingError(
          'model-precondition',
          `every packed face has ${channel}`,
          { face: f, channel },
          'unwrap (m.uv.unwrap) or project (m.uv.project) these faces before packing',
        ),
      );
    }
  }
  const prepare = (source: EditMesh, ids: readonly number[]) =>
    jobMesh(source, ids, (copy) => {
      const values = new Map<number, Float32Array>();
      for (const f of copy.faces()) {
        for (const h of copy.faceHalves(f)) values.set(h, copy.corner(channel, h) as Float32Array);
      }
      copy.channels.clear();
      for (const [h, v] of values) copy.setCorner('uv0', h, v);
      for (const e of copy.edges()) copy.eFlags[e] = 0;
    });
  const prepared = prepare(mesh, faces);
  if (!prepared.ok) return prepared;
  const { bytes, job, corner } = prepared.value;
  const inputs: Uint8Array[] = [];
  let own = 0;
  const sessions = options.with ?? [];
  if (!sessions.some((m) => m.editMesh === mesh)) inputs.push(bytes);
  for (const other of sessions) {
    if (other.editMesh === mesh) {
      own = inputs.length;
      inputs.push(bytes);
      continue;
    }
    const failure = other.poisoned;
    if (failure !== undefined) return err(failure);
    const source = other.editMesh;
    const ids = source.faces();
    const missing = ids.find((f) =>
      source.faceHalves(f).some((h) => source.corner(channel, h) === undefined),
    );
    if (missing !== undefined) {
      return err(
        modelingError(
          'model-precondition',
          `every face of every shared session has ${channel}`,
          { face: missing, channel },
          'unwrap the other sessions before packing them together',
        ),
      );
    }
    const theirs = prepare(source, ids);
    if (!theirs.ok) return theirs;
    inputs.push(theirs.value.bytes);
  }
  const rotate = options.rotate ?? true;
  const density = options.density;
  const parts = partList(density?.parts);
  const result = runJob(
    'uv.pack',
    inputs,
    {
      resolution: options.resolution,
      padding: paddingTexels(options.padding),
      rotate: rotate !== false,
      normalize: options.normalize ?? true,
      ...(options.method === undefined ? {} : { method: options.method }),
      ...(options.orient === undefined ? {} : { orient: options.orient }),
      ...(typeof rotate === 'object' ? { rotateStep: rotate.step } : {}),
      ...(options.stack === undefined ? {} : { stack: options.stack }),
      ...(options.stack === 'mirrored' ? { mirrorTolerance: context.tolerance } : {}),
      ...(options.snap === undefined ? {} : { snap: options.snap }),
      ...(options.groups === undefined ? {} : { groups: options.groups }),
      ...(options.fill === undefined ? {} : { fill: options.fill }),
      ...(options.tiles === undefined
        ? {}
        : {
            tiles: {
              across: options.tiles.across,
              ...(options.tiles.down === undefined ? {} : { down: options.tiles.down }),
              by: options.tiles.by,
              ...(options.tiles.zones === undefined
                ? {}
                : { zones: Object.entries(options.tiles.zones).sort(byTag) }),
            },
          }),
      ...(options.priority === undefined || Object.keys(options.priority).length === 0
        ? {}
        : { priority: Object.entries(options.priority).sort(byTag) }),
      ...(density === undefined
        ? {}
        : {
            density: {
              ...(density.target === undefined ? {} : { target: density.target }),
              tolerance: density.tolerance ?? 0,
              ...(parts === undefined ? {} : { parts }),
            },
          }),
    },
    context,
    options,
  );
  if (!result.ok) return result;
  const values = decodeCornerUvs(job, result.value.outputs[own] as Uint8Array);
  for (const [h, target] of corner) mesh.setCorner(channel, h, values.get(target) as number[]);
  const followers = new Set<number>();
  if (options.stack === 'mirrored') {
    const { faceIsland, placements } = result.value.provenance;
    for (const f of faces) {
      const first = corner.get(mesh.faceHalves(f)[0] as number) as number;
      const island = faceIsland[job.hFace[first] as number] as number;
      if (placements[island]?.mirrored === true) followers.add(f);
    }
  }
  const pairs = mirrorPairs(mesh, faces, context.tolerance);
  const reflected = new Set<number>();
  for (const f of pairs.partner.keys()) if (!followers.has(f)) reflected.add(f);
  const unstacked = checkWritten(
    mesh,
    faces,
    channel,
    'uv.pack',
    diagnostics,
    followers,
    reflected,
  );
  if (unstacked.length > 0) {
    const stacking = options.stack === 'mirrored';
    diagnostics.push({
      severity: 'warn',
      message: `uv.pack: ${unstacked.length} mirrored face(s) carry the reflected UVs of their partner (from uv.plan mirror 'mirrored') but ${
        stacking
          ? `were not stacked on it: ${
              pairs.unpaired.length > 0
                ? `${pairs.unpaired.length} copy face(s) reflect no original face, so the pairing is partial`
                : "its island does not cover the same faces as its partner's island"
            }`
          : "were not stacked, because the pack stacks mirrored islands only with stack 'mirrored'"
      }; the island keeps its own texels and its triangles stay inverted. ${
        stacking
          ? "Repair the copy and re-plan, or plan with mirror 'unique'"
          : "Pack with stack 'mirrored', or plan with mirror 'unique'"
      }`,
      detail: {
        reflectedUnstacked: unstacked.length,
        unpairedCopies: pairs.unpaired.length,
        faces: unstacked.slice(0, ISLAND_DETAIL_LIMIT),
      },
    });
  }
  if (followers.size > 0) {
    const odd = pairs.asymmetric.filter((f) => followers.has(f));
    if (odd.length > 0) {
      diagnostics.push({
        severity: 'warn',
        message: `uv.pack: ${odd.length} mirrored face(s) share texels with a partner that has another material or tag set; give the copy its own island (plan with mirror 'unique') or make the halves equal`,
        detail: {
          faces: odd.slice(0, ISLAND_DETAIL_LIMIT).map((f) => ({
            face: f,
            partner: pairs.partner.get(f)?.face,
          })),
        },
      });
    }
  }
  const table =
    parts === undefined
      ? undefined
      : partTable(job, values, parts, options.resolution, result.value.report.metrics);
  diagnostics.push({
    severity: 'info',
    message: `uv.pack placed ${result.value.provenance.placements.length} island(s) in a ${options.resolution} texel atlas on the ${result.value.report.backend} backend (${result.value.report.quality})`,
    detail: {
      ...summary(result.value.report),
      ...(options.stack === undefined || options.stack === false
        ? {}
        : {
            pairs: result.value.report.metrics.stacked,
            mirroredPairs: result.value.report.metrics.mirrored,
            unpaired: result.value.report.metrics.mirrorUnpaired,
            texelsSaved: Math.round(result.value.report.metrics.texelsSaved ?? 0),
          }),
      ...(table === undefined ? {} : { parts: table.rows }),
    },
  });
  if (table !== undefined) {
    const empty = table.rows.filter((r) => r.part !== null && r.islands === 0).map((r) => r.part);
    if (empty.length > 0) {
      diagnostics.push({
        severity: 'warn',
        message: `uv.pack density parts ${empty.join(', ')} match no island: no face carries the tag`,
        detail: { parts: empty },
      });
    }
    if (table.mixed > 0) {
      diagnostics.push({
        severity: 'warn',
        message: `uv.pack: ${table.mixed} island(s) carry faces of several density parts and take the majority part; cut the part borders as seams (uv.plan tagBorders)`,
        detail: { islands: table.mixed },
      });
    }
  }
  return ok({ packed: faces.length });
}

/** Per-part density rows of a finished pack: the job mesh with the packed corner values measured. */
function partTable(
  job: EditMesh,
  values: ReadonlyMap<number, readonly number[]>,
  parts: PartList,
  resolution: number,
  metrics: Readonly<Record<string, number>>,
) {
  const packed = job.clone();
  for (const f of packed.faces()) {
    for (const h of packed.faceHalves(f)) packed.setCorner('uv0', h, values.get(h) as number[]);
  }
  const measured = measureUv(packed, 'uv0');
  if (!measured.ok) return undefined;
  const found = partDensities(packed, measured.value, parts, resolution);
  const base = metrics.texelsPerUnit ?? 0;
  return {
    mixed: found.mixed,
    rows: found.rows.map((r) => ({
      ...r,
      ratio: base > 0 ? r.texelsPerMeter / base : 0,
    })),
  };
}

export interface StraightenOptions {
  /** Only boundary chains with an edge in the selection (default: every island's boundary). */
  readonly edges?: EdgeSelector;
  /**
   * Degrees (default 20, in (0, 90)): a boundary turn above it is a corner that ends a chain,
   * and a chain whose edges stay within it of the chord between its corners is straightened.
   */
  readonly maxAngle?: number;
  /** An island keeps the result only if its largest stretch grows by at most this factor (default 1.15, >= 1). */
  readonly maxStretch?: number;
  readonly channel?: UvChannel;
  readonly compute?: ComputePolicy;
  readonly budget?: number;
}

/**
 * Straighten the boundary chains of the UV islands of `faces`: each run between corners moves onto
 * the chord between its corners (at its 3D arc-length parameter) and the island interior relaxes
 * by SLIM with the chains held. An island keeps the result only when it stays flip-free, within
 * `maxStretch` of its stretch and no more overlapped; otherwise it keeps its UVs and the verdict is
 * reported. Chains on the selection border (a neighbor outside `faces`) stay put. Islands are not
 * moved or rescaled as a whole: pack afterwards.
 */
export function straightenUv(
  mesh: EditMesh,
  faces: readonly number[],
  options: StraightenOptions,
  edgeIds: readonly number[] | undefined,
  context: UvContext,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const channel = options.channel ?? 'uv0';
  for (const f of faces) {
    const h = mesh.faceHalves(f).find((half) => mesh.corner(channel, half) === undefined);
    if (h !== undefined) {
      return err(
        modelingError(
          'model-precondition',
          `every straightened face has ${channel}`,
          { face: f, channel },
          'unwrap (m.uv.unwrap) or project (m.uv.project) these faces before straightening',
        ),
      );
    }
  }
  const inside = new Set(faces);
  const chosen = edgeIds === undefined ? undefined : new Set(edgeIds);
  const prepared = jobMesh(mesh, faces, (copy) => {
    const values = new Map<number, Float32Array>();
    for (const f of copy.faces()) {
      for (const h of copy.faceHalves(f)) values.set(h, copy.corner(channel, h) as Float32Array);
    }
    copy.channels.clear();
    for (const [h, v] of values) copy.setCorner('uv0', h, v);
    for (const e of copy.edges()) {
      const outside = [e * 2, e * 2 + 1].some((h) => {
        const g = mesh.hFace[h] as number;
        return g !== NONE && !inside.has(g);
      });
      copy.eFlags[e] = (chosen?.has(e) === true ? EDGE_SEAM : 0) | (outside ? EDGE_SHARP : 0);
    }
  });
  if (!prepared.ok) return prepared;
  const { bytes, job, corner } = prepared.value;
  const result = runJob(
    'uv.straighten',
    bytes,
    {
      maxAngle: options.maxAngle ?? 20,
      maxStretch: options.maxStretch ?? 1.15,
      ...(chosen === undefined ? {} : { selected: true }),
    },
    context,
    options,
  );
  if (!result.ok) return result;
  const values = decodeCornerUvs(job, result.value.outputs[0] as Uint8Array);
  for (const [h, target] of corner) mesh.setCorner(channel, h, values.get(target) as number[]);
  checkWritten(mesh, faces, channel, 'uv.straighten', diagnostics);
  const islands = result.value.provenance.islands;
  const metrics = result.value.report.metrics;
  const kept = islands.filter((i) =>
    ['flipped', 'blocked', 'stretch', 'overlap', 'unavailable'].includes(i.status),
  );
  if (kept.length > 0) {
    diagnostics.push({
      severity: 'warn',
      message: `uv.straighten: ${kept.length} island(s) keep their UVs (a straightened layout would fold, stretch beyond maxStretch or overlap more); cut them into smaller islands or raise maxStretch`,
      detail: {
        islands: kept.slice(0, ISLAND_DETAIL_LIMIT).map((island) => ({
          island: islands.indexOf(island),
          faces: island.faces,
          verdict: island.status,
          angleBefore: island.angleBefore,
        })),
      },
    });
  }
  diagnostics.push({
    severity: 'info',
    message: `uv.straighten straightened ${metrics.straightened as number} of ${metrics.chains as number} boundary chain(s) in ${islands.length} island(s) on the ${result.value.report.backend} backend (${result.value.report.quality}); worst remaining chord deviation ${(metrics.maxAngleError as number).toPrecision(3)} degrees`,
    detail: {
      ...summary(result.value.report),
      chains: metrics.chains,
      straightened: metrics.straightened,
      maxAngleError: metrics.maxAngleError,
      verdicts: {
        accepted: metrics.accepted,
        partial: metrics.partial,
        none: metrics.none,
        flipped: metrics.flipped,
        blocked: metrics.blocked,
        stretch: metrics.stretchRejected,
        overlap: metrics.overlapRejected,
        unavailable: metrics.unavailable,
      },
      islands: islands.slice(0, ISLAND_DETAIL_LIMIT),
    },
  });
  return ok({ straightened: metrics.straightened as number });
}

/** Edges an edge selector resolved to, for the unwrap seam source. */
export function seamSelection(
  mesh: EditMesh,
  seams: SeamSource | undefined,
): Result<number[], ModelingError> {
  if (seams === undefined || seams === 'marked' || seams === 'sharp') return ok([]);
  if (typeof seams === 'string' || seams.domain !== 'edge') {
    return err(
      modelingError('model-invalid-argument', "seams is 'marked', 'sharp' or an edge selector", {
        seams: typeof seams === 'string' ? seams : seams.description,
      }),
    );
  }
  return seams.resolve(mesh);
}

/**
 * Edges carrying any of `flags` between two of `faces` whose corner values in `channel`
 * agree on both sides, so no UV island boundary runs along them.
 */
export function crossedEdges(
  mesh: EditMesh,
  faces: readonly number[],
  channel: UvChannel,
  flags: number,
): number {
  const inFaces = new Set(faces);
  const same = (a: number, b: number) => {
    const x = mesh.corner(channel, a);
    const y = mesh.corner(channel, b);
    return x !== undefined && y !== undefined && x.every((v, k) => v === (y[k] as number));
  };
  let crossing = 0;
  for (const f of faces) {
    for (const h of mesh.faceHalves(f)) {
      const t = h ^ 1;
      const g = mesh.hFace[t] as number;
      if (g === NONE || g < f || !inFaces.has(g)) continue;
      if (((mesh.eFlags[h >> 1] as number) & flags) === 0) continue;
      if (same(h, mesh.hNext[t] as number) && same(mesh.hNext[h] as number, t)) crossing++;
    }
  }
  return crossing;
}

/** The latest info diagnostic a UV step pushed, for the auto summary. */
function lastInfo(diagnostics: readonly OpDiagnostic[], from: number) {
  const info = diagnostics
    .slice(from)
    .filter((d) => d.severity === 'info')
    .at(-1);
  return (
    (info?.detail as { metrics?: Readonly<Record<string, number>> } | undefined)?.metrics ?? {}
  );
}

/**
 * Automatic UVs (design 13): charts from the uv.chart job (farthest-point patches merged
 * under distortion and normal limits; marked seams, sharp edges when `respectSharp`
 * and open edges are hard boundaries), cut along chart borders, flattened per chart by
 * uv.unwrap and packed into one atlas by uv.pack. The effect assertion: no chart and
 * no UV island crosses a hard edge.
 */
export function autoUv(
  mesh: EditMesh,
  faces: readonly number[],
  options: AutoUvOptions,
  context: UvContext,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const respectSharp = options.respectSharp === undefined ? true : options.respectSharp;
  if (!isRespectSharp(respectSharp)) {
    return err(
      modelingError('model-invalid-argument', 'respectSharp is a boolean or a NormalMode', {
        respectSharp,
      }),
    );
  }
  const hardMode = typeof respectSharp === 'object' ? respectSharp : undefined;
  for (const name of ['resolution', 'padding'] as const) {
    const value = name === 'padding' ? paddingTexels(options.padding) : options.resolution;
    if (!Number.isFinite(value)) {
      return err(
        modelingError(
          'model-invalid-argument',
          name === 'padding'
            ? 'padding is a finite number of texels or { mips: k } with k an integer in [0, 10]'
            : `${name} is a finite number`,
          { [name]: options[name] },
        ),
      );
    }
  }
  const hardFlags = EDGE_SEAM | (respectSharp === true ? EDGE_SHARP : 0);
  const prepared = jobMesh(mesh, faces, (copy) => {
    copy.channels.clear();
    for (const e of copy.edges()) {
      copy.eFlags[e] = ((copy.eFlags[e] as number) & hardFlags) !== 0 ? EDGE_SEAM : 0;
    }
  });
  if (!prepared.ok) return prepared;
  const { bytes, corner } = prepared.value;
  const charted = runJob(
    'uv.chart',
    bytes,
    {
      maxCharts: options.maxCharts ?? 100,
      maxDistortion: options.maxDistortion ?? 1.5,
      maxNormalDeviation: options.maxNormalDeviation ?? 45,
    },
    context,
    options,
  );
  if (!charted.ok) return charted;
  const cutBytes = charted.value.outputs[0] as Uint8Array;
  const cuts = new Set<number>();
  for (const [h, target] of corner) if (cutBytes[target >> 1] === 1) cuts.add(h >> 1);
  if (hardMode !== undefined) {
    // The one write of a NormalMode's hard edges: they are not mesh flags, so the chart job's cuts
    // do not carry them; unwrap takes them as extra seams.
    const inside = new Set(faces);
    for (const f of faces) {
      for (const h of mesh.faceHalves(f)) {
        const e = h >> 1;
        if (inside.has(mesh.hFace[h ^ 1] as number) && shadingHard(mesh, e, hardMode)) cuts.add(e);
      }
    }
  }
  const start = diagnostics.length;
  const unwrapped = unwrapUv(
    mesh,
    faces,
    {
      method: options.method ?? 'lscm',
      ...(options.refine === undefined ? {} : { refine: options.refine }),
      seams: respectSharp === true ? 'sharp' : 'marked',
      ...(options.channel === undefined ? {} : { channel: options.channel }),
      ...(options.compute === undefined ? {} : { compute: options.compute }),
      ...(options.budget === undefined ? {} : { budget: options.budget }),
    },
    [...cuts].sort((a, b) => a - b),
    context,
    diagnostics,
    'expmap',
  );
  if (!unwrapped.ok) return unwrapped;
  const unwrapMetrics = lastInfo(diagnostics, start);
  const packStart = diagnostics.length;
  const packed = packUv(
    mesh,
    faces,
    {
      ...options.pack,
      resolution: options.resolution,
      padding: options.padding,
      ...(options.channel === undefined ? {} : { channel: options.channel }),
      ...(options.compute === undefined ? {} : { compute: options.compute }),
      ...(options.budget === undefined ? {} : { budget: options.budget }),
    },
    context,
    diagnostics,
  );
  if (!packed.ok) return packed;
  const packMetrics = lastInfo(diagnostics, packStart);
  const crossing = crossedEdges(mesh, faces, options.channel ?? 'uv0', hardFlags);
  if (crossing > 0) {
    return err(
      modelingError(
        'model-op-no-effect',
        'uv.auto cuts every hard edge',
        { edges: crossing },
        'report this mesh: a chart crossed a hard edge',
      ),
    );
  }
  const report = charted.value.report;
  const maxCharts = options.maxCharts ?? 100;
  if ((report.metrics.charts as number) > maxCharts) {
    diagnostics.push({
      severity: 'warn',
      message: `uv.auto made ${report.metrics.charts as number} chart(s), above maxCharts ${maxCharts}: ${report.metrics.components as number} separate part(s) and the distortion limit need them (charts never merge across parts or hard edges); raise maxCharts to silence this`,
      detail: {
        charts: report.metrics.charts as number,
        maxCharts,
        components: report.metrics.components as number,
        splits: report.metrics.splits as number,
      },
    });
  }
  diagnostics.push({
    severity: 'info',
    message: `uv.auto made ${report.metrics.charts as number} chart(s) from ${report.metrics.initialPatches as number} patch(es) (${report.metrics.merges as number} merge(s)) on the ${report.backend} backend (${report.quality})`,
    detail: {
      ...summary(report),
      charts: charted.value.provenance.charts.slice(0, ISLAND_DETAIL_LIMIT),
      unwrap: unwrapMetrics,
      pack: packMetrics,
    },
  });
  return ok({ charted: faces.length });
}

// ---- trim regions: uv.trim and uv.swatch ----------------------------------------

/** How an instance's extent along one region axis becomes UVs. */
export type TrimFit = 'metric' | 'fit' | 'tile';

/** Per-instance variation (clone breaking), all from a deterministic instance hash. */
export interface TrimVariation {
  /** Variant of a family per instance: 'hash' (default when the family has variants) or an index. */
  readonly variant?: 'hash' | number;
  /** Quarter turns in region space: 'hash' or 0 / 90 / 180 / 270 (90 and 270 on square cells only). */
  readonly rotate?: 'hash' | 0 | 90 | 180 | 270;
  /** Mirror along u: 'hash' or fixed. Mirrored UVs flip the tangent sign; export splits their vertices. */
  readonly mirror?: 'hash' | boolean;
  /** Strips: start each instance at a whole-period phase picked by the hash. */
  readonly phase?: 'hash';
  /** Seed of the instance hash (default 0). */
  readonly seed?: number;
  /**
   * Write the instance hash in [0, 1) into the corner color alpha, the per-instance
   * variation lane a material reads for tint or wear (default false). One documented
   * lane until the surface contract names its mask targets.
   */
  readonly hashTo?: boolean;
}

export interface TrimUvOptions {
  /**
   * A region of a `trimSheet`, or a family (`sheet.families.<id>`): each instance then
   * takes the scale bucket nearest its size and a variant.
   */
  readonly region: TrimRegion | readonly TrimRegion[];
  /**
   * World direction that runs along the region's u (projected into each instance's
   * plane), or 'longest' (default): the long side of the instance's minimal rectangle.
   */
  readonly axis?: 'longest' | Tuple3;
  /**
   * Per region axis: 'metric' keeps meters (the region's texel density; the instance
   * must fit), 'fit' stretches the instance over the region, 'tile' (u of a 'u' strip
   * only) keeps meters and repeats past the region. Default u: 'tile' on a strip, else
   * 'metric'; v: 'metric'.
   */
  readonly fit?: { readonly u?: TrimFit; readonly v?: Exclude<TrimFit, 'tile'> };
  /** Meters added along u and v before mapping (a phase for tiling, a position in a larger cell). */
  readonly offset?: readonly [number, number];
  /** Where u and v start: each instance's own minimum (default 'instance') or the world origin's projection ('world', continuous tiling across instances). */
  readonly anchor?: 'instance' | 'world';
  /**
   * Instances are face runs connected across edges that are not seams or sharp and turn
   * by at most this many degrees (default 30, the hard-edge rule).
   */
  readonly split?: number;
  readonly variation?: TrimVariation;
  /** Relative density deviation from the region above which instances are warned about (default 0.1). */
  readonly tolerance?: number;
  readonly channel?: UvChannel;
}

export interface SwatchUvOptions {
  readonly region: TrimRegion;
  readonly channel?: UvChannel;
}

/** Relative extent overshoot a 'metric' axis still accepts (float noise of exact fits). */
const FIT_SLACK = 1e-6;
/** Relative difference of measured and planned texel density that reveals a non-planar instance. */
const PROJECTION_WARN = 0.02;

function checkRegion(region: TrimRegion): Result<TrimRegion, ModelingError> {
  const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const ok4 = (a: unknown) => Array.isArray(a) && a.length === 4 && a.every(finite);
  const ok2 = (a: unknown) =>
    Array.isArray(a) && a.length === 2 && a.every((v) => finite(v) && (v as number) > 0);
  if (
    typeof region !== 'object' ||
    region === null ||
    !ok4(region.rect) ||
    !ok4(region.uv) ||
    !ok2(region.size) ||
    !ok2(region.density) ||
    (region.tiling !== 'none' && region.tiling !== 'u') ||
    !(finite(region.scale) && region.scale > 0) ||
    !(finite(region.inset) && region.inset >= 0) ||
    !(Number.isInteger(region.variant) && region.variant >= 0) ||
    !(Number.isInteger(region.resolution) && region.resolution > 0)
  ) {
    return err(
      modelingError(
        'model-invalid-argument',
        'region is a TrimRegion from trimSheet',
        { region: typeof region === 'object' && region !== null ? region.id : region },
        'pass sheet.regions.<id> of a trimSheet result',
      ),
    );
  }
  return ok(region);
}

/**
 * Instances: faces connected across shared edges that are neither seams nor sharp and
 * whose normals turn by at most `split` degrees, in order of their lowest face.
 */
function components(mesh: EditMesh, faces: readonly number[], split: number): number[][] {
  const local = new Map<number, number>();
  for (const f of faces) local.set(f, local.size);
  const normals = new Map<number, Tuple3>();
  for (const f of faces) {
    normals.set(f, normalize(newell(mesh.faceVertices(f).map((v) => mesh.position(v) as Tuple3))));
  }
  const limit = cos((split * Math.PI) / 180);
  const sets = new UnionFind(faces.length);
  for (const f of faces) {
    for (const h of mesh.faceHalves(f)) {
      const other = mesh.hFace[h ^ 1] as number;
      const g = local.get(other);
      if (g === undefined || ((mesh.eFlags[h >> 1] as number) & (EDGE_SEAM | EDGE_SHARP)) !== 0) {
        continue;
      }
      if (dot(normals.get(f) as Tuple3, normals.get(other) as Tuple3) < limit) continue;
      sets.union(local.get(f) as number, g);
    }
  }
  const groups = new Map<number, number[]>();
  for (const f of [...faces].sort((a, b) => a - b)) {
    const root = sets.find(local.get(f) as number);
    const group = groups.get(root);
    if (group === undefined) groups.set(root, [f]);
    else group.push(f);
  }
  return [...groups.values()];
}

/** An orthonormal pair spanning the plane of unit `n`. */
function planeBasis(n: Tuple3): [Tuple3, Tuple3] {
  const helper: Tuple3 =
    Math.abs(n[0]) <= Math.abs(n[1]) && Math.abs(n[0]) <= Math.abs(n[2])
      ? [1, 0, 0]
      : Math.abs(n[1]) <= Math.abs(n[2])
        ? [0, 1, 0]
        : [0, 0, 1];
  const e1 = normalize(cross(helper, n));
  return [e1, cross(n, e1)];
}

/** The direction or its opposite, whichever has a positive largest component. */
function canonicalSign(d: Tuple3): Tuple3 {
  let k = 0;
  for (let i = 1; i < 3; i++)
    if (Math.abs(d[i] as number) > Math.abs(d[k] as number) + 1e-12) k = i;
  return (d[k] as number) < 0 ? [-d[0], -d[1], -d[2]] : d;
}

interface InstanceFrame {
  readonly n: Tuple3;
  readonly s: Tuple3;
  readonly t: Tuple3;
}

/**
 * The instance's plane frame: area-weighted normal, s along `axis` (or the long side of
 * the minimal rectangle) and t = n x s, so (s, t) maps to (u, v) without mirroring.
 */
function instanceFrame(
  mesh: EditMesh,
  faces: readonly number[],
  axis: 'longest' | Tuple3,
): Result<InstanceFrame, ModelingError> {
  const sum: Tuple3 = [0, 0, 0];
  for (const f of faces) {
    const a = newell(mesh.faceVertices(f).map((v) => mesh.position(v) as Tuple3));
    sum[0] += a[0];
    sum[1] += a[1];
    sum[2] += a[2];
  }
  if (!(length(sum) > 0)) {
    return err(
      modelingError('model-degenerate', 'every trimmed instance has a positive area', {
        face: faces[0],
      }),
    );
  }
  const n = normalize(sum);
  let s: Tuple3;
  if (axis === 'longest') {
    const [e1, e2] = planeBasis(n);
    const vertices = [...new Set(faces.flatMap((f) => mesh.faceVertices(f)))];
    const d = orientation(
      vertices.map((v) => {
        const p = mesh.position(v) as Tuple3;
        return [dot(p, e1), dot(p, e2)];
      }),
    );
    s = canonicalSign(
      normalize([
        d[0] * e1[0] + d[1] * e2[0],
        d[0] * e1[1] + d[1] * e2[1],
        d[0] * e1[2] + d[1] * e2[2],
      ]),
    );
  } else {
    const along = sub(axis, [n[0] * dot(axis, n), n[1] * dot(axis, n), n[2] * dot(axis, n)]);
    if (!(length(along) > 1e-6 * Math.max(1, length(axis)))) {
      return err(
        modelingError(
          'model-invalid-argument',
          "axis has a component in every trimmed instance's plane",
          { face: faces[0], axis, normal: n },
          "use axis: 'longest' for instances that face along the axis",
        ),
      );
    }
    s = normalize(along);
  }
  return ok({ n, s, t: cross(n, s) });
}

interface AxisMap {
  readonly lo: number;
  readonly scale: number;
  readonly start: number;
}

/**
 * One region axis: coordinate c -> region fraction (c - lo) * scale + start. Returns
 * the texel density factor relative to the region (1 for metric and tile).
 */
function axisMap(
  fit: TrimFit,
  lo: number,
  hi: number,
  regionLength: number,
  offset: number,
  anchorAtWorld: boolean,
  name: 'u' | 'v',
  face: number,
): Result<AxisMap & { readonly factor: number }, ModelingError> {
  const extent = hi - lo;
  if (fit === 'fit') {
    if (!(extent > 0)) {
      return err(
        modelingError('model-degenerate', `every instance has an extent along ${name}`, { face }),
      );
    }
    return ok({ lo, scale: 1 / extent, start: 0, factor: regionLength / extent });
  }
  const origin = anchorAtWorld ? 0 : lo;
  if (
    fit === 'metric' &&
    (lo - origin + offset < -FIT_SLACK * regionLength ||
      hi - origin + offset > regionLength * (1 + FIT_SLACK))
  ) {
    return err(
      modelingError(
        'model-precondition',
        `every instance fits the region along ${name} at its texel density`,
        { face, extent, offset, regionLength },
        `use fit: { ${name}: 'fit' } to stretch, a 'u' strip to tile, or split the faces at the region length`,
      ),
    );
  }
  return ok({ lo: origin, scale: 1 / regionLength, start: offset / regionLength, factor: 1 });
}

/** 32-bit integer mix (Murmur3 finalizer style), exact in every realm. */
function mix(h: number, v: number): number {
  let x = Math.imul((h ^ v) >>> 0, 0x9e3779b1);
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  return (x ^ (x >>> 13)) >>> 0;
}

/** Hash in [0, 1) of an instance: its vertex centroid quantized to 0.1 mm, the seed and a stream. */
function instanceHash(c: Tuple3, seed: number, stream: number): number {
  let h = mix(seed >>> 0, stream);
  for (const v of c) h = mix(h, Math.round(v * 1e4) | 0);
  return h / 4294967296;
}

/** The members of a region or family argument, checked to share one sheet and family. */
function familyOf(
  region: TrimRegion | readonly TrimRegion[],
): Result<readonly TrimRegion[], ModelingError> {
  const list = Array.isArray(region) ? (region as readonly TrimRegion[]) : [region as TrimRegion];
  if (list.length === 0) {
    return err(modelingError('model-invalid-argument', 'a region family has members', {}));
  }
  for (const r of list) {
    const checked = checkRegion(r);
    if (!checked.ok) return checked;
  }
  const first = list[0] as TrimRegion;
  const base = (r: TrimRegion) => [r.size[0] / r.scale, r.size[1] / r.scale];
  for (const r of list) {
    const [s0, t0] = base(r) as [number, number];
    const [s1, t1] = base(first) as [number, number];
    if (
      r.sheet !== first.sheet ||
      r.family !== first.family ||
      Math.abs(s0 / s1 - 1) > 1e-9 ||
      Math.abs(t0 / t1 - 1) > 1e-9
    ) {
      return err(
        modelingError(
          'model-invalid-argument',
          'a region list is one family of one sheet (sheet.families.<id>)',
          { regions: list.map((x) => x.id) },
        ),
      );
    }
  }
  return ok(list);
}

/**
 * Map faces into a trim region or family: each connected instance is
 * projected onto its own plane frame, takes the family's bucket nearest its size and a
 * variant, and is laid into that region per axis (metric, fit or tile), with optional
 * per-instance rotation, mirroring, phase and hash channel. The info diagnostic
 * reports instances and texel density against the regions; warnings report density
 * deviation above `tolerance` and non-planar instances.
 */
export function trimUv(
  mesh: EditMesh,
  faces: readonly number[],
  options: TrimUvOptions,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const family = familyOf(options.region);
  if (!family.ok) return family;
  const members = family.value;
  const head = members[0] as TrimRegion;
  const channel = options.channel ?? 'uv0';
  const axis = options.axis ?? 'longest';
  if (
    axis !== 'longest' &&
    !(Array.isArray(axis) && axis.length === 3 && axis.every((v) => Number.isFinite(v)))
  ) {
    return err(
      modelingError('model-invalid-argument', "axis is 'longest' or a world direction [x, y, z]", {
        axis,
      }),
    );
  }
  const buckets = [...new Set(members.map((r) => r.scale))].sort((a, b) => a - b);
  const sized = buckets.length > 1;
  const fitU = options.fit?.u ?? (head.tiling === 'u' ? 'tile' : sized ? 'fit' : 'metric');
  const fitV = options.fit?.v ?? (sized ? 'fit' : 'metric');
  if (!['metric', 'fit', 'tile'].includes(fitU) || !['metric', 'fit'].includes(fitV)) {
    return err(
      modelingError(
        'model-invalid-argument',
        "fit.u is 'metric', 'fit' or 'tile'; fit.v is 'metric' or 'fit'",
        { fit: options.fit },
      ),
    );
  }
  if (fitU === 'tile' && head.tiling !== 'u') {
    return err(
      modelingError(
        'model-invalid-argument',
        "fit.u 'tile' maps into a region with tiling 'u'",
        { region: head.id, tiling: head.tiling },
        "declare the module with tiling: 'u' (a strip across the sheet), or use 'metric' / 'fit'",
      ),
    );
  }
  const offset = options.offset ?? [0, 0];
  if (!(offset.length === 2 && offset.every((v) => Number.isFinite(v)))) {
    return err(modelingError('model-invalid-argument', 'offset is [u, v] in meters', { offset }));
  }
  const anchor = options.anchor ?? 'instance';
  if (anchor !== 'instance' && anchor !== 'world') {
    return err(
      modelingError('model-invalid-argument', "anchor is 'instance' or 'world'", { anchor }),
    );
  }
  const split = options.split ?? 30;
  if (!(Number.isFinite(split) && split >= 0 && split <= 180)) {
    return err(
      modelingError('model-invalid-argument', 'split is an angle in [0, 180] degrees', { split }),
    );
  }
  const inset = head.inset;
  const tolerance = options.tolerance ?? 0.1;
  if (!(Number.isFinite(tolerance) && tolerance >= 0)) {
    return err(
      modelingError('model-invalid-argument', 'tolerance is a fraction >= 0', { tolerance }),
    );
  }
  const variation = options.variation ?? {};
  const seed = variation.seed ?? 0;
  const variantCount = maxOf(members.map((r) => r.variant)) + 1;
  const variant = variation.variant ?? (variantCount > 1 ? 'hash' : 0);
  const rotate = variation.rotate ?? 0;
  const mirror = variation.mirror ?? false;
  const square = members.every((r) => r.rect[2] === r.rect[3]);
  if (
    !(
      variant === 'hash' ||
      (Number.isInteger(variant) && variant >= 0 && variant < variantCount)
    ) ||
    !(rotate === 'hash' || [0, 90, 180, 270].includes(rotate)) ||
    !(mirror === 'hash' || typeof mirror === 'boolean') ||
    !(variation.phase === undefined || variation.phase === 'hash') ||
    !Number.isInteger(seed) ||
    !(variation.hashTo === undefined || typeof variation.hashTo === 'boolean')
  ) {
    return err(
      modelingError(
        'model-invalid-argument',
        'variation is { variant: hash | index < variants, rotate: hash | 0 | 90 | 180 | 270, mirror: hash | boolean, phase: hash, seed: integer, hashTo: boolean }',
        { variation, variants: variantCount },
      ),
    );
  }
  if ((rotate === 90 || rotate === 270) && (!square || fitU === 'tile')) {
    return err(
      modelingError(
        'model-invalid-argument',
        'quarter turns map into square cells',
        { rotate, region: head.id },
        "use rotate: 180 or 'hash' (which keeps to half turns on non-square regions)",
      ),
    );
  }
  const baseSize = [head.size[0] / head.scale, head.size[1] / head.scale] as const;
  const writes: [number, [number, number]][] = [];
  const colors: [number, number][] = [];
  const mirroredFaces = new Set<number>();
  const used = new Set<string>();
  const reports: {
    face: number;
    faces: number;
    region: string;
    densityU: number;
    densityV: number;
    deviation: number;
    projectionError: number;
    turn: number;
    mirrored: boolean;
  }[] = [];
  for (const group of components(mesh, faces, split)) {
    const first = group[0] as number;
    const frame = instanceFrame(mesh, group, axis);
    if (!frame.ok) return frame;
    const { s, t } = frame.value;
    const coords = new Map<number, [number, number]>();
    const centroid: Tuple3 = [0, 0, 0];
    let [a0, a1, b0, b1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const f of group) {
      for (const v of mesh.faceVertices(f)) {
        if (coords.has(v)) continue;
        const p = mesh.position(v) as Tuple3;
        const ab: [number, number] = [dot(p, s), dot(p, t)];
        coords.set(v, ab);
        for (let k = 0; k < 3; k++) centroid[k] = (centroid[k] as number) + (p[k] as number);
        a0 = Math.min(a0, ab[0]);
        a1 = Math.max(a1, ab[0]);
        b0 = Math.min(b0, ab[1]);
        b1 = Math.max(b1, ab[1]);
      }
    }
    for (let k = 0; k < 3; k++) centroid[k] = (centroid[k] as number) / coords.size;
    const hash = (stream: number) => instanceHash(centroid, seed, stream);
    const k = Math.sqrt(((a1 - a0) * (b1 - b0)) / (baseSize[0] * baseSize[1]));
    const ratio = (b: number) => (k > 0 ? Math.max(k / b, b / k) : b);
    const bucket = buckets.reduce(
      (best, b) => (ratio(b) < ratio(best) ? b : best),
      buckets[0] as number,
    );
    const candidates = members
      .filter((r) => r.scale === bucket)
      .sort((a, b) => a.variant - b.variant);
    const pick =
      variant === 'hash'
        ? Math.floor(hash(1) * candidates.length)
        : Math.min(variant, candidates.length - 1);
    const region = candidates[pick] as TrimRegion;
    used.add(region.id);
    const [x, y, w, h] = region.rect as [number, number, number, number];
    const res = region.resolution;
    const iu = fitU === 'tile' ? 0 : inset;
    if (2 * iu >= w || 2 * inset >= h) {
      return err(
        modelingError('model-invalid-argument', 'inset leaves part of the region', {
          inset,
          rect: region.rect,
        }),
      );
    }
    const [u0, v0, u1, v1] = [
      (x + iu) / res,
      (y + inset) / res,
      (x + w - iu) / res,
      (y + h - inset) / res,
    ];
    const [lengthU, lengthV] = region.size as [number, number];
    const [densityU, densityV] = region.density as [number, number];
    const world = anchor === 'world';
    let startU = offset[0] as number;
    if (variation.phase === 'hash' && fitU === 'tile' && region.period !== undefined) {
      const repeats = Math.round(lengthU / region.period);
      startU += Math.floor(hash(2) * repeats) * region.period;
    }
    const mu = axisMap(fitU, a0, a1, lengthU, startU, world && fitU !== 'fit', 'u', first);
    if (!mu.ok) return mu;
    const mv = axisMap(
      fitV,
      b0,
      b1,
      lengthV,
      offset[1] as number,
      world && fitV !== 'fit',
      'v',
      first,
    );
    if (!mv.ok) return mv;
    const mirrored = mirror === 'hash' ? hash(3) < 0.5 : mirror;
    const turns =
      fitU === 'tile' ? [0, 180] : region.rect[2] === region.rect[3] ? [0, 90, 180, 270] : [0, 180];
    const turn =
      rotate === 'hash'
        ? (turns[Math.floor(hash(4) * turns.length)] as number)
        : fitU === 'tile'
          ? 0
          : rotate;
    const place = (ab: readonly [number, number]): [number, number] => {
      let x = (ab[0] - mu.value.lo) * mu.value.scale + mu.value.start;
      let y = (ab[1] - mv.value.lo) * mv.value.scale + mv.value.start;
      if (mirrored) x = fitU === 'tile' ? -x : 1 - x;
      if (turn === 90) [x, y] = [1 - y, x];
      else if (turn === 180) [x, y] = fitU === 'tile' ? [-x, 1 - y] : [1 - x, 1 - y];
      else if (turn === 270) [x, y] = [y, 1 - x];
      return [u0 + x * (u1 - u0), v0 + y * (v1 - v0)];
    };
    let area3d = 0;
    let areaUv = 0;
    const tint = variation.hashTo === true ? hash(5) : undefined;
    for (const f of group) {
      const halves = mesh.faceHalves(f);
      const uvs = halves.map((h) => place(coords.get(mesh.hVert[h] as number) as [number, number]));
      for (const [i, h] of halves.entries()) {
        writes.push([h, uvs[i] as [number, number]]);
        if (tint !== undefined) colors.push([h, tint]);
      }
      if (mirrored) mirroredFaces.add(f);
      area3d += length(newell(mesh.faceVertices(f).map((v) => mesh.position(v) as Tuple3))) / 2;
      let twice = 0;
      for (let i = 0; i < uvs.length; i++) {
        const p = uvs[i] as [number, number];
        const q = uvs[(i + 1) % uvs.length] as [number, number];
        twice += p[0] * q[1] - q[0] * p[1];
      }
      areaUv += Math.abs(twice) / 2;
    }
    const du = ((w - 2 * iu) / lengthU) * mu.value.factor;
    const dv = ((h - 2 * inset) / lengthV) * mv.value.factor;
    const nominal = (densityU + densityV) / 2;
    const measured =
      area3d > 0 ? Math.sqrt((areaUv * region.resolution * region.resolution) / area3d) : 0;
    reports.push({
      face: first,
      faces: group.length,
      region: region.id,
      densityU: du,
      densityV: dv,
      deviation: Math.max(Math.abs(du / nominal - 1), Math.abs(dv / nominal - 1)),
      projectionError: Math.abs(measured / Math.sqrt(du * dv) - 1),
      turn,
      mirrored,
    });
  }
  for (const [h, uv] of writes) mesh.setCorner(channel, h, uv);
  for (const [h, value] of colors) {
    const color = Array.from(mesh.corner('color', h) ?? [1, 1, 1, 1]);
    color[3] = value;
    mesh.setCorner('color', h, color);
  }
  checkWritten(mesh, faces, channel, 'uv.trim', diagnostics, mirroredFaces);
  const deviating = reports.filter((r) => r.deviation > tolerance);
  if (deviating.length > 0) {
    diagnostics.push({
      severity: 'warn',
      message: `uv.trim: ${deviating.length} instance(s) deviate more than ${Math.round(tolerance * 100)}% from their region's texel density; map them metric, or declare a region (or scale bucket) at their size`,
      detail: { instances: deviating.slice(0, ISLAND_DETAIL_LIMIT) },
    });
  }
  const bent = reports.filter((r) => r.projectionError > PROJECTION_WARN);
  if (bent.length > 0) {
    diagnostics.push({
      severity: 'warn',
      message: `uv.trim: ${bent.length} instance(s) are not planar, so the planar projection stretches them; trim each flat face run separately`,
      detail: { instances: bent.slice(0, ISLAND_DETAIL_LIMIT) },
    });
  }
  const densities = reports.flatMap((r) => [r.densityU, r.densityV]);
  diagnostics.push({
    severity: 'info',
    message: `uv.trim mapped ${reports.length} instance(s) into ${used.size} region(s) of ${head.family} on sheet ${head.sheet}`,
    detail: {
      region: head.id,
      family: head.family,
      sheet: head.sheet,
      metrics: {
        instances: reports.length,
        faces: faces.length,
        regionsUsed: used.size,
        regionDensity: (head.density[0] + head.density[1]) / 2,
        densityMin: minOf(densities),
        densityMax: maxOf(densities),
        densityDeviation: Math.max(0, maxOf(reports.map((r) => r.deviation))),
        projectionError: Math.max(0, maxOf(reports.map((r) => r.projectionError))),
        mirrored: reports.filter((r) => r.mirrored).length,
        turned: reports.filter((r) => r.turn !== 0).length,
      },
      instances: reports.slice(0, ISLAND_DETAIL_LIMIT),
    },
  });
  return ok({ trimmed: faces.length });
}

/**
 * Map every face on its own into a region's interior, kept `inset` texels clear of the
 * border: the face samples the region alone, so a flat color swatch
 * colors it exactly.
 */
export function swatchUv(
  mesh: EditMesh,
  faces: readonly number[],
  options: SwatchUvOptions,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const checked = checkRegion(options.region);
  if (!checked.ok) return checked;
  const region = checked.value;
  const inset = region.inset;
  const channel = options.channel ?? 'uv0';
  const cell: TrimRegion = { ...region, tiling: 'none' };
  for (const f of faces) {
    const scratch: OpDiagnostic[] = [];
    const mapped = trimUv(
      mesh,
      [f],
      { region: cell, fit: { u: 'fit', v: 'fit' }, channel },
      scratch,
    );
    if (!mapped.ok) return mapped;
  }
  checkWritten(mesh, faces, channel, 'uv.swatch', diagnostics);
  diagnostics.push({
    severity: 'info',
    message: `uv.swatch mapped ${faces.length} face(s) into region ${region.id} of sheet ${region.sheet}`,
    detail: { region: region.id, sheet: region.sheet, metrics: { faces: faces.length, inset } },
  });
  return ok({ swatched: faces.length });
}
