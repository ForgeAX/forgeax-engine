import { err, ok, type Result } from '@forgeax/engine-types';
import { pushAll } from '../arrays';
import { cos, hypot2, sin } from '../dmath';
import { type ModelingError, modelingError } from '../errors';
import type { Tuple3 } from '../geom';
import type { DesignedContact } from '../interference';
import { type Model, model, type OpReport } from '../model';
import type { Point2 } from '../primitives';
import {
  checkAll,
  finishPart,
  inRange,
  type Range,
  type RecipeNaming,
  type RecipePart,
} from './common';
import type { JuzhePurlin } from './juzhe-roof';

export interface TileRowsOptions extends RecipeNaming {
  /**
   * One side of the roof cross-section, ridge first: `run` 0 at the ridge purlin, strictly
   * increasing run, non-increasing height. `juzhePurlins` produces it.
   */
  readonly purlins: readonly JuzhePurlin[];
  /** Ridge length along Z in meters (default 1.2), matching the roof it covers. */
  readonly length?: number;
  /** Tile width along the ridge, meters (default 0.3). Joints every tileWidth along Z. */
  readonly tileWidth?: number;
  /** Largest pitch of a row along the slope, meters (default 0.2). */
  readonly exposure?: number;
  /** Covered tail of a row under the next row, meters (default 0.05). Layout only, see below. */
  readonly lap?: number;
  /** Tile thickness above the bedding, meters (default 0.02). */
  readonly thickness?: number;
  /** Slope distance from the ridge purlin to the ridge cap's side face on each facet (default 0.08). */
  readonly ridgeHalf?: number;
  /** Height of the ridge cap's side face above the roof, meters (default 0.06). */
  readonly ridgeHeight?: number;
  /** Width of the cover strips along the ridge, meters (default 0.3 * tileWidth). Below tileWidth. */
  readonly coverWidth?: number;
}

/** Declared ranges. Tile dimensions are design choices, not source values. */
export const TILE_ROWS_RANGES = {
  length: [0.2, 30],
  tileWidth: [0.02, 1],
  exposure: [0.05, 1],
  lap: [0, 0.5],
  thickness: [0.005, 0.05],
  ridgeHalf: [0.01, 1],
  ridgeHeight: [0.01, 0.3],
  coverWidth: [0.005, 0.5],
} as const satisfies Record<string, Range>;

/** Crown of the ridge cap above its side tops, as a multiple of `ridgeHeight`. */
const CROWN_RATIO = 0.3;
/** Extra cover height at the butt over the head, in thicknesses. */
const COVER_BUTT_STEP = 0.5;
/** Segments of the half-round cover top. */
const COVER_ARC_SEGMENTS = 6;
/** Absolute tolerance of degenerate lengths and areas, meters. */
const EPS = 1e-12;

/** @internal One facet of a roof side in the side frame (run to the right, height up). */
export interface Facet {
  readonly upper: Point2;
  readonly lower: Point2;
  /** Unit down-slope direction, from the upper purlin to the lower one. */
  readonly d: Point2;
  /** Unit outward normal: d turned a quarter turn, pointing up and away from the roof body. */
  readonly n: Point2;
  readonly length: number;
}

/**
 * @internal The mitre of the fold at purlin j (1 <= j < facets): a line through the purlin along
 * the bisector `dir` of the two outward normals. The upper facet (j-1) lies where
 * cross(dir, p - origin) >= 0 and the lower facet (j) where it is <= 0.
 */
export interface FoldMitre {
  readonly origin: Point2;
  readonly dir: Point2;
}

/** @internal Facets of one roof side, from its purlin points. */
export function facetFrames(purlins: readonly JuzhePurlin[]): Facet[] {
  const out: Facet[] = [];
  for (let i = 0; i + 1 < purlins.length; i++) {
    const a = purlins[i] as JuzhePurlin;
    const b = purlins[i + 1] as JuzhePurlin;
    const dx = b.run - a.run;
    const dy = b.height - a.height;
    const length = hypot2(dx, dy);
    const d: Point2 = [dx / length, dy / length];
    out.push({
      upper: [a.run, a.height],
      lower: [b.run, b.height],
      d,
      n: [-d[1], d[0]],
      length,
    });
  }
  return out;
}

/** @internal The mitre at interior purlin j, through the purlin along the normal bisector. */
export function foldMitre(facets: readonly Facet[], j: number): FoldMitre {
  const up = facets[j - 1] as Facet;
  const down = facets[j] as Facet;
  const sx = up.n[0] + down.n[0];
  const sy = up.n[1] + down.n[1];
  const len = hypot2(sx, sy);
  return { origin: down.upper, dir: [sx / len, sy / len] };
}

/**
 * @internal The row polygon of a facet between slope positions `s0` and `s1`, in the side frame:
 * bedding at h = 0, head at one thickness, butt at two. Convex, counter-clockwise.
 */
export function sawtoothRow(facet: Facet, s0: number, s1: number, thickness: number): Point2[] {
  const at = (s: number, h: number): Point2 => [
    facet.upper[0] + s * facet.d[0] + h * facet.n[0],
    facet.upper[1] + s * facet.d[1] + h * facet.n[1],
  ];
  return [at(s0, 0), at(s1, 0), at(s1, 2 * thickness), at(s0, thickness)];
}

/**
 * @internal Sutherland-Hodgman clip of a convex polygon to the closed half-plane where
 * cross(dir, p - origin) >= 0. Coincident vertices collapse.
 */
export function clipHalfPlane(poly: readonly Point2[], origin: Point2, dir: Point2): Point2[] {
  const side = (p: Point2): number => dir[0] * (p[1] - origin[1]) - dir[1] * (p[0] - origin[0]);
  const out: Point2[] = [];
  const push = (p: Point2) => {
    const last = out[out.length - 1];
    if (last === undefined || Math.abs(last[0] - p[0]) > EPS || Math.abs(last[1] - p[1]) > EPS) {
      out.push(p);
    }
  };
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i] as Point2;
    const q = poly[(i + 1) % poly.length] as Point2;
    const fp = side(p);
    const fq = side(q);
    if (fp >= 0) push(p);
    if (fp >= 0 !== fq >= 0) {
      const t = fp / (fp - fq);
      push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  if (out.length > 1) {
    const first = out[0] as Point2;
    const last = out[out.length - 1] as Point2;
    if (Math.abs(first[0] - last[0]) <= EPS && Math.abs(first[1] - last[1]) <= EPS) out.pop();
  }
  return out;
}

/** @internal Unsigned area of a simple polygon (shoelace). */
export function polygonArea(poly: readonly Point2[]): number {
  let twice = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i] as Point2;
    const q = poly[(i + 1) % poly.length] as Point2;
    twice += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(twice) / 2;
}

/** Labels of one row on one facet: `pans[c]` for each column, `covers[j]` between pans j and j+1. */
interface RowLabels {
  readonly pans: readonly string[];
  readonly covers: readonly string[];
}

interface Span {
  readonly z0: number;
  readonly z1: number;
}

/**
 * Tile rows on both slopes of a juzhe roof, from closed-form geometry only. Each facet is covered
 * by rows of pans whose cross-section is a sawtooth: bedding at h = 0, head at one thickness and
 * butt at two, so a butt stands one thickness above the head of the row below it. Pans are cut at
 * every interior fold by the mitre (the bisector of the two outward normals), so adjacent facets
 * meet on one plane. Cover strips (tong wa) of width `coverWidth` sit in the gaps over the joints every
 * `tileWidth` along the ridge; each is a loft of two planar end rings, and the rings at a fold lie
 * in the mitre plane. A ridge cap runs the full length over the first facet of each side.
 *
 * The lap of a row is a layout dimension, never a volume: the covered tail under the next row is
 * not modelled. `dimensions.tileLength` reports `pitchMax + lap`. Eave end caps (wa dang, di shui) are
 * not modelled.
 *
 * Touching pieces are declared `seat` contacts. Anchors: each facet's upper purlin at z = 0, and
 * the ridge.
 */
export function tileRows(options: TileRowsOptions): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'tile-rows';
  const length = options.length ?? 1.2;
  const tileWidth = options.tileWidth ?? 0.3;
  const exposure = options.exposure ?? 0.2;
  const lap = options.lap ?? 0.05;
  const thickness = options.thickness ?? 0.02;
  const ridgeHalf = options.ridgeHalf ?? 0.08;
  const ridgeHeight = options.ridgeHeight ?? 0.06;
  const coverWidth = options.coverWidth ?? 0.3 * tileWidth;
  const checked = checkAll([
    () => inRange('length', length, TILE_ROWS_RANGES.length),
    () => inRange('tileWidth', tileWidth, TILE_ROWS_RANGES.tileWidth),
    () => inRange('exposure', exposure, TILE_ROWS_RANGES.exposure),
    () => inRange('lap', lap, TILE_ROWS_RANGES.lap),
    () => inRange('thickness', thickness, TILE_ROWS_RANGES.thickness),
    () => inRange('ridgeHalf', ridgeHalf, TILE_ROWS_RANGES.ridgeHalf),
    () => inRange('ridgeHeight', ridgeHeight, TILE_ROWS_RANGES.ridgeHeight),
    () => inRange('coverWidth', coverWidth, TILE_ROWS_RANGES.coverWidth),
  ]);
  if (!checked.ok) return checked;
  if (coverWidth >= tileWidth) {
    return err(
      modelingError(
        'model-invalid-argument',
        'coverWidth is below tileWidth',
        { coverWidth, tileWidth },
        'a cover strip must be narrower than the tile joint it covers',
      ),
    );
  }

  const shape = profileError(options.purlins);
  if (shape !== undefined) return err(shape);
  const facets = facetFrames(options.purlins);
  const folds: FoldMitre[] = [];
  for (let j = 1; j < facets.length; j++) folds.push(foldMitre(facets, j));

  const first = facets[0] as Facet;
  if (first.length - ridgeHalf <= EPS) {
    return err(
      modelingError(
        'model-invalid-argument',
        'ridgeHalf is shorter than the first facet',
        { ridgeHalf, facet: first.length },
        'the ridge cap must stop before the first purlin',
      ),
    );
  }
  const columns = Math.ceil(length / tileWidth - 1e-9);
  const spans = panSpans(length, tileWidth, coverWidth, columns);
  if (spans.some((s) => s.z1 - s.z0 <= EPS)) {
    return err(
      modelingError(
        'model-invalid-argument',
        'coverWidth leaves room for every pan column',
        { coverWidth, tileWidth, length },
        'narrow the cover strip or change the length so every pan keeps a positive width',
      ),
    );
  }

  const m: Model = model();
  const anchors: Record<string, Tuple3> = {};
  const contacts: DesignedContact[] = [];
  let pans = 0;
  let covers = 0;
  let rows = 0;
  let pitchMin = Number.POSITIVE_INFINITY;
  let pitchMax = 0;

  const ridgeLabel = `${name}-ridge`;
  const cap = m.extrudePolygon({
    points: ridgeCap(first, ridgeHalf, ridgeHeight),
    depth: length,
    label: ridgeLabel,
  });
  const capFailure = failure(cap, 'the ridge cap could not be built');
  if (capFailure !== undefined) return err(capFailure);
  anchors.ridge = [0, first.upper[1], 0];

  for (const sign of [1, -1] as const) {
    const side = sign === 1 ? 'R' : 'L';
    const sideRows: RowLabels[][] = [];
    for (let i = 0; i < facets.length; i++) {
      const f = facets[i] as Facet;
      const sStart = i === 0 ? ridgeHalf : 0;
      const range = f.length - sStart;
      const count = Math.ceil(range / exposure - 1e-9);
      const pitch = range / count;
      rows += count;
      pitchMin = Math.min(pitchMin, pitch);
      pitchMax = Math.max(pitchMax, pitch);
      anchors[`facet-${side}${i}`] = [sign * f.upper[0], f.upper[1], 0];
      const atUpper = i >= 1 ? folds[i - 1] : undefined;
      const atLower = i + 1 < facets.length ? folds[i] : undefined;
      const grid: RowLabels[] = [];

      for (let r = 0; r < count; r++) {
        const s0 = r === 0 ? sStart : sStart + (range * r) / count;
        const s1 = r === count - 1 ? f.length : sStart + (range * (r + 1)) / count;
        let poly = sawtoothRow(f, s0, s1, thickness);
        // Facet i is the upper facet of the fold at its lower purlin (keeps +dir) and the lower
        // facet of the fold at its upper purlin (keeps -dir).
        if (atLower !== undefined) poly = clipHalfPlane(poly, atLower.origin, atLower.dir);
        if (atUpper !== undefined) {
          poly = clipHalfPlane(poly, atUpper.origin, [-atUpper.dir[0], -atUpper.dir[1]]);
        }
        if (poly.length < 3 || polygonArea(poly) <= EPS) {
          return err(
            modelingError(
              'model-invalid-argument',
              'thickness too large for the fold',
              { thickness, facet: i, row: r, vertices: poly.length },
              'lower the tile thickness or make the roof fold gentler',
            ),
          );
        }
        const worldPoly = poly.map(([x, y]): Point2 => [sign * x, y]);

        const panLabels: string[] = [];
        for (let c = 0; c < columns; c++) {
          const span = spans[c] as Span;
          const label = `${name}-${side}${i}-r${r}-c${c}`;
          const plate = model();
          const built = plate.extrudePolygon({
            points: worldPoly,
            depth: span.z1 - span.z0,
            label,
          });
          const plateFailure = failure(built, 'a tile pan could not be built');
          if (plateFailure !== undefined) return err(plateFailure);
          const placed = m.append(plate, { translate: [0, 0, span.z0], label });
          const placedFailure = failure(placed, 'a tile pan could not be placed');
          if (placedFailure !== undefined) return err(placedFailure);
          panLabels.push(label);
          pans++;
        }

        const coverLabels: string[] = [];
        for (let j = 0; j < columns - 1; j++) {
          const zc = (j + 1) * tileWidth;
          const headShift = r === 0 && atUpper !== undefined ? foldShift(atUpper, f) : 0;
          const buttShift = r === count - 1 && atLower !== undefined ? foldShift(atLower, f) : 0;
          const head = sectionRing(f, s0, headShift, 2 * thickness, zc, coverWidth, sign);
          const butt = sectionRing(
            f,
            s1,
            buttShift,
            (2 + COVER_BUTT_STEP) * thickness,
            zc,
            coverWidth,
            sign,
          );
          const label = `${name}-${side}${i}-r${r}-k${j}`;
          const loft = m.loft({ profiles: [head, butt], caps: true, match: 'index', label });
          const loftFailure = failure(loft, 'a cover strip could not be lofted');
          if (loftFailure !== undefined) return err(loftFailure);
          coverLabels.push(label);
          covers++;
        }
        grid.push({ pans: panLabels, covers: coverLabels });
      }
      sideRows.push(grid);
    }
    pushAll(contacts, sideContacts(sideRows, ridgeLabel));
  }
  if (m.poisoned !== undefined) return err(m.poisoned);

  const finished = finishPart(m, name, anchors, {
    pans,
    covers,
    rows,
    columns,
    facets: 2 * facets.length,
    tileWidth,
    coverWidth,
    exposure,
    lap,
    pitchMin,
    pitchMax,
    tileLength: pitchMax + lap,
    thickness,
    length,
    ridgeHalf,
    ridgeHeight,
  });
  if (!finished.ok) return finished;
  return ok({ ...finished.value, contacts });
}

/** Maps a failed operation report to its error; a successful or skipped report yields undefined. */
function failure(report: OpReport, fallback: string): ModelingError | undefined {
  if (report.status !== 'failed') return undefined;
  return report.error ?? modelingError('model-degenerate', fallback, { op: report.op });
}

/** Pan spans between the covers: joints at k * tileWidth, covers of width `coverWidth` centred on them. */
function panSpans(length: number, tileWidth: number, coverWidth: number, columns: number): Span[] {
  const out: Span[] = [];
  let start = 0;
  for (let k = 1; k < columns; k++) {
    const centre = k * tileWidth;
    out.push({ z0: start, z1: centre - coverWidth / 2 });
    start = centre + coverWidth / 2;
  }
  out.push({ z0: start, z1: length });
  return out;
}

/** The ridge cap: a prism covering both first facets from the ridge down to `ridgeHalf`. */
function ridgeCap(first: Facet, half: number, rise: number): Point2[] {
  const apex = first.upper;
  const p: Point2 = [apex[0] + half * first.d[0], apex[1] + half * first.d[1]];
  const q: Point2 = [p[0] + rise * first.n[0], p[1] + rise * first.n[1]];
  const crown: Point2 = [0, q[1] + CROWN_RATIO * rise];
  return [apex, p, q, crown, [-q[0], q[1]], [-p[0], p[1]]];
}

/**
 * Slope offset per unit height of the mitre line through the fold origin: a point at height h
 * on the facet meets the mitre at slope `h * shift` measured from the fold origin.
 */
function foldShift(fold: FoldMitre, f: Facet): number {
  const bn = fold.dir[0] * f.n[0] + fold.dir[1] * f.n[1];
  const bd = fold.dir[0] * f.d[0] + fold.dir[1] * f.d[1];
  return bd / bn;
}

/**
 * The cover's end ring at slope position `s` of the facet, mapped to world. A profile point
 * (zz, hh) sits hh above the facet at slope `s + hh * shift`; a nonzero shift puts the ring in the
 * fold's mitre plane.
 */
function sectionRing(
  f: Facet,
  s: number,
  shift: number,
  hs: number,
  zc: number,
  coverWidth: number,
  sign: 1 | -1,
): Tuple3[] {
  return coverProfile(coverWidth, hs).map(([zz, hh]): Tuple3 => {
    const along = s + hh * shift;
    const x = f.upper[0] + along * f.d[0] + hh * f.n[0];
    const y = f.upper[1] + along * f.d[1] + hh * f.n[1];
    return [sign * x, y, zc + zz];
  });
}

/** Cover cross-section in (z, h): flat bedding, vertical sides to hs, half-round top of radius g/2. */
function coverProfile(g: number, hs: number): Point2[] {
  const r = g / 2;
  const out: Point2[] = [
    [-r, 0],
    [r, 0],
  ];
  for (let j = 0; j <= COVER_ARC_SEGMENTS; j++) {
    const angle = (Math.PI * j) / COVER_ARC_SEGMENTS;
    out.push([r * cos(angle), hs + r * sin(angle)]);
  }
  return out;
}

/**
 * Seat contacts of one roof side: within a row, pan to cover; between rows, same-column pans and
 * same-gap covers; across each fold, the last row of the upper facet to the first row of the
 * lower facet; the first row of the first facet to the ridge cap.
 */
function sideContacts(
  sideRows: readonly (readonly RowLabels[])[],
  ridge: string,
): DesignedContact[] {
  const out: DesignedContact[] = [];
  const seat = (a: string, b: string): void => {
    out.push({ parts: [a, b], kind: 'seat' });
  };
  const seatRows = (above: RowLabels, below: RowLabels): void => {
    above.pans.forEach((p, c) => {
      seat(p, below.pans[c] as string);
    });
    above.covers.forEach((cv, j) => {
      seat(cv, below.covers[j] as string);
    });
  };
  sideRows.forEach((grid, i) => {
    grid.forEach((row, r) => {
      row.covers.forEach((cv, j) => {
        seat(row.pans[j] as string, cv);
        seat(cv, row.pans[j + 1] as string);
      });
      if (r > 0) seatRows(grid[r - 1] as RowLabels, row);
    });
    if (i > 0) {
      const upper = sideRows[i - 1] as readonly RowLabels[];
      seatRows(upper[upper.length - 1] as RowLabels, grid[0] as RowLabels);
    }
  });
  const head = sideRows[0]?.[0];
  if (head !== undefined) {
    head.pans.forEach((p) => {
      seat(ridge, p);
    });
    head.covers.forEach((cv) => {
      seat(ridge, cv);
    });
  }
  return out;
}

function profileError(purlins: readonly JuzhePurlin[]): ModelingError | undefined {
  if (purlins.length < 2) {
    return modelingError(
      'model-invalid-argument',
      'purlins has at least a ridge and an eave point',
      { count: purlins.length },
      'pass the purlin points of juzhePurlins',
    );
  }
  for (let i = 0; i < purlins.length; i++) {
    const p = purlins[i] as JuzhePurlin;
    if (!Number.isFinite(p.run) || !Number.isFinite(p.height)) {
      return modelingError('model-invalid-argument', 'purlin values are finite', { index: i });
    }
    if (i === 0 && p.run !== 0) {
      return modelingError('model-invalid-argument', 'the first purlin is the ridge at run 0', {
        run: p.run,
      });
    }
    if (i > 0) {
      const q = purlins[i - 1] as JuzhePurlin;
      if (p.run <= q.run) {
        return modelingError('model-invalid-argument', 'purlin runs strictly increase', {
          index: i,
        });
      }
      if (p.height > q.height) {
        return modelingError('model-invalid-argument', 'purlin heights do not rise outward', {
          index: i,
        });
      }
    }
  }
  return undefined;
}
