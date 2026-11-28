import type { NativeCookDraft, NativeCooker } from '@forgeax/engine-pack/native-cooker';
import type { PackCookSource } from '@forgeax/engine-pack/source';
import {
  type ByteCache,
  err,
  type MeshAsset,
  ok,
  type Result,
  type TextureAsset,
} from '@forgeax/engine-types';
import { getModelingKernelWasm } from '@forgeax/modeling-kernel';
import { maxOf, minOf, pushAll } from './arrays';
import { BAKE_CHECKS, type BakeCheck } from './bake-checks';
import {
  bakeCorrespondWithRustKernel,
  dilateAtlasWithRustKernel,
  evaluateBakeMapsWithRustKernel,
  isRustBakeMapKind,
  type RustBakeCorrespondenceState,
  resolveBakeCagesWithRustKernel,
  shouldUseRustBake,
} from './bake-rust';
import { fromBase64, toBase64 } from './base64';
import {
  type AtlasBleedReport,
  type AtlasGrid,
  atlasBleedReport,
  type DilateAtlasOptions,
  type DilateAtlasResult,
  dilate,
  prepareAtlasDilation,
} from './compute/atlas-ts';
import {
  bakeCorrespondCpu,
  type CpuCorrespondenceData,
  evaluateBakeMapsCpu,
  prepareEvalBake,
} from './compute/bake-correspond-cpu';
import {
  allRows,
  BAKE_MAP_KINDS,
  type BakeRows,
  bakeRows,
  diagonalOf,
  emissiveScale,
  ensureGroupBvhs,
  finishBake,
  finishBakeWithFilter,
  gridOf,
  prepareBake,
  resolveBakeCagePlan,
  tsBakeBackend,
} from './compute/bake-ts';
import { filterBakeTexture } from './compute/bake-webgpu';
import { prepareBakeOcclusion } from './compute/bake-webgpu-ao';
import {
  bakeCorrespondGpu,
  evaluateBakeMapsGpu,
  type GpuCorrespondenceData,
  runBakeCorrespondGpu,
  runGpuAtlasDilation,
} from './compute/bake-webgpu-correspond';
import {
  type AnalyticPatch,
  type AnalyticVerify,
  type BakeAnalyticParams,
  type BakeBounds,
  type BakeCage,
  type BakeClipCluster,
  type BakeDirection,
  type BakeGroupReport,
  type BakeGroupSettings,
  type BakeHandedness,
  type BakeJobNormals,
  type BakeJobParams,
  type BakeMapKind,
  type BakeProvenance,
  type BakeSlot,
  type BakeStack,
  type BakeStrayCluster,
  type ComputeBackend,
  type ComputeJobReport,
  type ComputeJobRequest,
  type ComputeJobResult,
  type ComputePolicy,
  computeCacheKey,
  DEFAULT_WORK_BUDGET,
  runComputeJob,
  WorkMeter,
} from './compute/job';
import { type ModelingError, type ModelingErrorCode, modelingError } from './errors';
import type { NormalMode } from './finish';
import { checkSnapshotOperand, decodeSnapshot, encodeSnapshot } from './fxem';
import type { Tuple3 } from './geom';
import type { LowpolyOptions } from './lowpoly';
import type { TextureReference, TextureSink } from './materials';
import type { CornerChannelName } from './mesh';
import { Model, model } from './model';
import type { OpDiagnostic } from './ops';
import type { Issue } from './report';
import { sel } from './selectors';
import { mipChain, packFloat32Texture, r16Texture } from './texture';
import { defaultProtectMip } from './uv';
import type { ValidationCode, ValidationReport } from './validate';

export {
  type AtlasBleedReport,
  type AtlasGrid,
  atlasBleedReport,
  type DilateAtlasOptions,
  type DilateAtlasResult,
};

function packDilatedTexture(
  name: string,
  tex: TextureAsset,
  rgba01: Float32Array,
  grid: AtlasGrid,
  wantMips: boolean | undefined,
  alphaCutoff: number | undefined,
): Result<TextureAsset, ModelingError> {
  const mips = wantMips ?? tex.mips.kind === 'packed';
  const texels = grid.w * grid.h;
  if (tex.format === 'r16unorm') {
    return ok(r16Texture(grid.w, grid.h, (x, y) => rgba01[(y * grid.w + x) * 4] as number, mips));
  }
  const packed = new Uint8Array(texels * 4);
  for (let i = 0; i < texels * 4; i++) {
    packed[i] = Math.max(0, Math.min(255, Math.round((rgba01[i] as number) * 255)));
  }
  const base: TextureAsset = {
    kind: 'texture',
    format: tex.format,
    colorSpace: tex.colorSpace,
    shape: { viewDimension: '2d', extent: { width: grid.w, height: grid.h } },
    mips: { kind: 'none' },
    data: packed,
  };
  if (!mips) return ok(base);
  const layout =
    name === 'normal' || name === 'normalObject'
      ? 'normal'
      : name === 'ormh'
        ? 'ormh'
        : alphaCutoff !== undefined
          ? 'mask'
          : 'color';
  const chain = mipChain(base, {
    layout,
    ...(layout === 'mask' && alphaCutoff !== undefined ? { alphaCutoff } : {}),
  });
  if (!chain.ok) return chain;
  const total = chain.value.levels.reduce((sum, l) => sum + l.length, 0);
  const data = new Uint8Array(total);
  let off = 0;
  for (const level of chain.value.levels) {
    data.set(level, off);
    off += level.length;
  }
  return ok({
    ...base,
    data,
    mips: { kind: 'packed', levelCount: chain.value.levels.length },
  });
}

/**
 * Dilate 2D atlas `TextureAsset` buffers on CPU without re-running a 3D mesh bake.
 * Reuses the exact `dilate` and `mipBleed` primitives used by `bakeMaps`.
 */
export function dilateAtlas(options: DilateAtlasOptions): Result<DilateAtlasResult, ModelingError> {
  if (shouldUseRustBake(options.backend, undefined)) {
    return dilateAtlasWithRustKernel(options, packDilatedTexture);
  }
  const prep = prepareAtlasDilation(options);
  if (!prep.ok) return prep;
  const { entries, grid, mask, owner, frame, gutter, protectMip, categorical } = prep.value;
  const texels = grid.w * grid.h;
  const kinds = entries.map(([name]) =>
    categorical.has(name) ? ('materialId' as BakeMapKind) : 'baseColor',
  );
  const buffers = entries.map(([, tex]) => {
    const out = new Float64Array(texels * 4);
    if (tex.format === 'r16unorm') {
      const view = new Uint16Array(tex.data.buffer, tex.data.byteOffset, texels);
      for (let i = 0; i < texels; i++) {
        out[i * 4] = (view[i] as number) / 65535;
        out[i * 4 + 3] = 1;
      }
    } else {
      for (let i = 0; i < texels * 4; i++) {
        out[i] = (tex.data[i] as number) / 255;
      }
    }
    return out;
  });
  const covered = Uint8Array.from(mask);
  const outOwner = Int32Array.from(owner);
  dilate(kinds, buffers, covered, outOwner, frame, grid, gutter);
  const textures: Record<string, TextureAsset> = {};
  for (const [k, [name, tex]] of entries.entries()) {
    const packed = packDilatedTexture(
      name,
      tex,
      Float32Array.from(buffers[k] as Float64Array),
      grid,
      options.mips,
      options.alphaCutoff,
    );
    if (!packed.ok) return packed;
    textures[name] = packed.value;
  }
  return ok({
    textures,
    bleed: atlasBleedReport(outOwner, mask, grid, protectMip),
    backend: 'ts',
  });
}

/**
 * Dilate 2D atlas `TextureAsset` maps on WebGPU reusing the bake JFA + ring dilation +
 * RGBA8 pack pipelines. Falls back cleanly to CPU `dilateAtlas` when GPU preconditions aren't met.
 */
export async function dilateAtlasWithGpu(
  options: DilateAtlasOptions,
  device: GPUDevice,
): Promise<Result<DilateAtlasResult, ModelingError>> {
  const gpu = await runGpuAtlasDilation(options, device);
  if (gpu === undefined) return dilateAtlas(options);
  if (!gpu.ok) return gpu;
  const { entries, grid, packedBytesCopy, bleed } = gpu.value;
  const texels = grid.w * grid.h;
  const mapBytes = texels * 4;
  const textures: Record<string, TextureAsset> = {};
  for (let m = 0; m < entries.length; m++) {
    const [name, tex] = entries[m] as readonly [string, TextureAsset];
    const u8 = new Uint8Array(packedBytesCopy, m * mapBytes, mapBytes);
    const f32 = new Float32Array(mapBytes);
    for (let i = 0; i < mapBytes; i++) f32[i] = (u8[i] as number) / 255;
    const packed = packDilatedTexture(name, tex, f32, grid, options.mips, options.alphaCutoff);
    if (!packed.ok) return packed;
    textures[name] = packed.value;
  }
  return ok({ textures, bleed, backend: 'webgpu' });
}

/**
 * Baking (bake groups, cage and ray
 * directions, B20) from a detail mesh onto a base mesh with uv0: one correspondence pass
 * per bake group feeds the normal, AO, curvature, height, material-id and resample
 * evaluators, on the CPU through the `bake` compute job.
 *
 * Tangent-space normals use the base's exported tangent frame (`computeTangentVec4`
 * through `toMesh`), so render the base with the same `normals` export mode. In a Pack,
 * `bakeSources` defers the work to the `modeling-bake` NativeCooker (outside the build
 * timeout); `bakeMaps` runs it in place.
 */
export type BakeTarget = 'texture' | 'vertex';

export interface BakeSettings {
  readonly maps: readonly BakeMapKind[];
  /** Texture size (required for the texture target): square, or [width, height] for strips. */
  readonly resolution?: number | readonly [number, number];
  /** 'texture' (default): uv0 atlas maps; 'vertex': one value per base vertex. */
  readonly target?: BakeTarget;
  /**
   * Cage of every group: rays start `offset` meters outside the base and travel at
   * most `maxRay` meters. Default 'auto' for both: the group's largest outward and inward
   * detail deviation along the ray direction, times 1.05.
   */
  readonly cage?: Partial<BakeCage>;
  /** Ray direction field (U43, default 'averaged'). */
  readonly direction?: BakeDirection;
  /**
   * Face-tag conventions of the bake: `groupPrefix` is a tag prefix, so a face tagged
   * `<groupPrefix><id>` belongs to bake group `id` on the base and on the detail (untagged faces
   * form the group ''; rays only find their own group); `floater` tags detail faces
   * that float over the surface (normal-only: height ignores them, AO does not see them).
   * Floating detail shells (a boolean's `details: 'float'`) are floaters without a tag.
   */
  readonly tags?: { readonly groupPrefix?: string; readonly floater?: string };
  /** Per bake group id: overrides of the bake-wide cage and direction. */
  readonly groups?: Readonly<Record<string, BakeGroupSettings>>;
  /** Gutter texels around charts, or 'fill' (default): every empty texel takes its nearest chart. */
  readonly gutter?: number | 'fill';
  /** Lowest mip level that must not mix charts with each other or background (V4; default: the level of 128 texels). */
  readonly protectMip?: number;
  /** Samples per texel, a square grid (default 1). */
  readonly samples?: 1 | 4 | 9 | 16;
  /** Reconstruction inside each chart (default 'bspline'). */
  readonly filter?: 'bspline' | 'none';
  /** The base's export normal mode, as passed to its `toMesh` (default smooth). */
  readonly normals?: NormalMode;
  /**
   * The detail's shading normal mode (default `DEFAULT_DETAIL_NORMALS`, autoSmooth 35
   * degrees: hard-surface chamfers stay flat, dense or sculpted highs stay smooth).
   */
  readonly detailNormals?: NormalMode;
  /**
   * Occlusion rays: count (default 32), bias in degrees above the tangent plane (default
   * 15), reach (default per group min(0.1 x its diagonal, 0.5 m)), `attenuation` (default
   * 'linear': an occluder at distance t weighs 1 - t / reach; 'none': any hit), an
   * optional `floor` (world y of an occluding ground plane) and scope: 'group' (default,
   * the sample's own group occludes) or 'all' (every group but `exclude`).
   */
  readonly ao?: {
    readonly rays?: number;
    readonly bias?: number;
    readonly distance?: number;
    readonly scope?: 'group' | 'all';
    readonly exclude?: readonly string[];
    readonly attenuation?: 'linear' | 'none';
    readonly floor?: number;
    /** Edge-aware denoise radius in texels (default 0, off; 2 suits 16-32 rays). */
    readonly denoise?: number;
  };
  /** Height storage: `bits` 8 (default, rgba8) or 16 (r16unorm); `range` [inner, outer] meters mapped to 0 and 1 (default symmetric around the cage). */
  readonly height?: { readonly bits?: 8 | 16; readonly range?: readonly [number, number] };
  /** Position map bounds: the detail's 'box' (default, per axis) or bounding 'sphere' (uniform). */
  readonly position?: { readonly bounds?: 'box' | 'sphere' };
  /** Thickness rays (default 32) and reach (default 0.1 x the group diagonal). */
  readonly thickness?: { readonly rays?: number; readonly distance?: number };
  /**
   * Surface per detail material slot (`BakeSlot`: base color, roughness, metallic,
   * emission), read by the `ormh`, `baseColor`, `emissive` and `opacity` maps; `'*'` is the
   * fallback of slots without an entry (default: white, 0.5, 0, no emission).
   */
  readonly slots?: Readonly<Record<string, BakeSlot>>;
  /**
   * Edge wear: rises over `range` [low, high] of normalized convex curvature (default
   * [0.15, 0.5]); `noise` breaks it up (default scale 0.02 m, amount 0, seed 0).
   */
  readonly edgeWear?: {
    readonly range?: readonly [number, number];
    readonly noise?: { readonly scale?: number; readonly amount?: number; readonly seed?: number };
  };
  /** Cavity: rises over `range` of normalized concave curvature (default [0.15, 0.5]). */
  readonly cavity?: { readonly range?: readonly [number, number] };
  /** Opacity alpha test cutoff its mips keep coverage for (default 0.5). */
  readonly opacity?: { readonly cutoff?: number };
  /**
   * Atlas wrap per uv axis: `true` joins opposite atlas borders (cyclic uv such as a
   * cylinder); a world vector also repeats the detail by that period (tileable bakes).
   */
  readonly wrap?: { readonly u?: true | Tuple3; readonly v?: true | Tuple3 };
  /** Pack box-filtered mips with the textures (default true; resample maps have none). */
  readonly mips?: boolean;
  /**
   * Analytic bake (BK63, texture target): where the base carries the patch domain (`uv1`, or
   * the BK56 carrier channel) and a `Model` detail records NURBS patches, position, normal /
   * normalObject and height come from the exact patches instead of rays; every other map, and
   * every base triangle the patches do not fully describe, is ray-baked and counted in the
   * `analytic` diagnostic (fail-closed). Default off: the ray bake is unchanged byte for byte.
   * `true` is `{ verify: 'all' }`. The analytic bake buys accuracy, not speed: at 256 x 256 the
   * default verifier costs about 4.2x the ray bake (1.7x the `'off'` / `'sample'` cost).
   */
  readonly analytic?: true | AnalyticOptions;
  readonly compute?: ComputePolicy;
  /** Execution backend selector ('auto' uses Rust WASM when initialized; 'ts' forces TS baseline). */
  readonly backend?: 'auto' | 'rust' | 'ts';
  /** Work units before `model-work-budget`. */
  readonly budget?: number;
}

export interface AnalyticOptions {
  /**
   * 'all' (default): before sampling, compare the exact patch with the ray bake at every
   * analytic sub-sample; a disagreement beyond the tolerance ray-bakes the whole group
   * (`analytic-mismatch`). The weaker modes are explicit opt-outs with a known limit:
   * 'sample' compares at most 256 area-stratified points per group, so a local error (for
   * example a 10 mm move of four faces) can pass between them; 'off' trusts the patches, and
   * only the stale-descriptor guard (the detail's own vertices must lie on each patch within
   * its chord) still protects the output. That guard compares every face of a patch up to 2048
   * faces and a deterministic every-Nth-face stride above that (a 2484-face patch is compared at
   * stride 2); it cannot see a deleted detail face, and 'sample' catches only a contiguous hole
   * of a few percent while 'all' catches a single deleted face. Neither opt-out proves the exact result.
   */
  readonly verify?: AnalyticVerify;
  /**
   * The patches to evaluate (default: the detail Model's recorded surfaces with their `chord` /
   * `angle`). A primitive-Shape producer supplies descriptors here; a bytes detail needs them.
   */
  readonly patches?: readonly AnalyticPatch[];
  /** The base corner channel holding the normalized patch domain (default: the base Model's). */
  readonly domain?: CornerChannelName;
}

export interface BakeOptions extends BakeSettings {
  /** The low-poly receiver: needs complete uv0 for the texture target. */
  readonly base: Model | Uint8Array;
  readonly detail: Model | Uint8Array;
  /** Detail texture (rgba8, level 0) sampled through the detail's uv0 for `resample`. */
  readonly resample?: TextureAsset;
  readonly signal?: { readonly aborted: boolean };
  readonly native?: ComputeBackend;
  /**
   * Host result store of the bake job (see `ComputeOptions.cache`); `bakeMaps` only,
   * `bakeMapsParallel` samples through its executor without it.
   */
  readonly cache?: ByteCache;
  /** Stores each baked texture (`<key>-<map>`) and returns its material reference. */
  readonly texture?: TextureSink;
  /** Texture key prefix (default 'bake'). */
  readonly key?: string;
}

export interface BakeResult {
  /** Texture target: one texture per map (normal and data maps linear, material ids sRGB). */
  readonly textures: Partial<Record<BakeMapKind, TextureAsset>>;
  /** References returned by `texture` for each map. */
  readonly references: Partial<Record<BakeMapKind, TextureReference>>;
  /** Vertex target: linear RGBA per base corner, in FXEM face order. */
  readonly vertexColors: Partial<Record<BakeMapKind, Float32Array>>;
  /** Vertex target: the base FXEM with the first map in its color channel. */
  readonly colored?: Uint8Array;
  readonly report: ComputeJobReport;
  readonly provenance: BakeProvenance;
  /** No `error` or `warn` issue: every bake check held. */
  readonly pass: boolean;
  /** Bake checks that did not hold (reference/uv-bake.md "Bake checks" gives each code's remedy). */
  readonly issues: readonly Issue<BakeTimeCheck>[];
  readonly diagnostics: readonly OpDiagnostic[];
}

/**
 * Default detail shading normals (audit A5): smooth normals bent a 45 degree chamfer of a
 * hard-surface high by 16.6 degrees on its flat faces; split above 35 degrees (the trim
 * sheet's rule), such a chamfer bakes flat while a sculpt or a fine bevel (steps under 35
 * degrees) stays smooth.
 * @internal
 */
export const DEFAULT_DETAIL_NORMALS: NormalMode = { mode: 'autoSmooth', angle: 35 };

/** The checks a bake reports itself; `validate({ bake })` runs the rest of the catalogue. */
type BakeTimeCheck = Exclude<BakeCheck, (typeof BAKE_CHECKS)[number]>;

/** Steep (unseen) fraction of a group's detail area above which the bake warns (V3). */
const STEEP_WARN = 0.03;
/** Fraction of a group's samples below which its ray correspondence is reported (V2). */
const RAY_HIT_WARN = 0.99;
/**
 * Flat-fallback share of a group's samples above which the bake warns: a flat sample has no facing
 * detail surface within reach, so its texel carries the base normal, not the detail's.
 */
export const FLAT_SHARE_WARN = 0.05;
/** Fraction of stacked samples that may conflict before V5 reports (outliers at chart rims). */
const STACK_RATIO = 0.01;
/**
 * V5 below the ratio (audit A6): this many conflicting sub-samples with a normal angle of
 * STACK_SEVERE_ANGLE degrees or a height gap of STACK_SEVERE_HEIGHT of the height range
 * (a 4 mm bump on one of two stacked plates: 20 of 3840 samples at 77 degrees).
 */
const STACK_SEVERE_SAMPLES = 4;
const STACK_SEVERE_ANGLE = 45;
const STACK_SEVERE_HEIGHT = 0.1;
/** Largest alpha-test coverage change of an opacity mip from mip 0. */
const COVERAGE_DELTA = 0.05;
/** Smallest mip side V12 judges: below it one texel moves coverage by more than 0.4 %. */
const COVERAGE_MIN_SIDE = 16;

/**
 * V12: the first mip of an RGBA8 texture, down to a 16-texel side, whose alpha-test
 * coverage (alpha >= cutoff) moves more than COVERAGE_DELTA from mip 0.
 * @internal
 */
export function coverageIssue(
  texture: TextureAsset,
  cutoff: number,
): Issue<BakeTimeCheck> | undefined {
  const levels = alphaCoverage(texture, cutoff);
  const base = levels[0] as number;
  const level = levels.findIndex((c) => Math.abs(c - base) > COVERAGE_DELTA);
  if (level <= 0) return undefined;
  return {
    code: 'opacity-coverage',
    severity: 'warn',
    detail: { level, coverage: levels[level], base, cutoff },
  };
}

/**
 * Alpha-test coverage (alpha >= cutoff) per level of a packed RGBA8 texture, down to COVERAGE_MIN_SIDE.
 * @internal
 */
export function alphaCoverage(texture: TextureAsset, cutoff: number): number[] {
  const { width, height } = texture.shape.extent as { width: number; height: number };
  const count = texture.mips.kind === 'packed' ? texture.mips.levelCount : 1;
  const out: number[] = [];
  let offset = 0;
  for (let k = 0; k < count; k++) {
    const w = Math.max(1, width >> k);
    const h = Math.max(1, height >> k);
    const texels = w * h;
    if (k > 0 && Math.min(w, h) < COVERAGE_MIN_SIDE) break;
    let hit = 0;
    for (let i = 0; i < texels; i++) {
      if ((texture.data[offset + i * 4 + 3] as number) / 255 >= cutoff) hit++;
    }
    out.push(hit / texels);
    offset += texels * 4;
  }
  return out;
}

function snapshotOf(input: Model | Uint8Array, name: string): Result<Uint8Array, ModelingError> {
  if (input instanceof Uint8Array) {
    const poisoned = checkSnapshotOperand(input);
    return poisoned.ok ? ok(input) : poisoned;
  }
  const failure = input.poisoned;
  if (failure !== undefined) {
    return err(
      modelingError(
        failure.code,
        failure.expected,
        { ...failure.detail, input: name },
        failure.hint,
      ),
    );
  }
  return ok(input.snapshot());
}

/** The analytic bake of the options: its job params, or why the bake stays on rays (undefined: not requested). */
function analyticOf(
  settings: BakeSettings,
  base: Model | Uint8Array,
  detail: Model | Uint8Array,
): { readonly params?: BakeAnalyticParams; readonly skipped?: string } | undefined {
  const request = settings.analytic;
  if (request === undefined) return undefined;
  const options: AnalyticOptions = request === true ? {} : request;
  if ((settings.target ?? 'texture') !== 'texture') {
    return { skipped: 'the vertex target has no analytic bake' };
  }
  if (
    !settings.maps.some(
      (m) => m === 'position' || m === 'normal' || m === 'normalObject' || m === 'height',
    )
  ) {
    return { skipped: 'no requested map is analytic (position, normal, normalObject, height)' };
  }
  let patches = options.patches;
  if (patches === undefined) {
    if (!(detail instanceof Model)) {
      return {
        skipped: 'a bytes detail records no patches: pass analytic.patches or a Model detail',
      };
    }
    patches = detail.analyticSource().surfaces.map((surface) => ({
      kind: 'nurbs' as const,
      name: surface.name,
      surface: surface.surface,
      chord: surface.chord ?? 0.001,
      angle: surface.angle ?? 12,
    }));
  }
  if (patches.length === 0) return { skipped: 'the detail records no patches' };
  const domain = options.domain ?? (base instanceof Model ? base.analyticSource().domain : 'uv1');
  const detailDomain = detail instanceof Model ? detail.analyticSource().domain : domain;
  return { params: { verify: options.verify ?? 'all', domain, detailDomain, patches } };
}

function diagonal(snapshots: readonly Uint8Array[]): Result<number, ModelingError> {
  const positions: number[][] = [];
  for (const bytes of snapshots) {
    const mesh = decodeSnapshot(bytes);
    if (!mesh.ok) return mesh;
    positions.push(mesh.value.vertices().flatMap((v) => mesh.value.position(v)));
  }
  const d = diagonalOf(...positions);
  if (!(d > 0)) {
    return err(modelingError('model-precondition', 'the base and detail have extent', {}));
  }
  return ok(d);
}

/** A normal mode as JSON-safe job params: a transfer source travels as base64. */
function jsonNormals(normals: NormalMode): BakeJobNormals {
  return normals.mode === 'transfer' ? { ...normals, from: toBase64(normals.from) } : normals;
}

/** Resolve settings against both meshes into the job parameters. */
function jobParams(
  settings: BakeSettings,
  snapshots: readonly Uint8Array[],
  resample: TextureAsset | undefined,
  analytic?: BakeAnalyticParams,
): Result<BakeJobParams, ModelingError> {
  const target = settings.target ?? 'texture';
  if (target === 'texture' && settings.resolution === undefined) {
    return err(
      modelingError('model-invalid-argument', 'a texture bake has a resolution', {
        resolution: settings.resolution,
      }),
    );
  }
  const extent = diagonal(snapshots);
  if (!extent.ok) return extent;
  const resolution = settings.resolution ?? 1;
  return ok({
    maps: [...settings.maps],
    target,
    resolution,
    cage: { offset: settings.cage?.offset ?? 'auto', maxRay: settings.cage?.maxRay ?? 'auto' },
    direction: settings.direction ?? 'averaged',
    ...(settings.tags === undefined ? {} : { tags: settings.tags }),
    ...(settings.groups === undefined ? {} : { groups: settings.groups }),
    gutter: settings.gutter ?? 'fill',
    protectMip:
      settings.protectMip ??
      defaultProtectMip(typeof resolution === 'number' ? resolution : minOf(resolution)),
    samples: settings.samples ?? 1,
    filter: settings.filter ?? 'bspline',
    baseNormals: jsonNormals(settings.normals ?? { mode: 'smooth' }),
    detailNormals: jsonNormals(settings.detailNormals ?? DEFAULT_DETAIL_NORMALS),
    ao: {
      rays: settings.ao?.rays ?? 32,
      bias: settings.ao?.bias ?? 15,
      distance: settings.ao?.distance ?? 'auto',
      scope: settings.ao?.scope ?? 'group',
      exclude: [...(settings.ao?.exclude ?? [])],
      attenuation: settings.ao?.attenuation ?? 'linear',
      denoise: settings.ao?.denoise ?? 0,
      ...(settings.ao?.floor === undefined ? {} : { floor: settings.ao.floor }),
    },
    height: {
      bits: settings.height?.bits ?? 8,
      ...(settings.height?.range === undefined ? {} : { range: settings.height.range }),
    },
    position: { bounds: settings.position?.bounds ?? 'box' },
    thickness: {
      rays: settings.thickness?.rays ?? 32,
      distance: settings.thickness?.distance ?? 'auto',
    },
    slots: settings.slots ?? {},
    edgeWear: {
      range: settings.edgeWear?.range ?? [0.15, 0.5],
      noise: {
        scale: settings.edgeWear?.noise?.scale ?? 0.02,
        amount: settings.edgeWear?.noise?.amount ?? 0,
        seed: settings.edgeWear?.noise?.seed ?? 0,
      },
    },
    cavity: { range: settings.cavity?.range ?? [0.15, 0.5] },
    opacity: { cutoff: settings.opacity?.cutoff ?? 0.5 },
    ...(settings.wrap === undefined ? {} : { wrap: settings.wrap }),
    ...(analytic === undefined ? {} : { analytic }),
    ...(resample === undefined
      ? {}
      : {
          resample: {
            width: resample.shape.extent.width,
            height: resample.shape.extent.height,
          },
        }),
  });
}

function resampleBytes(texture: TextureAsset): Result<Uint8Array, ModelingError> {
  const { width, height } = texture.shape.extent;
  const data = texture.data;
  if (
    texture.shape.viewDimension !== '2d' ||
    (texture.format !== 'rgba8unorm' && texture.format !== 'rgba8unorm-srgb') ||
    !(data instanceof Uint8Array) ||
    data.length < width * height * 4
  ) {
    return err(
      modelingError(
        'model-invalid-argument',
        'the resample texture is a 2d rgba8unorm(-srgb) texture with its texel bytes',
        { format: texture.format, viewDimension: texture.shape.viewDimension },
      ),
    );
  }
  return ok(data.subarray(0, width * height * 4));
}

/** One baked map as a texture asset (rows follow v, as the Renderer samples them). */
function textureOf(
  map: BakeMapKind,
  values: Float32Array,
  params: BakeJobParams,
  mips: boolean,
  resample: TextureAsset | undefined,
): Result<TextureAsset, ModelingError> {
  const { w: width, h: height } = gridOf(params);
  const at = (x: number, y: number) => (y * width + x) * 4;
  switch (map) {
    case 'normal':
    case 'normalObject':
      return packFloat32Texture(width, height, values, { colorSpace: 'linear', mips }, 'normal');
    case 'height':
      if (params.height.bits === 16) {
        return ok(r16Texture(width, height, (x, y) => values[at(x, y)] as number, mips));
      }
      break;
    case 'resample': {
      const source = resample as TextureAsset;
      return ok({
        kind: 'texture',
        format: source.format,
        colorSpace: source.colorSpace,
        shape: { viewDimension: '2d', extent: { width, height } },
        mips: { kind: 'none' },
        data: Uint8Array.from(values, (v) => Math.max(0, Math.min(255, Math.round(v * 255)))),
      } as TextureAsset);
    }
    default:
      break;
  }
  if (map === 'materialId') {
    return packFloat32Texture(width, height, values, { colorSpace: 'srgb', mips }, 'id');
  }
  return packFloat32Texture(
    width,
    height,
    values,
    {
      colorSpace: map === 'baseColor' ? 'srgb' : 'linear',
      mips,
      ...(map === 'opacity' ? { alphaCutoff: params.opacity.cutoff } : {}),
    },
    'color',
  );
}

const floats = (bytes: Uint8Array) =>
  new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

/**
 * Bake `maps` from `detail` onto `base` in place (CPU, the TS `bake` job). The texture
 * target returns one texture per map, optionally stored through `texture`; the vertex
 * target returns per-corner colors and the base with the first map as vertex colors.
 */
export function bakeMaps(options: BakeOptions): Result<BakeResult, ModelingError> {
  const request = bakeRequest(options);
  if (!request.ok) return request;
  const p = request.value.params;
  const canRust =
    shouldUseRustBake(options.backend, options.compute) &&
    options.native === undefined &&
    options.budget === undefined &&
    options.cache === undefined &&
    p.target === 'texture' &&
    p.analytic === undefined &&
    p.maps.every(isRustBakeMapKind) &&
    !(p.wrap && (typeof p.wrap.u === 'object' || typeof p.wrap.v === 'object'));
  if (canRust) {
    const work = new WorkMeter(DEFAULT_WORK_BUDGET, options.signal);
    const prepared = prepareBake(request.value, work, { deferDetailBvh: true });
    if (!prepared.ok) return prepared;
    const rustCorr = bakeCorrespondWithRustKernel(prepared.value);
    if (!rustCorr.ok) return rustCorr;
    try {
      const out = evaluateBakeMapsWithRustKernel(rustCorr.value, p);
      if (!out.ok) return out;
      const backendIdentity = `${tsBakeBackend.identity}/rust-wasm/1`;
      const { metrics, ...rest } = out.value;
      return bakeResult(options, request.value, {
        ...rest,
        report: {
          backend: tsBakeBackend.name,
          backendIdentity,
          quality: tsBakeBackend.quality('bake'),
          cacheKey: computeCacheKey(request.value, backendIdentity),
          metrics: { ...metrics, work: work.units },
        },
      });
    } finally {
      rustCorr.value.corr.dispose();
    }
  }
  const job = runComputeJob(request.value, tsBakeBackend, {
    policy: options.compute ?? 'auto',
    ...(options.native === undefined ? {} : { native: options.native }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.cache === undefined ? {} : { cache: options.cache }),
  });
  if (!job.ok) return job;
  return bakeResult(options, request.value, job.value);
}

/**
 * Bake with host-owned WebGPU texture filtering. The CPU still owns sampling and
 * diagnostics. Unsupported atlas shapes fall back to the ordinary CPU filter.
 */
export async function bakeMapsWithGpu(
  options: BakeOptions,
  device: GPUDevice,
): Promise<Result<BakeResult, ModelingError>> {
  if (options.compute === 'native' || options.compute === 'ts') return bakeMaps(options);
  const request = bakeRequest(options);
  if (!request.ok) return request;
  const work = new WorkMeter(options.budget ?? DEFAULT_WORK_BUDGET, options.signal);
  const prepared = prepareBake(request.value, work, {
    deferDetailBvh: options.budget === undefined && getModelingKernelWasm() !== undefined,
  });
  if (!prepared.ok) return prepared;
  if (options.budget === undefined) {
    const gpuOut = await runBakeCorrespondGpu(device, prepared.value, work, options.mips ?? true);
    if (gpuOut !== undefined) {
      if (!gpuOut.ok) return gpuOut;
      if (!work.spend(0)) return err(work.failure as ModelingError);
      const backendIdentity = `${tsBakeBackend.identity}/webgpu-correspond-jfa/1`;
      const { metrics, ...rest } = gpuOut.value.output;
      return bakeResult(
        options,
        request.value,
        {
          ...rest,
          report: {
            backend: tsBakeBackend.name,
            backendIdentity,
            quality: tsBakeBackend.quality('bake'),
            cacheKey: computeCacheKey(request.value, backendIdentity),
            metrics: { ...metrics, work: work.units },
          },
        },
        gpuOut.value.prepackedTextures,
      );
    }
  }
  ensureGroupBvhs(prepared.value);
  const params = request.value.params;
  const grid = gridOf(params);
  const ao =
    options.budget === undefined &&
    params.target === 'texture' &&
    params.analytic === undefined &&
    !grid.u &&
    !grid.v &&
    !params.maps.includes('opacity')
      ? prepareBakeOcclusion(device, prepared.value, grid.w, grid.h)
      : undefined;
  const rows =
    params.target === 'texture'
      ? bakeRows(prepared.value, allRows(params), work, ao?.sampleGroups)
      : ok(undefined);
  if (!rows.ok) return rows;
  let backendIdentity = tsBakeBackend.identity;
  if (ao !== undefined && rows.value !== undefined) {
    await ao.apply(rows.value);
    backendIdentity += '/webgpu-ao/1';
  }
  const out = await finishBakeWithFilter(
    prepared.value,
    rows.value === undefined ? [] : [rows.value],
    work,
    async (input) => {
      const filtered = await filterBakeTexture(device, input);
      if (filtered !== undefined) backendIdentity += '/webgpu-uv-filter/1';
      return filtered;
    },
  );
  if (!out.ok) return out;
  if (!work.spend(0)) return err(work.failure as ModelingError);
  const { metrics, ...rest } = out.value;
  return bakeResult(options, request.value, {
    ...rest,
    report: {
      backend: tsBakeBackend.name,
      backendIdentity,
      quality: tsBakeBackend.quality('bake'),
      cacheKey: computeCacheKey(request.value, backendIdentity),
      metrics: { ...metrics, work: work.units },
    },
  });
}

/** A failure crossing a thread boundary as plain data; `bakeMapsParallel` rebuilds the `ModelingError`. */
export interface BakeFailure {
  readonly code: ModelingErrorCode;
  readonly expected: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly hint: string;
}

/**
 * Samples tile rows of one bake elsewhere, such as Worker threads (`bakeWorkers` in
 * `@forgeax/engine-modeling/tools`): every tile row of `rows` once, each prepared from
 * the same request, so the parts assemble to the serial bytes.
 */
export type BakeExecutor = (
  request: ComputeJobRequest<'bake'>,
  rows: readonly number[],
  options: { readonly budget: number; readonly signal?: { readonly aborted: boolean } },
) => Promise<
  | { readonly ok: true; readonly parts: readonly BakeRows[]; readonly work: number }
  | { readonly ok: false; readonly failure: BakeFailure }
>;

/**
 * `bakeMaps` with its tile rows sampled by `executor`: the texture target splits
 * across Workers and assembles byte-identical to the serial bake (rows are independent
 * and every part is merged by position). The vertex target and the TS-only policy run
 * here; `compute: 'native'` is `model-capability-unavailable` as in `bakeMaps`.
 */
export async function bakeMapsParallel(
  options: BakeOptions,
  executor: BakeExecutor,
): Promise<Result<BakeResult, ModelingError>> {
  const request = bakeRequest(options);
  if (!request.ok) return request;
  if (options.compute === 'native') {
    return err(
      modelingError('model-capability-unavailable', 'a native bake backend is available', {
        kind: 'bake',
      }),
    );
  }
  const result = await parallelBakeJob(request.value, options, executor);
  return result.ok ? bakeResult(options, request.value, result.value) : result;
}

async function parallelBakeJob(
  request: ComputeJobRequest<'bake'>,
  options: Pick<BakeOptions, 'budget' | 'signal'>,
  executor: BakeExecutor,
): Promise<Result<ComputeJobResult<'bake'>, ModelingError>> {
  const budget = options.budget ?? DEFAULT_WORK_BUDGET;
  const work = new WorkMeter(budget, options.signal);
  const fail = (cause: ModelingError) =>
    err(
      modelingError(
        cause.code,
        cause.expected,
        {
          ...cause.detail,
          backend: tsBakeBackend.name,
          backendIdentity: tsBakeBackend.identity,
          work: work.units,
        },
        cause.hint,
      ),
    );
  const prepared = prepareBake(request, work);
  if (!prepared.ok) return fail(prepared.error);
  let parts: readonly BakeRows[] = [];
  if (request.params.target === 'texture') {
    const sampled = await executor(request, allRows(request.params), {
      budget: budget - work.units,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!sampled.ok) {
      const f = sampled.failure;
      return fail(modelingError(f.code, f.expected, { ...f.detail }, f.hint));
    }
    if (!work.spend(sampled.work)) return fail(work.failure as ModelingError);
    parts = sampled.parts;
  }
  const out = finishBake(prepared.value, parts, work);
  if (!out.ok) return fail(out.error);
  const { metrics, ...rest } = out.value;
  return ok({
    ...rest,
    report: {
      backend: tsBakeBackend.name,
      backendIdentity: tsBakeBackend.identity,
      quality: tsBakeBackend.quality('bake'),
      cacheKey: computeCacheKey(request, tsBakeBackend.identity),
      metrics: { ...metrics, work: work.units },
    },
  });
}

/** `x` rounded up to three significant digits (a hint's number never undershoots the measurement). */
function ceil3(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return 0;
  let scale = 1;
  while (x * scale < 100) scale *= 10;
  while (x * scale >= 1000) scale /= 10;
  return Math.ceil(x * scale - 1e-6) / scale;
}

const SPLIT_HINT =
  'or bake the feature as its own group (tags.groupPrefix) with a cage that covers it';

function clipHint(c: BakeClipCluster, g: BakeGroupReport): string {
  if (c.side === 'below') {
    return `raise the ray distance maxRay to ${ceil3(g.maxRay + c.worst)} m or more (now ${g.maxRay}) so rays reach the detail ${ceil3(c.worst)} m past the cage end, ${SPLIT_HINT}`;
  }
  return `raise the cage offset to ${ceil3(g.offset + c.worst)} m or more (now ${g.offset}) and maxRay to ${ceil3(g.maxRay + c.worst)} m to keep the cage end, the detail stands ${ceil3(c.worst)} m past the cage start, ${SPLIT_HINT}`;
}

function clipGroupHint(g: BakeGroupReport): string {
  const worst = (side: BakeClipCluster['side']) =>
    maxOf(g.clipClusters.filter((c) => c.side === side).map((c) => c.worst));
  const above = g.clipClusters.some((c) => c.side === 'above');
  const reach = maxOf(g.clipClusters.map((c) => c.worst));
  const steps = [
    ...(above ? [`raise the cage offset to ${ceil3(g.offset + worst('above'))} m or more`] : []),
    `raise maxRay to ${ceil3(g.maxRay + reach)} m or more`,
  ];
  return `${steps.join(' and ')}, ${SPLIT_HINT}; each cluster names its feature`;
}

function strayHint(c: BakeStrayCluster): string {
  return `remove this floater island from the detail (it floats ${ceil3(c.gap)} m off the base), tag its faces tags.floater if it is meant to float, or move it to its own bake group (tags.groupPrefix)`;
}

const STRAY_GROUP_HINT =
  'remove each floater island named in clusters from the detail, tag it tags.floater if it is meant to float, or move it to its own bake group (tags.groupPrefix)';

/** Option shape: `true` admits any value, a nested shape only its keys, `{ record }` any key whose value has that shape. */
type OptionShape = {
  readonly [key: string]: true | OptionShape | { readonly record: OptionShape | true };
};

const CAGE_SHAPE = { offset: true, maxRay: true } as const;
const SETTINGS_SHAPE: OptionShape = {
  maps: true,
  resolution: true,
  target: true,
  cage: CAGE_SHAPE,
  direction: true,
  tags: { groupPrefix: true, floater: true },
  groups: { record: { cage: CAGE_SHAPE, direction: true } },
  gutter: true,
  protectMip: true,
  samples: true,
  filter: true,
  normals: true,
  detailNormals: true,
  ao: {
    rays: true,
    bias: true,
    distance: true,
    scope: true,
    exclude: true,
    attenuation: true,
    floor: true,
    denoise: true,
  },
  height: { bits: true, range: true },
  position: { bounds: true },
  thickness: { rays: true, distance: true },
  slots: {
    record: {
      materialId: true,
      baseColor: true,
      roughness: true,
      metallic: true,
      emissive: true,
      emissiveIntensity: true,
    },
  },
  edgeWear: { range: true, noise: { scale: true, amount: true, seed: true } },
  cavity: { range: true },
  opacity: { cutoff: true },
  wrap: { u: true, v: true },
  mips: true,
  analytic: { verify: true, patches: true, domain: true },
  compute: true,
  backend: true,
  budget: true,
};
const OPTIONS_SHAPE: OptionShape = {
  ...SETTINGS_SHAPE,
  base: true,
  detail: true,
  resample: true,
  signal: true,
  native: true,
  cache: true,
  texture: true,
  key: true,
};
const { target: _target, compute: _compute, ...SOURCE_SETTINGS } = SETTINGS_SHAPE;
const SOURCE_SHAPE: OptionShape = { ...SOURCE_SETTINGS, base: true, detail: true, key: true };

/** The first option path the shape does not name (audit A9: misspelt or removed options were ignored). */
function unknownOption(value: unknown, shape: OptionShape, path: string): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  for (const [key, inner] of Object.entries(value)) {
    const spec = shape[key];
    const at = path === '' ? key : `${path}.${key}`;
    if (spec === undefined) return inner === undefined ? undefined : at;
    if (spec === true) continue;
    if ('record' in spec && typeof spec.record === 'object') {
      if (inner === null || typeof inner !== 'object') continue;
      for (const [id, entry] of Object.entries(inner)) {
        const found = unknownOption(entry, spec.record as OptionShape, `${at}.${id}`);
        if (found !== undefined) return found;
      }
      continue;
    }
    const found = unknownOption(inner, spec as OptionShape, at);
    if (found !== undefined) return found;
  }
  return undefined;
}

function rejectUnknown(options: unknown, shape: OptionShape): ModelingError | undefined {
  const option = unknownOption(options, shape, '');
  if (option === undefined) return undefined;
  const top = Object.keys(shape).sort();
  return modelingError(
    'model-invalid-argument',
    'every bake option is one the bake reads',
    { option, options: top },
    'check the spelling against BakeOptions; the cage reach is cage.offset / cage.maxRay, the AO reach ao.distance',
  );
}

/** The bake job request of `bakeMaps` options: snapshots, resample bytes and resolved params. */
function bakeRequest(options: BakeOptions): Result<ComputeJobRequest<'bake'>, ModelingError> {
  const unknown = rejectUnknown(options, OPTIONS_SHAPE);
  if (unknown !== undefined) return err(unknown);
  const base = snapshotOf(options.base, 'base');
  if (!base.ok) return base;
  const detail = snapshotOf(options.detail, 'detail');
  if (!detail.ok) return detail;
  const inputs = [base.value, detail.value];
  if (options.resample !== undefined) {
    const bytes = resampleBytes(options.resample);
    if (!bytes.ok) return bytes;
    inputs.push(bytes.value);
  }
  const analytic = analyticOf(options, options.base, options.detail)?.params;
  const params = jobParams(options, inputs.slice(0, 2), options.resample, analytic);
  if (!params.ok) return params;
  return ok({ kind: 'bake', inputs, params: params.value });
}

/** Textures or vertex colors, references and diagnostics of a finished bake job. */
function bakeResult(
  options: BakeOptions,
  request: ComputeJobRequest<'bake'>,
  job: ComputeJobResult<'bake'>,
  prepackedTextures?: Partial<Record<BakeMapKind, TextureAsset>>,
): Result<BakeResult, ModelingError> {
  const base = { value: request.inputs[0] as Uint8Array };
  const params = { value: request.params };
  const { outputs, provenance, report } = job;
  const p = params.value;
  const textures: Partial<Record<BakeMapKind, TextureAsset>> = {};
  const references: Partial<Record<BakeMapKind, TextureReference>> = {};
  const vertexColors: Partial<Record<BakeMapKind, Float32Array>> = {};
  let colored: Uint8Array | undefined;
  for (const [k, map] of p.maps.entries()) {
    if (p.target === 'vertex') {
      vertexColors[map] = floats(outputs[k] as Uint8Array);
      continue;
    }
    const prepacked = prepackedTextures?.[map];
    if (prepacked !== undefined) {
      textures[map] = prepacked;
      if (options.texture !== undefined) {
        references[map] = options.texture(`${options.key ?? 'bake'}-${map}`, prepacked);
      }
      continue;
    }
    const values = floats(outputs[k] as Uint8Array);
    const texture = textureOf(map, values, p, options.mips ?? true, options.resample);
    if (!texture.ok) return texture;
    textures[map] = texture.value;
    if (options.texture !== undefined) {
      references[map] = options.texture(`${options.key ?? 'bake'}-${map}`, texture.value);
    }
  }
  if (p.target === 'vertex') {
    const mesh = decodeSnapshot(base.value);
    if (!mesh.ok) return mesh;
    const first = vertexColors[p.maps[0] as BakeMapKind] as Float32Array;
    let i = 0;
    for (const f of mesh.value.faces()) {
      for (const h of mesh.value.faceHalves(f)) {
        mesh.value.setCorner('color', h, first.subarray(i * 4, i * 4 + 4));
        i++;
      }
    }
    colored = encodeSnapshot(mesh.value);
  }
  const issues: Issue<BakeTimeCheck>[] = [];
  for (const g of provenance.groups) {
    if (g.samples > 0 && (g.rayHits / g.samples < RAY_HIT_WARN || g.missClusters.length > 0)) {
      issues.push({
        code: 'ray-miss',
        severity: 'warn',
        detail: {
          subject: g.id,
          samples: g.samples,
          rayHits: g.rayHits,
          nearest: g.nearest,
          clusters: g.missClusters,
        },
      });
    }
  }
  for (const g of provenance.groups) {
    const flat = g.branches.flat;
    if (g.samples > 0 && flat / g.samples > FLAT_SHARE_WARN) {
      issues.push({
        code: 'ray-miss',
        severity: 'warn',
        detail: {
          subject: g.id,
          check: 'flat-fallback',
          samples: g.samples,
          flat,
          share: flat / g.samples,
          threshold: FLAT_SHARE_WARN,
        },
      });
    }
  }
  for (const g of provenance.groups) {
    if (g.clipped > 0) {
      issues.push({
        code: 'cage-clip',
        severity: 'warn',
        detail: {
          subject: g.id,
          samples: g.samples,
          clipped: g.clipped,
          offset: g.offset,
          maxRay: g.maxRay,
          clusters: g.clipClusters.map((c) => ({ ...c, hint: clipHint(c, g) })),
          hint: clipGroupHint(g),
        },
      });
    }
  }
  for (const g of provenance.groups) {
    if (g.stray.samples > 0) {
      issues.push({
        code: 'stray-detail',
        severity: 'warn',
        detail: {
          subject: g.id,
          parts: g.stray.parts,
          gap: g.stray.gap,
          samples: g.stray.samples,
          clusters: g.stray.clusters.map((c) => ({ ...c, hint: strayHint(c) })),
          hint: STRAY_GROUP_HINT,
        },
      });
    }
  }
  for (const g of provenance.groups) {
    if (g.steepArea > STEEP_WARN) {
      issues.push({
        code: 'steep-wall',
        severity: 'warn',
        detail: { subject: g.id, steepArea: g.steepArea },
      });
    }
  }
  const bleeding = provenance.bleed
    .slice(0, p.protectMip)
    .map((blocks, level) => ({ level: level + 1, blocks }))
    .filter((b) => b.blocks > 0);
  if (bleeding.length > 0) {
    issues.push({
      code: 'mip-bleed',
      severity: 'warn',
      detail: { protectMip: p.protectMip, bleeding },
    });
  }
  const stack = provenance.stack;
  const [inner, outer] = provenance.heightRange;
  // A few severe conflicts (a small asymmetric bump on one stacked shell) fail below the ratio.
  const severe =
    stack.conflicts >= STACK_SEVERE_SAMPLES &&
    (stack.maxAngle >= STACK_SEVERE_ANGLE ||
      stack.maxHeight >= STACK_SEVERE_HEIGHT * (outer - inner));
  if (stack.conflicts > STACK_RATIO * stack.samples || severe) {
    issues.push({
      code: 'stack-conflict',
      severity: 'warn',
      detail: {
        subject: stack.face,
        samples: stack.samples,
        conflicts: stack.conflicts,
        maxAngle: stack.maxAngle,
        maxHeight: stack.maxHeight,
      },
    });
  }
  if (provenance.handedness.samples > 0) {
    issues.push({
      code: 'tangent-seam',
      severity: 'warn',
      detail: { subject: provenance.handedness.face, samples: provenance.handedness.samples },
    });
  }
  const analytic = provenance.analytic;
  for (const m of analytic?.mismatches ?? []) {
    issues.push({
      code: 'analytic-mismatch',
      severity: 'warn',
      detail: {
        subject: m.patch,
        group: m.group,
        map: m.map,
        worst: m.worst,
        tolerance: m.tolerance,
        count: m.count,
      },
    });
  }
  const coverage =
    textures.opacity === undefined ? undefined : coverageIssue(textures.opacity, p.opacity.cutoff);
  if (coverage !== undefined) issues.push(coverage);
  const diagnostics: OpDiagnostic[] = [];
  diagnostics.push({
    severity: 'info',
    message: `bake (${p.maps.join(', ')}) sampled ${provenance.covered} ${p.target === 'texture' ? 'texel(s)' : 'vertices'} on the ${report.backend} backend (${report.quality})`,
    detail: { metrics: report.metrics, cacheKey: report.cacheKey, materials: provenance.materials },
  });
  const analyticNote = analyticOf(options, options.base, options.detail);
  if (analytic !== undefined) {
    const share =
      analytic.analyticSamples / Math.max(1, analytic.analyticSamples + analytic.raySamples);
    diagnostics.push({
      severity: 'info',
      message: `analytic bake: ${analytic.analyticSamples} sub-sample(s) exact, ${analytic.raySamples} on rays (${(share * 100).toFixed(1)} % exact), verify ${analytic.verify}${analytic.mismatches.length > 0 ? `, ${analytic.mismatches.length} mismatch(es) ray-baked` : ''}`,
      detail: {
        analyticSamples: analytic.analyticSamples,
        raySamples: analytic.raySamples,
        maps: analytic.maps,
        groups: analytic.groups,
        mismatches: analytic.mismatches,
      },
    });
  } else if (analyticNote?.skipped !== undefined) {
    diagnostics.push({
      severity: 'info',
      message: `analytic bake skipped, every map is ray-baked: ${analyticNote.skipped}`,
      detail: { reason: analyticNote.skipped },
    });
  }
  return ok({
    textures,
    references,
    vertexColors,
    ...(colored === undefined ? {} : { colored }),
    report,
    provenance,
    pass: issues.every((i) => i.severity === 'info'),
    issues,
    diagnostics,
  });
}

// ---- Pack: PackCookSource + NativeCooker -------------------------------------------

/** Pack custom-source kind and NativeCooker key of a deferred bake. */
export const BAKE_COOK_KIND = 'modeling-bake';
const SOURCE_VERSION = 1;

/** The serialized source of one deferred map: JSON only, so every transport keeps it. */
export interface BakeCookSource {
  readonly version: typeof SOURCE_VERSION;
  readonly map: BakeMapKind;
  readonly params: BakeJobParams;
  readonly mips: boolean;
  readonly base: string;
  readonly detail: string;
}

export interface BakeSourceOptions extends Omit<BakeSettings, 'target' | 'compute'> {
  readonly base: Model | Uint8Array;
  readonly detail: Model | Uint8Array;
  /** Output key prefix: maps become `texture/<key>-<map>`. */
  readonly key: string;
}

/**
 * Pack outputs that bake `maps` at cook time: `texture/<key>-<map>` -> a
 * `modeling-bake` PackCookSource. The cooker runs the same `bake` job once for all
 * maps of a source and publishes each as an ordinary texture asset, so materials
 * reference `texture/<key>-<map>` by GUID. Register `createBakeCooker()` in the
 * project's build plugin (`nativeCookers`).
 */
export function bakeSources(
  options: BakeSourceOptions,
): Result<Record<string, PackCookSource>, ModelingError> {
  const unknown = rejectUnknown(options, SOURCE_SHAPE);
  if (unknown !== undefined) return err(unknown);
  if (options.maps.includes('resample')) {
    return err(
      modelingError(
        'model-invalid-argument',
        'deferred bakes have no resample map',
        { maps: options.maps },
        'resample with bakeMaps in the build, or bake the source texture first',
      ),
    );
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(options.key)) {
    return err(
      modelingError('model-invalid-argument', 'key is a lower-case Pack source key segment', {
        key: options.key,
      }),
    );
  }
  const base = snapshotOf(options.base, 'base');
  if (!base.ok) return base;
  const detail = snapshotOf(options.detail, 'detail');
  if (!detail.ok) return detail;
  const params = jobParams(
    { ...options, target: 'texture' },
    [base.value, detail.value],
    undefined,
    analyticOf({ ...options, target: 'texture' }, options.base, options.detail)?.params,
  );
  if (!params.ok) return params;
  const encoded = { base: toBase64(base.value), detail: toBase64(detail.value) };
  const out: Record<string, PackCookSource> = {};
  for (const map of params.value.maps) {
    const source: BakeCookSource = {
      version: SOURCE_VERSION,
      map,
      params: params.value,
      mips: options.mips ?? true,
      ...encoded,
    };
    out[`texture/${options.key}-${map.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`] =
      { kind: BAKE_COOK_KIND, execution: 'cooked', source };
  }
  return ok(out);
}

function parseSource(source: unknown): BakeCookSource {
  const s = source as Partial<BakeCookSource> | null;
  if (
    s === null ||
    typeof s !== 'object' ||
    s.version !== SOURCE_VERSION ||
    typeof s.map !== 'string' ||
    !BAKE_MAP_KINDS.includes(s.map) ||
    typeof s.params !== 'object' ||
    s.params === null ||
    !Array.isArray(s.params.maps) ||
    !s.params.maps.includes(s.map) ||
    typeof s.mips !== 'boolean' ||
    typeof s.base !== 'string' ||
    typeof s.detail !== 'string' ||
    Object.keys(s).some((k) => !['version', 'map', 'params', 'mips', 'base', 'detail'].includes(k))
  ) {
    throw new TypeError(
      `${BAKE_COOK_KIND}: the source is { version: ${SOURCE_VERSION}, map, params, mips, base, detail } from bakeSources()`,
    );
  }
  return s as BakeCookSource;
}

export interface BakeCookInput {
  readonly guid: string;
  readonly source: unknown;
}

/**
 * The `modeling-bake` NativeCooker: decodes a `bakeSources` entry, runs the bake job on
 * the TS backend (one run per distinct base, detail and settings; later maps of the
 * same bake reuse it) and returns the map as an ordinary texture payload. An optional
 * row executor shares bakeMapsParallel's exact kernel and returns asynchronously;
 * that path retains the per-cooker map memo, while job ByteCache reuse stays serial. A failed bake
 * throws, so the cook transaction keeps its last-known-good texture.
 */
export function createBakeCooker(
  options: { readonly budget?: number; readonly executor?: BakeExecutor } = {},
): NativeCooker<TextureAsset, BakeCookInput> {
  const memo = new Map<string, Map<BakeMapKind, Float32Array>>();
  return {
    key: BAKE_COOK_KIND,
    cacheIdentity: () => tsBakeBackend.identity,
    cook(input, context): NativeCookDraft<TextureAsset> | Promise<NativeCookDraft<TextureAsset>> {
      if (typeof input?.guid !== 'string' || input.guid.length === 0) {
        throw new TypeError(`${BAKE_COOK_KIND}: the cook input carries its asset GUID`);
      }
      const source = parseSource(input.source);
      const base = fromBase64(source.base);
      const detail = fromBase64(source.detail);
      if (base === undefined || detail === undefined) {
        throw new TypeError(`${BAKE_COOK_KIND}: base and detail are base64 FXEM`);
      }
      const request = { kind: 'bake' as const, inputs: [base, detail], params: source.params };
      const key = computeCacheKey(request, tsBakeBackend.identity);
      const textureFor = (maps: Map<BakeMapKind, Float32Array>): NativeCookDraft<TextureAsset> => {
        const texture = textureOf(
          source.map,
          maps.get(source.map) as Float32Array,
          source.params,
          source.mips,
          undefined,
        );
        if (!texture.ok) throw new TypeError(`${texture.error.code}: ${texture.error.message}`);
        return {
          guid: input.guid,
          payload: texture.value,
          refs: [],
          artifacts: {},
          inputFingerprint: `${key}:${source.map}:${source.mips ? 'mips' : 'base'}`,
        };
      };
      const retained = memo.get(key);
      if (retained !== undefined) return textureFor(retained);
      const remember = (job: Result<ComputeJobResult<'bake'>, ModelingError>) => {
        if (!job.ok) throw new TypeError(`${job.error.code}: ${job.error.message}`);
        const maps = new Map(
          source.params.maps.map((m, k) => [m, floats(job.value.outputs[k] as Uint8Array)]),
        );
        memo.clear();
        memo.set(key, maps);
        return textureFor(maps);
      };
      if (options.executor !== undefined) {
        return parallelBakeJob(request, options, options.executor).then(remember);
      }
      return remember(
        runComputeJob(request, tsBakeBackend, {
          policy: 'ts',
          ...(options.budget === undefined ? {} : { budget: options.budget }),
          ...(context?.cache === undefined ? {} : { cache: context.cache }),
        }),
      );
    },
  };
}

// ---- Decomposed Atoms: Cage Plan, Correspondence, Map Evaluation, and Lowpoly Bake ----

export interface BakeCageOptions {
  readonly base: Model | Uint8Array;
  readonly detail: Model | Uint8Array;
  readonly cage?: Partial<BakeCage>;
  readonly direction?: BakeDirection;
  readonly tags?: { readonly groupPrefix?: string; readonly floater?: string };
  readonly groups?: Readonly<Record<string, BakeGroupSettings>>;
  readonly normals?: NormalMode;
  readonly detailNormals?: NormalMode;
  readonly ao?: BakeSettings['ao'];
  readonly thickness?: BakeSettings['thickness'];
  readonly height?: BakeSettings['height'];
  readonly position?: BakeSettings['position'];
  readonly wrap?: BakeSettings['wrap'];
  readonly backend?: 'auto' | 'rust' | 'ts';
}

export interface BakeCageStrayPart {
  readonly gap: number;
  readonly faces: readonly number[];
  readonly bounds: BakeBounds;
}

export interface BakeCageGroupPlan {
  readonly id: string;
  readonly offset: number;
  readonly maxRay: number;
  readonly aoDistance: number;
  readonly thicknessDistance: number;
  readonly direction: BakeDirection;
  readonly detailTriangles: number;
  readonly steepArea: number;
  readonly strayParts: number;
  readonly strayGap: number;
  readonly strayInfo: readonly BakeCageStrayPart[];
}

export interface BakeCagePlan {
  readonly diagonal: number;
  readonly heightRange: readonly [number, number];
  readonly positionBounds: BakeBounds;
  readonly emissiveScale: number;
  readonly uvReady: boolean;
  readonly groups: readonly BakeCageGroupPlan[];
  readonly strayParts: number;
  readonly maxSteepArea: number;
  readonly issues: readonly Issue<BakeTimeCheck>[];
  readonly pass: boolean;
}

const CAGE_PLAN_SHAPE: OptionShape = {
  base: true,
  detail: true,
  cage: CAGE_SHAPE,
  direction: true,
  tags: { groupPrefix: true, floater: true },
  groups: { record: { cage: CAGE_SHAPE, direction: true } },
  normals: true,
  detailNormals: true,
  ao: {
    rays: true,
    bias: true,
    distance: true,
    scope: true,
    exclude: true,
    attenuation: true,
    floor: true,
    denoise: true,
  },
  thickness: { rays: true, distance: true },
  height: { bits: true, range: true },
  position: { bounds: true },
  wrap: { u: true, v: true },
  backend: true,
};

/**
 * Preflight cage distances, direction fields, stray floating parts, and steep-wall fractions
 * per bake group before running UV rasterization or raycasting.
 */
export function resolveBakeCages(options: BakeCageOptions): Result<BakeCagePlan, ModelingError> {
  const unknown = rejectUnknown(options, CAGE_PLAN_SHAPE);
  if (unknown !== undefined) return err(unknown);
  const base = snapshotOf(options.base, 'base');
  if (!base.ok) return base;
  const detail = snapshotOf(options.detail, 'detail');
  if (!detail.ok) return detail;
  const synthSettings: BakeSettings = {
    maps: ['normal'],
    resolution: 64,
    ...(options.cage === undefined ? {} : { cage: options.cage }),
    ...(options.direction === undefined ? {} : { direction: options.direction }),
    ...(options.tags === undefined ? {} : { tags: options.tags }),
    ...(options.groups === undefined ? {} : { groups: options.groups }),
    ...(options.normals === undefined ? {} : { normals: options.normals }),
    ...(options.detailNormals === undefined ? {} : { detailNormals: options.detailNormals }),
    ...(options.ao === undefined ? {} : { ao: options.ao }),
    ...(options.thickness === undefined ? {} : { thickness: options.thickness }),
    ...(options.height === undefined ? {} : { height: options.height }),
    ...(options.position === undefined ? {} : { position: options.position }),
    ...(options.wrap === undefined ? {} : { wrap: options.wrap }),
    ...(options.backend === undefined ? {} : { backend: options.backend }),
  };
  const params = jobParams(synthSettings, [base.value, detail.value], undefined, undefined);
  if (!params.ok) return params;
  let plan = resolveBakeCagePlan(
    { kind: 'bake', inputs: [base.value, detail.value], params: params.value },
    { allowMissingUv: true },
  );
  if (!plan.ok) return plan;
  if (shouldUseRustBake(options.backend, undefined)) {
    plan = resolveBakeCagesWithRustKernel(base.value, detail.value, params.value, plan.value);
    if (!plan.ok) return plan;
  }
  const groups: BakeCageGroupPlan[] = plan.value.groups.map((g) => ({
    id: g.id,
    offset: g.offset,
    maxRay: g.maxRay,
    aoDistance: g.aoDistance,
    thicknessDistance: g.thicknessDistance,
    direction: g.direction,
    detailTriangles: g.triangles,
    steepArea: g.steep,
    strayParts: g.strayParts,
    strayGap: g.strayGap,
    strayInfo: g.strayInfo.map((info) => ({
      gap: info.gap,
      faces: [...info.faces],
      bounds: info.bounds,
    })),
  }));
  const issues: Issue<BakeTimeCheck>[] = [];
  for (const g of groups) {
    if (g.steepArea > STEEP_WARN) {
      issues.push({
        code: 'steep-wall',
        severity: 'warn',
        detail: { subject: g.id, steepArea: g.steepArea },
      });
    }
    if (g.strayParts > 0) {
      issues.push({
        code: 'stray-detail',
        severity: 'warn',
        detail: {
          subject: g.id,
          parts: g.strayParts,
          gap: g.strayGap,
          partsInfo: g.strayInfo,
          hint: STRAY_GROUP_HINT,
        },
      });
    }
  }
  return ok({
    diagonal: plan.value.diagonal,
    heightRange: plan.value.encoding.heightRange,
    positionBounds: plan.value.encoding.positionBounds,
    emissiveScale: emissiveScale(params.value.slots),
    uvReady: plan.value.uvReady,
    groups,
    strayParts: groups.reduce((n, g) => n + g.strayParts, 0),
    maxSteepArea: groups.reduce((m, g) => Math.max(m, g.steepArea), 0),
    issues,
    pass: issues.every((i) => i.severity === 'info'),
  });
}

export interface BakeCorrespondOptions {
  readonly base: Model | Uint8Array;
  readonly detail: Model | Uint8Array;
  readonly resolution: number | readonly [number, number];
  readonly cage?: Partial<BakeCage>;
  readonly direction?: BakeDirection;
  readonly tags?: { readonly groupPrefix?: string; readonly floater?: string };
  readonly groups?: Readonly<Record<string, BakeGroupSettings>>;
  readonly samples?: 1 | 4 | 9 | 16;
  readonly normals?: NormalMode;
  readonly detailNormals?: NormalMode;
  readonly height?: BakeSettings['height'];
  readonly position?: BakeSettings['position'];
  readonly wrap?: BakeSettings['wrap'];
  readonly rawCage?: boolean;
  readonly analytic?: BakeSettings['analytic'];
  readonly ao?: BakeSettings['ao'];
  readonly thickness?: BakeSettings['thickness'];
  readonly compute?: ComputePolicy;
  readonly backend?: 'auto' | 'rust' | 'ts';
  readonly budget?: number;
  readonly signal?: { readonly aborted: boolean };
}

export interface BakeEvalOptions {
  readonly maps: readonly BakeMapKind[];
  readonly filter?: 'bspline' | 'none';
  readonly gutter?: number | 'fill';
  readonly protectMip?: number;
  readonly ao?: BakeSettings['ao'];
  readonly thickness?: BakeSettings['thickness'];
  readonly slots?: BakeSettings['slots'];
  readonly edgeWear?: BakeSettings['edgeWear'];
  readonly cavity?: BakeSettings['cavity'];
  readonly height?: BakeSettings['height'];
  readonly position?: BakeSettings['position'];
  readonly opacity?: BakeSettings['opacity'];
  readonly resample?: TextureAsset;
  readonly mips?: boolean;
  readonly texture?: TextureSink;
  readonly key?: string;
  readonly budget?: number;
  readonly signal?: { readonly aborted: boolean };
}

export interface BakeCorrespondence {
  readonly version: 1;
  readonly backend: 'ts' | 'rust' | 'webgpu';
  readonly resolution: readonly [number, number];
  readonly samples: 1 | 4 | 9 | 16;
  readonly covered: number;
  readonly coverage: number;
  readonly rayHits: number;
  readonly nearest: number;
  readonly heightRange: readonly [number, number];
  readonly positionBounds: BakeBounds;
  readonly stack: BakeStack;
  readonly handedness: BakeHandedness;
  readonly groups: readonly BakeGroupReport[];
  readonly issues: readonly Issue<BakeTimeCheck>[];
  readonly pass: boolean;
  readonly cacheKey: string;
  /** @internal */
  readonly _state: {
    readonly sourceOptions: BakeOptions;
    readonly baseRequest: ComputeJobRequest<'bake'>;
    readonly workUnits: number;
    readonly cpu?: CpuCorrespondenceData;
    readonly rust?: RustBakeCorrespondenceState;
    readonly gpu?: GpuCorrespondenceData;
    readonly seedJob: ComputeJobResult<'bake'>;
  };
}

const CORRESPOND_SHAPE: OptionShape = {
  base: true,
  detail: true,
  resolution: true,
  cage: CAGE_SHAPE,
  direction: true,
  tags: { groupPrefix: true, floater: true },
  groups: { record: { cage: CAGE_SHAPE, direction: true } },
  samples: true,
  normals: true,
  detailNormals: true,
  height: { bits: true, range: true },
  position: { bounds: true },
  wrap: { u: true, v: true },
  rawCage: true,
  analytic: { verify: true, patches: true, domain: true },
  ao: {
    rays: true,
    bias: true,
    distance: true,
    scope: true,
    exclude: true,
    attenuation: true,
    floor: true,
    denoise: true,
  },
  thickness: { rays: true, distance: true },
  compute: true,
  backend: true,
  budget: true,
  signal: true,
};

const EVAL_SHAPE: OptionShape = {
  maps: true,
  filter: true,
  gutter: true,
  protectMip: true,
  ao: {
    rays: true,
    bias: true,
    distance: true,
    scope: true,
    exclude: true,
    attenuation: true,
    floor: true,
    denoise: true,
  },
  thickness: { rays: true, distance: true },
  slots: {
    record: {
      materialId: true,
      baseColor: true,
      roughness: true,
      metallic: true,
      emissive: true,
      emissiveIntensity: true,
    },
  },
  edgeWear: { range: true, noise: { scale: true, amount: true, seed: true } },
  cavity: { range: true },
  height: { bits: true, range: true },
  position: { bounds: true },
  opacity: { cutoff: true },
  resample: true,
  mips: true,
  texture: true,
  key: true,
  budget: true,
  signal: true,
};

function buildCorrespondenceHandle(
  backend: 'ts' | 'rust' | 'webgpu',
  sourceOptions: BakeOptions,
  baseRequest: ComputeJobRequest<'bake'>,
  workUnits: number,
  provenance: BakeProvenance,
  metrics: Readonly<Record<string, number>>,
  cpu?: CpuCorrespondenceData,
  gpu?: GpuCorrespondenceData,
  rust?: RustBakeCorrespondenceState,
): Result<BakeCorrespondence, ModelingError> {
  const { w, h } = gridOf(baseRequest.params);
  const backendIdentity =
    backend === 'webgpu'
      ? `${tsBakeBackend.identity}/webgpu-correspond-jfa/1`
      : backend === 'rust'
        ? `${tsBakeBackend.identity}/rust-wasm/1`
        : tsBakeBackend.identity;
  const seedJob: ComputeJobResult<'bake'> = {
    status: 'ok',
    outputs: [new Uint8Array(0)],
    provenance,
    locations: [],
    report: {
      backend: tsBakeBackend.name,
      backendIdentity,
      quality: tsBakeBackend.quality('bake'),
      cacheKey: computeCacheKey(baseRequest, backendIdentity),
      metrics: { ...metrics, work: workUnits },
    },
  };
  const dummyTex: TextureAsset = {
    kind: 'texture',
    format: 'rgba8unorm',
    colorSpace: 'linear',
    shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
    mips: { kind: 'none' },
    data: new Uint8Array(4),
  };
  const dummyEval = bakeResult(
    { ...sourceOptions, maps: ['normal'], mips: false },
    { ...baseRequest, params: { ...baseRequest.params, maps: ['normal'] } },
    seedJob,
    { normal: dummyTex },
  );
  if (!dummyEval.ok) return dummyEval;
  return ok({
    version: 1,
    backend,
    resolution: [w, h],
    samples: baseRequest.params.samples as 1 | 4 | 9 | 16,
    covered: provenance.covered,
    coverage: provenance.covered / (w * h),
    rayHits: provenance.rayHits,
    nearest: provenance.nearest,
    heightRange: provenance.heightRange,
    positionBounds: provenance.positionBounds,
    stack: provenance.stack,
    handedness: provenance.handedness,
    groups: provenance.groups,
    issues: dummyEval.value.issues,
    pass: dummyEval.value.pass,
    cacheKey: seedJob.report.cacheKey,
    _state: {
      sourceOptions,
      baseRequest,
      workUnits,
      ...(cpu === undefined ? {} : { cpu }),
      ...(rust === undefined ? {} : { rust }),
      ...(gpu === undefined ? {} : { gpu }),
      seedJob,
    },
  });
}

function gpuCorrespondenceProvenance(gpu: GpuCorrespondenceData): {
  readonly provenance: BakeProvenance;
  readonly metrics: Readonly<Record<string, number>>;
} {
  const { prepared, width, height, weight, island, counters, stack, handedness, activeCount } = gpu;
  const { groups, params, encoding } = prepared;
  const syntheticPart: BakeRows = {
    rows: [],
    sums: [],
    weight,
    island,
    point: new Float64Array(0),
    normal: new Float64Array(0),
    hits: new Float64Array(0),
    counts: Float64Array.from({ length: groups.length * 11 }, (_, idx) => {
      const g = Math.floor(idx / 11);
      const k = idx % 11;
      const src = g * 5;
      if (k === 0) return counters[src] ?? 0;
      if (k === 1) return counters[src + 1] ?? 0;
      if (k === 2) return counters[src + 2] ?? 0;
      if (k === 3) return counters[src + 3] ?? 0;
      if (k === 4) return counters[src + 4] ?? 0;
      if (k === 6) return counters[src] ?? 0;
      if (k === 7) return (counters[src + 1] ?? 0) + (counters[src + 2] ?? 0);
      return 0;
    }),
    findings: new Float64Array(0),
    stack: new Float64Array(8),
  };
  const dummyWork = new WorkMeter(DEFAULT_WORK_BUDGET);
  const done = finishBake(
    {
      ...prepared,
      params: { ...params, maps: ['normal'] },
      encoding: { ...encoding, params: { ...params, maps: ['normal'] } },
    },
    [syntheticPart],
    dummyWork,
    {
      values: [new Float32Array(0)],
      covered: activeCount,
      curvatureRange: 0,
      bleed: [],
      stack,
      handedness,
    },
  );
  if (done.ok) {
    return { provenance: done.value.provenance, metrics: done.value.metrics };
  }
  return {
    provenance: {
      covered: activeCount,
      rayHits: 0,
      nearest: 0,
      groups: [],
      materials: [],
      curvatureRange: 0,
      heightRange: encoding.heightRange,
      positionBounds: encoding.positionBounds,
      emissiveScale: 1,
      bleed: [],
      stack,
      handedness,
    },
    metrics: { covered: activeCount, coverage: activeCount / (width * height) },
  };
}

/**
 * Resolve base-to-detail primary correspondence once on CPU, producing an immutable
 * `BakeCorrespondence` reusable across any subsequent `evaluateBakeMaps` passes.
 */
export function bakeCorrespond(
  options: BakeCorrespondOptions,
): Result<BakeCorrespondence, ModelingError> {
  const unknown = rejectUnknown(options, CORRESPOND_SHAPE);
  if (unknown !== undefined) return err(unknown);
  const bakeOpts: BakeOptions = {
    ...(options as unknown as Omit<BakeOptions, 'maps'>),
    maps: ['normal'],
    mips: false,
  };
  const request = bakeRequest(bakeOpts);
  if (!request.ok) return request;
  const work = new WorkMeter(options.budget ?? DEFAULT_WORK_BUDGET, options.signal);
  const p = request.value.params;
  const canRust =
    shouldUseRustBake(options.backend, options.compute) &&
    options.budget === undefined &&
    p.target === 'texture' &&
    p.analytic === undefined &&
    !(p.wrap && (typeof p.wrap.u === 'object' || typeof p.wrap.v === 'object'));
  const prepared = prepareBake(request.value, work, canRust ? { deferDetailBvh: true } : undefined);
  if (!prepared.ok) return prepared;
  if (canRust) {
    const rustCorr = bakeCorrespondWithRustKernel(prepared.value);
    if (!rustCorr.ok) return rustCorr;
    return buildCorrespondenceHandle(
      'rust',
      bakeOpts,
      request.value,
      work.units,
      rustCorr.value.provenance,
      rustCorr.value.metrics,
      undefined,
      undefined,
      rustCorr.value,
    );
  }
  const corr = bakeCorrespondCpu(prepared.value, work);
  if (!corr.ok) return corr;
  // Run light finishBake to obtain canonical group reports & audit metrics
  const dummyWork = new WorkMeter(DEFAULT_WORK_BUDGET);
  const seedOut = evaluateBakeMapsCpu(
    corr.value,
    { ...request.value.params, maps: ['height'], filter: 'none', gutter: 0 },
    undefined,
    dummyWork,
  );
  if (!seedOut.ok) return seedOut;
  return buildCorrespondenceHandle(
    'ts',
    bakeOpts,
    request.value,
    work.units,
    seedOut.value.provenance,
    seedOut.value.metrics,
    corr.value,
  );
}

/**
 * Resolve base-to-detail primary correspondence once on WebGPU (WASM batch SAH BVH +
 * single-submission `correspondOnly` compute pass), falling back to CPU `bakeCorrespond`
 * for `samples > 1`, wrapped UVs, or analytic bakes.
 */
export async function bakeCorrespondWithGpu(
  options: BakeCorrespondOptions,
  device: GPUDevice,
): Promise<Result<BakeCorrespondence, ModelingError>> {
  if (options.compute === 'ts' || options.compute === 'native') return bakeCorrespond(options);
  const unknown = rejectUnknown(options, CORRESPOND_SHAPE);
  if (unknown !== undefined) return err(unknown);
  const bakeOpts: BakeOptions = {
    ...(options as unknown as Omit<BakeOptions, 'maps'>),
    maps: ['normal'],
    mips: false,
  };
  const request = bakeRequest(bakeOpts);
  if (!request.ok) return request;
  const work = new WorkMeter(options.budget ?? DEFAULT_WORK_BUDGET, options.signal);
  const prepared = prepareBake(request.value, work, {
    deferDetailBvh: options.budget === undefined && getModelingKernelWasm() !== undefined,
  });
  if (!prepared.ok) return prepared;
  if (options.budget === undefined) {
    const gpu = await bakeCorrespondGpu(device, prepared.value);
    if (gpu !== undefined) {
      if (!work.spend(0)) return err(work.failure as ModelingError);
      const { provenance, metrics } = gpuCorrespondenceProvenance(gpu);
      return buildCorrespondenceHandle(
        'webgpu',
        bakeOpts,
        request.value,
        work.units,
        provenance,
        metrics,
        undefined,
        gpu,
      );
    }
  }
  ensureGroupBvhs(prepared.value);
  const cpu = bakeCorrespondCpu(prepared.value, work);
  if (!cpu.ok) return cpu;
  const dummyWork = new WorkMeter(DEFAULT_WORK_BUDGET);
  const seedOut = evaluateBakeMapsCpu(
    cpu.value,
    { ...request.value.params, maps: ['height'], filter: 'none', gutter: 0 },
    undefined,
    dummyWork,
  );
  if (!seedOut.ok) return seedOut;
  return buildCorrespondenceHandle(
    'ts',
    bakeOpts,
    request.value,
    work.units,
    seedOut.value.provenance,
    seedOut.value.metrics,
    cpu.value,
  );
}

function buildEvalRequest(
  correspondence: BakeCorrespondence,
  options: BakeEvalOptions,
): Result<
  {
    readonly evalOptions: BakeOptions;
    readonly request: ComputeJobRequest<'bake'>;
    readonly resampleTex:
      | { readonly width: number; readonly height: number; readonly data: Uint8Array }
      | undefined;
  },
  ModelingError
> {
  const unknown = rejectUnknown(options, EVAL_SHAPE);
  if (unknown !== undefined) return err(unknown);
  const { sourceOptions, baseRequest } = correspondence._state;
  const evalOptions: BakeOptions = {
    ...sourceOptions,
    maps: options.maps,
    ...(options.filter === undefined ? {} : { filter: options.filter }),
    ...(options.gutter === undefined ? {} : { gutter: options.gutter }),
    ...(options.protectMip === undefined ? {} : { protectMip: options.protectMip }),
    ...(options.ao === undefined ? {} : { ao: options.ao }),
    ...(options.thickness === undefined ? {} : { thickness: options.thickness }),
    ...(options.slots === undefined ? {} : { slots: options.slots }),
    ...(options.edgeWear === undefined ? {} : { edgeWear: options.edgeWear }),
    ...(options.cavity === undefined ? {} : { cavity: options.cavity }),
    ...(options.height === undefined ? {} : { height: options.height }),
    ...(options.position === undefined ? {} : { position: options.position }),
    ...(options.opacity === undefined ? {} : { opacity: options.opacity }),
    ...(options.resample === undefined ? {} : { resample: options.resample }),
    mips: options.mips ?? true,
    ...(options.texture === undefined ? {} : { texture: options.texture }),
    ...(options.key === undefined ? {} : { key: options.key }),
  };
  let resampleBytesVal: Uint8Array | undefined;
  let resampleTex:
    | { readonly width: number; readonly height: number; readonly data: Uint8Array }
    | undefined;
  if (options.resample !== undefined) {
    const bytes = resampleBytes(options.resample);
    if (!bytes.ok) return bytes;
    resampleBytesVal = bytes.value;
    resampleTex = {
      width: options.resample.shape.extent.width,
      height: options.resample.shape.extent.height,
      data: bytes.value,
    };
  }
  const inputs =
    resampleBytesVal === undefined
      ? baseRequest.inputs.slice(0, 2)
      : [
          baseRequest.inputs[0] as Uint8Array,
          baseRequest.inputs[1] as Uint8Array,
          resampleBytesVal,
        ];
  const analytic = analyticOf(evalOptions, sourceOptions.base, sourceOptions.detail)?.params;
  const params = jobParams(evalOptions, inputs.slice(0, 2), options.resample, analytic);
  if (!params.ok) return params;
  return ok({
    evalOptions,
    request: { kind: 'bake', inputs, params: params.value },
    resampleTex,
  });
}

/**
 * Evaluate arbitrary maps (`normal`, `ao`, `curvature`, `edgeWear`, `cavity`, `ormh`, `slots`, etc.)
 * on CPU from an existing `BakeCorrespondence` without repeating UV rasterization or primary raycasts.
 */
export function evaluateBakeMaps(
  correspondence: BakeCorrespondence,
  options: BakeEvalOptions,
): Result<BakeResult, ModelingError> {
  const built = buildEvalRequest(correspondence, options);
  if (!built.ok) return built;
  const rust = correspondence._state.rust;
  if (
    rust !== undefined &&
    options.budget === undefined &&
    built.value.request.params.maps.every(isRustBakeMapKind)
  ) {
    const out = evaluateBakeMapsWithRustKernel(rust, built.value.request.params);
    if (!out.ok) return out;
    const { metrics, ...rest } = out.value;
    const backendIdentity = `${tsBakeBackend.identity}/rust-wasm/1`;
    return bakeResult(built.value.evalOptions, built.value.request, {
      ...rest,
      report: {
        backend: tsBakeBackend.name,
        backendIdentity,
        quality: tsBakeBackend.quality('bake'),
        cacheKey: computeCacheKey(built.value.request, backendIdentity),
        metrics: { ...metrics, work: 0 },
      },
    });
  }
  const work = new WorkMeter(options.budget ?? DEFAULT_WORK_BUDGET, options.signal);
  let cpu = correspondence._state.cpu;
  if (cpu === undefined && rust !== undefined) {
    ensureGroupBvhs(rust.prepared);
    const fallback = bakeCorrespondCpu(rust.prepared, work);
    if (!fallback.ok) return fallback;
    cpu = fallback.value;
  }
  if (cpu === undefined) {
    return err(
      modelingError(
        'model-invalid-argument',
        'evaluateBakeMaps expects a CPU correspondence from bakeCorrespond',
        { backend: correspondence.backend },
        'call evaluateBakeMapsWithGpu(correspondence, options, device) for a WebGPU correspondence',
      ),
    );
  }
  const out = evaluateBakeMapsCpu(cpu, built.value.request.params, built.value.resampleTex, work);
  if (!out.ok) return out;
  const { metrics, ...rest } = out.value;
  const backendIdentity = tsBakeBackend.identity;
  return bakeResult(built.value.evalOptions, built.value.request, {
    ...rest,
    report: {
      backend: tsBakeBackend.name,
      backendIdentity,
      quality: tsBakeBackend.quality('bake'),
      cacheKey: computeCacheKey(built.value.request, backendIdentity),
      metrics: { ...metrics, work: work.units },
    },
  });
}

/**
 * Evaluate arbitrary maps on WebGPU from an existing `BakeCorrespondence` without rebuilding
 * BVHs, rasterizing base UVs, or re-running primary correspondence rays (when AO is omitted,
 * no BVH buffers are even uploaded to GPU). Falls back cleanly to CPU `evaluateBakeMaps` if needed.
 */
export async function evaluateBakeMapsWithGpu(
  correspondence: BakeCorrespondence,
  options: BakeEvalOptions,
  device: GPUDevice,
): Promise<Result<BakeResult, ModelingError>> {
  const gpu = correspondence._state.gpu;
  if (gpu === undefined) return evaluateBakeMaps(correspondence, options);
  const built = buildEvalRequest(correspondence, options);
  if (!built.ok) return built;
  const work = new WorkMeter(options.budget ?? DEFAULT_WORK_BUDGET, options.signal);
  const evalPrepared = prepareEvalBake(
    gpu.prepared,
    built.value.request.params,
    built.value.resampleTex,
  );
  if (options.budget === undefined) {
    const gpuOut = await evaluateBakeMapsGpu(
      device,
      gpu,
      evalPrepared,
      work,
      built.value.evalOptions.mips ?? true,
    );
    if (gpuOut !== undefined) {
      if (!gpuOut.ok) return gpuOut;
      if (!work.spend(0)) return err(work.failure as ModelingError);
      const backendIdentity = `${tsBakeBackend.identity}/webgpu-correspond-eval/1`;
      const { metrics, ...rest } = gpuOut.value.output;
      return bakeResult(
        built.value.evalOptions,
        built.value.request,
        {
          ...rest,
          report: {
            backend: tsBakeBackend.name,
            backendIdentity,
            quality: tsBakeBackend.quality('bake'),
            cacheKey: computeCacheKey(built.value.request, backendIdentity),
            metrics: { ...metrics, work: work.units },
          },
        },
        gpuOut.value.prepackedTextures,
      );
    }
  }
  const cpuFallback = bakeCorrespond({
    ...(correspondence._state.sourceOptions as BakeCorrespondOptions),
  });
  if (!cpuFallback.ok) return cpuFallback;
  return evaluateBakeMaps(cpuFallback.value, options);
}

export interface BakeLowpolyOptions {
  readonly detail: Model;
  /** Optional explicit low-poly base. When omitted, derived non-destructively from `detail`. */
  readonly base?: Model;
  readonly key?: string;
  readonly lowpoly?: Omit<LowpolyOptions, 'uv'>;
  readonly maps?: readonly BakeMapKind[];
  readonly resolution?: number | readonly [number, number];
  readonly normals?: NormalMode;
  readonly detailNormals?: NormalMode;
  readonly tags?: { readonly groupPrefix?: string; readonly floater?: string };
  readonly groups?: Readonly<Record<string, BakeGroupSettings>>;
  readonly cage?: Partial<BakeCage>;
  readonly direction?: BakeDirection;
  readonly gutter?: number | 'fill';
  readonly protectMip?: number;
  readonly samples?: 1 | 4 | 9 | 16;
  readonly filter?: 'bspline' | 'none';
  readonly ao?: BakeSettings['ao'];
  readonly thickness?: BakeSettings['thickness'];
  readonly slots?: BakeSettings['slots'];
  readonly edgeWear?: BakeSettings['edgeWear'];
  readonly cavity?: BakeSettings['cavity'];
  readonly height?: BakeSettings['height'];
  readonly position?: BakeSettings['position'];
  readonly opacity?: BakeSettings['opacity'];
  readonly wrap?: BakeSettings['wrap'];
  readonly mips?: boolean;
  readonly view?: { readonly distance: number; readonly fov?: number; readonly height?: number };
  readonly texture?: TextureSink;
  readonly compute?: ComputePolicy;
  readonly backend?: 'auto' | 'rust' | 'ts';
  readonly budget?: number;
  readonly signal?: { readonly aborted: boolean };
}

export interface BakeLowpolyResult {
  readonly base: Model;
  readonly mesh: MeshAsset;
  readonly assetKey: string;
  readonly textures: Partial<Record<BakeMapKind, TextureAsset>>;
  readonly references: Partial<Record<BakeMapKind, TextureReference>>;
  readonly cagePlan: BakeCagePlan;
  readonly correspondence: BakeCorrespondence;
  readonly validation: ValidationReport;
  readonly bake: BakeResult;
  readonly pass: boolean;
  readonly issues: readonly (Issue<ValidationCode> | Issue<BakeTimeCheck>)[];
  readonly diagnostics: readonly OpDiagnostic[];
}

const BAKE_LOWPOLY_SHAPE: OptionShape = {
  ...CORRESPOND_SHAPE,
  ...EVAL_SHAPE,
  lowpoly: {
    union: { mode: true, voxelSize: true },
    targetFaces: true,
    hardAngle: true,
    silhouette: { views: true, weight: true },
    slivers: true,
    quads: true,
    tags: { groupPrefix: true, preserveGroups: true },
    roles: true,
  },
  view: { distance: true, fov: true, height: true },
  key: true,
};

function prepareLowpolyStage(options: BakeLowpolyOptions): Result<
  {
    readonly base: Model;
    readonly key: string;
    readonly normals: NormalMode;
    readonly resolution: number | readonly [number, number];
    readonly maps: readonly BakeMapKind[];
    readonly protectMip: number;
    readonly validation: ValidationReport;
    readonly cagePlan: BakeCagePlan;
    readonly correspondOpts: BakeCorrespondOptions;
    readonly evalOpts: BakeEvalOptions;
    readonly diagnostics: readonly OpDiagnostic[];
  },
  ModelingError
> {
  const unknown = rejectUnknown(options, BAKE_LOWPOLY_SHAPE);
  if (unknown !== undefined) return err(unknown);
  const key = options.key ?? 'model';
  const maps = options.maps ?? (['normal', 'ormh', 'baseColor', 'ao'] as const);
  const resolution = options.resolution ?? 1024;
  const minRes = typeof resolution === 'number' ? resolution : minOf(resolution);
  const protectMip = options.protectMip ?? defaultProtectMip(minRes);
  const hardAngle = options.lowpoly?.hardAngle ?? 45;
  const normals: NormalMode = options.normals ?? { mode: 'autoSmooth', angle: hardAngle };
  const diagnostics: OpDiagnostic[] = [];

  let base: Model;
  if (options.base !== undefined) {
    base = model(options.backend === undefined ? undefined : { backend: options.backend });
    const copy = base.append(options.base);
    if (copy.status !== 'ok' || base.poisoned !== undefined) {
      return err(
        base.poisoned ??
          modelingError('model-precondition', 'base model is valid', { status: copy.status }),
      );
    }
  } else {
    base = model(options.backend === undefined ? undefined : { backend: options.backend });
    const copy = base.append(options.detail);
    if (copy.status !== 'ok' || base.poisoned !== undefined) {
      return err(
        base.poisoned ??
          modelingError('model-precondition', 'detail model is valid for lowpoly derivation', {}),
      );
    }
    const floaterTag = options.tags?.floater;
    if (floaterTag !== undefined) {
      base.delete(sel.tag(floaterTag).atLeast(0));
      if (base.poisoned !== undefined) return err(base.poisoned);
    }
    const detailInspect = base.inspect();
    const defaultTarget = Math.max(24, Math.min(2000, Math.round(detailInspect.faces * 0.25)));
    const groupPrefix = options.lowpoly?.tags?.groupPrefix ?? options.tags?.groupPrefix;
    const lowReport = base.lowpoly(sel.all(), {
      ...options.lowpoly,
      targetFaces: options.lowpoly?.targetFaces ?? defaultTarget,
      hardAngle,
      roles: options.lowpoly?.roles ?? 'form',
      ...(groupPrefix === undefined
        ? {}
        : { tags: { groupPrefix, preserveGroups: options.lowpoly?.tags?.preserveGroups ?? true } }),
      uv: { resolution: minRes, padding: { mips: protectMip } },
    });
    if (lowReport.diagnostics !== undefined) pushAll(diagnostics, lowReport.diagnostics);
    if (lowReport.status !== 'ok' || base.poisoned !== undefined) {
      return err(
        base.poisoned ??
          modelingError('model-precondition', 'lowpoly derivation succeeded', {
            report: lowReport.diagnostics,
          }),
      );
    }
  }

  const validation = base.validate({
    bake: {
      checks: BAKE_CHECKS,
      normals,
      ...(options.view === undefined ? {} : { view: options.view }),
    },
    shells: {},
    uniqueUv: true,
  });

  const cageOpts: BakeCageOptions = {
    base,
    detail: options.detail,
    normals,
    ...(options.detailNormals === undefined ? {} : { detailNormals: options.detailNormals }),
    ...(options.cage === undefined ? {} : { cage: options.cage }),
    ...(options.direction === undefined ? {} : { direction: options.direction }),
    ...(options.tags === undefined ? {} : { tags: options.tags }),
    ...(options.groups === undefined ? {} : { groups: options.groups }),
    ...(options.ao === undefined ? {} : { ao: options.ao }),
    ...(options.thickness === undefined ? {} : { thickness: options.thickness }),
    ...(options.height === undefined ? {} : { height: options.height }),
    ...(options.position === undefined ? {} : { position: options.position }),
    ...(options.wrap === undefined ? {} : { wrap: options.wrap }),
    ...(options.backend === undefined ? {} : { backend: options.backend }),
  };
  const cagePlan = resolveBakeCages(cageOpts);
  if (!cagePlan.ok) return cagePlan;

  const correspondOpts: BakeCorrespondOptions = {
    base,
    detail: options.detail,
    resolution,
    normals,
    ...(options.detailNormals === undefined ? {} : { detailNormals: options.detailNormals }),
    ...(options.cage === undefined ? {} : { cage: options.cage }),
    ...(options.direction === undefined ? {} : { direction: options.direction }),
    ...(options.tags === undefined ? {} : { tags: options.tags }),
    ...(options.groups === undefined ? {} : { groups: options.groups }),
    ...(options.samples === undefined ? {} : { samples: options.samples }),
    ...(options.ao === undefined ? {} : { ao: options.ao }),
    ...(options.thickness === undefined ? {} : { thickness: options.thickness }),
    ...(options.height === undefined ? {} : { height: options.height }),
    ...(options.position === undefined ? {} : { position: options.position }),
    ...(options.wrap === undefined ? {} : { wrap: options.wrap }),
    ...(options.compute === undefined ? {} : { compute: options.compute }),
    ...(options.backend === undefined ? {} : { backend: options.backend }),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const evalOpts: BakeEvalOptions = {
    maps,
    protectMip,
    key,
    ...(options.filter === undefined ? {} : { filter: options.filter }),
    ...(options.gutter === undefined ? {} : { gutter: options.gutter }),
    ...(options.ao === undefined ? {} : { ao: options.ao }),
    ...(options.thickness === undefined ? {} : { thickness: options.thickness }),
    ...(options.slots === undefined ? {} : { slots: options.slots }),
    ...(options.edgeWear === undefined ? {} : { edgeWear: options.edgeWear }),
    ...(options.cavity === undefined ? {} : { cavity: options.cavity }),
    ...(options.height === undefined ? {} : { height: options.height }),
    ...(options.position === undefined ? {} : { position: options.position }),
    ...(options.opacity === undefined ? {} : { opacity: options.opacity }),
    ...(options.mips === undefined ? {} : { mips: options.mips }),
    ...(options.texture === undefined ? {} : { texture: options.texture }),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };

  return ok({
    base,
    key,
    normals,
    resolution,
    maps,
    protectMip,
    validation,
    cagePlan: cagePlan.value,
    correspondOpts,
    evalOpts,
    diagnostics,
  });
}

function finalizeLowpolyStage(
  stage: Extract<ReturnType<typeof prepareLowpolyStage>, { ok: true }>['value'],
  correspondence: BakeCorrespondence,
  bake: BakeResult,
): Result<BakeLowpolyResult, ModelingError> {
  const { base, key, normals, validation, cagePlan, diagnostics } = stage;
  const assetKey = `mesh/${key}`;
  const finished = base.finish({ key, normals });
  if (!finished.ok) return finished;
  const mesh = finished.value[assetKey] as MeshAsset;
  const issues: (Issue<ValidationCode> | Issue<BakeTimeCheck>)[] = [
    ...validation.issues,
    ...bake.issues,
  ];
  return ok({
    base,
    mesh,
    assetKey,
    textures: bake.textures,
    references: bake.references,
    cagePlan,
    correspondence,
    validation,
    bake,
    pass: validation.pass && bake.pass,
    issues,
    diagnostics: [...diagnostics, ...bake.diagnostics],
  });
}

/**
 * End-to-end non-destructive high-to-low authoring pipeline (CPU):
 * derives low-poly `base` (unless explicitly supplied) preserving `bake:<id>` groups and
 * dropping `detail`/`tool`/`floater` faces -> aligns sharp edges & `uv.auto` padding to
 * `protectMip` -> validates `BAKE_CHECKS` / `shells` / `uniqueUv` -> preflights cages ->
 * runs `bakeCorrespond` + `evaluateBakeMaps` -> exports `MeshAsset` with matching tangent frame.
 */
export function bakeLowpoly(options: BakeLowpolyOptions): Result<BakeLowpolyResult, ModelingError> {
  const stage = prepareLowpolyStage(options);
  if (!stage.ok) return stage;
  const correspondence = bakeCorrespond(stage.value.correspondOpts);
  if (!correspondence.ok) return correspondence;
  const bake = evaluateBakeMaps(correspondence.value, stage.value.evalOpts);
  if (!bake.ok) return bake;
  return finalizeLowpolyStage(stage.value, correspondence.value, bake.value);
}

/**
 * End-to-end non-destructive high-to-low authoring pipeline executed on WebGPU (`bakeCorrespondWithGpu`
 * + `evaluateBakeMapsWithGpu`) with exact CPU tangent/validation/export semantics.
 */
export async function bakeLowpolyWithGpu(
  options: BakeLowpolyOptions,
  device: GPUDevice,
): Promise<Result<BakeLowpolyResult, ModelingError>> {
  const stage = prepareLowpolyStage(options);
  if (!stage.ok) return stage;
  const correspondence = await bakeCorrespondWithGpu(stage.value.correspondOpts, device);
  if (!correspondence.ok) return correspondence;
  const bake = await evaluateBakeMapsWithGpu(correspondence.value, stage.value.evalOpts, device);
  if (!bake.ok) return bake;
  return finalizeLowpolyStage(stage.value, correspondence.value, bake.value);
}
