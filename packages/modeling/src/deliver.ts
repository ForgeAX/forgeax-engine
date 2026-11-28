// One call from a fine exact (B-rep) source to a game asset for a named output profile: per-part quads (the mesher route
// is chosen here), material assignment, seams along the B-rep creases, unwrap, mip-safe pack, and the measured verdict.
// The exact stage is injected (`options.exact`), so this module never reaches the B-rep bundle.
import type { MeshAsset, TextureAsset } from '@forgeax/engine-types';
import { err, ok, type Result } from '@forgeax/engine-types';
import { minOf, pushAll } from './arrays';
import {
  ASSET_OUTPUT_PROFILES,
  type AssetBudgetCode,
  type AssetOutputProfile,
  type AssetOutputProfileId,
  type AssetStats,
  assetStats,
  checkAssetBudget,
  textureBytes,
} from './asset-budget';
import { type BakeResult, bakeMaps } from './bake';
import type { QuadOptions, QuadResult } from './brep/quad';
import type { Shape } from './brep/types';
import type { BakeGroupReport } from './compute/job';
import { measureUv } from './compute/uv-ts';
import { encodeSnapshot } from './fxem';
import { lodTopologyReport } from './lod-topology';
import type { EditMesh } from './mesh';
import { type ExactStage, type Model, model } from './model';
import type { Issue } from './report';
import { sel } from './selectors';
import { encodeSrgb } from './texture';
import { defaultProtectMip, paddingTexels } from './uv';
import { uvOverlapPairs } from './uv-overlap';
import { checkSize, faceOwners, texture } from './uv-textures';

export type DeliveryErrorCode =
  | 'delivery-invalid-argument'
  | 'delivery-part-refused'
  | 'delivery-no-size-fits'
  | 'delivery-kernel-failed';

/** Expected failure of a delivery: a value, never a throw. `detail` narrows per code (see each emitter). */
export interface DeliveryError {
  readonly code: DeliveryErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export const DELIVERY_ERROR_HINTS: Readonly<Record<DeliveryErrorCode, string>> = {
  'delivery-invalid-argument':
    'pass a non-empty source with unique part names, an exact stage and positive sizes',
  'delivery-part-refused':
    'every mesher route refused this part; read detail.tried, then simplify the part or split it into analytic faces',
  'delivery-no-size-fits':
    'no quad size meets the profile budget; detail.attempts lists each size with its issue codes, so add a coarser size or a lighter profile',
  'delivery-kernel-failed':
    'a modeling operation of the delivery failed; detail.step and detail.cause name it',
};

export interface DeliveryPart {
  readonly name: string;
  readonly shape: Shape;
  /** Source material slot; parts with the same slot share one material. */
  readonly material: string;
}

export interface DeliverySource {
  readonly parts: readonly DeliveryPart[];
}

export interface DeliverBake {
  /** Texture size of each baked map (square); an unusable size is refused by the kernel and reported as data. */
  readonly resolution: number;
  /** Maps baked from the detail onto the base: `normal` is tangent-space, `ao` is occlusion. */
  readonly maps: readonly ('normal' | 'ao')[];
}

export interface DeliverOptions {
  /** The exact stage, injected as `model({ exact })` is: `await import('@forgeax/engine-modeling/brep')`. */
  readonly exact: ExactStage;
  /** Quad sizes tried in order; the first whose verdict passes is delivered. Required: no hidden quality default. */
  readonly sizes: readonly number[];
  /** Source material slot -> output slot, applied before unwrap. */
  readonly merge?: Readonly<Record<string, string>>;
  /** Quad size of the bake detail; default `min(sizes) / 2.5`, so the detail stays finer than every output. */
  readonly detailSize?: number;
  /** Bake the detail onto the delivered base, one bake group per part. Omitted: no bake and no textures. */
  readonly bake?: DeliverBake;
  /** Coarser quad sizes for LOD1..n, each larger than the delivered size; each LOD is re-built with the same seams. */
  readonly lods?: readonly number[];
  /**
   * Base-colour atlas over the delivered UV layout: each texel takes the linear colour of the source slot
   * of its face, so a merged output slot keeps every source colour. Every source slot used by a part
   * needs a colour; the atlas is `textures.albedo` and is independent of `bake`.
   */
  readonly albedo?: AlbedoAtlas;
}

export interface AlbedoAtlas {
  /** Square texture side in texels (an integer in the texture kernel's range). */
  readonly size: number;
  /** Linear RGB per source material slot (before `merge`). */
  readonly colors: Readonly<Record<string, readonly [number, number, number]>>;
}

export type DeliveryStep =
  | 'quad'
  | 'assign'
  | 'seams'
  | 'unwrap'
  | 'pack'
  | 'bake'
  | 'atlas'
  | 'lod'
  | 'budget';

/**
 * The bake of the delivered base against its detail. A failing bake is data: `pass` is false and the flat asset still
 * ships. `refusal` is set only when the kernel refused before producing maps.
 */
export interface DeliveryBakeReport {
  readonly maps: DeliverBake['maps'];
  readonly detailSize: number;
  /** Measured RGBA8 bytes (with mips) of the textures the bake produced; 0 when it refused. */
  readonly bytes: number;
  readonly pass: boolean;
  readonly issues: BakeResult['issues'];
  readonly groups: readonly BakeGroupReport[];
  /** The base frame normals the bake used; the delivered mesh is exported with the same mode. */
  readonly baseNormals: typeof BASE_CREASE_NORMALS;
  readonly refusal?: { readonly code: string; readonly expected: string; readonly hint: string };
}

export interface DeliveryStepReport {
  readonly step: DeliveryStep;
  readonly status: 'ok' | 'skipped' | 'failed';
  readonly detail: Readonly<Record<string, unknown>>;
}

/** One size of the search: its measured counts and the issue codes its verdict raised. */
export interface DeliveryAttempt {
  readonly size: number;
  readonly triangles: number;
  readonly vertices: number;
  readonly materials: number;
  readonly issues: readonly AssetBudgetCode[];
}

export interface DeliveryReport {
  readonly profile: string;
  readonly size: number;
  readonly attempts: readonly DeliveryAttempt[];
  readonly stats: AssetStats;
  /** A delivered asset always passes its budget; a failing verdict is `delivery-no-size-fits`. */
  readonly budget: { readonly ok: true; readonly issues: readonly Issue<AssetBudgetCode>[] };
  readonly uv: {
    readonly islands: number;
    readonly coverage: number;
    readonly exactOverlapPairs: number;
    readonly paddingTexels: number;
  };
  readonly steps: readonly DeliveryStepReport[];
  /** Present when the call requested a bake. */
  readonly bake?: DeliveryBakeReport;
}

export interface DeliveredAsset {
  readonly mesh: MeshAsset;
  /**
   * The session that produced the base `mesh`, in its final state (tags, UV and
   * packed layout after overlap repair). Base level only: LODs are assets, not
   * sessions. Use it for reading and inspection; editing it after delivery does
   * not change `mesh`.
   */
  readonly model: Model;
  /** LOD1..n, coarser than `mesh` in the order requested; empty unless `lods` was given. */
  readonly lods: readonly MeshAsset[];
  /** Baked maps of the delivered base; empty unless a bake was requested and produced them. */
  readonly textures: BakeResult['textures'] & { readonly albedo?: TextureAsset };
  readonly report: DeliveryReport;
}

const QUAD_MODES = ['iso', 'quad-dominant', 'blossom-row', 'split-3'] as const;
type QuadMode = (typeof QUAD_MODES)[number];

/** Texture size the atlas padding protects; a bake changes it in a later step. */
const PACK_RESOLUTION = 1024;
/** The gutter the packer reserves around every chart; the only texels a bake may fill past a chart. */
const ATLAS_PADDING = { mips: defaultProtectMip(PACK_RESOLUTION) } as const;
/**
 * Pack repair passes. The layout leaves exact UV overlap pairs where the unwrap touches two faces of one
 * island; rotation and scale turn the touch into a crossing. Measured on the blaster (mobile-hero): 0 passes
 * leave 15 pairs, 1 pass leaves 1, 2 passes leave 0; the repair adds 58 vertices and no triangles.
 */
const OVERLAP_REPAIR_PASSES = 2;
const ASSET_PART = 'asset';
/** Face tag prefix of a bake group: every part is its own group, so no ray crosses into a neighbouring part. */
const BAKE_GROUP_PREFIX = 'bake:';
/**
 * Low-poly normals split at creases above 30 degrees. Used both for the exported mesh and the bake base frame,
 * so the render frame equals the frame the tangent normals were baked in. Smoothing across creases tilted the
 * muzzle rim's baked texels (above 20 degrees: 1326 with `smooth` base, 358 at 30, 876 at 60).
 */
const BASE_CREASE_NORMALS = { mode: 'autoSmooth', angle: 30 } as const;

function quadOptions(mode: QuadMode, size: number): QuadOptions {
  switch (mode) {
    case 'iso':
      return { size, trimmed: 'quad-dominant', isoQuadric: true };
    case 'quad-dominant':
      return { size, trimmed: 'quad-dominant' };
    case 'blossom-row':
      return { size, trimmed: 'blossom-row' };
    case 'split-3':
      return { size, trimmed: 'quad-dominant', fallback: 'split-3' };
  }
}

interface QuadTry {
  readonly mode: QuadMode;
  readonly status: 'ok' | 'refused';
  readonly code?: string;
  readonly triangles?: number;
  readonly openEdges?: number;
  readonly nonManifoldEdges?: number;
  readonly minScaledJacobian?: number;
}

interface PartQuad {
  readonly part: string;
  readonly material: string;
  readonly mode: QuadMode;
  readonly triangles: number;
  readonly tried: readonly QuadTry[];
  readonly result: QuadResult;
}

const round4 = (v: number): number => Math.round(v * 10000) / 10000;

/**
 * Fewest leftover triangles (quad-dominant triangles the mesher could not pair), then no open or non-manifold edges, then the highest least scaled Jacobian. The Jacobian is
 * rounded to four decimals before comparing, so the choice is stable under floating-point noise.
 */
function score(t: QuadTry): number {
  return (
    (t.triangles as number) * 1000 +
    (t.openEdges as number) * 1e6 +
    (t.nonManifoldEdges as number) * 1e6 -
    (t.minScaledJacobian as number)
  );
}

/**
 * Default slot merge when the caller gives none: fold the lightest source slot into the heaviest
 * until at most `maxMaterials` slots remain. Weight is the quad mesh's face count, so the rule
 * reads only the quads already built; ties resolve by material name.
 */
function defaultMerge(quads: readonly PartQuad[], maxMaterials: number): Record<string, string> {
  const weight = new Map<string, number>();
  for (const q of quads) {
    weight.set(q.material, (weight.get(q.material) ?? 0) + q.result.report.faces);
  }
  const target = new Map<string, string>();
  const owner = (m: string): string => target.get(m) ?? m;
  while (weight.size > maxMaterials) {
    const order = [...weight.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
    const [lightest] = order;
    const heaviest = order[order.length - 1];
    if (lightest === undefined || heaviest === undefined || lightest[0] === heaviest[0]) break;
    weight.set(heaviest[0], heaviest[1] + lightest[1]);
    weight.delete(lightest[0]);
    for (const [src, dst] of target) if (dst === lightest[0]) target.set(src, heaviest[0]);
    target.set(lightest[0], heaviest[0]);
  }
  const merge: Record<string, string> = {};
  for (const q of quads) {
    const dst = owner(q.material);
    if (dst !== q.material) merge[q.material] = dst;
  }
  return merge;
}

function quadPart(stage: ExactStage, part: DeliveryPart, size: number): PartQuad | DeliveryError {
  const tried: QuadTry[] = [];
  let best: { mode: QuadMode; row: QuadTry; result: QuadResult } | undefined;
  for (const mode of QUAD_MODES) {
    const r = stage.quadrangulate(part.shape, quadOptions(mode, size));
    if (!r.ok) {
      tried.push({ mode, status: 'refused', code: r.error.code });
      continue;
    }
    const rep = r.value.report;
    const row: QuadTry = {
      mode,
      status: 'ok',
      triangles: rep.triangles,
      openEdges: rep.openEdges,
      nonManifoldEdges: rep.nonManifoldEdges,
      minScaledJacobian: round4(rep.scaledJacobian.min),
    };
    tried.push(row);
    if (best === undefined || score(row) < score(best.row)) best = { mode, row, result: r.value };
  }
  if (best === undefined) {
    return deliveryError('delivery-part-refused', { part: part.name, tried });
  }
  return {
    part: part.name,
    material: part.material,
    mode: best.mode,
    triangles: best.row.triangles as number,
    tried,
    result: best.result,
  };
}

export function deliveryError(
  code: DeliveryErrorCode,
  detail: Readonly<Record<string, unknown>>,
  expected = '',
): DeliveryError {
  const fallback: Readonly<Record<DeliveryErrorCode, string>> = {
    'delivery-invalid-argument':
      'a non-empty source with unique part names, an exact stage and positive sizes',
    'delivery-part-refused': 'a mesher route that meshes every part',
    'delivery-no-size-fits': 'a quad size whose measured asset passes the profile budget',
    'delivery-kernel-failed': 'every modeling operation of the delivery to succeed',
  };
  return {
    code,
    expected: expected === '' ? fallback[code] : expected,
    hint: DELIVERY_ERROR_HINTS[code],
    detail,
  };
}

function isDeliveryError(x: PartQuad | DeliveryError): x is DeliveryError {
  return 'code' in x;
}

function kernelFailed(
  step: DeliveryStep,
  cause: { code?: string | undefined; expected?: string | undefined },
): DeliveryError {
  return deliveryError('delivery-kernel-failed', { step, cause }, `the ${step} step to succeed`);
}

interface Assembled {
  readonly model: Model;
  readonly mesh: MeshAsset;
  readonly stats: AssetStats;
  readonly islands: number;
  readonly exactOverlapPairs: number;
  readonly padding: number;
  readonly steps: readonly DeliveryStepReport[];
}

/** Assemble the quads of one size into a model, run the UV steps and export the measured mesh. */
function assemble(
  quads: readonly PartQuad[],
  merge: Readonly<Record<string, string>>,
  groups: boolean,
): Result<Assembled, DeliveryError> {
  const m = model();
  for (const q of quads) m.append(encodeSnapshot(q.result.mesh), { tag: q.part });
  if (groups) {
    for (const q of quads) {
      const t = m.tag(sel.tag(q.part), `${BAKE_GROUP_PREFIX}${q.part}`);
      if (t.status !== 'ok') return err(kernelFailed('bake', { code: t.error?.code }));
    }
  }
  const steps: DeliveryStepReport[] = [
    {
      step: 'quad',
      status: 'ok',
      detail: {
        parts: quads.map((q) => ({
          part: q.part,
          mode: q.mode,
          leftoverTriangles: q.triangles,
          tried: q.tried,
        })),
      },
    },
  ];
  for (const q of quads) {
    const slot = merge[q.material] ?? q.material;
    const r = m.assign(sel.tag(q.part), slot);
    if (r.status !== 'ok') return err(kernelFailed('assign', { code: r.error?.code }));
  }
  steps.push({
    step: 'assign',
    status: 'ok',
    detail: {
      slots: [...new Set(quads.map((q) => merge[q.material] ?? q.material))],
      merge: { ...merge },
    },
  });
  // The mesher flags the B-rep creases sharp; they are seams, so a smooth-normal bake never crosses one.
  const plan = m.uv.plan({ hardAngle: 60, respectSharp: true });
  if (plan.status !== 'ok') return err(kernelFailed('seams', { code: plan.error?.code }));
  steps.push({ step: 'seams', status: 'ok', detail: { respectSharp: true, hardAngle: 60 } });
  const unwrap = m.uv.unwrap({ seams: 'marked' });
  if (unwrap.status !== 'ok') return err(kernelFailed('unwrap', { code: unwrap.error?.code }));
  steps.push({ step: 'unwrap', status: 'ok', detail: {} });
  const pack = m.uv.pack({
    resolution: PACK_RESOLUTION,
    padding: ATLAS_PADDING,
    resolveOverlaps: OVERLAP_REPAIR_PASSES,
  });
  if (pack.status !== 'ok') return err(kernelFailed('pack', { code: pack.error?.code }));
  steps.push({
    step: 'pack',
    status: 'ok',
    detail: {
      resolution: PACK_RESOLUTION,
      mips: ATLAS_PADDING.mips,
      resolveOverlaps: OVERLAP_REPAIR_PASSES,
    },
  });
  const island = measureUv(m.editMesh, 'uv0');
  if (!island.ok) return err(kernelFailed('pack', { code: island.error.code }));
  const exported = m.toMesh({ normals: BASE_CREASE_NORMALS });
  if (!exported.ok) return err(kernelFailed('pack', { code: exported.error.code }));
  const measured = assetStats([{ id: ASSET_PART, mesh: exported.value.mesh }]);
  if (!measured.ok) return err(kernelFailed('budget', { code: measured.error.code }));
  return ok({
    model: m,
    mesh: exported.value.mesh,
    stats: measured.value,
    islands: island.value.islands.length,
    exactOverlapPairs: uvOverlapPairs(m.editMesh, m.editMesh.faces(), 'uv0').length,
    padding: paddingTexels(ATLAS_PADDING),
    steps,
  });
}

interface BakeStep {
  readonly report: DeliveryBakeReport;
  readonly textures: BakeResult['textures'];
}

/** Linear to sRGB encoding of one channel, rounded to a byte. */
function encodeByte(linear: number): number {
  return Math.round(encodeSrgb(Math.max(0, Math.min(1, linear))) * 255);
}

/**
 * Base-colour atlas of the delivered UV layout. Each covered texel takes the colour of the source slot
 * of its owning face (the part the face came from), so merging output slots never loses a source colour.
 * Uncovered texels are transparent black. The source slot is read from the part, not the mesh, because
 * `merge` has already renamed the mesh slot.
 */
function albedoAtlas(
  model: Model,
  parts: readonly DeliveryPart[],
  atlas: AlbedoAtlas,
): Result<TextureAsset, DeliveryError> {
  const bySlot = new Map(parts.map((p) => [p.name, p.material]));
  const used = new Set(parts.map((p) => p.material));
  for (const slot of used) {
    const c = atlas.colors[slot];
    if (c === undefined || c.length !== 3 || c.some((v) => !Number.isFinite(v))) {
      return err(
        deliveryError(
          'delivery-invalid-argument',
          { albedo: slot },
          `a finite linear RGB for ${slot}`,
        ),
      );
    }
  }
  const mesh = model.editMesh;
  const owners = faceOwners(mesh, 'uv0', atlas.size);
  if (!owners.ok) return err(kernelFailed('atlas', { code: owners.error.code }));
  const data = new Uint8Array(atlas.size * atlas.size * 4);
  const tagNames = mesh.tagNames;
  for (let k = 0; k < owners.value.length; k++) {
    const f = owners.value[k] as number;
    if (f === -1) continue;
    const slot = partSlot(mesh, f, tagNames, bySlot);
    if (slot === undefined) continue;
    const c = atlas.colors[slot] as readonly [number, number, number];
    data[k * 4] = encodeByte(c[0]);
    data[k * 4 + 1] = encodeByte(c[1]);
    data[k * 4 + 2] = encodeByte(c[2]);
    data[k * 4 + 3] = 255;
  }
  return ok(texture(atlas.size, data));
}

/** The source slot of a face: the part tag it was appended under. */
function partSlot(
  mesh: EditMesh,
  f: number,
  tagNames: readonly string[],
  bySlot: ReadonlyMap<string, string>,
): string | undefined {
  for (let t = 0; t < tagNames.length; t++) {
    const name = tagNames[t] as string;
    if (!mesh.hasTag(f, t)) continue;
    const slot = bySlot.get(name);
    if (slot !== undefined) return slot;
  }
  return undefined;
}

/**
 * Bakes the detail (same parts, quads at `detailSize`, no merge) onto the delivered base. The kernel's refusal is data:
 * it comes back as `report.refusal` with `pass: false`, and only a detail that cannot be built is a delivery error.
 */
function bakeDetail(
  stage: ExactStage,
  parts: readonly DeliveryPart[],
  base: Model,
  detailSize: number,
  bake: DeliverBake,
): Result<BakeStep, DeliveryError> {
  const quads: PartQuad[] = [];
  for (const part of parts) {
    const q = quadPart(stage, part, detailSize);
    if (isDeliveryError(q)) return err(q);
    quads.push(q);
  }
  const detail = assemble(quads, {}, true);
  if (!detail.ok) return detail;
  const baked = bakeMaps({
    maps: [...bake.maps],
    resolution: bake.resolution,
    mips: false,
    gutter: paddingTexels(ATLAS_PADDING),
    normals: BASE_CREASE_NORMALS,
    tags: { groupPrefix: BAKE_GROUP_PREFIX },
    base: base.snapshot(),
    detail: detail.value.model.snapshot(),
  });
  if (!baked.ok) {
    return ok({
      report: {
        maps: bake.maps,
        detailSize,
        bytes: 0,
        pass: false,
        issues: [],
        groups: [],
        baseNormals: BASE_CREASE_NORMALS,
        refusal: {
          code: baked.error.code,
          expected: baked.error.expected,
          hint: baked.error.hint,
        },
      },
      textures: {},
    });
  }
  return ok({
    report: {
      maps: bake.maps,
      detailSize,
      bytes: Object.values(baked.value.textures).reduce((n, t) => n + (t?.data.byteLength ?? 0), 0),
      pass: baked.value.pass,
      issues: baked.value.issues,
      groups: baked.value.provenance.groups,
      baseNormals: BASE_CREASE_NORMALS,
    },
    textures: baked.value.textures,
  });
}

/**
 * Delivers one exact source as a game asset for `profile`. Sizes are tried in order and the first whose measured
 * export passes the profile budget is returned; if none passes, the call fails with every attempt's issue codes.
 */
interface LodRow {
  readonly size: number;
  readonly triangles: number;
  readonly vertices: number;
  readonly freeChains: number;
  readonly nonManifoldEdges: number;
  readonly boundarySetEqualsLod0: boolean;
}

interface LodBuild {
  readonly meshes: readonly MeshAsset[];
  readonly steps: readonly DeliveryStepReport[];
}

/**
 * LOD1..n: each requested coarser size is quadded and assembled with the delivered merge and seam
 * plan. A LOD must keep LOD0's boundary set, open no boundary chain and add no non-manifold edges
 * beyond LOD0's own; a LOD that breaks one is a refusal with the numbers, never a silent chain.
 */
function buildLods(
  options: DeliverOptions,
  parts: readonly DeliveryPart[],
  merge: Readonly<Record<string, string>>,
  lod0Size: number,
  lod0: MeshAsset,
): Result<LodBuild, DeliveryError> {
  const requested = options.lods ?? [];
  if (requested.some((s) => !Number.isFinite(s) || s <= lod0Size)) {
    return err(deliveryError('delivery-invalid-argument', { lods: [...requested], lod0Size }));
  }
  const meshes: MeshAsset[] = [lod0];
  const rows: LodRow[] = [];
  for (const size of requested) {
    const quads: PartQuad[] = [];
    for (const part of parts) {
      const q = quadPart(options.exact, part, size);
      if (isDeliveryError(q)) return err(q);
      quads.push(q);
    }
    const built = assemble(quads, merge, false);
    if (!built.ok) return built;
    meshes.push(built.value.mesh);
    const topo = lodTopologyReport(meshes);
    const mine = topo[meshes.length - 1];
    const base = topo[0];
    if (mine === undefined || base === undefined) {
      return err(kernelFailed('lod', { code: 'lod-topology-missing' }));
    }
    rows.push({
      size,
      triangles: built.value.stats.triangles,
      vertices: built.value.stats.vertices,
      freeChains: mine.freeChains,
      nonManifoldEdges: mine.nonManifoldEdges,
      boundarySetEqualsLod0: mine.boundarySetEqualsLod0,
    });
    if (
      mine.freeChains !== 0 ||
      !mine.boundarySetEqualsLod0 ||
      mine.nonManifoldEdges > base.nonManifoldEdges
    ) {
      return err(
        deliveryError(
          'delivery-kernel-failed',
          {
            step: 'lod',
            size,
            cause: {
              freeChains: mine.freeChains,
              boundarySetEqualsLod0: mine.boundarySetEqualsLod0,
              nonManifoldEdges: mine.nonManifoldEdges,
              lod0NonManifoldEdges: base.nonManifoldEdges,
            },
          },
          'every LOD to keep LOD0 seams closed and add no non-manifold edges',
        ),
      );
    }
  }
  const steps: DeliveryStepReport[] =
    requested.length > 0 ? [{ step: 'lod', status: 'ok', detail: { lods: rows } }] : [];
  return ok({ meshes: meshes.slice(1), steps });
}

export function deliverAsset(
  source: DeliverySource,
  profile: AssetOutputProfileId | AssetOutputProfile,
  options: DeliverOptions,
): Result<DeliveredAsset, DeliveryError> {
  const limits = typeof profile === 'string' ? ASSET_OUTPUT_PROFILES[profile] : profile;
  const profileName = typeof profile === 'string' ? profile : 'custom';
  const sizes = options.sizes;
  const names = new Set(source.parts.map((p) => p.name));
  if (source.parts.length === 0 || names.size !== source.parts.length) {
    return err(
      deliveryError('delivery-invalid-argument', {
        parts: source.parts.length,
        unique: names.size,
      }),
    );
  }
  if (sizes.length === 0 || sizes.some((s) => !Number.isFinite(s) || s <= 0)) {
    return err(deliveryError('delivery-invalid-argument', { sizes: [...sizes] }));
  }
  const detailSize = options.detailSize ?? minOf(sizes) / 2.5;
  if (!Number.isFinite(detailSize) || detailSize <= 0) {
    return err(deliveryError('delivery-invalid-argument', { detailSize }));
  }
  if (options.albedo !== undefined) {
    const sizeBad = checkSize(options.albedo.size);
    if (sizeBad !== undefined)
      return err(deliveryError('delivery-invalid-argument', { albedo: sizeBad.detail }));
    const missing = [...new Set(source.parts.map((p) => p.material))].filter((slot) => {
      const c = options.albedo?.colors[slot];
      return c === undefined || c.length !== 3 || c.some((v) => !Number.isFinite(v));
    });
    if (missing.length > 0) {
      return err(
        deliveryError(
          'delivery-invalid-argument',
          { albedo: { missing } },
          'a finite linear RGB for every used source slot',
        ),
      );
    }
  }
  if (options.bake !== undefined && options.bake.maps.length === 0) {
    return err(deliveryError('delivery-invalid-argument', { bake: 'no maps requested' }));
  }
  const attempts: DeliveryAttempt[] = [];
  for (const size of sizes) {
    const quads: PartQuad[] = [];
    for (const part of source.parts) {
      const q = quadPart(options.exact, part, size);
      if (isDeliveryError(q)) return err(q);
      quads.push(q);
    }
    const merge = options.merge ?? defaultMerge(quads, limits.maxMaterials);
    const textureEstimate =
      options.bake === undefined
        ? undefined
        : {
            bytes:
              options.bake.maps.length *
              textureBytes(options.bake.resolution, options.bake.resolution, false),
          };
    const built = assemble(quads, merge, options.bake !== undefined);
    if (!built.ok) return built;
    const verdict = checkAssetBudget(built.value.stats, profile, textureEstimate);
    attempts.push({
      size,
      triangles: built.value.stats.triangles,
      vertices: built.value.stats.vertices,
      materials: built.value.stats.materials,
      issues: verdict.issues.map((i) => i.code),
    });
    if (!verdict.ok) continue;
    const a = built.value;
    const steps: DeliveryStepReport[] = [...a.steps];
    let bake: BakeStep | undefined;
    if (options.bake !== undefined) {
      const baked = bakeDetail(options.exact, source.parts, a.model, detailSize, options.bake);
      if (!baked.ok) return baked;
      bake = baked.value;
      steps.push({
        step: 'bake',
        status: bake.report.pass ? 'ok' : 'failed',
        detail: {
          maps: bake.report.maps,
          detailSize,
          groups: bake.report.groups.length,
          refusal: bake.report.refusal?.code,
        },
      });
    }
    let albedo: TextureAsset | undefined;
    if (options.albedo !== undefined) {
      const atlas = albedoAtlas(a.model, source.parts, options.albedo);
      if (!atlas.ok) return atlas;
      albedo = atlas.value;
      steps.push({
        step: 'atlas',
        status: 'ok',
        detail: {
          size: options.albedo.size,
          slots: [...new Set(source.parts.map((p) => p.material))],
        },
      });
    }
    const lods = buildLods(options, source.parts, merge, size, a.mesh);
    if (!lods.ok) return lods;
    pushAll(steps, lods.value.steps);
    steps.push({ step: 'budget', status: 'ok', detail: { profile: profileName } });
    return ok({
      mesh: a.mesh,
      model: a.model,
      lods: lods.value.meshes,
      textures: { ...(bake?.textures ?? {}), ...(albedo === undefined ? {} : { albedo }) },
      report: {
        profile: profileName,
        size,
        attempts,
        stats: a.stats,
        budget: { ok: true, issues: [] },
        uv: {
          islands: a.islands,
          coverage: a.stats.uvCoverage,
          exactOverlapPairs: a.exactOverlapPairs,
          paddingTexels: a.padding,
        },
        steps,
        ...(bake === undefined ? {} : { bake: bake.report }),
      },
    });
  }
  return err(
    deliveryError(
      'delivery-no-size-fits',
      { profile: profileName, attempts, limits },
      `a size in [${sizes.join(', ')}] whose asset passes the ${profileName} budget`,
    ),
  );
}
