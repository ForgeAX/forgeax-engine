import type { NativeCookDraft, NativeCooker } from '@forgeax/engine-pack/native-cooker';
import type { PackCookSource } from '@forgeax/engine-pack/source';
import { type ByteCache, err, ok, type Result, type TextureAsset } from '@forgeax/engine-types';
import { maxOf, minOf } from './arrays';
import type { BAKE_CHECKS, BakeCheck } from './bake-checks';
import { fromBase64, toBase64 } from './base64';
import {
  allRows,
  BAKE_MAP_KINDS,
  type BakeRows,
  diagonalOf,
  finishBake,
  gridOf,
  prepareBake,
  tsBakeBackend,
} from './compute/bake-ts';
import {
  type BakeCage,
  type BakeClipCluster,
  type BakeDirection,
  type BakeGroupReport,
  type BakeGroupSettings,
  type BakeJobNormals,
  type BakeJobParams,
  type BakeMapKind,
  type BakeProvenance,
  type BakeSlot,
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
import type { TextureReference, TextureSink } from './materials';
import type { Model } from './model';
import type { OpDiagnostic } from './ops';
import type { Issue } from './report';
import { idTexture, normalTexture, r16Texture, textureFrom } from './texture';
import { defaultProtectMip } from './uv';

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
  readonly compute?: ComputePolicy;
  /** Work units before `model-work-budget`. */
  readonly budget?: number;
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
      return normalTexture(
        width,
        height,
        (x, y) => {
          const o = at(x, y);
          return [
            (values[o] as number) * 2 - 1,
            (values[o + 1] as number) * 2 - 1,
            (values[o + 2] as number) * 2 - 1,
          ];
        },
        { mips },
      );
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
  const texel = (x: number, y: number) => {
    const o = at(x, y);
    return [
      values[o] as number,
      values[o + 1] as number,
      values[o + 2] as number,
      values[o + 3] as number,
    ] as const;
  };
  if (map === 'materialId') return idTexture(width, height, texel, mips);
  return textureFrom(width, height, texel, {
    colorSpace: map === 'baseColor' ? 'srgb' : 'linear',
    mips,
    ...(map === 'opacity' ? { alphaCutoff: params.opacity.cutoff } : {}),
  });
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
  const prepared = prepareBake(request.value, work);
  if (!prepared.ok) return fail(prepared.error);
  let parts: readonly BakeRows[] = [];
  if (request.value.params.target === 'texture') {
    const sampled = await executor(request.value, allRows(request.value.params), {
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
  return bakeResult(options, request.value, {
    ...rest,
    report: {
      backend: tsBakeBackend.name,
      backendIdentity: tsBakeBackend.identity,
      quality: tsBakeBackend.quality('bake'),
      cacheKey: computeCacheKey(request.value, tsBakeBackend.identity),
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
  compute: true,
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
  const params = jobParams(options, inputs.slice(0, 2), options.resample);
  if (!params.ok) return params;
  return ok({ kind: 'bake', inputs, params: params.value });
}

/** Textures or vertex colors, references and diagnostics of a finished bake job. */
function bakeResult(
  options: BakeOptions,
  request: ComputeJobRequest<'bake'>,
  job: ComputeJobResult<'bake'>,
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
    const values = floats(outputs[k] as Uint8Array);
    if (p.target === 'vertex') {
      vertexColors[map] = values;
      continue;
    }
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
    if (g.samples > 0 && g.rayHits / g.samples < RAY_HIT_WARN) {
      issues.push({
        code: 'ray-miss',
        severity: 'warn',
        detail: { subject: g.id, samples: g.samples, rayHits: g.rayHits },
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
  const coverage =
    textures.opacity === undefined ? undefined : coverageIssue(textures.opacity, p.opacity.cutoff);
  if (coverage !== undefined) issues.push(coverage);
  const diagnostics: OpDiagnostic[] = [];
  diagnostics.push({
    severity: 'info',
    message: `bake (${p.maps.join(', ')}) sampled ${provenance.covered} ${p.target === 'texture' ? 'texel(s)' : 'vertices'} on the ${report.backend} backend (${report.quality})`,
    detail: { metrics: report.metrics, cacheKey: report.cacheKey, materials: provenance.materials },
  });
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
  if (!/^[\w-]+$/.test(options.key)) {
    return err(
      modelingError('model-invalid-argument', 'key is letters, digits, _ or -', {
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
    out[`texture/${options.key}-${map}`] = { kind: BAKE_COOK_KIND, execution: 'cooked', source };
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
 * same bake reuse it) and returns the map as an ordinary texture payload. A failed bake
 * throws, so the cook transaction keeps its last-known-good texture.
 */
export function createBakeCooker(
  options: { readonly budget?: number } = {},
): NativeCooker<TextureAsset, BakeCookInput> {
  const memo = new Map<string, Map<BakeMapKind, Float32Array>>();
  return {
    key: BAKE_COOK_KIND,
    cacheIdentity: () => tsBakeBackend.identity,
    cook(input, context): NativeCookDraft<TextureAsset> {
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
      let maps = memo.get(key);
      if (maps === undefined) {
        const job = runComputeJob(request, tsBakeBackend, {
          policy: 'ts',
          ...(options.budget === undefined ? {} : { budget: options.budget }),
          ...(context?.cache === undefined ? {} : { cache: context.cache }),
        });
        if (!job.ok) {
          throw new TypeError(`${job.error.code}: ${job.error.message}`);
        }
        maps = new Map(
          source.params.maps.map((m, k) => [m, floats(job.value.outputs[k] as Uint8Array)]),
        );
        memo.clear();
        memo.set(key, maps);
      }
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
    },
  };
}
