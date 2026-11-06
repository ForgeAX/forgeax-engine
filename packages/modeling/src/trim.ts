import { err, ok, type Result, type TextureAsset } from '@forgeax/engine-types';
import { maxOf, minOf, pushAll } from './arrays';
import { type BakeResult, bakeMaps, DEFAULT_DETAIL_NORMALS } from './bake';
import {
  emissiveScale,
  materialIdError,
  resolveMaterialId,
  resolveSlot,
  tsBakeBackend,
} from './compute/bake-ts';
import {
  type BakeMapKind,
  type BakeSlot,
  type ComputeJobReport,
  type ComputePolicy,
  computeCacheKey,
} from './compute/job';
import { sha256 } from './compute/sha256';
import { cos, sin } from './dmath';
import { type ModelingError, modelingError } from './errors';
import type { NormalMode } from './finish';
import { decodeSnapshot } from './fxem';
import { triangulateLoop } from './geom';
import type { TextureReference, TextureSink } from './materials';
import { type Model, model } from './model';
import type { OpDiagnostic } from './ops';
import type { Issue } from './report';
import { sel } from './selectors';
import { decodeSrgb, idTexture, normalTexture, textureFrom } from './texture';
import { defaultProtectMip, paddingTexels, type UvPadding } from './uv';

/**
 * Trim sheets: one shared texture whose regions hold baked or
 * stamped detail modules. A module is the pair of a form (the flat region a
 * runtime quad maps into with `m.uv.trim`) and a detail source (a high-poly mesh baked
 * onto the plane, an analytic height field, or a flat swatch). `trimSheet` lays the
 * regions out (pure and cheap: generators read the regions without baking);
 * `bakeTrimSheet` produces the textures.
 *
 * Module space: s along +x, t along +y, the module plane z = 0 facing +z, the lower-left
 * corner at the origin. Region texels: x along u, rows along v (rows follow v, as the
 * Renderer samples them), so a quad mapped by `uv.trim` gets the tangent frame the
 * module was baked in.
 *
 * Reuse: a module may declare scale buckets and detail variants, a
 * family of regions `uv.trim` chooses from per instance; modules with one canonical
 * signature share one region (dedupe), and `trimReport` measures how the meshes use them.
 */

/** 'none': a cell; 'u': a strip spanning the sheet width that repeats along u (sample with repeat addressing). */
export type TrimTiling = 'none' | 'u';

/** A high-poly detail baked onto the module plane (the `bake` job through `bakeMaps`). */
export interface TrimMeshSource {
  readonly kind: 'mesh';
  /** Detail in module space; it stays read-only. */
  readonly detail: Model | Uint8Array;
  /**
   * A plate at z = 0 under the detail so every ray finds a surface (slot 'trim-base';
   * `{ material }` names it). Default: a plate when the detail lies on or above z = 0,
   * none when it reaches below (a detail with grooves or holes brings its own surface,
   * which the plate would cover).
   */
  readonly backing?: boolean | { readonly material: string };
}

/** A height field stamped directly into the region: no rays, no cage (milliseconds). */
export interface TrimAnalyticSource {
  readonly kind: 'analytic';
  /** Height above the module plane in meters at module point (s, t); called at any real s, t. */
  readonly height: (s: number, t: number) => number;
  /**
   * Tangent-space normal of the surface at (s, t), any length (default: from the height
   * gradient). Give it when the field has cliffs: the surface a sample lands on then
   * shades it, as a ray bake sees it, instead of a finite difference across the wall.
   */
  readonly normal?: (s: number, t: number) => readonly [number, number, number];
  /** Material slot for the material-id map: one name or a name per point (default 'trim-base'). */
  readonly material?: string | ((s: number, t: number) => string);
}

/** A flat region (recess filler, color swatch): the plane itself. */
export interface TrimFlatSource {
  readonly kind: 'flat';
  readonly material?: string;
}

export type TrimSource = TrimMeshSource | TrimAnalyticSource | TrimFlatSource;

/** Which family member a source factory builds. */
export interface TrimSourceContext {
  /** Variant index in [0, variants). */
  readonly variant: number;
  /** Bucket scale relative to the module size. */
  readonly scale: number;
}

/**
 * Canonical identity of a module's detail: a generator id and its
 * parameters. Numbers compare at 5 significant digits, so M12 and M12.0001 are one
 * signature. Stamps fill it in.
 */
export interface TrimSignature {
  readonly id: string;
  readonly params: Readonly<Record<string, number | string | boolean>>;
}

export interface TrimModule {
  /** Region id: letters, digits, _ or -, unique in the sheet. */
  readonly id: string;
  /** Module extent [s, t] in meters; a strip's s is its length, which the sheet width holds. */
  readonly size: readonly [number, number];
  /** 'none' (default) or 'u' (a strip tiling along u across the whole sheet width). */
  readonly tiling?: TrimTiling;
  /** Repeat length along s in meters; it divides size[0] (tileable detail repeats exactly). */
  readonly period?: number;
  /** Texels per meter of a cell (default the sheet density); a strip derives it from its length. */
  readonly density?: number;
  /** Fixed content rectangle [x, y, w, h] in texels (a standardized layout); auto-placed otherwise. */
  readonly rect?: readonly [number, number, number, number];
  /**
   * Detail source (default flat), or a factory of one per family member. A plain source
   * is scaled with its bucket (mesh detail and analytic field alike).
   */
  readonly source?: TrimSource | ((context: TrimSourceContext) => TrimSource);
  /** Dedupe signature: modules with one signature and declaration share one region. */
  readonly signature?: TrimSignature;
  /**
   * Scale buckets relative to `size` (cells only; default [1]): one region per bucket at
   * the module density, so instances of other sizes keep their texel density (R7b
   * section 5.2: sqrt 2 steps keep instances within about 19 %).
   */
  readonly scales?: readonly number[];
  /** Detail variants per bucket (default 1; more need a source factory): clone breaking. */
  readonly variants?: number;
}

export interface TrimSheetOptions {
  /** Sheet identity: texture keys become `<key>-<map>`. */
  readonly key: string;
  /** Square sheet size in texels, an integer in [16, 4096]. */
  readonly size: number;
  /** Default texels per meter of a cell. */
  readonly density: number;
  readonly modules: readonly TrimModule[];
  /**
   * Texels between region contents (half at the sheet border, edge-padded in the bake),
   * even, or `{ mips: k }` for 2^(k+1) texels (default `{ mips: defaultProtectMip(size) }`:
   * regions stay apart down to the 128-texel level, as bake gutters do).
   */
  readonly padding?: UvPadding;
  /**
   * Texels `uv.trim` and `uv.swatch` keep clear inside every region border (default 0.5):
   * bilinear taps at an instance's edge never read a neighbor or, through repeat
   * addressing, the opposite sheet edge. Strips keep it along v only.
   */
  readonly inset?: number;
  /** Region placement grid in texels, BC block aligned (default 4). */
  readonly block?: number;
  /**
   * Fill the sheet (default false). true: scale every auto-placed cell's density by the
   * largest common factor (at least 1) that still fits. `{ grow }`: then, largest cell
   * first, scale each cell further by up to `grow` (one scale bucket, at most 2), so a
   * layout whose big cells block a uniform fill still uses its free texels; region
   * densities then differ by up to `grow` (reported as `densitySpread`).
   */
  readonly fill?: boolean | { readonly grow: number };
}

/** One declared region: plain data, safe to hand to generators and journals. */
export interface TrimRegion {
  /** Key of the sheet it belongs to. */
  readonly sheet: string;
  readonly id: string;
  /** Module id of the family the region belongs to. */
  readonly family: string;
  /** Bucket scale relative to the family's module size (1 without buckets). */
  readonly scale: number;
  /** Variant index (0 without variants). */
  readonly variant: number;
  /** Sheet size in texels. */
  readonly resolution: number;
  /** Content texels [x, y, w, h]; y runs along v. */
  readonly rect: readonly [number, number, number, number];
  /** [u0, v0, u1, v1] of the content rectangle. */
  readonly uv: readonly [number, number, number, number];
  /** Module extent [s, t] in meters the content holds (the module size times the bucket scale). */
  readonly size: readonly [number, number];
  /** Texels per meter along u and v inside the inset: (w - 2 inset) / size[0], (h - 2 inset) / size[1] (strips: w / size[0]). */
  readonly density: readonly [number, number];
  readonly tiling: TrimTiling;
  readonly period?: number;
  /** Dedupe key of the content (signature or mesh digest, declaration, bucket, variant); absent for unkeyed analytic sources. */
  readonly key?: string;
  /** Texels uv.trim keeps clear inside the border (the sheet's `inset`). */
  readonly inset: number;
}

export interface TrimSheetMetrics {
  /** Content texels over sheet texels. */
  readonly utilization: number;
  /** Texels reserved by contents plus their padding, over sheet texels. */
  readonly reserved: number;
  /** Common density factor `fill` applied to auto cells (1 without fill). */
  readonly fillScale: number;
  /** Area-weighted coefficient of variation of region densities. */
  readonly densitySpread: number;
  /** Regions with their own texels (dedupe aliases excluded). */
  readonly regions: number;
  readonly strips: number;
  readonly families: number;
  /** Family members that reuse an earlier member's region (same key). */
  readonly dedupeHits: number;
  /** Keyed members with their own region. */
  readonly dedupeMisses: number;
}

/** A placed family member with its resolved source (what the bake renders). */
export interface TrimMember {
  readonly region: string;
  readonly source: TrimSource;
  /** Region id whose texels this member reuses (dedupe), if any. */
  readonly alias?: string;
}

export interface TrimSheet {
  readonly key: string;
  readonly size: number;
  readonly padding: number;
  readonly block: number;
  /** Every region by id (family members as `<id>.s<bucket>v<variant>`, the base member as `<id>`). */
  readonly regions: Readonly<Record<string, TrimRegion>>;
  /** Regions of each module, bucket-major then variant. */
  readonly families: Readonly<Record<string, readonly TrimRegion[]>>;
  /** The declared modules in declaration order. */
  readonly modules: readonly TrimModule[];
  /** Members in layout order with resolved sources (kept by reference for the bake). */
  readonly members: readonly TrimMember[];
  readonly metrics: TrimSheetMetrics;
}

const ID = /^[\w-]+$/;
/** Relative tolerance of "period divides the length". */
const DIVIDES = 1e-9;
const FILL_STEPS = 24;
/** Significant digits a signature number keeps in a dedupe key. */
const KEY_DIGITS = 5;

function invalid(expected: string, detail: Record<string, unknown>, hint?: string): ModelingError {
  return modelingError('model-invalid-argument', expected, detail, hint);
}

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Canonical JSON: sorted keys, numbers at KEY_DIGITS significant digits. */
function canonical(value: unknown): string {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(Number(value.toPrecision(KEY_DIGITS))) : String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const digest = (text: string) => sha256(new TextEncoder().encode(text)).slice(0, 16);

/** Occupancy of the block grid; `free` answers rectangle queries through a summed-area table. */
class BlockGrid {
  readonly cells: Uint8Array;
  private sums: Int32Array;
  private dirty = true;
  readonly n: number;

  constructor(n: number) {
    this.n = n;
    this.cells = new Uint8Array(n * n);
    this.sums = new Int32Array((n + 1) * (n + 1));
  }
  mark(x: number, y: number, w: number, h: number): void {
    for (let j = Math.max(0, y); j < Math.min(this.n, y + h); j++) {
      for (let i = Math.max(0, x); i < Math.min(this.n, x + w); i++) this.cells[j * this.n + i] = 1;
    }
    this.dirty = true;
  }
  private refresh(): void {
    const n = this.n;
    const s = this.sums;
    for (let j = 0; j < n; j++) {
      let row = 0;
      for (let i = 0; i < n; i++) {
        row += this.cells[j * n + i] as number;
        s[(j + 1) * (n + 1) + i + 1] = (s[j * (n + 1) + i + 1] as number) + row;
      }
    }
    this.dirty = false;
  }
  free(x: number, y: number, w: number, h: number): boolean {
    if (this.dirty) this.refresh();
    const n1 = this.n + 1;
    const s = this.sums;
    return (
      (s[(y + h) * n1 + x + w] as number) -
        (s[y * n1 + x + w] as number) -
        (s[(y + h) * n1 + x] as number) +
        (s[y * n1 + x] as number) ===
      0
    );
  }
  /** Lowest row, then lowest column, where a w x h block rectangle is free. */
  firstFit(w: number, h: number): [number, number] | undefined {
    for (let y = 0; y + h <= this.n; y++) {
      for (let x = 0; x + w <= this.n; x++) if (this.free(x, y, w, h)) return [x, y];
    }
    return undefined;
  }
}

/** One family member to place: a module at one bucket and variant. */
interface Declared {
  readonly module: TrimModule;
  readonly id: string;
  readonly tiling: TrimTiling;
  /** Texels per meter (cells: before the fill factor). */
  readonly density: number;
  readonly scale: number;
  readonly variant: number;
  /** Member size in meters (module size times scale). */
  readonly size: readonly [number, number];
  readonly source: TrimSource;
  readonly key?: string;
  /** Index of the earlier member with the same key. */
  readonly alias?: number;
}

/** A source scaled uniformly about the module origin (the bucket of a plain source). */
function scaledSource(
  source: TrimSource,
  k: number,
  id: string,
): Result<TrimSource, ModelingError> {
  if (k === 1 || source.kind === 'flat') return ok(source);
  if (source.kind === 'analytic') {
    const { height, normal, material } = source;
    return ok({
      kind: 'analytic',
      height: (s, t) => k * height(s / k, t / k),
      ...(normal === undefined ? {} : { normal: (s: number, t: number) => normal(s / k, t / k) }),
      ...(material === undefined
        ? {}
        : {
            material:
              typeof material === 'function'
                ? (s: number, t: number) => material(s / k, t / k)
                : material,
          }),
    });
  }
  const bytes = snapshotBytes(source.detail, id);
  if (!bytes.ok) return bytes;
  const m = model();
  m.append(bytes.value);
  m.scale(sel.all(), [k, k, k]);
  const failure = m.poisoned;
  if (failure !== undefined) return err(failure);
  return ok({ ...source, detail: m.snapshot() });
}

function checkSource(source: unknown, id: string): Result<TrimSource, ModelingError> {
  const kind = (source as { kind?: unknown } | undefined)?.kind;
  if (kind !== 'mesh' && kind !== 'analytic' && kind !== 'flat') {
    return err(invalid("source kind is 'mesh', 'analytic' or 'flat'", { id, kind }));
  }
  return ok(source as TrimSource);
}

/** What a member's content is, for its dedupe key; undefined when it has no identity. */
function contentIdentity(module: TrimModule, source: TrimSource): Result<unknown, ModelingError> {
  if (module.signature !== undefined) return ok({ signature: module.signature });
  if (typeof module.source === 'function') return ok(undefined);
  if (source.kind === 'flat') return ok({ flat: source.material ?? BACKING_SLOT });
  if (source.kind === 'mesh') {
    const bytes = snapshotBytes(source.detail, module.id);
    if (!bytes.ok) return bytes;
    return ok({ mesh: sha256(bytes.value), backing: source.backing ?? 'auto' });
  }
  return ok(undefined);
}

function checkModules(options: TrimSheetOptions): Result<Declared[], ModelingError> {
  const seen = new Set<string>();
  const out: Declared[] = [];
  const byKey = new Map<string, number>();
  const signatures = new Map<string, string>();
  for (const module of options.modules) {
    const id = module.id;
    if (typeof id !== 'string' || !ID.test(id)) {
      return err(invalid('a module id is letters, digits, _ or -', { id }));
    }
    if (seen.has(id)) return err(invalid('module ids are unique in a sheet', { id }));
    seen.add(id);
    const size = module.size;
    if (!Array.isArray(size) || size.length !== 2 || !size.every(positive)) {
      return err(invalid('size is two positive meter extents [s, t]', { id, size }));
    }
    const tiling = module.tiling ?? 'none';
    if (tiling !== 'none' && tiling !== 'u') {
      return err(invalid("tiling is 'none' or 'u'", { id, tiling }));
    }
    if (module.period !== undefined) {
      if (!positive(module.period)) {
        return err(invalid('period is a positive length in meters', { id, period: module.period }));
      }
      const repeats = size[0] / module.period;
      if (Math.abs(repeats - Math.round(repeats)) > DIVIDES * repeats || Math.round(repeats) < 1) {
        return err(
          invalid(
            'period divides the module length size[0] a whole number of times',
            { id, period: module.period, length: size[0], repeats },
            'pick the length as a whole number of periods, so the tiling repeats exactly',
          ),
        );
      }
    }
    if (tiling === 'u' && module.density !== undefined) {
      return err(
        invalid(
          "a 'u' strip takes its density from its length (sheet size / size[0])",
          { id, density: module.density },
          'drop density, or set size[0] to sheet size / density',
        ),
      );
    }
    if (module.density !== undefined && !positive(module.density)) {
      return err(
        invalid('density is a positive texel count per meter', { id, density: module.density }),
      );
    }
    if (tiling === 'u' && module.rect !== undefined && module.rect[2] !== options.size) {
      return err(invalid("a 'u' strip's rect spans the sheet width", { id, rect: module.rect }));
    }
    const scales = module.scales ?? [1];
    if (!Array.isArray(scales) || scales.length === 0 || !scales.every(positive)) {
      return err(invalid('scales are positive factors', { id, scales }));
    }
    if (new Set(scales).size !== scales.length) {
      return err(invalid('scales are distinct', { id, scales }));
    }
    const variants = module.variants ?? 1;
    if (!(Number.isInteger(variants) && variants >= 1 && variants <= 64)) {
      return err(invalid('variants is a whole count in [1, 64]', { id, variants }));
    }
    if (variants > 1 && typeof module.source !== 'function') {
      return err(
        invalid(
          'variants come from a source factory',
          { id, variants },
          'pass source: ({ variant, scale }) => source, so each variant differs',
        ),
      );
    }
    if (tiling === 'u' && (scales.length > 1 || scales[0] !== 1)) {
      return err(
        invalid("a 'u' strip has no scale buckets (its length is the sheet width)", { id, scales }),
      );
    }
    if (module.rect !== undefined && scales.length * variants > 1) {
      return err(invalid('a fixed rect holds one region: no buckets or variants', { id }));
    }
    const declaration = canonical({
      size,
      tiling,
      period: module.period,
      density: module.density ?? options.density,
      scales,
      variants,
    });
    if (module.signature !== undefined) {
      const signature = module.signature;
      if (
        typeof signature.id !== 'string' ||
        typeof signature.params !== 'object' ||
        signature.params === null
      ) {
        return err(invalid('signature is { id, params }', { id, signature }));
      }
      const signatureKey = canonical(signature);
      const earlier = signatures.get(signatureKey);
      if (earlier !== undefined && earlier !== declaration) {
        return err(
          invalid(
            'modules with one signature share one declaration (size, tiling, period, density, scales, variants)',
            { id, signature: signature.id },
            'declare the signature once and add sizes as scales; a second declaration would miss the dedupe',
          ),
        );
      }
      signatures.set(signatureKey, declaration);
    }
    const spread = (s: number) => Math.max(s, 1 / s);
    const base = scales.reduce(
      (best, s, i) => (spread(s) < spread(scales[best] as number) ? i : best),
      0,
    );
    for (const [b, scale] of scales.entries()) {
      for (let v = 0; v < variants; v++) {
        const raw =
          typeof module.source === 'function'
            ? module.source({ variant: v, scale })
            : (module.source ?? { kind: 'flat' as const });
        const checked = checkSource(raw, id);
        if (!checked.ok) return checked;
        const source =
          typeof module.source === 'function'
            ? ok(checked.value)
            : scaledSource(checked.value, scale, id);
        if (!source.ok) return source;
        const identity = contentIdentity(module, source.value);
        if (!identity.ok) return identity;
        const key =
          identity.value === undefined
            ? undefined
            : digest(canonical({ content: identity.value, declaration, scale, variant: v }));
        const alias = key === undefined ? undefined : byKey.get(key);
        if (key !== undefined && alias === undefined) byKey.set(key, out.length);
        out.push({
          module,
          id: b === base && v === 0 ? id : `${id}.s${b}v${v}`,
          tiling,
          density: tiling === 'u' ? options.size / size[0] : (module.density ?? options.density),
          scale,
          variant: v,
          size: [size[0] * scale, size[1] * scale],
          source: source.value,
          ...(key === undefined ? {} : { key }),
          ...(alias === undefined ? {} : { alias }),
        });
      }
    }
  }
  if (out.length === 0) return err(invalid('a sheet declares at least one module', {}));
  return ok(out);
}

interface Placed {
  readonly rect: [number, number, number, number];
}

/**
 * Place every region: fixed rects first, then strips top-down in declaration order (a
 * standardized layout keeps strip rows stable), then cells tallest first, first fit on
 * the block grid. Each content reserves `padding / 2` around it; aliases take their
 * original's rect.
 */
function layout(
  declared: readonly Declared[],
  size: number,
  padding: number,
  block: number,
  scales: readonly number[],
  inset: number,
): Result<Placed[], ModelingError> | undefined {
  const n = size / block;
  const grid = new BlockGrid(n);
  const half = padding / 2;
  const placed: (Placed | undefined)[] = declared.map(() => undefined);
  const extent = (d: Declared, i: number): [number, number] => {
    const [s, t] = d.size;
    // The inset border comes on top of the content, so the content keeps the density.
    const edge = 2 * inset;
    if (d.tiling === 'u') return [size, Math.max(1, Math.round(t * d.density + edge))];
    const k = scales[i] as number;
    return [
      Math.max(1, Math.round(s * d.density * k + edge)),
      Math.max(1, Math.round(t * d.density * k + edge)),
    ];
  };
  const reserve = (x: number, y: number, w: number, h: number, strip: boolean) => {
    const x0 = strip ? 0 : Math.floor((x - half) / block);
    const x1 = strip ? n : Math.ceil((x + w + half) / block);
    grid.mark(
      x0,
      Math.floor((y - half) / block),
      x1 - x0,
      Math.ceil((y + h + half) / block) - Math.floor((y - half) / block),
    );
  };
  for (const [i, d] of declared.entries()) {
    const rect = d.module.rect;
    if (rect === undefined) continue;
    const [x, y, w, h] = rect;
    if (
      !rect.every((v) => Number.isInteger(v)) ||
      x < 0 ||
      y < 0 ||
      w < 1 ||
      h < 1 ||
      x + w > size ||
      y + h > size
    ) {
      return err(invalid('rect is [x, y, w, h] whole texels inside the sheet', { id: d.id, rect }));
    }
    const x0 = Math.floor(x / block);
    const y0 = Math.floor(y / block);
    if (!grid.free(x0, y0, Math.ceil((x + w) / block) - x0, Math.ceil((y + h) / block) - y0)) {
      return err(invalid('fixed rects keep their padding apart', { id: d.id, rect, padding }));
    }
    reserve(x, y, w, h, d.tiling === 'u');
    placed[i] = { rect: [x, y, w, h] };
  }
  const span = (texels: number) => Math.ceil((texels + padding) / block);
  for (const [i, d] of declared.entries()) {
    if (d.tiling !== 'u' || placed[i] !== undefined || d.alias !== undefined) continue;
    const [, h] = extent(d, i);
    const rows = span(h);
    let found: number | undefined;
    for (let y = 0; y + rows <= n && found === undefined; y++)
      if (grid.free(0, y, n, rows)) found = y;
    if (found === undefined) return undefined;
    const top = found * block + half;
    reserve(0, top, size, h, true);
    placed[i] = { rect: [0, top, size, h] };
  }
  const cells = declared
    .map((d, i) => ({ d, i, e: extent(d, i) }))
    .filter(({ d, i }) => d.tiling === 'none' && placed[i] === undefined && d.alias === undefined)
    .sort((a, b) => b.e[1] - a.e[1] || b.e[0] - a.e[0] || a.i - b.i);
  for (const { i, e } of cells) {
    const [w, h] = e;
    const at = grid.firstFit(span(w), span(h));
    if (at === undefined) return undefined;
    const x = at[0] * block + half;
    const y = at[1] * block + half;
    reserve(x, y, w, h, false);
    placed[i] = { rect: [x, y, w, h] };
  }
  for (const [i, d] of declared.entries()) {
    if (d.alias !== undefined) placed[i] = placed[d.alias];
  }
  return ok(placed as Placed[]);
}

/**
 * Declare a trim sheet: validate the modules, expand their families (scale buckets x
 * variants), merge members with one dedupe key, and place their regions (strips across
 * the width in declaration order, cells by first fit on a block grid). Pure and
 * deterministic: generators call it to map faces; `bakeTrimSheet` makes the textures.
 */
export function trimSheet(options: TrimSheetOptions): Result<TrimSheet, ModelingError> {
  if (typeof options.key !== 'string' || !ID.test(options.key)) {
    return err(invalid('key is letters, digits, _ or -', { key: options.key }));
  }
  const size = options.size;
  if (!Number.isInteger(size) || size < 16 || size > 4096) {
    return err(invalid('size is an integer texel count in [16, 4096]', { size }));
  }
  if (!positive(options.density)) {
    return err(
      invalid('density is a positive texel count per meter', { density: options.density }),
    );
  }
  const block = options.block ?? 4;
  if (!Number.isInteger(block) || block < 1 || size % block !== 0) {
    return err(invalid('block is a whole texel count dividing the sheet size', { block, size }));
  }
  const padding = paddingTexels(options.padding ?? { mips: defaultProtectMip(size) });
  if (!Number.isInteger(padding) || padding < 0 || padding % 2 !== 0 || padding >= size / 4) {
    return err(
      invalid('padding is an even texel count in [0, size / 4), or { mips: k }', {
        padding: options.padding,
      }),
    );
  }
  const inset = options.inset ?? 0.5;
  if (!(Number.isFinite(inset) && inset >= 0 && inset <= padding / 2 + 0.5)) {
    return err(invalid('inset is a texel count in [0, padding / 2 + 0.5]', { inset, padding }));
  }
  const declared = checkModules(options);
  if (!declared.ok) return declared;
  const d = declared.value;
  const scales = d.map(() => 1);
  const base = layout(d, size, padding, block, scales, inset);
  if (base === undefined) {
    return err(
      modelingError(
        'model-precondition',
        `the ${d.length} region(s) fit a ${size} texel sheet at their densities with ${padding} texel padding`,
        { size, padding, regions: d.length },
        'lower the density, raise the size or split the sheet',
      ),
    );
  }
  if (!base.ok) return base;
  let placed = base.value;
  const fill = options.fill ?? false;
  const grow = typeof fill === 'object' && fill !== null ? fill.grow : 1;
  if (fill !== false && fill !== true && !(positive(grow) && grow >= 1 && grow <= 2)) {
    return err(invalid('fill is a boolean or { grow } with grow in [1, 2]', { fill }));
  }
  const auto = d.flatMap((x, i) =>
    x.tiling === 'none' && x.module.rect === undefined && x.alias === undefined ? [i] : [],
  );
  /** Largest factor in [1, limit] for `members` (on top of `scales`) that still lays out. */
  const search = (members: readonly number[], limit: number): number => {
    const attempt = (k: number) => {
      const trial = scales.map((v, i) => (members.includes(i) ? v * k : v));
      const tried = layout(d, size, padding, block, trial, inset);
      if (tried === undefined || !tried.ok) return false;
      placed = tried.value;
      return true;
    };
    let low = 1;
    let high = limit;
    if (attempt(high)) return high;
    for (let step = 0; step < FILL_STEPS; step++) {
      const mid = (low + high) / 2;
      if (attempt(mid)) low = mid;
      else high = mid;
    }
    attempt(low);
    return low;
  };
  let fillScale = 1;
  if (fill !== false && auto.length > 0) {
    fillScale = search(auto, 64);
    for (const i of auto) scales[i] = fillScale;
    if (grow > 1) {
      const area = (i: number) => {
        const x = d[i] as Declared;
        return x.size[0] * x.size[1] * x.density * x.density;
      };
      const order = [...auto].sort((a, b) => area(b) - area(a) || a - b);
      for (const i of order) scales[i] = (scales[i] as number) * search([i], grow);
      const final = layout(d, size, padding, block, scales, inset);
      if (final?.ok) placed = final.value;
    }
  }
  const regions: Record<string, TrimRegion> = {};
  const families: Record<string, TrimRegion[]> = {};
  const members: TrimMember[] = [];
  let content = 0;
  let reserved = 0;
  const densities: [number, number][] = [];
  for (const [i, x] of d.entries()) {
    const [rx, ry, w, h] = (placed[i] as Placed).rect;
    const iu = x.tiling === 'u' ? 0 : inset;
    if (w - 2 * iu <= 0 || h - 2 * inset <= 0) {
      return err(
        invalid('every region is wider and taller than twice the inset', {
          id: x.id,
          rect: [rx, ry, w, h],
          inset,
        }),
      );
    }
    const density: [number, number] = [(w - 2 * iu) / x.size[0], (h - 2 * inset) / x.size[1]];
    const region: TrimRegion = {
      sheet: options.key,
      id: x.id,
      family: x.module.id,
      scale: x.scale,
      variant: x.variant,
      resolution: size,
      rect: [rx, ry, w, h],
      uv: [rx / size, ry / size, (rx + w) / size, (ry + h) / size],
      size: [x.size[0], x.size[1]],
      density,
      tiling: x.tiling,
      ...(x.module.period === undefined ? {} : { period: x.module.period }),
      ...(x.key === undefined ? {} : { key: x.key }),
      inset,
    };
    regions[x.id] = region;
    const family = families[x.module.id];
    if (family === undefined) families[x.module.id] = [region];
    else family.push(region);
    const alias = x.alias === undefined ? undefined : (d[x.alias] as Declared).id;
    members.push({ region: x.id, source: x.source, ...(alias === undefined ? {} : { alias }) });
    if (alias !== undefined) continue;
    content += w * h;
    reserved += x.tiling === 'u' ? size * (h + padding) : (w + padding) * (h + padding);
    densities.push([(density[0] + density[1]) / 2, w * h]);
  }
  let wsum = 0;
  let mean = 0;
  let sq = 0;
  for (const [v, wt] of densities) {
    wsum += wt;
    mean += v * wt;
    sq += v * v * wt;
  }
  mean /= wsum;
  const hits = d.filter((x) => x.alias !== undefined).length;
  return ok({
    key: options.key,
    size,
    padding,
    block,
    regions,
    families,
    modules: options.modules,
    members,
    metrics: {
      utilization: content / (size * size),
      reserved: Math.min(1, reserved / (size * size)),
      fillScale,
      densitySpread: mean > 0 ? Math.sqrt(Math.max(0, sq / wsum - mean * mean)) / mean : 0,
      regions: d.length - hits,
      strips: d.filter((x) => x.tiling === 'u' && x.alias === undefined).length,
      families: Object.keys(families).length,
      dedupeHits: hits,
      dedupeMisses: d.filter((x) => x.key !== undefined && x.alias === undefined).length,
    },
  });
}

/**
 * DDC key of a sheet bake, on the bake job's `computeCacheKey` (TS backend identity =
 * kernel digest): the settings and every region's content key and rect; undefined when
 * a region has no content identity (an analytic source or factory without a signature).
 * @internal Used by the bake report and cookers.
 */
export function trimBakeKey(sheet: TrimSheet, settings: TrimBakeSettings): string | undefined {
  const parts: unknown[] = [];
  for (const member of sheet.members) {
    const region = sheet.regions[member.region] as TrimRegion;
    if (region.key === undefined) return undefined;
    parts.push([region.key, region.rect, region.tiling, region.inset]);
  }
  const {
    texture: _texture,
    signal: _signal,
    compute: _compute,
    budget: _budget,
    ...rest
  } = settings;
  // The bake job's own key scheme: the sheet content travels as the one input.
  const content = new TextEncoder().encode(
    canonical({ size: sheet.size, padding: sheet.padding, parts }),
  );
  return computeCacheKey(
    { kind: 'bake', inputs: [content], params: { trimSheet: canonical(rest) } as never },
    tsBakeBackend.identity,
  ).slice(0, 16);
}

// ---- bake --------------------------------------------------------------------------

/** The bake map kinds a trim sheet produces for every source kind (a subset of `BakeMapKind`). */
export const TRIM_MAP_KINDS = [
  'normal',
  'ao',
  'height',
  'curvature',
  'materialId',
  'baseColor',
  'emissive',
] as const satisfies readonly BakeMapKind[];
export type TrimMapKind = (typeof TRIM_MAP_KINDS)[number];

export interface TrimBakeSettings {
  readonly maps: readonly TrimMapKind[];
  /** Samples per texel, a square grid (default 4). */
  readonly samples?: 1 | 4 | 9 | 16;
  /**
   * The cage, as `bakeMaps` names it: rays start `offset` meters above the module plane
   * and travel at most `maxRay` (defaults: 1.25 x the largest relief of any module, at
   * least 1 mm, and twice that). Heights encode 0.5 + h / (2 heightRange), heightRange =
   * max(offset, maxRay - offset), for mesh and analytic modules alike.
   */
  readonly cage?: { readonly offset?: number; readonly maxRay?: number };
  /** Occlusion: rays (default 32), bias in degrees above the plane (default 15), reach (default 2 x the largest relief). */
  readonly ao?: { readonly rays?: number; readonly bias?: number; readonly distance?: number };
  /**
   * Surface per material slot (`BakeSlot`, `'*'` the fallback), the bake's one table: mesh
   * and analytic modules read it for `baseColor` and `emissive` alike.
   */
  readonly slots?: Readonly<Record<string, BakeSlot>>;
  /** Shading normals of mesh details (default autoSmooth 35 degrees, the hard-surface rule). */
  readonly detailNormals?: NormalMode;
  /**
   * Reconstruction of mesh bakes inside each region (default 'none': the box-filtered
   * supersamples analytic modules use, so both kinds filter alike; 'bspline' smooths as
   * `bakeMaps` does by default).
   */
  readonly filter?: 'bspline' | 'none';
  /** Pack box-filtered mips with each texture (default true). */
  readonly mips?: boolean;
  /** Stores each texture as `<sheet key>-<map>` and returns its reference. */
  readonly texture?: TextureSink;
  readonly compute?: ComputePolicy;
  readonly budget?: number;
  readonly signal?: { readonly aborted: boolean };
}

export interface TrimBakeReport {
  /** The `bake` job report when the sheet has mesh modules. */
  readonly bake?: ComputeJobReport;
  readonly cage: { readonly offset: number; readonly maxRay: number };
  /** Half the encoded height range in meters. */
  readonly heightRange: number;
  /** The emissive map's scale (`BakeProvenance.emissiveScale`): a material's emissive intensity. */
  readonly emissiveScale: number;
  readonly aoDistance: number;
  /** Region content texels (padding excluded). */
  readonly coveredTexels: number;
  readonly utilization: number;
  /** Source kind per region id. */
  readonly sources: Readonly<Record<string, TrimSource['kind']>>;
  /** `trimBakeKey` of this bake: the DDC key, when every region has a content key. */
  readonly cacheKey?: string;
}

export interface TrimBakeResult {
  readonly textures: Partial<Record<TrimMapKind, TextureAsset>>;
  readonly references: Partial<Record<TrimMapKind, TextureReference>>;
  /** Resolved material-id colors (linear) per encountered slot. */
  readonly materials: readonly { readonly slot: string; readonly color: readonly number[] }[];
  readonly report: TrimBakeReport;
  /** No `error` or `warn` issue in the bake of the mesh modules (always true without them). */
  readonly pass: boolean;
  /** The mesh-module bake's check issues (`BakeResult.issues`). */
  readonly issues: BakeResult['issues'];
  readonly diagnostics: readonly OpDiagnostic[];
}

const BACKING_SLOT = 'trim-base';
const HORIZON_DIRECTIONS = 8;
const HORIZON_STEPS = 8;

function snapshotBytes(detail: Model | Uint8Array, id: string): Result<Uint8Array, ModelingError> {
  if (detail instanceof Uint8Array) return ok(detail);
  const failure = detail.poisoned;
  if (failure !== undefined) {
    return err(
      modelingError(
        failure.code,
        failure.expected,
        { ...failure.detail, module: id },
        failure.hint,
      ),
    );
  }
  return ok(detail.snapshot());
}

/** Lowest and highest z of a mesh detail (module space), including 0. */
function zRange(bytes: Uint8Array): Result<[number, number], ModelingError> {
  const mesh = decodeSnapshot(bytes);
  if (!mesh.ok) return mesh;
  let lo = 0;
  let hi = 0;
  for (const v of mesh.value.vertices()) {
    const z = mesh.value.position(v)[2] as number;
    lo = Math.min(lo, z);
    hi = Math.max(hi, z);
  }
  return ok([lo, hi]);
}

/** Largest |z| of a mesh detail (module space), or of a sampled analytic height field. */
function reliefOf(
  source: TrimSource,
  region: TrimRegion,
  bytes: Uint8Array | undefined,
): Result<number, ModelingError> {
  if (source.kind === 'mesh') {
    const range = zRange(bytes as Uint8Array);
    if (!range.ok) return range;
    return ok(Math.max(-range.value[0], range.value[1]));
  }
  if (source.kind === 'analytic') {
    const [S, T] = region.size;
    // Texel centers and corners: the rasterizer never samples a finer grid.
    const nx = Math.min(2048, 2 * (region.rect[2] as number));
    const ny = Math.min(2048, 2 * (region.rect[3] as number));
    let z = 0;
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const h = source.height((i / nx) * S, (j / ny) * T);
        if (!Number.isFinite(h)) {
          return err(
            invalid('an analytic height is finite everywhere', {
              id: region.id,
              s: (i / nx) * S,
              t: (j / ny) * T,
              height: h,
            }),
          );
        }
        z = Math.max(z, Math.abs(h));
      }
    }
    return ok(z);
  }
  return ok(0);
}

/** Linear [0, 1] RGBA planes of one map over the whole sheet. */
type Plane = Float64Array;

function background(map: TrimMapKind): readonly number[] {
  switch (map) {
    case 'normal':
      return [0.5, 0.5, 1, 1];
    case 'ao':
      return [1, 1, 1, 1];
    case 'materialId':
    case 'emissive':
      return [0, 0, 0, 1];
    case 'baseColor':
      return [0, 0, 0, 0];
    case 'height':
    case 'curvature':
      return [0.5, 0.5, 0.5, 1];
  }
}

/** Preserve each baked ID's authored linear value when copying its quantized sRGB texels. */
function paletteBytes(materials: readonly { readonly color: readonly number[] }[]) {
  return materials.map(({ color }) => {
    const c = color;
    const probe = textureFrom(1, 1, () => [c[0] as number, c[1] as number, c[2] as number, 1], {
      colorSpace: 'srgb',
      mips: false,
    });
    return {
      color,
      bytes: probe.ok ? Array.from((probe.value.data as Uint8Array).subarray(0, 3)) : [0, 0, 0],
    };
  });
}

interface Field {
  readonly height: (s: number, t: number) => number;
  readonly normal?: (s: number, t: number) => readonly [number, number, number];
  readonly material: (s: number, t: number) => string;
}

function fieldOf(source: TrimSource, region: TrimRegion): Field {
  const length = region.size[0];
  const wrap = (s: number) => (region.tiling === 'u' ? s - length * Math.floor(s / length) : s);
  if (source.kind === 'analytic') {
    const { material, normal } = source;
    return {
      height: (s, t) => source.height(wrap(s), t),
      ...(normal === undefined ? {} : { normal: (s: number, t: number) => normal(wrap(s), t) }),
      material:
        typeof material === 'function'
          ? (s, t) => material(wrap(s), t)
          : () => material ?? BACKING_SLOT,
    };
  }
  const slot = source.kind === 'flat' ? (source.material ?? BACKING_SLOT) : BACKING_SLOT;
  return { height: () => 0, material: () => slot };
}

/**
 * Rasterize an analytic or flat region: tangent normals from the height gradient
 * (+x along u, +y along v, so they match quads mapped by uv.trim), cosine-weighted
 * horizon occlusion, signed height and mean curvature.
 */
function rasterizeField(
  field: Field,
  region: TrimRegion,
  maps: readonly TrimMapKind[],
  planes: ReadonlyMap<TrimMapKind, Plane>,
  materialId: (slot: string) => readonly number[],
  settings: {
    samples: number;
    heightRange: number;
    aoDistance: number;
    bias: number;
    slot: (name: string) => ReturnType<typeof resolveSlot>;
  },
  curvature: Float64Array,
): void {
  const [x0, y0, w, h] = region.rect as [number, number, number, number];
  const [S, T] = region.size as [number, number];
  const size = region.resolution;
  const iu = region.tiling === 'u' ? 0 : region.inset;
  const iv = region.inset;
  const ds = S / (w - 2 * iu);
  const dt = T / (h - 2 * iv);
  const k = Math.round(Math.sqrt(settings.samples));
  const sinBias = sin((settings.bias * Math.PI) / 180);
  const floor = sinBias * sinBias;
  const dirs: [number, number][] = [];
  for (let d = 0; d < HORIZON_DIRECTIONS; d++) {
    const a = (2 * Math.PI * d) / HORIZON_DIRECTIONS;
    dirs.push([cos(a), sin(a)]);
  }
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const o = ((y0 + j) * size + x0 + i) * 4;
      let nx = 0;
      let ny = 0;
      let nz = 0;
      let height = 0;
      for (let b = 0; b < k; b++) {
        for (let a = 0; a < k; a++) {
          const s = (i + (a + 0.5) / k - iu) * ds;
          const t = (j + (b + 0.5) / k - iv) * dt;
          if (field.normal !== undefined) {
            const n = field.normal(s, t);
            const len = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
            nx += n[0] / len;
            ny += n[1] / len;
            nz += n[2] / len;
          } else {
            const gx = (field.height(s + ds / 2, t) - field.height(s - ds / 2, t)) / ds;
            const gy = (field.height(s, t + dt / 2) - field.height(s, t - dt / 2)) / dt;
            const len = Math.sqrt(gx * gx + gy * gy + 1);
            nx += -gx / len;
            ny += -gy / len;
            nz += 1 / len;
          }
          height += field.height(s, t);
        }
      }
      height /= k * k;
      const s = (i + 0.5 - iu) * ds;
      const t = (j + 0.5 - iv) * dt;
      for (const map of maps) {
        const plane = planes.get(map) as Plane;
        switch (map) {
          case 'normal': {
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            plane.set(
              [(nx / len) * 0.5 + 0.5, (ny / len) * 0.5 + 0.5, (nz / len) * 0.5 + 0.5, 1],
              o,
            );
            break;
          }
          case 'height': {
            const v = Math.max(0, Math.min(1, 0.5 + height / (2 * settings.heightRange)));
            plane.set([v, v, v, 1], o);
            break;
          }
          case 'ao': {
            const here = field.height(s, t);
            let occluded = 0;
            for (const [cx, cy] of dirs) {
              let best = 0;
              for (let step = 1; step <= HORIZON_STEPS; step++) {
                const r = (settings.aoDistance * step) / HORIZON_STEPS;
                const rise = (field.height(s + cx * r, t + cy * r) - here) / r;
                if (rise > best) best = rise;
              }
              const sin2 = (best * best) / (1 + best * best);
              occluded += Math.max(0, sin2 - floor);
            }
            const v = 1 - occluded / dirs.length / (1 - floor);
            plane.set([v, v, v, 1], o);
            break;
          }
          case 'curvature': {
            const c =
              -(
                (field.height(s + ds, t) - 2 * field.height(s, t) + field.height(s - ds, t)) /
                  (ds * ds) +
                (field.height(s, t + dt) - 2 * field.height(s, t) + field.height(s, t - dt)) /
                  (dt * dt)
              ) / 2;
            curvature[o / 4] = c;
            break;
          }
          case 'materialId': {
            const c = materialId(field.material(s, t));
            plane.set([c[0] as number, c[1] as number, c[2] as number, 1], o);
            break;
          }
          case 'baseColor':
            plane.set(settings.slot(field.material(s, t)).baseColor, o);
            break;
          case 'emissive': {
            const e = settings.slot(field.material(s, t)).emissive;
            plane.set([e[0] as number, e[1] as number, e[2] as number, 1], o);
            break;
          }
        }
      }
    }
  }
}

/** Copy one region's content texels out of a baked (level 0, rgba8) texture into the plane. */
function copyBaked(
  map: TrimMapKind,
  texture: TextureAsset,
  region: TrimRegion,
  plane: Plane,
  palette: readonly { readonly color: readonly number[]; readonly bytes: readonly number[] }[],
): void {
  const data = texture.data as Uint8Array;
  const size = region.resolution;
  const [x0, y0, w, h] = region.rect as [number, number, number, number];
  for (let j = y0; j < y0 + h; j++) {
    for (let i = x0; i < x0 + w; i++) {
      const o = (j * size + i) * 4;
      if (map === 'materialId') {
        const gap = (bytes: readonly number[]) => {
          let d = 0;
          for (let c = 0; c < 3; c++) {
            const e = (data[o + c] as number) - (bytes[c] as number);
            d += e * e;
          }
          return d;
        };
        let color: readonly number[] = [0, 0, 0];
        let bestDistance = gap([0, 0, 0]);
        for (const candidate of palette) {
          const { bytes } = candidate;
          const d = gap(bytes);
          if (d < bestDistance) {
            bestDistance = d;
            color = candidate.color;
          }
        }
        plane.set([color[0] as number, color[1] as number, color[2] as number, 1], o);
        continue;
      }
      for (let c = 0; c < 4; c++) {
        const v = (data[o + c] as number) / 255;
        plane[o + c] = map === 'baseColor' && c < 3 ? decodeSrgb(v) : v;
      }
    }
  }
}

/** Edge padding: every texel within padding / 2 outside a region repeats its nearest content texel. */
function padRegion(region: TrimRegion, padding: number, plane: Plane): void {
  const size = region.resolution;
  const [x0, y0, w, h] = region.rect as [number, number, number, number];
  const half = padding / 2;
  const xa = region.tiling === 'u' ? 0 : Math.max(0, x0 - half);
  const xb = region.tiling === 'u' ? size : Math.min(size, x0 + w + half);
  const ya = Math.max(0, y0 - half);
  const yb = Math.min(size, y0 + h + half);
  for (let j = ya; j < yb; j++) {
    for (let i = xa; i < xb; i++) {
      if (i >= x0 && i < x0 + w && j >= y0 && j < y0 + h) continue;
      const si = Math.min(x0 + w - 1, Math.max(x0, i));
      const sj = Math.min(y0 + h - 1, Math.max(y0, j));
      const from = (sj * size + si) * 4;
      plane.copyWithin((j * size + i) * 4, from, from + 4);
    }
  }
}

/**
 * Bake a trim sheet: mesh modules through one `bakeMaps` job (each module isolated on
 * its own plane, so AO holds only self-occlusion; 'u' strips see copies of their detail
 * one length either side, so they tile), analytic and flat modules rasterized directly,
 * then edge padding around every region. Byte-deterministic.
 */
export function bakeTrimSheet(
  sheet: TrimSheet,
  settings: TrimBakeSettings,
): Result<TrimBakeResult, ModelingError> {
  const slotTable = settings.slots ?? {};
  const invalidId = materialIdError(slotTable);
  if (invalidId !== undefined) return err(invalidId);
  const maps = settings.maps;
  if (maps.length === 0 || maps.some((m) => !(TRIM_MAP_KINDS as readonly string[]).includes(m))) {
    return err(invalid(`maps are some of ${TRIM_MAP_KINDS.join(', ')}`, { maps }));
  }
  const samples = settings.samples ?? 4;
  if (![1, 4, 9, 16].includes(samples)) {
    return err(invalid('samples is 1, 4, 9 or 16', { samples }));
  }
  const size = sheet.size;
  const bytes = new Map<string, Uint8Array>();
  const own = sheet.members.filter((m) => m.alias === undefined);
  let relief = 0;
  for (const member of own) {
    if (member.source.kind === 'mesh') {
      const b = snapshotBytes(member.source.detail, member.region);
      if (!b.ok) return b;
      bytes.set(member.region, b.value);
    }
    const region = sheet.regions[member.region] as TrimRegion;
    const r = reliefOf(member.source, region, bytes.get(member.region));
    if (!r.ok) return r;
    relief = Math.max(relief, r.value);
  }
  const offset = settings.cage?.offset ?? Math.max(1e-3, 1.25 * relief);
  const maxRay = settings.cage?.maxRay ?? 2 * offset;
  const aoDistance = settings.ao?.distance ?? Math.max(1e-3, 2 * relief);
  if (!positive(offset) || !positive(aoDistance) || !(positive(maxRay) && maxRay > offset)) {
    return err(
      invalid('cage.offset and ao.distance are positive lengths, cage.maxRay above the offset', {
        cage: settings.cage,
        aoDistance,
      }),
    );
  }
  const heightRange = Math.max(offset, maxRay - offset);
  const bias = settings.ao?.bias ?? 15;
  const planes = new Map<TrimMapKind, Plane>();
  for (const map of maps) {
    const plane = new Float64Array(size * size * 4);
    const fill = background(map);
    for (let i = 0; i < size * size; i++) plane.set(fill, i * 4);
    planes.set(map, plane);
  }
  const meshMembers = own.filter((m) => m.source.kind === 'mesh');
  const diagnostics: OpDiagnostic[] = [];
  let baked: BakeResult | undefined;
  if (meshMembers.length > 0) {
    const base = model();
    const detail = model();
    const gap = 2 * (maxRay + aoDistance) + 0.01;
    let cursor = 0;
    for (const member of meshMembers) {
      const region = sheet.regions[member.region] as TrimRegion;
      const source = member.source as TrimMeshSource;
      const [S, T] = region.size;
      const ext = region.tiling === 'u' ? S : 0;
      const ox = cursor + ext;
      cursor = ox + S + ext + gap;
      const tag = `trim:${member.region}`;
      base.plane({ width: S, height: T, center: [ox + S / 2, T / 2, 0], tag });
      base.uv.trim({
        faces: sel.tag(tag),
        region,
        axis: [1, 0, 0],
        fit: { u: 'metric', v: 'metric' },
      });
      for (const shift of ext > 0 ? [-S, 0, S] : [0]) {
        detail.append(bytes.get(member.region) as Uint8Array, { translate: [ox + shift, 0, 0] });
      }
      const range = zRange(bytes.get(member.region) as Uint8Array);
      if (!range.ok) return range;
      const backing = source.backing ?? range.value[0] >= -1e-9;
      if (backing !== false) {
        const margin = Math.max(maxRay, aoDistance);
        detail.plane({
          width: S + 2 * ext + 2 * margin,
          height: T + 2 * margin,
          center: [ox + S / 2, T / 2, 0],
          material: backing === true ? BACKING_SLOT : backing.material,
        });
      }
    }
    const failed = base.poisoned ?? detail.poisoned;
    if (failed !== undefined) return err(failed);
    const result = bakeMaps({
      base,
      detail,
      maps: [...maps],
      resolution: size,
      samples,
      cage: { offset, maxRay },
      gutter: 2,
      filter: settings.filter ?? 'none',
      detailNormals: settings.detailNormals ?? DEFAULT_DETAIL_NORMALS,
      ...(settings.slots === undefined ? {} : { slots: settings.slots }),
      ao: { rays: settings.ao?.rays ?? 32, bias, distance: aoDistance, attenuation: 'none' },
      mips: false,
      ...(settings.compute === undefined ? {} : { compute: settings.compute }),
      ...(settings.budget === undefined ? {} : { budget: settings.budget }),
      ...(settings.signal === undefined ? {} : { signal: settings.signal }),
    });
    if (!result.ok) return result;
    baked = result.value;
    pushAll(diagnostics, baked.diagnostics);
  }
  const materials: { slot: string; color: readonly number[] }[] = (
    baked?.provenance.materials ?? []
  ).map((m) => ({ slot: m.slot, color: m.color }));
  const materialId = (slot: string) => {
    let material = materials.find((m) => m.slot === slot);
    if (material === undefined) {
      material = {
        slot,
        color: [...resolveMaterialId(slotTable, slot, materials.length)],
      };
      materials.push(material);
    }
    return material.color;
  };
  const palette = paletteBytes(materials);
  const glow = emissiveScale(slotTable);
  const resolved = new Map<string, ReturnType<typeof resolveSlot>>();
  const curvature = new Float64Array(maps.includes('curvature') ? size * size : 0).fill(Number.NaN);
  const analytic: TrimRegion[] = [];
  const sources: Record<string, TrimSource['kind']> = {};
  for (const member of sheet.members) {
    const region = sheet.regions[member.region] as TrimRegion;
    const kind = member.source.kind;
    sources[member.region] = kind;
    if (member.alias !== undefined) continue;
    if (kind === 'mesh') {
      for (const map of maps) {
        copyBaked(
          map,
          (baked as BakeResult).textures[map] as TextureAsset,
          region,
          planes.get(map) as Plane,
          palette,
        );
      }
      continue;
    }
    analytic.push(region);
    rasterizeField(
      fieldOf(member.source, region),
      region,
      maps,
      planes,
      materialId,
      {
        samples,
        heightRange,
        aoDistance,
        bias,
        slot: (name) => {
          let s = resolved.get(name);
          if (s === undefined) {
            s = resolveSlot(slotTable, name, glow);
            resolved.set(name, s);
          }
          return s;
        },
      },
      curvature,
    );
  }
  if (maps.includes('curvature') && analytic.length > 0) {
    let range = baked?.provenance.curvatureRange ?? 0;
    if (!(range > 0)) {
      const mags = Array.from(
        curvature.filter((c) => !Number.isNaN(c)),
        (c) => Math.abs(c),
      ).sort((a, b) => a - b);
      range = mags.length > 0 ? (mags[Math.floor((mags.length - 1) * 0.95)] as number) : 0;
      if (!(range > 0)) range = 1;
    }
    const plane = planes.get('curvature') as Plane;
    for (const region of analytic) {
      const [x0, y0, w, h] = region.rect as [number, number, number, number];
      for (let j = y0; j < y0 + h; j++) {
        for (let i = x0; i < x0 + w; i++) {
          const c = Math.max(
            0,
            Math.min(1, 0.5 + (0.5 * (curvature[j * size + i] as number)) / range),
          );
          plane.set([c, c, c, 1], (j * size + i) * 4);
        }
      }
    }
  }
  let covered = 0;
  for (const member of own) {
    const region = sheet.regions[member.region] as TrimRegion;
    covered += (region.rect[2] as number) * (region.rect[3] as number);
    for (const plane of planes.values()) padRegion(region, sheet.padding, plane);
  }
  const mips = settings.mips ?? true;
  const cacheKey = trimBakeKey(sheet, settings);
  const textures: Partial<Record<TrimMapKind, TextureAsset>> = {};
  const references: Partial<Record<TrimMapKind, TextureReference>> = {};
  for (const map of maps) {
    const plane = planes.get(map) as Plane;
    const at = (x: number, y: number) => (y * size + x) * 4;
    const rgba = (x: number, y: number) =>
      [
        plane[at(x, y)] as number,
        plane[at(x, y) + 1] as number,
        plane[at(x, y) + 2] as number,
        plane[at(x, y) + 3] as number,
      ] as const;
    const texture =
      map === 'normal'
        ? normalTexture(
            size,
            size,
            (x, y) => [
              (plane[at(x, y)] as number) * 2 - 1,
              (plane[at(x, y) + 1] as number) * 2 - 1,
              (plane[at(x, y) + 2] as number) * 2 - 1,
            ],
            { mips },
          )
        : map === 'materialId'
          ? idTexture(size, size, rgba, mips)
          : textureFrom(size, size, rgba, {
              colorSpace: map === 'baseColor' ? 'srgb' : 'linear',
              mips,
            });
    if (!texture.ok) return texture;
    textures[map] = texture.value;
    if (settings.texture !== undefined)
      references[map] = settings.texture(`${sheet.key}-${map}`, texture.value);
  }
  diagnostics.push({
    severity: 'info',
    message: `trim sheet ${sheet.key}: baked ${maps.join(', ')} for ${own.length} region(s) (${meshMembers.length} mesh, ${analytic.length} analytic or flat)`,
    detail: {
      metrics: {
        coveredTexels: covered,
        utilization: covered / (size * size),
        heightRange,
        aoDistance,
        ...(baked === undefined ? {} : { rayHitRatio: baked.report.metrics.rayHitRatio as number }),
      },
    },
  });
  return ok({
    textures,
    references,
    materials,
    report: {
      ...(baked === undefined ? {} : { bake: baked.report }),
      cage: { offset, maxRay },
      heightRange,
      emissiveScale: glow,
      aoDistance,
      coveredTexels: covered,
      utilization: covered / (size * size),
      sources,
      ...(cacheKey === undefined ? {} : { cacheKey }),
    },
    pass: baked?.pass ?? true,
    issues: baked?.issues ?? [],
    diagnostics,
  });
}

// ---- reuse report -------------------------------------------------------------

export interface TrimReportOptions {
  /** UV channel the meshes map into the sheet with (default uv0). */
  readonly channel?: 'uv0' | 'uv1';
  /** Instances above which a family without variation is reported as clones (BK-V7, default 8). */
  readonly cloneLimit?: number;
  /** Triangles one instance of each family replaced, by family id. */
  readonly replaced?: Readonly<Record<string, number>>;
  /** Mesh bytes per triangle (default 129, the measured tiangong stride). */
  readonly bytesPerTriangle?: number;
  /** Compressed bytes per sheet texel across its maps (default 2.67: BC5 normal + BC7 ORMH). */
  readonly bytesPerTexel?: number;
}

export interface TrimRegionUse {
  readonly id: string;
  readonly family: string;
  readonly scale: number;
  readonly variant: number;
  readonly instances: number;
  readonly faces: number;
  /** Instances whose UVs are mirrored. */
  readonly mirrored: number;
  /** Fraction of the region's texels some instance samples. */
  readonly utilization: number;
  /** Measured instance texel densities (texels per meter). */
  readonly density: { readonly min: number; readonly max: number; readonly mean: number };
  /** Area-weighted coefficient of variation of instance densities. */
  readonly densitySpread: number;
  /** Instance density over the region density, min and max. */
  readonly scaleRange: readonly [number, number];
}

export interface TrimFamilyUse {
  readonly id: string;
  readonly instances: number;
  readonly regions: number;
  readonly regionsUsed: number;
  /** Own texels of the family's regions (dedupe aliases excluded). */
  readonly texels: number;
  /** More than `cloneLimit` instances, all alike: one region, one mirroring, one hash color. */
  readonly clones: boolean;
  /** R9: whether the shared texels cost less than the geometry the instances replaced. */
  readonly breakEven?: {
    readonly savedBytes: number;
    readonly regionBytes: number;
    readonly instancesNeeded: number;
    readonly worthIt: boolean;
  };
}

export interface TrimReport {
  /** No issue: no clones, no costly family, no unused region. */
  readonly pass: boolean;
  readonly regions: readonly TrimRegionUse[];
  readonly families: readonly TrimFamilyUse[];
  readonly sheet: {
    /** Region content over sheet texels (the layout's utilization). */
    readonly coverage: number;
    /** Texels some instance samples over sheet texels. */
    readonly used: number;
    readonly instances: number;
    /** UV islands of the meshes outside every region (not trimmed). */
    readonly outside: number;
    /** Area-weighted coefficient of variation of instance density over region density. */
    readonly densitySpread: number;
    readonly unusedRegions: readonly string[];
    readonly dedupeHits: number;
    readonly dedupeMisses: number;
  };
  readonly issues: readonly Issue<TrimCode>[];
}

/** What a trim report's issues name. */
export type TrimCode = 'trim-clones' | 'trim-break-even' | 'trim-unused';

interface Island {
  readonly faces: number;
  readonly triangles: [number, number][][];
  readonly area3d: number;
  readonly areaUv: number;
  readonly centroid: [number, number];
  readonly color: string;
}

/** UV islands (faces joined where both corners agree) of one mesh, as UV triangles. */
function uvIslands(bytes: Uint8Array, channel: 'uv0' | 'uv1'): Result<Island[], ModelingError> {
  const decoded = decodeSnapshot(bytes);
  if (!decoded.ok) return decoded;
  const mesh = decoded.value;
  const faces = mesh
    .faces()
    .filter((f) => mesh.faceHalves(f).every((h) => mesh.corner(channel, h) !== undefined));
  const local = new Map<number, number>();
  for (const f of faces) local.set(f, local.size);
  const same = (a: number, b: number) => {
    const x = mesh.corner(channel, a) as Float32Array;
    const y = mesh.corner(channel, b) as Float32Array;
    return x[0] === y[0] && x[1] === y[1];
  };
  const parent = faces.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i] as number] as number;
      i = parent[i] as number;
    }
    return i;
  };
  for (const f of faces) {
    for (const h of mesh.faceHalves(f)) {
      const g = local.get(mesh.hFace[h ^ 1] as number);
      if (g === undefined) continue;
      if (same(h, mesh.hNext[h ^ 1] as number) && same(mesh.hNext[h] as number, h ^ 1)) {
        parent[find(local.get(f) as number)] = find(g);
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (const f of faces) {
    const root = find(local.get(f) as number);
    const list = groups.get(root);
    if (list === undefined) groups.set(root, [f]);
    else list.push(f);
  }
  const out: Island[] = [];
  for (const group of groups.values()) {
    const triangles: [number, number][][] = [];
    let area3d = 0;
    let areaUv = 0;
    let cu = 0;
    let cv = 0;
    for (const f of group) {
      const halves = mesh.faceHalves(f);
      const uv = halves.map((h) => {
        const c = mesh.corner(channel, h) as Float32Array;
        return [c[0] as number, c[1] as number] as [number, number];
      });
      const p = halves.map((h) => mesh.position(mesh.hVert[h] as number));
      const tri = triangulateLoop(p) ?? [];
      for (let i = 0; i + 2 < tri.length; i += 3) {
        const [ia, ib, ic] = [tri[i], tri[i + 1], tri[i + 2]] as [number, number, number];
        const [a, b, c] = [uv[ia], uv[ib], uv[ic]] as [
          [number, number],
          [number, number],
          [number, number],
        ];
        const signed = ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
        triangles.push([a, b, c]);
        areaUv += signed;
        cu += ((a[0] + b[0] + c[0]) / 3) * Math.abs(signed);
        cv += ((a[1] + b[1] + c[1]) / 3) * Math.abs(signed);
        const [pa, pb, pc] = [p[ia], p[ib], p[ic]] as [number[], number[], number[]];
        const e1 = [0, 1, 2].map((k) => (pb[k] as number) - (pa[k] as number));
        const e2 = [0, 1, 2].map((k) => (pc[k] as number) - (pa[k] as number));
        const x = (e1[1] as number) * (e2[2] as number) - (e1[2] as number) * (e2[1] as number);
        const y = (e1[2] as number) * (e2[0] as number) - (e1[0] as number) * (e2[2] as number);
        const z = (e1[0] as number) * (e2[1] as number) - (e1[1] as number) * (e2[0] as number);
        area3d += Math.sqrt(x * x + y * y + z * z) / 2;
      }
    }
    const weight = triangles.reduce((sum, [a, b, c]) => {
      const t = [a, b, c] as [[number, number], [number, number], [number, number]];
      return (
        sum +
        Math.abs(
          (t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[2][0] - t[0][0]) * (t[1][1] - t[0][1]),
        ) /
          2
      );
    }, 0);
    const first = mesh.faceHalves(group[0] as number)[0] as number;
    out.push({
      faces: group.length,
      triangles,
      area3d,
      areaUv,
      centroid: weight > 0 ? [cu / weight, cv / weight] : (triangles[0]?.[0] ?? [0, 0]),
      color: Array.from(mesh.corner('color', first) ?? []).join(','),
    });
  }
  return ok(out);
}

/** Texels of `region` whose centers some triangle covers (strips wrap along u). */
function rasterize(
  region: TrimRegion,
  triangles: readonly (readonly (readonly [number, number])[])[],
  mask: Uint8Array,
): void {
  const size = region.resolution;
  const [x0, y0, w, h] = region.rect as [number, number, number, number];
  for (const tri of triangles) {
    const [a, b, c] = tri.map(([u, v]) => [u * size, v * size]) as [number[], number[], number[]];
    const area =
      ((b[0] as number) - (a[0] as number)) * ((c[1] as number) - (a[1] as number)) -
      ((c[0] as number) - (a[0] as number)) * ((b[1] as number) - (a[1] as number));
    if (area === 0) continue;
    const xs = [a[0], b[0], c[0]] as number[];
    const ys = [a[1], b[1], c[1]] as number[];
    const i0 = Math.floor(minOf(xs) - 0.5);
    const i1 = Math.ceil(maxOf(xs) - 0.5);
    const j0 = Math.max(y0, Math.floor(minOf(ys) - 0.5));
    const j1 = Math.min(y0 + h - 1, Math.ceil(maxOf(ys) - 0.5));
    if (region.tiling === 'u' && i1 - i0 > 4 * size) continue;
    const edge = (p: number[], q: number[], x: number, y: number) =>
      ((q[0] as number) - (p[0] as number)) * (y - (p[1] as number)) -
      ((q[1] as number) - (p[1] as number)) * (x - (p[0] as number));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = i + 0.5;
        const y = j + 0.5;
        const e0 = edge(a, b, x, y);
        const e1 = edge(b, c, x, y);
        const e2 = edge(c, a, x, y);
        const inside = area > 0 ? e0 >= 0 && e1 >= 0 && e2 >= 0 : e0 <= 0 && e1 <= 0 && e2 <= 0;
        if (!inside) continue;
        const col = region.tiling === 'u' ? (((i - x0) % w) + w) % w : i - x0;
        if (col < 0 || col >= w) continue;
        mask[(j - y0) * w + col] = 1;
      }
    }
  }
}

/**
 * How meshes use a trim sheet: UV islands are attributed to the
 * region holding their UV centroid (a strip by its band), then reported per region
 * (instances, utilization, density spread, scale range, mirrored), per family (clones,
 * R9 break-even) and for the sheet (coverage, used texels, unused regions, dedupe).
 * Issues: clone families (BK-V7), families whose texels cost more than the geometry
 * they replaced (BK-V10) and unused regions.
 */
export function trimReport(
  sheet: TrimSheet,
  meshes: readonly (Model | Uint8Array)[],
  options: TrimReportOptions = {},
): Result<TrimReport, ModelingError> {
  const channel = options.channel ?? 'uv0';
  const cloneLimit = options.cloneLimit ?? 8;
  const bytesPerTriangle = options.bytesPerTriangle ?? 129;
  const bytesPerTexel = options.bytesPerTexel ?? 2.67;
  if (
    (channel !== 'uv0' && channel !== 'uv1') ||
    !(Number.isInteger(cloneLimit) && cloneLimit >= 0) ||
    !positive(bytesPerTriangle) ||
    !positive(bytesPerTexel)
  ) {
    return err(
      invalid('channel is uv0 or uv1, cloneLimit a whole count, byte costs positive', {
        channel,
        cloneLimit,
        bytesPerTriangle,
        bytesPerTexel,
      }),
    );
  }
  const size = sheet.size;
  const own = sheet.members
    .filter((m) => m.alias === undefined)
    .map((m) => sheet.regions[m.region] as TrimRegion);
  const found = new Map<string, Island[]>(own.map((r) => [r.id, []]));
  let outside = 0;
  for (const [i, input] of meshes.entries()) {
    const bytes = snapshotBytes(input, `mesh ${i}`);
    if (!bytes.ok) return bytes;
    const islands = uvIslands(bytes.value, channel);
    if (!islands.ok) return islands;
    for (const island of islands.value) {
      const [u, v] = island.centroid;
      const region = own.find((r) => {
        const [u0, v0, u1, v1] = r.uv as [number, number, number, number];
        return v >= v0 && v <= v1 && (r.tiling === 'u' || (u >= u0 && u <= u1));
      });
      if (region === undefined) outside++;
      else found.get(region.id)?.push(island);
    }
  }
  const regions: TrimRegionUse[] = [];
  let usedTexels = 0;
  let wsum = 0;
  let mean = 0;
  let sq = 0;
  for (const region of own) {
    const islands = found.get(region.id) as Island[];
    const [, , w, h] = region.rect as [number, number, number, number];
    const mask = new Uint8Array(w * h);
    for (const island of islands) rasterize(region, island.triangles, mask);
    const covered = mask.reduce((n, x) => n + x, 0);
    usedTexels += covered;
    const nominal = (region.density[0] + region.density[1]) / 2;
    const densities = islands.map((x) =>
      x.area3d > 0 ? Math.sqrt((Math.abs(x.areaUv) * size * size) / x.area3d) : 0,
    );
    let rw = 0;
    let rm = 0;
    let rs = 0;
    for (const [k, x] of islands.entries()) {
      const d = densities[k] as number;
      rw += x.area3d;
      rm += d * x.area3d;
      rs += d * d * x.area3d;
      const r = d / nominal;
      wsum += x.area3d;
      mean += r * x.area3d;
      sq += r * r * x.area3d;
    }
    const rmean = rw > 0 ? rm / rw : 0;
    regions.push({
      id: region.id,
      family: region.family,
      scale: region.scale,
      variant: region.variant,
      instances: islands.length,
      faces: islands.reduce((n, x) => n + x.faces, 0),
      mirrored: islands.filter((x) => x.areaUv < 0).length,
      utilization: covered / (w * h),
      density: {
        min: densities.length > 0 ? minOf(densities) : 0,
        max: densities.length > 0 ? maxOf(densities) : 0,
        mean: rmean,
      },
      densitySpread: rmean > 0 ? Math.sqrt(Math.max(0, rs / rw - rmean * rmean)) / rmean : 0,
      scaleRange:
        densities.length > 0 ? [minOf(densities) / nominal, maxOf(densities) / nominal] : [0, 0],
    });
  }
  const families: TrimFamilyUse[] = [];
  for (const [id, members] of Object.entries(sheet.families)) {
    const uses = regions.filter((r) => r.family === id);
    const islands = uses.flatMap((r) => found.get(r.id) as Island[]);
    const instances = islands.length;
    const mirrored = islands.filter((x) => x.areaUv < 0).length;
    const varied =
      uses.filter((r) => r.instances > 0).length > 1 ||
      (mirrored > 0 && mirrored < instances) ||
      new Set(islands.map((x) => x.color)).size > 1;
    const texels = members
      .filter((r) => own.includes(r))
      .reduce((n, r) => n + (r.rect[2] as number) * (r.rect[3] as number), 0);
    const tris = options.replaced?.[id];
    const regionBytes = (texels * 4 * bytesPerTexel) / 3;
    const breakEven =
      tris === undefined
        ? undefined
        : {
            savedBytes: instances * tris * bytesPerTriangle,
            regionBytes,
            instancesNeeded: Math.ceil(regionBytes / (tris * bytesPerTriangle)),
            worthIt: instances * tris * bytesPerTriangle > regionBytes,
          };
    families.push({
      id,
      instances,
      regions: members.length,
      regionsUsed: uses.filter((r) => r.instances > 0).length,
      texels,
      clones: instances > cloneLimit && !varied,
      ...(breakEven === undefined ? {} : { breakEven }),
    });
  }
  const issues: Issue<TrimCode>[] = [];
  const clones = families.filter((f) => f.clones);
  if (clones.length > 0) {
    issues.push({
      code: 'trim-clones',
      severity: 'warn',
      detail: {
        families: clones.map((f) => ({ id: f.id, instances: f.instances })),
        cloneLimit,
        hint: 'BK-V7: add variants, uv.trim variation (rotate, mirror, phase) or the hash lane for the material',
      },
    });
  }
  const costly = families.filter((f) => f.breakEven !== undefined && !f.breakEven.worthIt);
  if (costly.length > 0) {
    issues.push({
      code: 'trim-break-even',
      severity: 'warn',
      detail: {
        families: costly.map((f) => ({ id: f.id, ...f.breakEven })),
        hint: 'BK-V10: the texels cost more than the triangles the instances replaced; lower the density or keep the geometry',
      },
    });
  }
  const unused = regions.filter((r) => r.instances === 0).map((r) => r.id);
  if (unused.length > 0) {
    issues.push({
      code: 'trim-unused',
      severity: 'warn',
      detail: { regions: unused, hint: 'drop the regions or map faces into them' },
    });
  }
  const instances = regions.reduce((n, r) => n + r.instances, 0);
  const rmean = wsum > 0 ? mean / wsum : 0;
  return ok({
    pass: issues.length === 0,
    regions,
    families,
    sheet: {
      coverage: sheet.metrics.utilization,
      used: usedTexels / (size * size),
      instances,
      outside,
      densitySpread: rmean > 0 ? Math.sqrt(Math.max(0, sq / wsum - rmean * rmean)) / rmean : 0,
      unusedRegions: unused,
      dedupeHits: sheet.metrics.dedupeHits,
      dedupeMisses: sheet.metrics.dedupeMisses,
    },
    issues,
  });
}
