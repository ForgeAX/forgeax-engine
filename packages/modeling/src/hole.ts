import { err, ok, type Result } from '@forgeax/engine-types';
import { type BooleanContext, booleanOp } from './boolean';
import { cos, sin } from './dmath';
import { type ModelingError, modelingError } from './errors';
import {
  add,
  cross,
  dot,
  faceCentroid,
  faceNormal,
  normalize,
  resolveSegments,
  scale,
  sub,
  type Tuple3,
  windingNumber,
} from './geom';
import { EditMesh } from './mesh';
import type { Attribution, OpDiagnostic, RoleCounts } from './ops';
import { appendRevolve, type Point2 } from './primitives';
import { sweep } from './sweep';
import { type ThreadGeometry, threadReach, threadSweep } from './thread-sweep';
import { type ThreadDesignation, type ThreadSpec, threads } from './threads';

export type HoleKind = 'simple' | 'counterbore' | 'countersink' | 'tapped';

type HoleShape =
  | { readonly kind: 'simple'; readonly diameter: number }
  | {
      readonly kind: 'counterbore';
      readonly diameter: number;
      readonly counterbore: { readonly diameter: number; readonly depth: number };
    }
  | {
      readonly kind: 'countersink';
      readonly diameter: number;
      /** Rim diameter at the face and the included cone angle in degrees (default 90). */
      readonly countersink: { readonly diameter: number; readonly angle?: number };
    }
  | {
      readonly kind: 'tapped';
      readonly thread: ThreadDesignation;
      /** 'modeled' sweeps the helical groove into the bore; 'cosmetic' (default) leaves it smooth. */
      readonly threadGeometry?: ThreadGeometry;
    };

export type HoleCutOptions = HoleShape & {
  /** Depth below the face, or `'through'` to cut the whole solid along the axis. */
  readonly depth: number | 'through';
  /** Hole axes in the planar face's frame; see `Model.hole`. */
  readonly centers: readonly Point2[];
  readonly label?: string;
  readonly tag?: string;
  readonly material?: string;
} & (
    | { readonly segments?: number; readonly tolerance?: never }
    | { readonly segments?: never; readonly tolerance: number }
  );

const DEFAULT_SEGMENTS = 24;

function invalid(option: string, value: unknown, expected: string): ModelingError {
  return modelingError(
    'model-invalid-argument',
    `${option} is ${expected}`,
    { option, value, expected },
    `pass ${option} as ${expected}`,
  );
}

const finitePositive = (x: unknown): x is number =>
  typeof x === 'number' && Number.isFinite(x) && x > 0;

interface Frame {
  readonly normal: Tuple3;
  readonly u: Tuple3;
  readonly v: Tuple3;
  readonly origin: Tuple3;
}

/**
 * The face frame: `u` is the next world axis after the normal's dominant one (cyclic
 * X, Y, Z) made perpendicular to the normal, `v = normal x u`, and the origin is the world
 * origin projected onto the face plane. A face facing +Z reads centers as world (x, y).
 */
function frameOf(normal: Tuple3, point: Tuple3): Frame {
  const axis = [0, 1, 2].reduce((best, k) =>
    Math.abs(normal[k] as number) > Math.abs(normal[best] as number) ? k : best,
  );
  const reference: Tuple3 = [0, 0, 0];
  reference[(axis + 1) % 3] = 1;
  const u = normalize(sub(reference, scale(normal, dot(reference, normal))));
  return {
    normal,
    u,
    v: cross(normal, u),
    origin: scale(normal, dot(point, normal)),
  };
}

function planeOf(
  mesh: EditMesh,
  faces: readonly number[],
  tolerance: number,
): Result<{ normal: Tuple3; point: Tuple3 }, ModelingError> {
  const first = faces[0];
  if (first === undefined) {
    return err(
      modelingError(
        'model-precondition',
        'the selection holds at least one face',
        { reason: 'hole-face', faces: 0 },
        'select the planar face the holes open into',
      ),
    );
  }
  const normal = faceNormal(mesh, first);
  const point = mesh.position(mesh.faceVertices(first)[0] as number);
  for (const f of faces) {
    const flat =
      dot(faceNormal(mesh, f), normal) > 1 - 1e-9 &&
      mesh
        .faceVertices(f)
        .every((v) => Math.abs(dot(sub(mesh.position(v), point), normal)) <= tolerance * 10);
    if (!flat) {
      return err(
        modelingError(
          'model-precondition',
          'the selected faces are planar and coplanar',
          { reason: 'hole-face', face: f },
          'select faces of one flat region, for example one top face',
        ),
      );
    }
  }
  return ok({ normal, point });
}

interface Cutter {
  /** `[radius, y]` profile along the hole axis; y = 0 at the face, negative into the solid. */
  readonly profile: Point2[];
  readonly rim: number;
  readonly stepDepth: number | undefined;
}

function cutterOf(
  options: HoleCutOptions,
  bore: number,
  depth: number,
  margin: number,
): Result<Cutter, ModelingError> {
  const r = bore / 2;
  const floor: Point2[] = [
    [0, -depth],
    [r, -depth],
  ];
  const axis: Point2 = [0, margin];
  switch (options.kind) {
    case 'simple':
    case 'tapped':
      return ok({ profile: [...floor, [r, margin], axis], rim: r, stepDepth: undefined });
    case 'counterbore': {
      const { diameter, depth: step } = options.counterbore;
      if (!finitePositive(diameter) || diameter <= bore) {
        return err(
          invalid('counterbore.diameter', diameter, 'a finite diameter wider than the bore'),
        );
      }
      if (!finitePositive(step) || (options.depth !== 'through' && step >= depth)) {
        return err(
          invalid('counterbore.depth', step, 'a finite depth greater than 0 and less than depth'),
        );
      }
      const wide = diameter / 2;
      return ok({
        profile: [...floor, [r, -step], [wide, -step], [wide, margin], axis],
        rim: wide,
        stepDepth: step,
      });
    }
    case 'countersink': {
      const { diameter, angle = 90 } = options.countersink;
      if (!finitePositive(diameter) || diameter <= bore) {
        return err(
          invalid('countersink.diameter', diameter, 'a finite diameter wider than the bore'),
        );
      }
      if (!(Number.isFinite(angle) && angle > 0 && angle < 180)) {
        return err(invalid('countersink.angle', angle, 'degrees within (0, 180)'));
      }
      const half = (angle * Math.PI) / 360;
      const slope = sin(half) / cos(half);
      const wide = diameter / 2;
      const cone = (wide - r) / slope;
      if (options.depth !== 'through' && cone >= depth) {
        return err(invalid('depth', options.depth, 'deeper than the countersink cone'));
      }
      const lip = Math.max(0.1 * cone, margin);
      const flare = wide + 0.1 * (wide - r);
      const top = Math.max(margin, lip);
      return ok({
        profile: [
          ...floor,
          [r, -cone],
          [flare, 0.1 * cone],
          ...(top > 0.1 * cone ? ([[flare, top]] as Point2[]) : []),
          [0, top],
        ],
        rim: wide,
        stepDepth: undefined,
      });
    }
  }
}

function distinct(centers: readonly Point2[], gap: number): boolean {
  for (let i = 0; i < centers.length; i++) {
    for (let j = i + 1; j < centers.length; j++) {
      const a = centers[i] as Point2;
      const b = centers[j] as Point2;
      const du = a[0] - b[0];
      const dv = a[1] - b[1];
      if (du * du + dv * dv < gap * gap) return false;
    }
  }
  return true;
}

interface Wall {
  readonly places: readonly Tuple3[];
  /** Tap-drill radius: cutter faces beyond it belong to the swept groove. */
  readonly radius: number;
}

function outsideBore(mesh: EditMesh, face: number, normal: Tuple3, wall: Wall): boolean {
  const c = faceCentroid(mesh, face);
  let nearest = Number.POSITIVE_INFINITY;
  for (const place of wall.places) {
    const d = sub(c, place);
    const r = sub(d, scale(normal, dot(d, normal)));
    nearest = Math.min(nearest, dot(r, r));
  }
  return nearest > wall.radius * wall.radius;
}

const FLAT = 1 - 1e-6;
const SIDE = 0.05;

/**
 * The boolean tags every cutter face `cutB`; the cutter plane tells which part of the hole a
 * face is: an axis-normal face is the floor or the counterbore step, an axis-parallel one
 * a wall (above the step: the counterbore wall), anything between a countersink cone.
 */
function reroleCutter(
  mesh: EditMesh,
  label: number,
  normal: Tuple3,
  faceDistance: number,
  stepDepth: number | undefined,
  eps: number,
  wall: Wall | undefined,
): RoleCounts {
  const counts: RoleCounts = {};
  const cutB = mesh.nameIndex(mesh.roleNames, 'cutB');
  for (const f of mesh.faces()) {
    if (mesh.fLabel[f] !== label || mesh.fRole[f] !== cutB) continue;
    const depth = faceDistance - dot(faceCentroid(mesh, f), normal);
    const along = Math.abs(dot(faceNormal(mesh, f), normal));
    const thread =
      wall !== undefined && (outsideBore(mesh, f, normal, wall) || (along > SIDE && along < FLAT));
    const onStep = stepDepth !== undefined && Math.abs(depth - stepDepth) <= eps;
    const role = thread
      ? 'hole-thread'
      : along >= FLAT
        ? onStep
          ? 'counterbore'
          : 'hole-floor'
        : along <= SIDE
          ? stepDepth !== undefined && depth < stepDepth
            ? 'counterbore'
            : 'hole-wall'
          : 'countersink';
    mesh.fRole[f] = mesh.nameIndex(mesh.roleNames, role);
    counts[role] = (counts[role] ?? 0) + 1;
  }
  return counts;
}

/**
 * Cut `options.centers` holes into the planar `faces` with one revolved cutter per center
 * and a single difference. Faces take the op label with roles `hole-wall`, `hole-floor`
 * (blind only), `counterbore` (step and wall) and `countersink` (cone).
 */
export function hole(
  mesh: EditMesh,
  faces: readonly number[],
  options: HoleCutOptions,
  attribution: Attribution,
  context: BooleanContext,
  diagnostics: OpDiagnostic[],
): Result<RoleCounts, ModelingError> {
  const kinds: readonly HoleKind[] = ['simple', 'counterbore', 'countersink', 'tapped'];
  if (!kinds.includes(options.kind)) {
    return err(invalid('kind', options.kind, kinds.join(', ')));
  }
  if (options.depth !== 'through' && !finitePositive(options.depth)) {
    return err(invalid('depth', options.depth, "a finite number greater than 0 or 'through'"));
  }
  const centers = options.centers;
  if (
    !Array.isArray(centers) ||
    centers.length === 0 ||
    !centers.every((c) => Array.isArray(c) && c.length === 2 && c.every(Number.isFinite))
  ) {
    return err(invalid('centers', centers, 'a non-empty list of finite [u, v] pairs'));
  }
  let bore: number;
  let thread: ThreadSpec | undefined;
  if (options.kind === 'tapped') {
    const found = threads.lookup(options.thread);
    if (!found.ok) return found;
    thread = found.value;
    bore = thread.tapDrill;
  } else {
    bore = options.diameter;
    if (!finitePositive(bore)) {
      return err(invalid('diameter', bore, 'a finite number greater than 0'));
    }
  }
  const plane = planeOf(mesh, faces, context.tolerance);
  if (!plane.ok) return plane;
  const frame = frameOf(plane.value.normal, plane.value.point);
  const { normal } = frame;
  const faceDistance = dot(plane.value.point, normal);
  let reach = 0;
  for (const v of mesh.vertices()) {
    reach = Math.max(reach, faceDistance - dot(mesh.position(v), normal));
  }
  const modeled =
    thread !== undefined && options.kind === 'tapped' && options.threadGeometry === 'modeled';
  const margin = Math.max(0.1 * reach, modeled && thread !== undefined ? 2 * thread.pitch : 0);
  const through = options.depth === 'through';
  const depth = options.depth === 'through' ? reach + margin : options.depth;
  const cutter = cutterOf(options, bore, depth, margin);
  if (!cutter.ok) return cutter;
  const { profile, rim, stepDepth } = cutter.value;
  if (!distinct(centers, 2 * rim)) {
    return err(invalid('centers', centers, 'at least one rim diameter apart'));
  }
  const segments = resolveSegments(
    'segments',
    options.segments ?? (options.tolerance === undefined ? DEFAULT_SEGMENTS : undefined),
    options.tolerance,
    rim,
    3,
  );
  if (!segments.ok) return segments;
  const places = centers.map((c) =>
    add(add(frame.origin, scale(frame.u, c[0])), scale(frame.v, c[1])),
  );
  const eps = Math.max(10 * context.tolerance, 1e-3 * depth);
  const solid = mesh.faces();
  const inside = (p: Tuple3): boolean => windingNumber(mesh, solid, p) >= 0.5;
  for (const place of places) {
    if (!through && !inside(sub(place, scale(normal, depth + eps)))) {
      return err(
        modelingError(
          'model-precondition',
          'the solid is deeper than the hole',
          { reason: 'hole-through', depth, center: place },
          "pass a smaller depth, or 'through'",
        ),
      );
    }
    if (thread !== undefined) {
      const radius = thread.major / 2;
      const down = sub(place, scale(normal, eps));
      for (let k = 0; k < segments.value; k++) {
        const a = (2 * Math.PI * (k + 0.5)) / segments.value;
        const p = add(down, add(scale(frame.u, radius * cos(a)), scale(frame.v, radius * sin(a))));
        if (!inside(p)) {
          return err(
            modelingError(
              'model-precondition',
              'the face leaves material around the thread major diameter',
              { reason: 'tap-wall', designation: thread.designation, major: thread.major },
              'move the center inward or pick a smaller thread',
            ),
          );
        }
      }
    }
  }
  if (thread !== undefined && modeled && depth < thread.pitch) {
    return err(
      modelingError(
        'model-precondition',
        'the hole is at least one thread pitch long',
        { reason: 'thread-length', designation: thread.designation, depth, pitch: thread.pitch },
        'pass a larger depth, or threadGeometry cosmetic',
      ),
    );
  }
  const none: Attribution = { label: 0, material: 0, tag: -1 };
  const place = (
    target: EditMesh,
    before: ReadonlySet<number>,
    at: Tuple3,
    turn: readonly [number, number],
  ): void => {
    for (const v of target.vertices()) {
      if (before.has(v)) continue;
      const p = target.position(v);
      const q = add(
        add(at, scale(frame.v, p[0] * turn[0] - p[2] * turn[1])),
        add(scale(normal, p[1]), scale(frame.u, p[0] * turn[1] + p[2] * turn[0])),
      );
      target.setPosition(v, q[0], q[1], q[2]);
    }
  };
  const half = Math.PI / segments.value;
  const tool = new EditMesh();
  for (const at of places) {
    const before = new Set(tool.vertices());
    const built = appendRevolve(tool, { points: profile, segments: segments.value }, none);
    if (!built.ok) return built;
    place(tool, before, at, [cos(half), sin(half)]);
  }
  let wall: Wall | undefined;
  const fine: BooleanContext =
    thread !== undefined && modeled
      ? { ...context, tolerance: Math.min(context.tolerance, thread.pitch * 1e-6) }
      : context;
  if (thread !== undefined && modeled) {
    const grooves = new EditMesh();
    const lip = threadReach(thread, segments.value, 'groove');
    const from = -depth + lip + 0.1 * thread.pitch;
    for (const at of places) {
      const before = new Set(grooves.vertices());
      const built = sweep(
        grooves,
        threadSweep(thread, 'groove', from, 0.5 * margin, segments.value),
        none,
        fine.tolerance,
        diagnostics,
      );
      if (!built.ok) return built;
      place(grooves, before, at, [1, 0]);
    }
    const joined = booleanOp(tool, 'union', { mesh: grooves }, {}, none, fine, diagnostics);
    if (!joined.ok) return joined;
    wall = { places, radius: thread.tapDrill / 2 };
  }
  const cut = booleanOp(
    mesh,
    'difference',
    { mesh: tool },
    options.material === undefined ? {} : { material: options.material },
    attribution,
    fine,
    diagnostics,
  );
  if (!cut.ok) return cut;
  return ok(reroleCutter(mesh, attribution.label, normal, faceDistance, stepDepth, eps, wall));
}
