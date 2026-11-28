// Closed solids whose curved faces carry holes: the inputs of the M-QF3 curved baseline. Each is assembled by hand
// because booleans do not yet produce holed curved faces. Space-curve edges (a bore meeting a cylinder or torus) are
// cubic interpolants through exact surface points, with pcurves fitted through the same parameters.
import { ok, type Result } from '@forgeax/engine-types';
import { type LoopEdge, ShapeAssembler } from '../../src/brep/assembler.ts';
import { surfaceInverse } from '../../src/brep/surfaces.ts';
import type { Curve, Frame, PCurve, Shape, Surface } from '../../src/brep/types.ts';
import { dist3, type P2, type P3, TWO_PI } from '../../src/brep/vec.ts';
import type { ModelingError } from '../../src/errors.ts';
import { interpolate } from '../../src/nurbs.ts';

const SAMPLES = 96;
type Tuple3 = [number, number, number];

/** Frame with origin `o`, axis `z` and first axis `x` (`y = z x x`). */
function frame(o: P3, z: P3, x: P3): Frame {
  const y: P3 = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return { o, x, y, z };
}

const uniform = (): number[] => Array.from({ length: SAMPLES + 1 }, (_, i) => i / SAMPLES);

/** A closed space curve `f(t)`, t in [0, 1], as an interpolating cubic. */
function spaceCurve(f: (t: number) => P3): Result<Curve, ModelingError> {
  const fit = interpolate(
    uniform().map((t): Tuple3 => f(t) as Tuple3),
    {
      degree: 3,
      parameters: uniform(),
    },
  );
  return fit.ok ? ok({ kind: 'nurbs', curve: fit.value }) : fit;
}

/** The (u, v) trim of `f(t)` on `surface`, unwrapped along the curve, as a 2D NURBS over the same parameters. */
function fittedPCurve(surface: Surface, f: (t: number) => P3): Result<PCurve, ModelingError> {
  const uv: P2[] = [];
  let prev: number | undefined;
  for (const t of uniform()) {
    const r = surfaceInverse(surface, f(t));
    let u = r.u;
    if (prev !== undefined) u += TWO_PI * Math.round((prev - u) / TWO_PI);
    prev = u;
    uv.push([u, r.v]);
  }
  const fit = interpolate(
    uv.map(([u, v]): Tuple3 => [u, v, 0]),
    { degree: 3, parameters: uniform() },
  );
  return fit.ok ? ok({ kind: 'nurbs', curve: fit.value }) : fit;
}

interface Part {
  readonly a: ShapeAssembler;
  readonly faces: number[];
}

function begin(diag: number, tol: number): Result<Part, ModelingError> {
  const a = ShapeAssembler.create(diag, { tol });
  return a.ok ? ok({ a: a.value, faces: [] }) : a;
}

function addFace(
  p: Part,
  surface: number,
  loops: readonly (readonly LoopEdge[])[],
  reversed: boolean,
  label: string,
): Result<void, ModelingError> {
  const ids: number[] = [];
  for (let i = 0; i < loops.length; i++) {
    const l = p.a.loop(surface, loops[i] as readonly LoopEdge[], i === 0);
    if (!l.ok) return l;
    ids.push(l.value);
  }
  p.faces.push(p.a.face(surface, ids, reversed, label, ''));
  return ok(undefined);
}

function line(a: ShapeAssembler, p: P3, q: P3): LoopEdge {
  const len = dist3(p, q);
  const d: P3 = [(q[0] - p[0]) / len, (q[1] - p[1]) / len, (q[2] - p[2]) / len];
  return { edge: a.edge(a.curve({ kind: 'line', o: p, d }), 0, len) };
}

function circle(a: ShapeAssembler, f: Frame, radius: number): LoopEdge {
  return { edge: a.edge(a.curve({ kind: 'circle', frame: f, radius }), 0, TWO_PI) };
}

function finish(p: Part): Result<Shape, ModelingError> {
  p.a.shell(p.faces);
  return p.a.finish();
}

/**
 * A closed pipe along z (radius `radius`, half height `half`) with caps. `bore` is a radial cylinder along +x
 * (radius `b`): a blind pocket ending at `x = floor`, or a branch pipe ending at `x = floor` outside the main wall.
 * The saddle where the bore meets the main wall is one shared edge.
 */
function pipe(
  mode: 'pocket' | 'branch',
  radius: number,
  half: number,
  b: number,
  floor: number,
): Result<Shape, ModelingError> {
  const part = begin(2 * Math.max(radius, half, floor), 2e-5);
  if (!part.ok) return part;
  const { a } = part.value;
  const main = frame([0, 0, 0], [0, 0, 1], [-1, 0, 0]);
  const mainSurface: Surface = { kind: 'cylinder', frame: main, radius };
  const wallSurface: Surface = {
    kind: 'cylinder',
    frame: frame([0, 0, 0], [1, 0, 0], [0, 1, 0]),
    radius: b,
  };
  const saddle = (t: number): P3 => {
    const phi = TWO_PI * t;
    const y = b * Math.cos(phi);
    return [Math.sqrt(radius * radius - y * y), y, b * Math.sin(phi)];
  };
  const curve = spaceCurve(saddle);
  if (!curve.ok) return curve;
  const saddleEdge: LoopEdge = { edge: a.edge(a.curve(curve.value), 0, 1) };
  const onMain = fittedPCurve(mainSurface, saddle);
  if (!onMain.ok) return onMain;
  const onWall = fittedPCurve(wallSurface, saddle);
  if (!onWall.ok) return onWall;

  const bottom = circle(a, frame([0, 0, -half], [0, 0, 1], [-1, 0, 0]), radius);
  const top = circle(a, frame([0, 0, half], [0, 0, 1], [-1, 0, 0]), radius);
  const seam = line(a, [-radius, 0, -half], [-radius, 0, half]);
  const side = addFace(
    part.value,
    a.surface(mainSurface),
    [[bottom, seam, top, seam], [{ ...saddleEdge, pcurve: onMain.value }]],
    false,
    'main',
  );
  if (!side.ok) return side;
  for (const [z, n, label] of [
    [-half, -1, 'cap-bottom'],
    [half, 1, 'cap-top'],
  ] as const) {
    const cap = addFace(
      part.value,
      a.surface({
        kind: 'plane',
        frame: { o: [0, 0, z], x: [1, 0, 0], y: [0, n, 0], z: [0, 0, n] },
      }),
      [[n < 0 ? bottom : top]],
      false,
      label,
    );
    if (!cap.ok) return cap;
  }

  const end = circle(a, frame([floor, 0, 0], [1, 0, 0], [0, 1, 0]), b);
  const xHigh = Math.sqrt(radius * radius - b * b);
  const wallSeam = line(
    a,
    [mode === 'pocket' ? floor : xHigh, b, 0],
    [mode === 'pocket' ? xHigh : floor, b, 0],
  );
  const wall = a.surface(wallSurface);
  const wallSaddle: LoopEdge = { ...saddleEdge, pcurve: onWall.value };
  const wallLoop =
    mode === 'pocket'
      ? [end, wallSeam, wallSaddle, wallSeam]
      : [wallSaddle, wallSeam, end, wallSeam];
  const bore = addFace(part.value, wall, [wallLoop], mode === 'pocket', 'bore');
  if (!bore.ok) return bore;
  const lid = addFace(
    part.value,
    a.surface({
      kind: 'plane',
      frame: { o: [floor, 0, 0], x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] },
    }),
    [[end]],
    false,
    mode === 'pocket' ? 'bore-floor' : 'branch-end',
  );
  if (!lid.ok) return lid;
  return finish(part.value);
}

/** Pipe (r = 1, z in [-1.2, 1.2]) with a blind radial pocket of radius 0.3 down to x = 0.3. */
export function pocketCylinder(): Result<Shape, ModelingError> {
  return pipe('pocket', 1, 1.2, 0.3, 0.3);
}

/** The same pipe with a radial branch pipe (radius 0.4) out to x = 2.2: a pipe tee. */
export function pipeTee(): Result<Shape, ModelingError> {
  return pipe('branch', 1, 1.2, 0.4, 2.2);
}

/**
 * Torus (R = 3, r = 1) with a vertical bore through the tube at (0, 3 + offset): two holes in one face. A positive
 * offset moves the bore towards the outer equator, where the u metric is R + r cos v rather than R.
 */
export function torusBore(offset = 0, b = 0.4): Result<Shape, ModelingError> {
  const major = 3;
  const minor = 1;
  const centre = major + offset;
  const part = begin(2 * (major + minor), 2e-5);
  if (!part.ok) return part;
  const { a } = part.value;
  const f = frame([0, 0, 0], [0, 0, 1], [1, 0, 0]);
  const torusSurface: Surface = { kind: 'torus', frame: f, major, minor };
  const wallSurface: Surface = {
    kind: 'cylinder',
    frame: frame([0, centre, 0], [0, 0, 1], [1, 0, 0]),
    radius: b,
  };
  const rim =
    (sign: 1 | -1) =>
    (t: number): P3 => {
      const phi = TWO_PI * t;
      const x = b * Math.cos(phi);
      const y = centre + b * Math.sin(phi);
      const dr = Math.sqrt(x * x + y * y) - major;
      return [x, y, sign * Math.sqrt(minor * minor - dr * dr)];
    };
  const rims: LoopEdge[] = [];
  const onTorus: PCurve[] = [];
  const onWall: PCurve[] = [];
  for (const sign of [1, -1] as const) {
    const curve = spaceCurve(rim(sign));
    if (!curve.ok) return curve;
    rims.push({ edge: a.edge(a.curve(curve.value), 0, 1) });
    const t = fittedPCurve(torusSurface, rim(sign));
    if (!t.ok) return t;
    onTorus.push(t.value);
    const w = fittedPCurve(wallSurface, rim(sign));
    if (!w.ok) return w;
    onWall.push(w.value);
  }
  const equator = circle(a, f, major + minor);
  const meridian = circle(
    a,
    { o: [major, 0, 0], x: [1, 0, 0], y: [0, 0, 1], z: [0, -1, 0] },
    minor,
  );
  const face = addFace(
    part.value,
    a.surface(torusSurface),
    [
      [equator, meridian, equator, meridian],
      [{ ...(rims[0] as LoopEdge), pcurve: onTorus[0] as PCurve }],
      [{ ...(rims[1] as LoopEdge), pcurve: onTorus[1] as PCurve }],
    ],
    false,
    'torus',
  );
  if (!face.ok) return face;
  const zHigh = rim(1)(0)[2];
  const zLow = -zHigh;
  const seam = line(a, [b, centre, zLow], [b, centre, zHigh]);
  const wall = addFace(
    part.value,
    a.surface(wallSurface),
    [
      [
        { ...(rims[1] as LoopEdge), pcurve: onWall[1] as PCurve },
        seam,
        { ...(rims[0] as LoopEdge), pcurve: onWall[0] as PCurve },
        seam,
      ],
    ],
    true,
    'bore',
  );
  if (!wall.ok) return wall;
  return finish(part.value);
}

/**
 * Unit sphere with a bore of radius 0.35 along x through the centre: two holes off the poles. `tilt` turns the polar
 * axis toward x, which moves the holes to latitudes of opposite sign and keeps the seam clear of both.
 */
export function sphereBore(tilt = 0): Result<Shape, ModelingError> {
  const radius = 1;
  const b = 0.35;
  const x0 = Math.sqrt(radius * radius - b * b);
  const part = begin(2 * radius, 1e-6);
  if (!part.ok) return part;
  const { a } = part.value;
  const pole: P3 = [Math.sin(tilt), 0, Math.cos(tilt)];
  const f = frame([0, 0, 0], pole, [0, 1, 0]);
  const sphereSurface: Surface = { kind: 'sphere', frame: f, radius };
  const wallFrame = frame([0, 0, 0], [1, 0, 0], [0, 1, 0]);
  const wallSurface: Surface = { kind: 'cylinder', frame: wallFrame, radius: b };
  const meridian = {
    edge: a.edge(
      a.curve({
        kind: 'circle',
        frame: {
          o: f.o,
          x: f.x,
          y: f.z,
          z: [
            f.x[1] * f.z[2] - f.x[2] * f.z[1],
            f.x[2] * f.z[0] - f.x[0] * f.z[2],
            f.x[0] * f.z[1] - f.x[1] * f.z[0],
          ],
        },
        radius,
      }),
      -Math.PI / 2,
      Math.PI / 2,
    ),
  };
  const south = a.degenerateEdge(
    a.vertex([-radius * pole[0], -radius * pole[1], -radius * pole[2]]),
  );
  const north = a.degenerateEdge(a.vertex([radius * pole[0], radius * pole[1], radius * pole[2]]));
  const rimAt =
    (x: number): ((t: number) => P3) =>
    (t) => {
      const phi = TWO_PI * t;
      return [x, b * Math.cos(phi), b * Math.sin(phi)];
    };
  const holes: LoopEdge[] = [];
  const onWall: PCurve[] = [];
  for (const x of [x0, -x0]) {
    const curve = spaceCurve(rimAt(x));
    if (!curve.ok) return curve;
    const edge = a.edge(a.curve(curve.value), 0, 1);
    const pc = fittedPCurve(sphereSurface, rimAt(x));
    if (!pc.ok) return pc;
    const wc = fittedPCurve(wallSurface, rimAt(x));
    if (!wc.ok) return wc;
    holes.push({ edge, pcurve: pc.value });
    onWall.push(wc.value);
  }
  const face = addFace(
    part.value,
    a.surface(sphereSurface),
    [
      [meridian, { edge: north, span: [-TWO_PI, 0] }, meridian, { edge: south, span: [TWO_PI, 0] }],
      [holes[0] as LoopEdge],
      [holes[1] as LoopEdge],
    ],
    false,
    'sphere',
  );
  if (!face.ok) return face;
  const rimHigh: LoopEdge = { edge: (holes[0] as LoopEdge).edge, pcurve: onWall[0] as PCurve };
  const rimLow: LoopEdge = { edge: (holes[1] as LoopEdge).edge, pcurve: onWall[1] as PCurve };
  const seam = line(a, [-x0, b, 0], [x0, b, 0]);
  const wall = addFace(
    part.value,
    a.surface(wallSurface),
    [[rimLow, seam, rimHigh, seam]],
    true,
    'bore',
  );
  if (!wall.ok) return wall;
  return finish(part.value);
}

/**
 * Cone (base radius 1.5, height 3, apex up) with a bore of radius `b` along x at height `h0`: two holes in the lateral
 * face, which is a single patch from the base circle to the apex (a degenerate edge) with the seam on +y.
 */
export function coneBore(b = 0.3, h0 = 1.2): Result<Shape, ModelingError> {
  const base = 1.5;
  const height = 3;
  const part = begin(2 * base, 1e-6);
  if (!part.ok) return part;
  const { a } = part.value;
  const f = frame([0, 0, 0], [0, 0, 1], [0, 1, 0]);
  const coneSurface: Surface = {
    kind: 'cone',
    frame: f,
    radius: base,
    halfAngle: Math.atan2(-base, height),
  };
  const wallSurface: Surface = {
    kind: 'cylinder',
    frame: frame([0, 0, h0], [1, 0, 0], [0, 1, 0]),
    radius: b,
  };
  const radiusAt = (z: number): number => base * (1 - z / height);
  const rimAt =
    (sign: number): ((t: number) => P3) =>
    (t) => {
      const phi = TWO_PI * t;
      const y = b * Math.cos(phi);
      const z = h0 + b * Math.sin(phi);
      const rho = radiusAt(z);
      return [sign * Math.sqrt(rho * rho - y * y), y, z];
    };
  const rim = circle(a, f, base);
  const seam = line(a, [0, base, 0], [0, 0, height]);
  const apex = a.degenerateEdge(a.vertex([0, 0, height]));
  const holes: LoopEdge[] = [];
  const onWall: PCurve[] = [];
  for (const sign of [1, -1]) {
    const curve = spaceCurve(rimAt(sign));
    if (!curve.ok) return curve;
    const edge = a.edge(a.curve(curve.value), 0, 1);
    const pc = fittedPCurve(coneSurface, rimAt(sign));
    if (!pc.ok) return pc;
    const wc = fittedPCurve(wallSurface, rimAt(sign));
    if (!wc.ok) return wc;
    holes.push({ edge, pcurve: pc.value });
    onWall.push(wc.value);
  }
  const lateral = addFace(
    part.value,
    a.surface(coneSurface),
    [
      [rim, seam, { edge: apex, span: [-TWO_PI, 0] }, seam],
      [holes[0] as LoopEdge],
      [holes[1] as LoopEdge],
    ],
    false,
    'cone',
  );
  if (!lateral.ok) return lateral;
  const disk = addFace(
    part.value,
    a.surface({
      kind: 'plane',
      frame: { o: [0, 0, 0], x: [1, 0, 0], y: [0, -1, 0], z: [0, 0, -1] },
    }),
    [[rim]],
    false,
    'base',
  );
  if (!disk.ok) return disk;
  const rimHigh: LoopEdge = { edge: (holes[0] as LoopEdge).edge, pcurve: onWall[0] as PCurve };
  const rimLow: LoopEdge = { edge: (holes[1] as LoopEdge).edge, pcurve: onWall[1] as PCurve };
  const rhoMid = radiusAt(h0);
  const xs = Math.sqrt(rhoMid * rhoMid - b * b);
  const wallSeam = line(a, [-xs, b, h0], [xs, b, h0]);
  const wall = addFace(
    part.value,
    a.surface(wallSurface),
    [[rimLow, wallSeam, rimHigh, wallSeam]],
    true,
    'bore',
  );
  if (!wall.ok) return wall;
  return finish(part.value);
}

export const CURVED_CASES: readonly {
  readonly name: string;
  readonly build: () => Result<Shape, ModelingError>;
}[] = [
  { name: 'cylinder-pocket', build: pocketCylinder },
  { name: 'pipe-tee', build: pipeTee },
  { name: 'torus-bore', build: torusBore },
  { name: 'sphere-bore', build: sphereBore },
  { name: 'sphere-bore-tilted', build: () => sphereBore(0.7) },
  { name: 'cone-bore', build: coneBore },
];

/** Inputs at the edge of what the iso strips can do: the layout refuses them with `iso-strip-distorted`. */
export const STRIP_LIMIT_CASES: typeof CURVED_CASES = [
  { name: 'torus-bore-far-off-crest', build: () => torusBore(-0.5) },
  { name: 'cone-bore-high-near-apex', build: () => coneBore(0.3, 2) },
];
