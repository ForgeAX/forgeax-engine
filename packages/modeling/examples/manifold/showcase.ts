import type { Result } from '@forgeax/engine-types';
import { booleanSolids } from '../../src/brep/boolean';
import { cylinder } from '../../src/brep/build';
import { loft } from '../../src/brep/loft';
import { type ProfileSegment, revolveProfile } from '../../src/brep/revolve-profile';
import { sweep } from '../../src/brep/sweep';
import type { Frame, Shape } from '../../src/brep/types';
import type { P2, P3 } from '../../src/brep/vec';
import { cos, sin } from '../../src/dmath';
import type { ModelingError } from '../../src/errors';
import { interpolate } from '../../src/nurbs';

const TAU = 2 * Math.PI;

function must<T>(result: Result<T, ModelingError>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

/** Dimensions in one place so the test can cross-check volumes by hand. */
export const MANIFOLD = {
  bore: 0.38,
  pipe: 0.5,
  flangeR: 0.8,
  flangeT: 0.25,
  headerLength: 6,
  boltRadius: 0.07,
  boltCircle: 0.65,
  boltCount: 8,
} as const;

/** Frame whose z runs along world +x (local x = world y, local y = world z). */
const alongX = (o: P3): Frame => ({ o, x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] });
/** Frame whose z runs along world -x (local x = world y, local y = world -z). */
const alongMinusX = (o: P3): Frame => ({ o, x: [0, 1, 0], y: [0, 0, -1], z: [-1, 0, 0] });

function circle(radius: number, count: number): P2[] {
  return Array.from({ length: count }, (_, i) => [
    radius * cos((TAU * i) / count),
    radius * sin((TAU * i) / count),
  ]);
}

/** Rounded rectangle with `arc` points per corner, counter-clockwise from the +x side. */
function roundedRect(w: number, h: number, r: number, arc: number): P2[] {
  const pts: P2[] = [];
  const corners: [number, number, number][] = [
    [w / 2 - r, h / 2 - r, 0],
    [-w / 2 + r, h / 2 - r, 1],
    [-w / 2 + r, -h / 2 + r, 2],
    [w / 2 - r, -h / 2 + r, 3],
  ];
  for (const [cx, cy, quarter] of corners) {
    for (let k = 0; k <= arc; k++) {
      const a = (Math.PI / 2) * (quarter + k / arc);
      pts.push([cx + r * cos(a), cy + r * sin(a)]);
    }
  }
  return pts;
}

const line = (to: P2): ProfileSegment => ({ kind: 'line', to });

/** One attempted boolean: failures are closed (`model-partial`), never silent. */
export interface JoinReport {
  readonly step: string;
  readonly ok: boolean;
  readonly code?: string;
  readonly brep?: string | undefined;
  readonly expected?: string;
}

export interface Manifold {
  readonly parts: readonly Shape[];
  readonly names: readonly string[];
  readonly joins: readonly JoinReport[];
  readonly boltHoles: number;
}

function drill(
  shape: Shape,
  center: P2,
  x0: number,
  x1: number,
  tag: string,
  joins: JoinReport[],
): { shape: Shape; holes: number } {
  let current = shape;
  const n = MANIFOLD.boltCount;
  for (let i = 0; i < n; i++) {
    const t = (TAU * i) / n;
    const hole = must(
      cylinder({
        radius: MANIFOLD.boltRadius,
        height: x1 - x0 + 0.1,
        frame: alongX([
          (x0 + x1) / 2,
          center[0] + MANIFOLD.boltCircle * cos(t),
          center[1] + MANIFOLD.boltCircle * sin(t),
        ]),
      }),
    );
    const next = booleanSolids(current, hole, 'difference');
    if (!next.ok) {
      joins.push(describe(`${tag}: bolt hole ${i} (difference)`, next));
      return { shape: current, holes: i };
    }
    current = next.value;
  }
  joins.push({ step: `${tag}: ${n} bolt holes (difference)`, ok: true });
  return { shape: current, holes: n };
}

function describe(step: string, r: Result<Shape, ModelingError>): JoinReport {
  if (r.ok) return { step, ok: true };
  const detail = r.error.detail as { brep?: string } | undefined;
  return { step, ok: false, code: r.error.code, brep: detail?.brep, expected: r.error.expected };
}

/** Union, recorded; the first operand is kept when the kernel refuses. */
function tryUnion(a: Shape, b: Shape, step: string, joins: JoinReport[]): Shape | undefined {
  const r = booleanSolids(a, b, 'union');
  joins.push(describe(step, r));
  return r.ok ? r.value : undefined;
}

/** Torispherical dome: knuckle torus tangent to a spherical crown, on a base disc of radius 0.55. */
function dome(frame: Frame): Shape {
  const k = 0.1;
  const kc: P2 = [0.45, 0];
  const phi = Math.PI / 3;
  // Crown centre on the axis so the crown is tangent to the knuckle: R = k + kc.r / cos(phi).
  const crown = k + kc[0] / cos(phi);
  const tangent: P2 = [kc[0] + k * cos(phi), kc[1] + k * sin(phi)];
  const cz = kc[1] + (k - crown) * sin(phi);
  return must(
    revolveProfile({
      start: [0, 0],
      segments: [
        line([kc[0] + k, 0]),
        { kind: 'arc', to: tangent, center: kc },
        { kind: 'arc', to: [0, cz + crown], center: [0, cz] },
      ],
      frame,
      label: 'manifold.dome',
      role: 'head',
    }),
  );
}

function blindFlange(frame: Frame): Shape {
  return must(
    revolveProfile({
      start: [0, 0],
      segments: [
        line([MANIFOLD.flangeR, 0]),
        line([MANIFOLD.flangeR, MANIFOLD.flangeT]),
        line([0, MANIFOLD.flangeT]),
      ],
      frame,
      label: 'manifold.blind-flange',
      role: 'flange',
    }),
  );
}

function flangeRing(x0: number, label: string): Shape {
  const { bore, flangeR, flangeT } = MANIFOLD;
  return must(
    revolveProfile({
      start: [bore, 0],
      segments: [
        line([flangeR, 0]),
        line([flangeR, flangeT]),
        line([bore, flangeT]),
        line([bore, 0]),
      ],
      frame: alongX([x0, 0, 0]),
      label,
      role: 'flange',
    }),
  );
}

/**
 * S-bend duct (sweep) - flange A (revolve) - header with stiffener rings (revolve) - flange B (revolve) -
 * lofted round-to-rectangle transition, with a blind flange and torispherical dome (torus + sphere) on the S-bend's free end.
 */
export function buildManifold(): Manifold {
  const { bore, pipe, flangeT, headerLength: L } = MANIFOLD;
  const joins: JoinReport[] = [];
  let holes = 0;

  // Header: a hollow tube with two stiffener rings seated on it; the union is attempted and recorded.
  const tube = must(
    revolveProfile({
      start: [bore, 0],
      segments: [line([pipe, 0]), line([pipe, L]), line([bore, L]), line([bore, 0])],
      frame: alongX([0, 0, 0]),
      label: 'manifold.header',
      role: 'header',
    }),
  );
  const ring = (x0: number): Shape =>
    must(
      revolveProfile({
        start: [0.5, 0],
        segments: [line([0.62, 0]), line([0.62, 0.3]), line([0.5, 0.3]), line([0.5, 0])],
        frame: alongX([x0, 0, 0]),
        label: 'manifold.stiffener',
        role: 'stiffener',
      }),
    );
  const header = tube;
  const rings = [1.8, 3.9].map(ring);
  for (const [i, r] of rings.entries()) {
    tryUnion(header, r, `header: stiffener ring ${i + 1} (seated union)`, joins);
  }

  const flangeA = drill(
    flangeRing(-flangeT, 'manifold.flange-a'),
    [0, 0],
    -flangeT,
    0,
    'flange A',
    joins,
  );
  const flangeB = drill(
    flangeRing(L, 'manifold.flange-b'),
    [0, 0],
    L,
    L + flangeT,
    'flange B',
    joins,
  );
  holes += flangeA.holes + flangeB.holes;

  // Blind flange on the free end of the S-bend, torispherical dome behind it pointing along -x.
  const free: P3 = [-5.5, 2.2, 1.2];
  const blind = drill(
    blindFlange(alongMinusX(free)),
    [free[1], free[2]],
    free[0] - flangeT,
    free[0],
    'blind flange',
    joins,
  );
  holes += blind.holes;
  const domePart = dome(alongMinusX([free[0] - flangeT, free[1], free[2]]));

  // Swept S-bend duct from the head flange down to flange A, along +x at both ends.
  const path = must(
    interpolate(
      [
        [...free],
        [-4.7, 2.2, 1.2],
        [-3.9, 2.0, 1.1],
        [-3.1, 1.4, 0.8],
        [-2.3, 0.7, 0.35],
        [-1.5, 0.2, 0.05],
        [-0.8, 0, 0],
        [-flangeT, 0, 0],
      ],
      { degree: 3 },
    ),
  );
  const sBend = must(
    sweep({
      profile: circle(pipe, 24),
      holes: [circle(bore, 24)],
      path: { kind: 'nurbs', curve: path },
      stations: 49,
      fitTolerance: 0.1,
      xHint: [0, 1, 0],
      label: 'manifold.s-bend',
      role: 'pipe',
    }),
  );

  // Lofted transition from the round bore to a rounded-rectangular duct.
  const at = (x: number): Frame => alongX([L + flangeT + x, 0, 0]);
  const transition = must(
    loft({
      samples: 40,
      label: 'manifold.transition',
      role: 'transition',
      sections: [
        { profile: circle(pipe, 32), holes: [circle(bore, 32)], frame: at(0) },
        {
          profile: roundedRect(1.3, 0.95, 0.3, 4),
          holes: [roundedRect(1.05, 0.7, 0.2, 4)],
          frame: at(0.9),
        },
        {
          profile: roundedRect(1.6, 0.9, 0.15, 4),
          holes: [roundedRect(1.3, 0.6, 0.1, 4)],
          frame: at(1.8),
        },
      ],
    }),
  );

  // Joints the kernel is asked for; each is recorded and the parts stay separate when it refuses.
  const attempts: [string, Shape, Shape][] = [
    ['flange A + header (planar annulus contact)', flangeA.shape, header],
    ['header + flange B (planar annulus contact)', header, flangeB.shape],
    ['S-bend (NURBS) + flange A', sBend, flangeA.shape],
    ['flange B + transition (NURBS)', flangeB.shape, transition],
    ['S-bend (NURBS) + blind flange', sBend, blind.shape],
    ['blind flange + dome (planar disc contact)', blind.shape, domePart],
  ];
  for (const [step, a, b] of attempts) tryUnion(a, b, step, joins);

  return {
    parts: [
      sBend,
      blind.shape,
      domePart,
      flangeA.shape,
      header,
      ...rings,
      flangeB.shape,
      transition,
    ],
    names: [
      's-bend',
      'blind-flange',
      'dome',
      'flange-a',
      'header',
      'stiffener-1',
      'stiffener-2',
      'flange-b',
      'transition',
    ],
    joins,
    boltHoles: holes,
  };
}
