import { err, ok, type Result } from '@forgeax/engine-types';
import { pushAll } from './arrays';
import { type FrameMode, type PathInput, pathFrames, samplePath } from './curve';
import { faceFolded } from './deform';
import { atan2, cos, hypot2, sin } from './dmath';
import { type ModelingError, modelingError } from './errors';
import {
  add,
  cross,
  dot,
  faceArea,
  faceCentroid,
  length,
  newell,
  normalize,
  scale,
  sub,
  type Tuple3,
  triangulateLoop,
} from './geom';
import type { EditMesh } from './mesh';
import { extrudeRegion, markRole, type OpDiagnostic, type RoleCounts } from './ops';

export interface PathExtrudeOptions {
  /**
   * Path in world meters; it is moved so its first point sits at the region's
   * area-weighted centroid. Polyline points or a `path.*` spec, as for sweep.
   */
  readonly path: PathInput;
  /** 'rmf' (default) rotation-minimizing frames; 'up' keeps the frame's y toward `up`. */
  readonly frame?: FrameMode;
  readonly up?: Tuple3;
  /**
   * Cross-section scale: the end value from 1, `[start, end]` linear in arc length, or one
   * value per sampled station (three or more values; station count = path points).
   */
  readonly scale?: number | readonly number[];
  /** Section rotation about the path in degrees, ramped like `scale` (from 0). */
  readonly twist?: number | readonly number[];
}

const MAX_REPORTED = 32;

function invalid(expected: string, detail: Record<string, unknown>): Result<never, ModelingError> {
  return err(modelingError('model-invalid-argument', expected, detail));
}

/** Value at station `i` of `n` with arc-length fraction `u`: end value, [start, end] or per station. */
function ramp(
  name: string,
  value: number | readonly number[] | undefined,
  rest: number,
  n: number,
): Result<(i: number, u: number) => number, ModelingError> {
  if (value === undefined) return ok(() => rest);
  const values = typeof value === 'number' ? [rest, value] : [...value];
  if (!values.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return invalid(`${name} is a finite number or a list of them`, { [name]: value });
  }
  if (values.length === 2) {
    const [a, b] = values as [number, number];
    return ok((_i, u) => a + (b - a) * u);
  }
  if (values.length !== n) {
    return invalid(`${name} has 1, 2 or one value per path station (${n})`, {
      [name]: value,
      stations: n,
    });
  }
  return ok((i) => values[i] as number);
}

/**
 * Region extrude along a path (spin or screw by a curve): the region's boundary ring is placed at every path station in that station's
 * frame, with its scale and twist, joined by one wall strip per span (role `side`); the
 * region itself ends at the last station (role `top`). With a label, the walls of span k
 * also get tag `<label>:ring:<k>`. Station 0 is the region where it
 * is, so the first frame is aligned with the region, not rotated onto the path.
 */
export function pathExtrude(
  mesh: EditMesh,
  faces: readonly number[],
  options: PathExtrudeOptions,
  label: number,
  tolerance: number,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const grown = pathExtrudeFaces(mesh, faces, options, label, tolerance, diagnostics);
  return grown.ok ? ok(grown.value.counts) : grown;
}

/** pathExtrude with the faces it produced: the walls and the moved region (`top`). */
export function pathExtrudeFaces(
  mesh: EditMesh,
  faces: readonly number[],
  options: PathExtrudeOptions,
  label: number,
  tolerance: number,
  diagnostics: OpDiagnostic[],
  /** The region's shared vertices when the caller knows them (see `detachRegion`). */
  shared?: ReadonlySet<number>,
): Result<
  { readonly counts: RoleCounts; readonly walls: number[]; readonly top: number[] },
  ModelingError
> {
  const sampled = samplePath(options.path, false, tolerance);
  if (!sampled.ok) return sampled;
  const area = faces.reduce<Tuple3>(
    (sum, f) => add(sum, newell(mesh.faceVertices(f).map((v) => mesh.position(v)))),
    [0, 0, 0],
  );
  const normal = normalize(area);
  let weight = 0;
  let center: Tuple3 = [0, 0, 0];
  for (const f of faces) {
    const a = dot(newell(mesh.faceVertices(f).map((v) => mesh.position(v))), normal);
    weight += a;
    center = add(center, scale(faceCentroid(mesh, f), a));
  }
  if (!(weight > 0)) {
    return err(
      modelingError('model-degenerate', 'the region has a non-zero area along its normal', {
        faces: faces.length,
      }),
    );
  }
  center = scale(center, 1 / weight);
  const shift = sub(center, sampled.value[0] as Tuple3);
  const points = sampled.value.map((p) => add(p, shift));
  const frames = pathFrames(points, false, options.frame ?? 'rmf', options.up ?? [0, 1, 0]);
  if (!frames.ok) return frames;
  const n = frames.value.length;
  const total = (frames.value[n - 1] as (typeof frames.value)[number]).s;
  const scaleAt = ramp('scale', options.scale, 1, n);
  if (!scaleAt.ok) return scaleAt;
  const twistAt = ramp('twist', options.twist, 0, n);
  if (!twistAt.ok) return twistAt;
  const first = frames.value[0] as (typeof frames.value)[number];
  if (dot(first.tangent, normal) < 0) {
    diagnostics.push({
      severity: 'warn',
      message: 'the path starts against the region normal; the first walls fold back into the part',
      detail: { normal, tangent: first.tangent },
    });
  }
  // A span that turns the section by half a turn or more reads as untwisted (the ring
  // joins the nearest vertices again): ask for more stations.
  const steep: { span: number; degrees: number }[] = [];
  for (let k = 1; k < n; k++) {
    const u0 = total > 0 ? (frames.value[k - 1] as (typeof frames.value)[number]).s / total : 0;
    const u1 = total > 0 ? (frames.value[k] as (typeof frames.value)[number]).s / total : 1;
    const degrees = Math.abs(twistAt.value(k, u1) - twistAt.value(k - 1, u0));
    if (degrees >= 180) steep.push({ span: k - 1, degrees });
  }
  if (steep.length > 0) {
    diagnostics.push({
      severity: 'warn',
      message: `${steep.length} path span(s) twist by 180 degrees or more, which the walls cannot show: add path points so each span twists less`,
      detail: { spans: steep.slice(0, MAX_REPORTED) },
    });
  }
  const local = new Map<number, Tuple3>();
  for (const f of faces) {
    for (const v of mesh.faceVertices(f)) {
      if (local.has(v)) continue;
      const d = sub(mesh.position(v), center);
      local.set(v, [dot(d, first.x), dot(d, first.y), dot(d, first.tangent)]);
    }
  }
  let region = [...faces];
  let origin = new Map<number, number>([...local.keys()].map((v) => [v, v]));
  const spanOf = new Map<number, number>();
  const sectionReach = [...local.values()].reduce((r, [x, y]) => Math.max(r, hypot2(x, y)), 0);
  const walls: number[] = [];
  for (let k = 1; k < n; k++) {
    const f = frames.value[k] as (typeof frames.value)[number];
    const u = total > 0 ? f.s / total : 1;
    const s = scaleAt.value(k, u);
    if (!(s > 0)) return invalid('scale stays > 0 at every station', { station: k, scale: s });
    const angle = (twistAt.value(k, u) * Math.PI) / 180;
    const c = cos(angle);
    const sn = sin(angle);
    const before = region.map((g) => mesh.faceVertices(g));
    // From the second station on, the region is the one moved before: only its new walls
    // use its vertices.
    const extruded = extrudeRegion(
      mesh,
      region,
      (v) => {
        const [x, y, z] = local.get(origin.get(v) as number) as Tuple3;
        const rx = (x * c - y * sn) * s;
        const ry = (x * sn + y * c) * s;
        return add(add(add(f.point, scale(f.x, rx)), scale(f.y, ry)), scale(f.tangent, z * s));
      },
      k > 1 ? 'boundary' : shared,
    );
    if (!extruded.ok) return extruded;
    const next = new Map<number, number>();
    for (const [i, g] of extruded.value.moved.entries()) {
      const old = before[i] as number[];
      for (const [j, v] of mesh.faceVertices(g).entries()) {
        next.set(v, origin.get(old[j] as number) as number);
      }
    }
    origin = next;
    region = extruded.value.moved;
    pushAll(walls, extruded.value.walls);
    for (const g of extruded.value.walls) spanOf.set(g, k);
    if (label !== 0) {
      // Ring k (the walls of span k) is addressable: sel.tag('<label>:ring:<k>').
      const ring = mesh.tagIndex(`${mesh.labelNames[label]}:ring:${k - 1}`, true);
      for (const f of extruded.value.walls) mesh.addTag(f, ring);
    }
  }
  const counts: RoleCounts = {};
  markRole(mesh, region, label, 'top', counts);
  markRole(mesh, walls, label, 'side', counts);
  const folded = walls.filter((g) => faceFolded(mesh, g));
  // As validate's face-degenerate: no area above the tolerance, or no triangulation.
  const collapsed = [...region, ...walls].filter(
    (g) =>
      faceArea(mesh, g) <= tolerance * tolerance ||
      triangulateLoop(mesh.faceVertices(g).map((v) => mesh.position(v))) === undefined,
  );
  diagnostics.push({
    severity: 'info',
    message: `extruded along ${n - 1} path spans (${total.toPrecision(4)} m)`,
    detail: { stations: n, length: total, walls: walls.length },
  });
  if (folded.length > 0) {
    // Per span with folded walls: how sharply the path turns into its end station, how long
    // it is, and how far the section reaches from the path there (a section reaching
    // farther than the turn leaves room for folds; lengthen the span before the turn, turn
    // less, or narrow the section).
    const spans = [...new Set(folded.map((g) => spanOf.get(g) as number))]
      .sort((a, b) => a - b)
      .map((k) => {
        const a = frames.value[k - 1] as (typeof frames.value)[number];
        const b = frames.value[k] as (typeof frames.value)[number];
        const u = total > 0 ? b.s / total : 1;
        return {
          span: k - 1,
          turnDegrees:
            (atan2(length(cross(a.tangent, b.tangent)), dot(a.tangent, b.tangent)) * 180) / Math.PI,
          length: length(sub(b.point, a.point)),
          reach: sectionReach * scaleAt.value(k, u),
        };
      });
    diagnostics.push({
      severity: 'warn',
      message: `${folded.length} wall face(s) fold over: a bend tighter than the section (detail.spans: turn, span length and section reach; lengthen the span before the turn, turn less or narrow the section), or a twist over half a turn per span`,
      detail: {
        faces: folded.slice(0, MAX_REPORTED),
        count: folded.length,
        spans: spans.slice(0, MAX_REPORTED),
      },
    });
  }
  if (collapsed.length > 0) {
    diagnostics.push({
      severity: 'warn',
      message: `${collapsed.length} face(s) collapse below the tolerance: a scale near 0 shrinks the section to a point (end on a small scale and close the tip separately), or a twist turns a wall edge onto its partner (add path points)`,
      detail: { faces: collapsed.slice(0, MAX_REPORTED), count: collapsed.length },
    });
  }
  return ok({ counts, walls, top: region });
}
