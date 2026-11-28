import { err, ok, type Result, type TextureAsset } from '@forgeax/engine-types';
import { type ModelingError, modelingError } from '../errors';

/**
 * Shared 2D UV atlas operators: owner-aware chart dilation (nearest/ring gutter fill),
 * mip-bleed verification, and standalone TextureAsset atlas dilation.
 */
export interface AtlasGrid {
  readonly w: number;
  readonly h: number;
  readonly u: boolean;
  readonly v: boolean;
}

/** An owner / source sentinel for an empty gutter texel. */
export const UNOWNED = -1;
/** An owner sentinel for a texel bordered by more than one chart. */
export const MIXED = -2;

export function atlasNeighbor(x: number, y: number, grid: AtlasGrid): number {
  let xi = x;
  let yi = y;
  if (xi < 0 || xi >= grid.w) {
    if (!grid.u) return -1;
    xi = ((xi % grid.w) + grid.w) % grid.w;
  }
  if (yi < 0 || yi >= grid.h) {
    if (!grid.v) return -1;
    yi = ((yi % grid.h) + grid.h) % grid.h;
  }
  return yi * grid.w + xi;
}

/** Most common frame among covered 8-neighbours of `i` (ties break by smallest index). */
export function dominantSource(
  i: number,
  covered: Uint8Array,
  source: Int32Array,
  grid: AtlasGrid,
): number {
  const x = i % grid.w;
  const y = (i - x) / grid.w;
  let best = -1;
  let count = 0;
  const seen = new Map<number, number>();
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const j = atlasNeighbor(x + dx, y + dy, grid);
      if (j < 0 || covered[j] !== 1) continue;
      const s = source[j] as number;
      if (s < 0) continue;
      const n = (seen.get(s) ?? 0) + 1;
      seen.set(s, n);
      if (n > count) {
        best = s;
        count = n;
      }
    }
  }
  return best;
}

/**
 * Dilate encoded texels into `gutter` rings of empty texels. Each texel takes the average
 * of the covered neighbours from its dominant source frame (exact value for categorical maps
 * such as `materialId`). `owner` tracks the chart owner (`MIXED` at chart boundaries) and
 * `frame` tracks the fine source frame (`triangle` / connected chart).
 */
export function dilate(
  kinds: readonly string[],
  values: readonly (Float32Array | Float64Array)[],
  covered: Uint8Array,
  owner: Int32Array,
  frame: Int32Array,
  grid: AtlasGrid,
  gutter: number,
): void {
  const texels = grid.w * grid.h;
  const seen = new Int32Array(texels).fill(-1);
  const source = Int32Array.from(frame);
  let frontier: number[] = [];
  for (let i = 0; i < texels; i++) if (covered[i] === 1) frontier.push(i);
  for (let pass = 0; pass < gutter && frontier.length > 0; pass++) {
    const fresh: number[] = [];
    for (const i of frontier) {
      const x = i % grid.w;
      const y = (i - x) / grid.w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const j = atlasNeighbor(x + dx, y + dy, grid);
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
          const j = atlasNeighbor(x + dx, y + dy, grid);
          if (j < 0 || covered[j] !== 1) continue;
          const o = owner[j] as number;
          chart = chart === UNOWNED ? o : chart === o ? chart : MIXED;
        }
      }
      owner[i] = chart;
    }
    for (const i of fresh) source[i] = dominantSource(i, covered, source, grid);
    for (const [k, v] of values.entries()) {
      const categorical = kinds[k] === 'materialId';
      for (const i of fresh) {
        const x = i % grid.w;
        const y = (i - x) / grid.w;
        const acc = [0, 0, 0, 0];
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const j = atlasNeighbor(x + dx, y + dy, grid);
            if (j < 0 || covered[j] !== 1 || source[j] !== source[i] || (categorical && n > 0))
              continue;
            n++;
            for (let c = 0; c < 4; c++) acc[c] = (acc[c] as number) + (v[j * 4 + c] as number);
          }
        }
        if (n > 0) {
          for (let c = 0; c < 4; c++) v[i * 4 + c] = (acc[c] as number) / n;
        }
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
export function mipBleed(owner: Int32Array, chart: Uint8Array, grid: AtlasGrid): number[] {
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

export interface AtlasBleedReport {
  readonly levels: readonly number[];
  readonly protectMip: number;
  readonly protectedBleed: number;
  readonly pass: boolean;
}

export interface DilateAtlasOptions {
  readonly textures: Readonly<Record<string, TextureAsset>>;
  /** Covered chart mask (1 = chart texel, 0 = empty gutter). Defaults to alpha > 0 of the first texture. */
  readonly mask?: Uint8Array;
  /** Per-texel chart owner id (-1 for uncovered gutter). Defaults to 0 where covered. */
  readonly owner?: Int32Array;
  /** Per-texel fine source frame id (-1 for uncovered gutter). Defaults to `owner`. */
  readonly frame?: Int32Array;
  /** Map names whose borders stay crisp without neighbor averaging (e.g. `['materialId']`). */
  readonly categorical?: readonly string[];
  /** Gutter width in texels, or `'fill'` (default). */
  readonly gutter?: number | 'fill';
  /** Periodic UV wrapping along atlas edges. */
  readonly wrap?: { readonly u?: boolean; readonly v?: boolean };
  /** Lowest mip levels checked for bleed (default: level of 128 texels). */
  readonly protectMip?: number;
  /** Generate packed mips on outputs (default preserves each input texture's mips setting). */
  readonly mips?: boolean;
  /** Alpha cutoff for opacity-style mip preservation (default unused). */
  readonly alphaCutoff?: number;
  /** Execution backend selector ('auto' uses Rust WASM when initialized; 'ts' forces TS baseline). */
  readonly backend?: 'auto' | 'rust' | 'ts';
}

export interface DilateAtlasResult {
  readonly textures: Readonly<Record<string, TextureAsset>>;
  readonly bleed: AtlasBleedReport;
  readonly backend: 'ts' | 'rust' | 'webgpu';
}

export function atlasBleedReport(
  owner: Int32Array,
  chart: Uint8Array,
  grid: AtlasGrid,
  protectMip?: number,
): AtlasBleedReport {
  let pm = protectMip;
  if (pm === undefined) {
    const minSide = Math.min(grid.w, grid.h);
    pm = 0;
    while (minSide / (1 << (pm + 1)) >= 128) pm++;
  }
  const levels = mipBleed(owner, chart, grid);
  const protectedBleed = levels.slice(0, pm).reduce((n, b) => n + b, 0);
  return { levels, protectMip: pm, protectedBleed, pass: protectedBleed === 0 };
}

/** Validate and normalize inputs for `dilateAtlas` / `dilateAtlasWithGpu`. */
export function prepareAtlasDilation(options: DilateAtlasOptions): Result<
  {
    readonly entries: readonly (readonly [string, TextureAsset])[];
    readonly grid: AtlasGrid;
    readonly mask: Uint8Array;
    readonly owner: Int32Array;
    readonly frame: Int32Array;
    readonly gutter: number;
    readonly protectMip: number;
    readonly categorical: ReadonlySet<string>;
  },
  ModelingError
> {
  const entries = Object.entries(options.textures);
  if (entries.length === 0) {
    return err(
      modelingError(
        'model-invalid-argument',
        'dilateAtlas expects at least one 2d TextureAsset',
        {},
      ),
    );
  }
  const first = entries[0]?.[1] as TextureAsset;
  const w = first.shape.extent.width;
  const h = first.shape.extent.height;
  if (!(w >= 1 && h >= 1) || first.shape.viewDimension !== '2d') {
    return err(
      modelingError('model-invalid-argument', 'every atlas texture is a non-empty 2d texture', {
        width: w,
        height: h,
        viewDimension: first.shape.viewDimension,
      }),
    );
  }
  const texels = w * h;
  for (const [name, tex] of entries) {
    if (
      tex.shape.viewDimension !== '2d' ||
      tex.shape.extent.width !== w ||
      tex.shape.extent.height !== h
    ) {
      return err(
        modelingError(
          'model-invalid-argument',
          'all textures in dilateAtlas share the same 2d dimensions',
          { name, expected: [w, h], actual: [tex.shape.extent.width, tex.shape.extent.height] },
        ),
      );
    }
    const bytesPerTexel = tex.format === 'r16unorm' ? 2 : 4;
    if (
      (tex.format !== 'rgba8unorm' &&
        tex.format !== 'rgba8unorm-srgb' &&
        tex.format !== 'r16unorm') ||
      tex.data.length < texels * bytesPerTexel
    ) {
      return err(
        modelingError(
          'model-invalid-argument',
          'dilateAtlas supports rgba8unorm, rgba8unorm-srgb, or r16unorm level-0 buffers',
          { name, format: tex.format, bytes: tex.data.length },
        ),
      );
    }
  }
  const gutter =
    options.gutter === undefined || options.gutter === 'fill'
      ? Math.max(w, h)
      : Math.floor(options.gutter);
  if (
    options.gutter !== undefined &&
    options.gutter !== 'fill' &&
    (!Number.isFinite(options.gutter) || options.gutter < 0)
  ) {
    return err(
      modelingError('model-invalid-argument', "gutter is 'fill' or a non-negative integer", {
        gutter: options.gutter,
      }),
    );
  }
  if (options.mask !== undefined && options.mask.length !== texels) {
    return err(
      modelingError('model-invalid-argument', 'mask length matches width * height', {
        expected: texels,
        actual: options.mask.length,
      }),
    );
  }
  if (options.owner !== undefined && options.owner.length !== texels) {
    return err(
      modelingError('model-invalid-argument', 'owner length matches width * height', {
        expected: texels,
        actual: options.owner.length,
      }),
    );
  }
  if (options.frame !== undefined && options.frame.length !== texels) {
    return err(
      modelingError('model-invalid-argument', 'frame length matches width * height', {
        expected: texels,
        actual: options.frame.length,
      }),
    );
  }
  const mask = new Uint8Array(texels);
  if (options.mask !== undefined) {
    for (let i = 0; i < texels; i++) mask[i] = (options.mask[i] as number) !== 0 ? 1 : 0;
  } else if (options.owner !== undefined) {
    for (let i = 0; i < texels; i++) mask[i] = (options.owner[i] as number) >= 0 ? 1 : 0;
  } else if (first.format === 'r16unorm') {
    const view = new Uint16Array(first.data.buffer, first.data.byteOffset, texels);
    for (let i = 0; i < texels; i++) mask[i] = (view[i] as number) > 0 ? 1 : 0;
  } else {
    for (let i = 0; i < texels; i++) mask[i] = (first.data[i * 4 + 3] as number) > 0 ? 1 : 0;
  }
  const owner = new Int32Array(texels);
  for (let i = 0; i < texels; i++) {
    owner[i] =
      mask[i] === 1
        ? options.owner !== undefined
          ? Math.max(0, options.owner[i] as number)
          : 0
        : UNOWNED;
  }
  const frame = new Int32Array(texels);
  for (let i = 0; i < texels; i++) {
    frame[i] =
      mask[i] === 1
        ? options.frame !== undefined
          ? Math.max(0, options.frame[i] as number)
          : (owner[i] as number)
        : UNOWNED;
  }
  const grid: AtlasGrid = {
    w,
    h,
    u: options.wrap?.u === true,
    v: options.wrap?.v === true,
  };
  let protectMip = options.protectMip;
  if (protectMip === undefined) {
    const minSide = Math.min(w, h);
    protectMip = 0;
    while (minSide / (1 << (protectMip + 1)) >= 128) protectMip++;
  }
  const categorical = new Set(options.categorical ?? ['materialId']);
  return ok({ entries, grid, mask, owner, frame, gutter, protectMip, categorical });
}
