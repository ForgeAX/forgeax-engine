import {
  type Model,
  model,
  type NurbsCurve,
  type NurbsSurface,
  nurbs,
  type PatchLayoutSpec,
  type Tuple3,
} from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';

/**
 * Case C-115: the door side, C-pillar and rear deck side of a mid-engine body
 * corner, built from a patch layout instead
 * of traced and interpolated. x runs rearward along the car, y up, z outward (left half).
 *
 * Lines first: the knee line (crease between the lower band and the upper surfaces) and
 * the shoulder line (top of the upper surfaces, the DLO and deck edge) are single-span
 * curves. Below the knee, one primary band is fit to the trace with the knee as its fixed
 * top edge and split exactly at the two stations: P04 (door), P04c (C-pillar foot) and
 * P05 (rear quarter). Above it, P10 (tumblehome, primary) and P11 (rear deck side,
 * primary) are fit with the knee and shoulder pieces as fixed edges; S03 (C-pillar,
 * secondary) between them is matched G2 to both. The knee is a G0 crease on its line,
 * held by G2 blends.
 */
export const C115 = {
  /** Stations along x (m): front of the door, C-pillar front and rear, tail. */
  x: [0, 0.9, 1.2, 1.6] as const,
  /** Heights (m): sill, knee line, shoulder line. */
  y: [0.3, 0.62, 0.95] as const,
  kneeBlend: 0.004,
  /** The designed S of the knee line in plan (tuck at the door, flare at the rear wheel). */
  kneeInflection: [0.1, 0.35] as readonly [number, number],
  /** And of the shoulder line (the sail turning in toward the tail). */
  shoulderInflection: [0.45, 0.75] as readonly [number, number],
  /** Weld distance of the tessellation: the blends refit their neighbours within 10 um. */
  weld: 5e-5,
  /** Trace noise (m) and the trace grid per fitted region. */
  noise: 0.0004,
  trace: [16, 10] as [number, number],
  fair: { rate: 1e-6 },
} as const;


/** Reference shapes (meters), polynomial so the single-span lines hold them exactly. */
export const shape = {
  /** Lower band: a barrel section, tucked at the door and widening over the rear wheel (one S in plan). */
  side(x: number, y: number): Tuple3 {
    const m = (y - 0.46) / 0.16;
    const t = x / 1.6;
    return [x, y, 0.88 - 0.035 * m * m - 0.03 * t * t + 0.05 * t * t * t];
  },
  /** Upper surfaces: lean in from the knee, more so toward the tail (the sail). */
  upper(x: number, y: number): Tuple3 {
    const h = (y - 0.62) / 0.33;
    const t = x / 1.6;
    const base = shape.side(x, 0.62)[2];
    return [x, y, base - (0.22 + 0.06 * t * t) * h - 0.04 * h * h];
  },
};

/** Deterministic trace noise, as in C-114. */
const noise = (i: number, j: number) =>
  C115.noise * Math.sin(i * 2.3 + j * 1.7) * Math.cos(i * 0.7 - j * 2.9);

/** A blueprint trace of `f` over [x0, x1] x [y0, y1]: rows along x, noisy in z. */
export function trace(
  f: (x: number, y: number) => Tuple3,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  size: readonly [number, number] = C115.trace,
): Tuple3[][] {
  const [nx, ny] = size;
  return Array.from({ length: nx }, (_, i) =>
    Array.from({ length: ny }, (_, j): Tuple3 => {
      const p = f(x0 + ((x1 - x0) * i) / (nx - 1), y0 + ((y1 - y0) * j) / (ny - 1));
      return [p[0], p[1], p[2] + noise(i, j)];
    }),
  );
}

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: Error }): T => {
  if (!r.ok) throw r.error;
  return r.value;
};

const L = C115.x[3];

/** A feature line along x, single-span quartic, parameter proportional to x (t = x / L). */
function line(at: (x: number) => Tuple3): NurbsCurve {
  const params = Array.from({ length: 17 }, (_, k) => k / 16);
  return ok(
    nurbs.approximate(
      params.map((t) => at(L * t)),
      { controlPoints: 5, degree: 4, parameters: params },
    ),
  );
}

export function featureLines() {
  return {
    knee: line((x) => shape.side(x, C115.y[1])),
    shoulder: line((x) => shape.upper(x, C115.y[2])),
  };
}

/** The piece of `curve` between stations x0 < x1 (exact split, same polynomial). */
function piece(curve: NurbsCurve, x0: number, x1: number): NurbsCurve {
  let out = curve;
  if (x1 < L) out = ok(nurbs.split(out, x1 / L))[0];
  if (x0 > 0) out = ok(nurbs.split(out, x0 / L))[1];
  return out;
}

/** The layout of the case: ids and nets, every side declared once. */
export function layout(): PatchLayoutSpec {
  const [x0, x1, x2, x3] = C115.x;
  const [ys, yk, yw] = C115.y;
  const fair = C115.fair;
  const { knee, shoulder } = featureLines();
  // Lower band: fit with the knee as its fixed top edge, split exactly at the stations.
  const band = ok(
    nurbs.fitSurface(trace(shape.side, x0, x3, ys, yk, [24, 10]), {
      degree: [6, 5],
      net: [7, 6],
      boundaries: { v1: knee },
      fair,
    }),
  ).surface;
  const [front, rest] = ok(nurbs.surface.split(band, 'u', x1 / L));
  const [foot, quarter] = ok(nurbs.surface.split(rest, 'u', x2 / L));
  const upper = (a: number, b: number) =>
    ok(
      nurbs.fitSurface(trace(shape.upper, a, b, yk, yw), {
        degree: [6, 5],
        net: [7, 6],
        boundaries: { v0: piece(knee, a, b), v1: piece(shoulder, a, b) },
        fair,
      }),
    ).surface;
  const knee0 = (to: `${string}:${'u0' | 'u1' | 'v0' | 'v1'}`) =>
    ({ to, continuity: 'G0', feature: 'knee' }) as const;
  return {
    name: 'c115',
    featureLines: ['knee', 'shoulder'],
    patches: [
      { id: 'P04', role: 'primary', inflections: { u: 1 }, panel: 'door', surface: front, sides: { u0: { free: true }, v0: { free: true } } },
      { id: 'P04c', role: 'primary', inflections: { u: 1 }, panel: 'door', surface: foot, sides: { u0: { to: 'P04:u1', continuity: 'G2' }, v0: { free: true } } },
      { id: 'P05', role: 'primary', inflections: { u: 1 }, panel: 'rear-fender', surface: quarter, sides: { u0: { to: 'P04c:u1', continuity: 'G2' }, u1: { free: true }, v0: { free: true } } },
      { id: 'P10', role: 'primary', inflections: { u: 1 }, panel: 'door', surface: upper(x0, x1), sides: { v0: knee0('P04:v1'), v1: { feature: 'shoulder' }, u0: { free: true } } },
      { id: 'P11', role: 'primary', inflections: { u: 1 }, panel: 'rear-fender', surface: upper(x2, x3), sides: { v0: knee0('P05:v1'), v1: { feature: 'shoulder' }, u1: { free: true } } },
      {
        id: 'S03',
        role: 'secondary',
        inflections: { u: 1 },
        panel: 'roof',
        surface: upper(x1, x2),
        sides: {
          u0: { to: 'P10:u1', continuity: 'G2' },
          u1: { to: 'P11:u0', continuity: 'G2' },
          v0: knee0('P04c:v1'),
          v1: { feature: 'shoulder' },
        },
      },
    ],
    blends: [
      { between: ['P04', 'P10'], radius: C115.kneeBlend, continuity: 'G2', name: 'knee-door' },
      { between: ['P04c', 'S03'], radius: C115.kneeBlend, continuity: 'G2', name: 'knee-pillar' },
      { between: ['P05', 'P11'], radius: C115.kneeBlend, continuity: 'G2', name: 'knee-deck' },
    ],
  };
}

/** Right: the layout built (fit, split, match, blend) and exported along the isoparms. */
export function buildLayout(session: SessionFactory = () => model()): Model {
  const body = session('layout');
  const lines = featureLines();
  body.featureLine({ name: 'knee', curve: lines.knee, continuity: 'G0', inflections: [C115.kneeInflection] });
  body.featureLine({ name: 'shoulder', curve: lines.shoulder, inflections: [C115.shoulderInflection] });
  body.patchLayout(layout());
  body.surface({ layout: 'c115', chord: 0.0005, weld: C115.weld, nonPlanar: 'keep', spacing: 'even', tag: 'body' });
  body.uv.project({ mode: 'box', scale: 1 });
  return body;
}

/** Wrong (the old way): the same region traced and interpolated with nurbs.grid as one patch. */
export function buildGrid(session: SessionFactory = () => model()): Model {
  const grid = session('grid');
  const [x0, , , x3] = C115.x;
  const [ys, yk, yw] = C115.y;
  const rows = trace((x, y) => (y <= yk ? shape.side(x, y) : shape.upper(x, y)), x0, x3, ys, yw, [24, 18]);
  const side = nurbs.grid(rows);
  if (!side.ok) throw side.error;
  const lines = featureLines();
  grid.featureLine({ name: 'knee', curve: lines.knee, continuity: 'G0', inflections: [C115.kneeInflection] });
  grid.featureLine({ name: 'shoulder', curve: lines.shoulder, inflections: [C115.shoulderInflection] });
  grid.surface({ patches: [{ name: 'side', surface: side.value }], chord: 0.0005, tag: 'body' });
  grid.uv.project({ mode: 'box', scale: 1 });
  return grid;
}

/** The built (matched, pre-blend) patches of the layout, by id. */
export function patches(m: Model): ReadonlyMap<string, NurbsSurface> {
  return new Map(m.diagnostics().surfaces.map((s) => [s.name, s.surface]));
}
