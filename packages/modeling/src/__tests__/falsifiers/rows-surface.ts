import { type AtlasBleedReport, atlasBleedReport } from '../../compute/atlas-ts';
import { measureUv } from '../../compute/uv-ts';
import type { Tuple3 } from '../../geom';
import { type Model, model } from '../../model';
import { type NurbsCurve, type NurbsSurface, nurbs } from '../../nurbs';
import { sel } from '../../selectors';
import {
  checkSurfaceQuality,
  curveFairness,
  D09_CLASSES,
  measureEdge,
} from '../../surface-quality';
import {
  type TrimModule,
  type TrimRegion,
  type TrimSheet,
  trimReport,
  trimSheet,
} from '../../trim';
import { uvOverlapPairs } from '../../uv-overlap';
import type { FalsifierRow, PendingCheck, Verdict } from './registry';

function heightPatch(
  [x0, x1]: readonly [number, number],
  [y0, y1]: readonly [number, number],
  f: (x: number, y: number) => number,
  n = 4,
): NurbsSurface {
  const rows = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j): Tuple3 => {
      const x = x0 + ((x1 - x0) * i) / (n - 1);
      const y = y0 + ((y1 - y0) * j) / (n - 1);
      return [x, y, f(x, y)];
    }),
  );
  const s = nurbs.grid(rows, { parametrization: 'uniform' });
  if (!s.ok) throw s.error;
  return s.value;
}

function curveThrough(points: readonly Tuple3[]): NurbsCurve {
  const c = nurbs.interpolate(points);
  if (!c.ok) throw c.error;
  return c.value;
}

const arc = (n: number): Tuple3[] =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / (n - 1)) * 1.2;
    return [2 * Math.sin(a), 0, 2 * (1 - Math.cos(a))];
  });

const paraboloid = (x: number, y: number) => 0.2 * (x * x + y * y);

/** Two patches meeting at x = 0: a flat one, then a slope of 2 (a 63 degree fold). */
const flatLeft = () => heightPatch([-1, 0], [-1, 1], () => 0);
const foldRight = () => heightPatch([0, 1], [-1, 1], (x) => 2 * x);

function curveVerdict(result: ReturnType<typeof curveFairness>): Verdict {
  if (!result.ok) return { pass: false, codes: [result.error.code] };
  const f = result.value;
  const codes = [
    ...(f.inflections.length > 0 ? ['curve-inflection'] : []),
    ...(f.spikes.length > 0 ? ['curve-spike'] : []),
    ...(f.rateRatio > 15 ? ['curve-curvature-rate'] : []),
  ];
  return { pass: f.pass, codes };
}

function surfaceVerdict(result: ReturnType<typeof checkSurfaceQuality>): Verdict {
  if (!result.ok) return { pass: false, codes: [result.error.code] };
  return { pass: result.value.pass, codes: result.value.issues.map((i) => i.code) };
}

/** Mirrors the G1 rule checkSurfaceQuality applies to a primary edge (default continuity). */
function edgeVerdict(result: ReturnType<typeof measureEdge>): Verdict {
  if (!result.ok) return { pass: false, codes: [result.error.code] };
  const limit = D09_CLASSES.primary;
  const pass = result.value.gap <= limit.position && result.value.angle <= limit.angle;
  return { pass, codes: pass ? [] : ['surface-continuity'] };
}

function uvVerdict(result: ReturnType<typeof measureUv>): Verdict {
  if (!result.ok) return { pass: false, codes: [result.error.code] };
  const pass = result.value.flipped === 0 && result.value.zeroArea === 0;
  return { pass, codes: [] };
}

/** Pairs are the kernel's overlap finding; validate reports exactly this as `uv-overlap`. */
function overlapVerdict(pairs: readonly [number, number][]): Verdict {
  return { pass: pairs.length === 0, codes: pairs.length > 0 ? ['uv-overlap'] : [] };
}

function trimVerdict(result: ReturnType<typeof trimReport>): Verdict {
  if (!result.ok) return { pass: false, codes: [result.error.code] };
  return { pass: result.value.pass, codes: result.value.issues.map((i) => i.code) };
}

/** A 1.96 m fan quad in the plane z = 0, the same shape the trimReport wall uses. */
function fanQuad(sheet: TrimSheet): Model {
  const m = model();
  m.polygon({
    points: [
      [0, 0, 0],
      [1.96, 0, 0],
      [1.96, 1.96, 0],
      [0, 1.96, 0],
    ],
    tag: 'fan',
  });
  m.uv.trim({
    faces: sel.tag('fan'),
    region: sheet.regions.fan as TrimRegion,
    axis: [1, 0, 0],
  });
  return m;
}

function trimSheetOf(modules: readonly TrimModule[]): TrimSheet {
  const r = trimSheet({ key: 'rows', size: 512, density: 128, modules });
  if (!r.ok) throw r.error;
  return r.value;
}

const FAN: TrimModule = { id: 'fan', size: [1.96, 1.96] };
const RECESS: TrimModule = { id: 'recess', size: [0.1, 0.1] };

export const SURFACE_ROWS: readonly FalsifierRow[] = [
  {
    check: 'curveFairness',
    pass: () => curveVerdict(curveFairness({ name: 'roof', curve: curveThrough(arc(6)) })),
    fail: () => {
      const base = curveThrough(arc(20));
      const bump: NurbsCurve = {
        ...base,
        points: base.points.map((p, i): Tuple3 => (i === 10 ? [p[0], p[1], p[2] - 0.003] : p)),
      };
      return curveVerdict(curveFairness({ name: 'bump', curve: bump }));
    },
    expect: 'curve-spike',
  },
  {
    check: 'checkSurfaceQuality',
    pass: () =>
      surfaceVerdict(
        checkSurfaceQuality({
          surfaces: [
            { name: 'left', surface: heightPatch([-1, 0], [-1, 1], paraboloid) },
            { name: 'right', surface: heightPatch([0, 1], [-1, 1], paraboloid) },
          ],
        }),
      ),
    fail: () =>
      surfaceVerdict(
        checkSurfaceQuality({
          surfaces: [
            { name: 'flat', surface: flatLeft() },
            { name: 'fold', surface: foldRight() },
          ],
        }),
      ),
    expect: 'surface-continuity',
  },
  {
    check: 'measureEdge',
    pass: () =>
      edgeVerdict(
        measureEdge(
          heightPatch([-1, 0], [-1, 1], paraboloid),
          'u1',
          heightPatch([0, 1], [-1, 1], paraboloid),
          'u0',
        ),
      ),
    fail: () => edgeVerdict(measureEdge(flatLeft(), 'u1', foldRight(), 'u0')),
    expect: 'surface-continuity',
  },
  {
    check: 'measureUv',
    pass: () => {
      const m = model();
      m.plane({ width: 2, height: 1, widthSegments: 2, heightSegments: 1 });
      m.uv.project({ mode: 'planar', axis: 'z', scale: 1 });
      return uvVerdict(measureUv(m.editMesh));
    },
    fail: () => {
      const m = model();
      m.plane({ width: 2, height: 1, widthSegments: 2, heightSegments: 1 });
      return uvVerdict(measureUv(m.editMesh));
    },
    expect: 'model-precondition',
  },
  {
    check: 'uvOverlapPairs',
    pass: () => {
      const m = model();
      m.plane({ width: 2, height: 1, widthSegments: 2, heightSegments: 1 });
      m.uv.project({ mode: 'planar', axis: 'z', scale: 1 });
      return overlapVerdict(uvOverlapPairs(m.editMesh, m.editMesh.faces()));
    },
    fail: () => {
      const m = model();
      m.cylinder({
        radiusTop: 0.5,
        radiusBottom: 0.5,
        height: 1,
        radialSegments: 16,
        heightSegments: 2,
        openEnded: true,
      });
      m.uv.project({ mode: 'planar', axis: 'z', scale: 1 });
      return overlapVerdict(uvOverlapPairs(m.editMesh, m.editMesh.faces()));
    },
    expect: 'uv-overlap',
  },
  {
    check: 'trimReport',
    pass: () => {
      const sheet = trimSheetOf([FAN]);
      return trimVerdict(trimReport(sheet, [fanQuad(sheet)]));
    },
    fail: () => {
      const sheet = trimSheetOf([FAN, RECESS]);
      return trimVerdict(trimReport(sheet, [fanQuad(sheet)]));
    },
    expect: 'trim-unused',
  },
  {
    check: 'atlasBleedReport',
    pass: () => {
      const owner = Int32Array.from([0, 0, 1, 1, 0, 0, 1, 1, 2, 2, 3, 3, 2, 2, 3, 3]);
      const chart = Uint8Array.from({ length: 16 }, () => 1);
      const r: AtlasBleedReport = atlasBleedReport(
        owner,
        chart,
        { w: 4, h: 4, u: false, v: false },
        1,
      );
      return { pass: r.pass, codes: r.pass ? [] : ['mip-bleed'] };
    },
    fail: () => {
      const owner = Int32Array.from([0, 1, 1, 1, 0, 0, 1, 1, 2, 2, 3, 3, 2, 2, 3, 3]);
      const chart = Uint8Array.from({ length: 16 }, () => 1);
      const r: AtlasBleedReport = atlasBleedReport(
        owner,
        chart,
        { w: 4, h: 4, u: false, v: false },
        1,
      );
      return { pass: r.pass, codes: r.pass ? [] : ['mip-bleed'] };
    },
    expect: 'mip-bleed',
  },
];

export const SURFACE_PENDING: readonly PendingCheck[] = [
  {
    check: 'thinHoleCheck',
    reason:
      'returns a bare ThinHoleReport boolean (maxError against tolerance) with no issue code and no caller maps it to one, so no expect code exists',
  },
];
