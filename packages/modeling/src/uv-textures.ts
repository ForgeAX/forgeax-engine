import { err, ok, type Result, type TextureAsset } from '@forgeax/engine-types';
import { measureUv } from './compute/uv-ts';
import { type ModelingError, modelingError } from './errors';
import { triangulateLoop } from './geom';
import type { CornerChannelName, EditMesh } from './mesh';

/** Largest side of a diagnostic texture; keeps a request inside memory a session can hold. */
const MAX_SIZE = 8192;
const DEFAULT_SIZE = 1024;
const DEFAULT_CELLS = 32;
/** Stretch that takes the top color unless `limit` says otherwise. */
const DEFAULT_LIMIT = 2;

export interface UvCheckerOptions {
  /** Texture side in texels (default 1024). */
  readonly size?: number;
  /** Squares per side (default 32). */
  readonly cells?: number;
}

export interface UvHeatmapOptions {
  /**
   * `'density'`: texel density against the channel's mean, diverging (blue under-sampled, white average,
   * red over-sampled); `'stretch'`: island-normalized L-infinity stretch, sequential green (1) to red
   * (`limit`) with magenta for a flipped or collapsed face.
   */
  readonly metric: 'density' | 'stretch';
  /** Texture side in texels (default 1024). */
  readonly size?: number;
  /** Stretch mapped to the top color (default 2); `'stretch'` only. */
  readonly limit?: number;
  readonly channel?: CornerChannelName;
}

export function texture(size: number, data: Uint8Array): TextureAsset {
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: size, height: size } },
    format: 'rgba8unorm-srgb',
    colorSpace: 'srgb',
    // Generated mips streak along triangle edges; a diagnostic texture is read at one level.
    mips: { kind: 'none' },
    data,
  };
}

export function checkSize(size: number): ModelingError | undefined {
  if (!Number.isInteger(size) || size < 1 || size > MAX_SIZE) {
    return modelingError('model-invalid-argument', `size is an integer in [1, ${MAX_SIZE}]`, {
      size,
    });
  }
  return undefined;
}

/**
 * UV test texture: `cells` x `cells` checker squares whose light squares are tinted by position (red
 * grows with u, green with v), so mirroring, rotation and stretching are visible. Row 0 is v = 0.
 * Deterministic: the same options give the same bytes.
 */
export function uvCheckerTexture(
  options: UvCheckerOptions = {},
): Result<TextureAsset, ModelingError> {
  const size = options.size ?? DEFAULT_SIZE;
  const cells = options.cells ?? Math.min(DEFAULT_CELLS, size);
  const bad = checkSize(size);
  if (bad !== undefined) return err(bad);
  if (!Number.isInteger(cells) || cells < 1 || cells > size) {
    return err(
      modelingError('model-invalid-argument', 'cells is an integer in [1, size]', { cells, size }),
    );
  }
  const data = new Uint8Array(size * size * 4);
  const cell = size / cells;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = Math.floor(x / cell);
      const cy = Math.floor(y / cell);
      const light = (cx + cy) % 2 === 0;
      const o = (y * size + x) * 4;
      data[o] = light ? 150 + Math.round((cx / cells) * 105) : 45;
      data[o + 1] = light ? 150 + Math.round((cy / cells) * 105) : 45;
      data[o + 2] = light ? 200 : 55;
      data[o + 3] = 255;
    }
  }
  return ok(texture(size, data));
}

type Rgb = readonly [number, number, number];

const lerp = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

const BLUE: Rgb = [49, 99, 210];
const WHITE: Rgb = [240, 240, 240];
const RED: Rgb = [214, 48, 49];
const GREEN: Rgb = [58, 176, 92];
const YELLOW: Rgb = [244, 208, 63];
const MAGENTA: Rgb = [220, 40, 220];

/** Diverging ramp over s in [-1, 1]. */
function diverging(s: number): Rgb {
  return s < 0 ? lerp(WHITE, BLUE, -s) : lerp(WHITE, RED, s);
}

/** Sequential green - yellow - red ramp over t in [0, 1]. */
function sequential(t: number): Rgb {
  return t < 0.5 ? lerp(GREEN, YELLOW, t * 2) : lerp(YELLOW, RED, (t - 0.5) * 2);
}

/** Neighbors a texel without a triangle borrows from, in a fixed order. */
const AROUND: readonly (readonly [number, number])[] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

/**
 * Density or stretch heat map of a UV channel, read from `measureUv` (no second metric pass). Every
 * face triangle is rasterized in UV space (u right, v down the rows, texel centers inside the triangle)
 * with its face value; the layer is then grown by one texel so thin islands and seams stay visible.
 * Texels outside every island are transparent. Overlapping triangles keep the highest face id.
 * Deterministic: integer scan conversion, no transcendental functions, fixed ramps.
 */
export function uvHeatmapTexture(
  mesh: EditMesh,
  options: UvHeatmapOptions,
): Result<TextureAsset, ModelingError> {
  const size = options.size ?? DEFAULT_SIZE;
  const channel = options.channel ?? 'uv0';
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (options.metric !== 'density' && options.metric !== 'stretch') {
    return err(
      modelingError('model-invalid-argument', "metric is 'density' or 'stretch'", {
        metric: options.metric,
      }),
    );
  }
  const bad = checkSize(size);
  if (bad !== undefined) return err(bad);
  if (!Number.isFinite(limit) || limit <= 1) {
    return err(
      modelingError('model-invalid-argument', 'limit is a finite number above 1', { limit }),
    );
  }
  const measured = measureUv(mesh, channel);
  if (!measured.ok) return measured;
  const grown = faceOwners(mesh, channel, size);
  if (!grown.ok) return grown;
  const faceAt = grown.value;
  const data = new Uint8Array(size * size * 4);
  for (let k = 0; k < faceAt.length; k++) {
    const f = faceAt[k] as number;
    if (f === -1) continue;
    let rgb: Rgb;
    if (options.metric === 'density') {
      const ratio = measured.value.faceDensity[f] as number;
      rgb = ratio > 0 ? diverging((ratio - 1) / (ratio + 1)) : MAGENTA;
    } else {
      const stretch = measured.value.faceStretch[f] as number;
      rgb = Number.isFinite(stretch)
        ? sequential(Math.max(0, Math.min(1, (stretch - 1) / (limit - 1))))
        : MAGENTA;
    }
    data[k * 4] = Math.round(rgb[0]);
    data[k * 4 + 1] = Math.round(rgb[1]);
    data[k * 4 + 2] = Math.round(rgb[2]);
    data[k * 4 + 3] = 255;
  }
  return ok(texture(size, data));
}

/**
 * The face owning each texel of a `size` x `size` UV raster (u right, v down the rows, texel centers
 * inside the triangle), -1 outside every island; the layer is grown by one texel so thin islands and
 * seams stay visible. Overlapping triangles keep the highest face id.
 */
export function faceOwners(
  mesh: EditMesh,
  channel: CornerChannelName,
  size: number,
): Result<Int32Array, ModelingError> {
  for (const f of mesh.faces()) {
    if (mesh.faceHalves(f).some((h) => mesh.corner(channel, h) === undefined)) {
      return err(
        modelingError(
          'model-precondition',
          `face ${f} has no ${channel}; unwrap or project it first`,
          { code: 'no-uv', face: f, channel },
          'unwrap (m.uv.unwrap) or project (m.uv.project) the faces first',
        ),
      );
    }
  }
  const owner = new Int32Array(size * size).fill(-1);
  for (const f of mesh.faces()) {
    const halves = mesh.faceHalves(f);
    const indices = triangulateLoop(halves.map((h) => mesh.position(mesh.hVert[h] as number)));
    if (indices === undefined) continue;
    const uv = halves.map((h) => mesh.corner(channel, h) as Float32Array);
    if (uv.some((c) => !Number.isFinite(c[0]) || !Number.isFinite(c[1]))) {
      return err(
        modelingError(
          'model-degenerate',
          `face ${f} has a non-finite ${channel} corner; unwrap or project it again`,
          { face: f, channel },
        ),
      );
    }
    for (let i = 0; i < indices.length; i += 3) {
      const a = uv[indices[i] as number] as Float32Array;
      const b = uv[indices[i + 1] as number] as Float32Array;
      const c = uv[indices[i + 2] as number] as Float32Array;
      fillTriangle(owner, size, f, a, b, c);
    }
  }
  if (!owner.some((f) => f !== -1)) {
    return err(
      modelingError(
        'model-degenerate',
        `no texel is covered: every ${channel} triangle lies outside [0, 1] or has no area`,
        { channel, size },
      ),
    );
  }
  const grown = new Int32Array(owner);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (owner[y * size + x] !== -1) continue;
      for (const [dx, dy] of AROUND) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const f = owner[ny * size + nx] as number;
        if (f !== -1) {
          grown[y * size + x] = f;
          break;
        }
      }
    }
  }
  return ok(grown);
}

/** Mark the texels whose centers lie inside the UV triangle (edges included) with `face`. */
function fillTriangle(
  owner: Int32Array,
  size: number,
  face: number,
  a: Float32Array,
  b: Float32Array,
  c: Float32Array,
): void {
  const ax = (a[0] as number) * size;
  const ay = (a[1] as number) * size;
  const bx = (b[0] as number) * size;
  const by = (b[1] as number) * size;
  const cx = (c[0] as number) * size;
  const cy = (c[1] as number) * size;
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (area === 0 || !Number.isFinite(area)) return;
  const sign = area > 0 ? 1 : -1;
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx) - 0.5));
  const x1 = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx) - 0.5));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy) - 0.5));
  const y1 = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy) - 0.5));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const inside =
        sign * ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) >= 0 &&
        sign * ((cx - bx) * (py - by) - (cy - by) * (px - bx)) >= 0 &&
        sign * ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) >= 0;
      if (inside) owner[y * size + x] = face;
    }
  }
}
