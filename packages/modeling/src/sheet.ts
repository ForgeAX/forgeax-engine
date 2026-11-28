import { err, ok, type Result } from '@forgeax/engine-types';
import { type Affine, applyPoint, IDENTITY, invertRigid, multiply } from './affine';
import { maxOf, minOf } from './arrays';
import { bisectMesh } from './cut';
import { cos, hypot3, sin } from './dmath';
import { type Drawing, type DrawingItem, resolveDrawing } from './drawing';
import { drawingDxf } from './drawing-export';
import { type ModelingError, modelingError } from './errors';
import { faceArea, faceCentroid, faceNormal, type Tuple3 } from './geom';
import { type EditMesh, NONE } from './mesh';
import { type Attribution, type RoleCounts, requireFinite, requirePositive } from './ops';
import { appendExtrudePolygon, type Point2, requireOutwardShell } from './primitives';
import { type Region2, type RegionInput, region2d, type Shape2, toRegion } from './region2d';

/** One straight bend across the flat pattern. */
export interface SheetBend {
  /**
   * The bend line in flat-pattern coordinates, meters. The zone (width = bend allowance) is
   * centered on it and the segment must cover every bit of material in the zone. The side left
   * of `line[0] -> line[1]` folds toward +Z for a positive `angle`.
   */
  readonly line: readonly [Point2, Point2];
  /** Fold angle in degrees, in (-180, 180) and not 0: positive folds up (the +Z face is the inside). */
  readonly angle: number;
  /** Inside bend radius, meters. */
  readonly radius: number;
}

/**
 * A sheet-metal part as its flat pattern; `m.sheet` derives the folded solid and never unfolds
 * one back. Flat coordinates are meters in the XY plane and the sheet fills z in [0, thickness].
 */
export interface SheetMetalSpec {
  /** Sheet thickness, meters. */
  readonly thickness: number;
  /** Neutral-axis position as a fraction of the thickness from the inside face (default 0.44). */
  readonly kFactor?: number;
  /** One outline with optional holes; each bend zone is part of it. */
  readonly outline: RegionInput;
  readonly bends: readonly SheetBend[];
}

const DEFAULT_K = 0.44;
const FACET_DEGREES = 5;
const AREA_EPS = 1e-12;
const LENGTH_EPS = 1e-9;

interface ReadBend {
  readonly index: number;
  readonly a: Point2;
  readonly d: Point2;
  readonly n: Point2;
  readonly length: number;
  readonly sign: 1 | -1;
  readonly theta: number;
  readonly degrees: number;
  readonly radius: number;
  readonly allowance: number;
  readonly half: number;
  readonly neutral: number;
}

interface ReadSheet {
  readonly thickness: number;
  readonly shape: Shape2;
  readonly region: Region2;
  readonly bends: readonly ReadBend[];
}

const invalid = (expected: string, detail: Record<string, unknown>) =>
  err(modelingError('model-invalid-argument', expected, detail));

const notSheet = (cause: string, detail: Record<string, unknown>, hint: string) =>
  err(
    modelingError(
      'model-precondition',
      'the flat pattern folds into a developable sheet',
      { reason: 'not-sheet', cause, ...detail },
      hint,
    ),
  );

/** The neutral-axis arc length of a bend: BA = angle (rad) * (radius + kFactor * thickness). */
function bendAllowance(
  angle: number,
  radius: number,
  thickness: number,
  kFactor: number = DEFAULT_K,
): number {
  return (Math.abs(angle) * Math.PI * (radius + kFactor * thickness)) / 180;
}

function isPoint(p: unknown): p is Point2 {
  return Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
}

function loopsOf(shape: Shape2): readonly (readonly Point2[])[] {
  return [shape.outer, ...(shape.holes ?? [])];
}

function readSheet(spec: SheetMetalSpec): Result<ReadSheet, ModelingError> {
  const thickness = requirePositive('thickness', spec.thickness);
  if (!thickness.ok) return thickness;
  const k = requireFinite('kFactor', spec.kFactor ?? DEFAULT_K);
  if (!k.ok) return k;
  if (k.value < 0 || k.value > 1) return invalid('kFactor is in [0, 1]', { kFactor: k.value });
  const region = toRegion(spec.outline);
  if (region.length !== 1) {
    return invalid('outline is one shape (an outline with optional holes)', {
      shapes: region.length,
    });
  }
  const shape = region[0] as Shape2;
  for (const loop of loopsOf(shape)) {
    if (loop.length < 3 || !loop.every(isPoint)) {
      return invalid('outline loops have at least 3 finite [x, y] points', { points: loop.length });
    }
  }
  const bends: ReadBend[] = [];
  for (const [index, bend] of spec.bends.entries()) {
    const [a, b] = bend.line;
    if (!isPoint(a) || !isPoint(b)) {
      return invalid('a bend line is two finite [x, y] points', { bend: index });
    }
    const length = hypot3(b[0] - a[0], b[1] - a[1], 0);
    if (length <= LENGTH_EPS)
      return invalid('a bend line has distinct end points', { bend: index });
    const angle = requireFinite('angle', bend.angle);
    if (!angle.ok) return angle;
    if (angle.value === 0 || Math.abs(angle.value) >= 180) {
      return invalid('a bend angle is in (-180, 180) and not 0 degrees', {
        bend: index,
        angle: angle.value,
      });
    }
    const radius = requirePositive('radius', bend.radius);
    if (!radius.ok) return radius;
    const d: Point2 = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    const allowance = bendAllowance(angle.value, radius.value, thickness.value, k.value);
    bends.push({
      index,
      a,
      d,
      n: [-d[1], d[0]],
      length,
      sign: angle.value > 0 ? 1 : -1,
      theta: (Math.abs(angle.value) * Math.PI) / 180,
      degrees: angle.value,
      radius: radius.value,
      allowance,
      half: allowance / 2,
      neutral: radius.value + k.value * thickness.value,
    });
  }
  return ok({ thickness: thickness.value, shape, region: [shape], bends });
}

/** Coordinates of `p` in a bend's frame: `a` across the zone from its low edge, `b` along the line. */
function bendFrame(bend: ReadBend, p: readonly number[]): { a: number; b: number } {
  const x = (p[0] as number) - bend.a[0];
  const y = (p[1] as number) - bend.a[1];
  return { a: x * bend.n[0] + y * bend.n[1] + bend.half, b: x * bend.d[0] + y * bend.d[1] };
}

function bandRect(
  bend: ReadBend,
  aLow: number,
  aHigh: number,
  bLow: number,
  bHigh: number,
): Point2[] {
  const at = (a: number, b: number): Point2 => [
    bend.a[0] + (a - bend.half) * bend.n[0] + b * bend.d[0],
    bend.a[1] + (a - bend.half) * bend.n[1] + b * bend.d[1],
  ];
  return [at(aLow, bLow), at(aHigh, bLow), at(aHigh, bHigh), at(aLow, bHigh)];
}

/** The developability rules of the flat pattern, checked in 2D before any solid exists. */
function checkDevelopable(read: ReadSheet): Result<void, ModelingError> {
  const points = loopsOf(read.shape).flat();
  const reach = 1 + maxOf(points.map((p) => hypot3(p[0], p[1], 0)));
  const strip = (bend: ReadBend, aLow: number, aHigh: number) =>
    bandRect(bend, aLow, aHigh, -2 * reach, 2 * reach + bend.length);
  const bands: Point2[][] = [];
  for (const bend of read.bends) {
    const sides: [number, number][] = [
      [-2 * reach, 0],
      [bend.allowance, bend.allowance + 2 * reach],
    ];
    for (const [low, high] of sides) {
      const side = region2d.intersection(read.region, strip(bend, low, high));
      if (!side.ok) return side;
      if (region2d.area(side.value.region) <= AREA_EPS) {
        return notSheet(
          'bend-no-material',
          { bend: bend.index },
          'a bend needs material on both sides of its zone',
        );
      }
    }
    const band = strip(bend, 0, bend.allowance);
    bands.push(band);
    const inside = region2d.intersection(read.region, band);
    if (!inside.ok) return inside;
    const span = inside.value.region.flatMap((s) => s.outer).map((p) => bendFrame(bend, p).b);
    if (span.length > 0 && (minOf(span) < -1e-6 || maxOf(span) > bend.length + 1e-6)) {
      return notSheet(
        'bend-line-short',
        { bend: bend.index, span: [minOf(span), maxOf(span)], length: bend.length },
        'extend the bend line over all material in its zone, or cut a relief',
      );
    }
    for (const loop of loopsOf(read.shape)) {
      for (let i = 0; i < loop.length; i++) {
        const p = loop[i] as Point2;
        const q = loop[(i + 1) % loop.length] as Point2;
        const pa = bendFrame(bend, p).a;
        const qa = bendFrame(bend, q).a;
        if (Math.max(pa, qa) <= LENGTH_EPS || Math.min(pa, qa) >= bend.allowance - LENGTH_EPS) {
          continue;
        }
        const dx = q[0] - p[0];
        const dy = q[1] - p[1];
        const len = hypot3(dx, dy, 0);
        const along = Math.abs(dx * bend.d[0] + dy * bend.d[1]);
        const across = Math.abs(dx * bend.n[0] + dy * bend.n[1]);
        if (along > 1e-9 * len && across > 1e-9 * len) {
          return notSheet(
            'bend-edge-oblique',
            { bend: bend.index, edge: [p, q] },
            'outline edges inside a bend zone run along or across the bend line',
          );
        }
      }
    }
  }
  for (let i = 0; i < bands.length; i++) {
    for (let j = i + 1; j < bands.length; j++) {
      const both = region2d.intersection(bands[i] as Point2[], bands[j] as Point2[]);
      if (!both.ok) return both;
      if (both.value.region.length === 0) continue;
      const shared = region2d.intersection(read.region, both.value.region);
      if (!shared.ok) return shared;
      if (region2d.area(shared.value.region) > AREA_EPS) {
        return notSheet(
          'bend-zones-overlap',
          { bends: [i, j] },
          'cut a relief so no material lies in two bend zones',
        );
      }
    }
  }
  return ok(undefined);
}

/** Flat -> bend frame (`a` across the zone, `b` along the line, `z`): a rigid map. */
function frameAffine(bend: ReadBend): Affine {
  const [nx, ny] = bend.n;
  const [dx, dy] = bend.d;
  return [
    nx,
    ny,
    0,
    bend.half - (nx * bend.a[0] + ny * bend.a[1]),
    dx,
    dy,
    0,
    -(dx * bend.a[0] + dy * bend.a[1]),
    0,
    0,
    1,
    0,
  ];
}

/** Where the fold puts the neutral-arc angle `phi` at height `z`, in the bend frame's (a, z) plane. */
function arcPoint(
  thickness: number,
  bend: ReadBend,
  phi: number,
  z: number,
): readonly [number, number] {
  if (bend.sign > 0) {
    const rho = thickness + bend.radius - z;
    return [rho * sin(phi), thickness + bend.radius - rho * cos(phi)];
  }
  const rho = z + bend.radius;
  return [rho * sin(phi), -bend.radius + rho * cos(phi)];
}

/** The rigid motion of everything beyond the zone, in the bend frame. */
function endAffine(thickness: number, bend: ReadBend): Affine {
  const c = cos(bend.theta);
  const s = sin(bend.theta);
  const r = bend.radius;
  const ba = bend.allowance;
  if (bend.sign > 0) {
    const u = thickness + r;
    return [c, 0, -s, u * s - ba * c, 0, 1, 0, 0, s, 0, c, u - u * c - ba * s];
  }
  return [c, 0, s, r * s - ba * c, 0, 1, 0, 0, -s, 0, c, -r + r * c + ba * s];
}

/** Cut positions across a zone: its edges, the outline vertices inside it, then even facets. */
function zoneCuts(read: ReadSheet, bend: ReadBend, tolerance: number): number[] {
  const gap = 4 * tolerance;
  const kept = [0, bend.allowance];
  const far = (a: number) => kept.every((x) => Math.abs(x - a) >= gap);
  const inside = loopsOf(read.shape)
    .flat()
    .map((p) => bendFrame(bend, p).a)
    .filter((a) => a > 0 && a < bend.allowance)
    .sort((x, y) => x - y);
  for (const a of inside) if (far(a)) kept.push(a);
  const facets = Math.max(
    1,
    Math.min(
      Math.ceil(Math.abs(bend.degrees) / FACET_DEGREES),
      Math.floor(bend.allowance / (8 * tolerance)),
    ),
  );
  for (let i = 1; i < facets; i++) {
    const a = (bend.allowance * i) / facets;
    if (far(a)) kept.push(a);
  }
  return kept.sort((x, y) => x - y);
}

interface Component {
  readonly kind: 'piece' | 'strip';
  readonly bend: number;
  readonly faces: number[];
  readonly low: Set<Component>;
  readonly high: Set<Component>;
  readonly strips: Set<Component>;
  placed: Affine | undefined;
}

function sameTransform(a: Affine, b: Affine, scale: number): boolean {
  return a.every((x, i) => Math.abs(x - (b[i] as number)) <= 1e-9 * scale);
}

/**
 * Fold a flat pattern into a solid: extrude the outline, slice it parallel to each bend line
 * across the bend zone, then move rigid pieces as a whole and bend each zone facet by facet.
 * Every face stays planar because slices run along the bend line and zone side walls stand
 * perpendicular to it.
 */
export function appendSheet(
  mesh: EditMesh,
  spec: SheetMetalSpec,
  attribution: Attribution,
  tolerance: number,
): Result<RoleCounts, ModelingError> {
  const read = readSheet(spec);
  if (!read.ok) return read;
  const sheet = read.value;
  const developable = checkDevelopable(sheet);
  if (!developable.ok) return developable;
  const before = new Set(mesh.faces());
  const holes = sheet.shape.holes;
  const extruded = appendExtrudePolygon(
    mesh,
    {
      points: sheet.shape.outer,
      ...(holes === undefined ? {} : { holes }),
      depth: sheet.thickness,
    },
    { ...attribution, label: 0 },
  );
  if (!extruded.ok) return extruded;
  const faces = new Set(mesh.faces().filter((f) => !before.has(f)));
  for (const bend of sheet.bends) {
    for (const a of zoneCuts(sheet, bend, tolerance)) {
      const plane = {
        point: [
          bend.a[0] + (a - bend.half) * bend.n[0],
          bend.a[1] + (a - bend.half) * bend.n[1],
          0,
        ] as Tuple3,
        normal: [bend.n[0], bend.n[1], 0] as Tuple3,
      };
      const cut = bisectMesh(mesh, plane, tolerance, faces);
      if (!cut.ok) return cut;
      const mine = cut.value.rewritten.filter((r) => faces.has(r.face));
      for (const r of mine) faces.delete(r.face);
      for (const r of mine) for (const f of r.faces) faces.add(f);
    }
  }
  const order = [...faces].sort((x, y) => x - y);
  const wall = new Set(order.filter((f) => Math.abs(faceNormal(mesh, f)[2]) <= 0.5));
  const bendOf = (face: number): number => {
    const normal = faceNormal(mesh, face);
    const c = faceCentroid(mesh, face);
    const probe: Tuple3 = wall.has(face)
      ? [c[0] - 2 * tolerance * normal[0], c[1] - 2 * tolerance * normal[1], c[2]]
      : c;
    for (const bend of sheet.bends) {
      const { a } = bendFrame(bend, probe);
      if (a > 0 && a < bend.allowance) return bend.index;
    }
    return -1;
  };
  const bendIndex = new Map(order.map((f) => [f, bendOf(f)]));
  const classOf = new Map<number, Component>();
  const components: Component[] = [];
  for (const f of order) {
    if (classOf.has(f)) continue;
    const bend = bendIndex.get(f) as number;
    const component: Component = {
      kind: bend < 0 ? 'piece' : 'strip',
      bend,
      faces: [],
      low: new Set(),
      high: new Set(),
      strips: new Set(),
      placed: undefined,
    };
    components.push(component);
    classOf.set(f, component);
    const stack = [f];
    while (stack.length > 0) {
      const g = stack.pop() as number;
      component.faces.push(g);
      for (const h of mesh.faceHalves(g)) {
        const other = mesh.hFace[h ^ 1] as number;
        if (other === NONE || !faces.has(other) || classOf.has(other)) continue;
        if (bendIndex.get(other) !== bend) continue;
        classOf.set(other, component);
        stack.push(other);
      }
    }
  }
  const stripList = components.filter((c) => c.kind === 'strip');
  const pieces = components.filter((c) => c.kind === 'piece');
  for (const strip of stripList) {
    const bend = sheet.bends[strip.bend] as ReadBend;
    for (const f of strip.faces) {
      for (const h of mesh.faceHalves(f)) {
        const other = mesh.hFace[h ^ 1] as number;
        if (other === NONE || !faces.has(other)) continue;
        const piece = classOf.get(other) as Component;
        if (piece.kind !== 'piece') continue;
        const from = mesh.position(mesh.hVert[h] as number);
        const to = mesh.position(mesh.hVert[mesh.hNext[h] as number] as number);
        const mid = bendFrame(bend, [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]).a;
        (mid < bend.half ? strip.low : strip.high).add(piece);
        piece.strips.add(strip);
      }
    }
    if (strip.low.size === 0 || strip.high.size === 0) {
      return notSheet(
        'bend-dangling',
        { bend: bend.index },
        'material on both sides of a bend zone must connect to it',
      );
    }
  }
  const upArea = (c: Component) =>
    c.faces.reduce((sum, f) => (faceNormal(mesh, f)[2] > 0.5 ? sum + faceArea(mesh, f) : sum), 0);
  const root = pieces.reduce((best, c) => (upArea(c) > upArea(best) ? c : best));
  const rigid = new Map<Component, Affine>([[root, IDENTITY]]);
  const extent = Math.max(
    1,
    maxOf(
      loopsOf(sheet.shape)
        .flat()
        .map((p) => hypot3(p[0], p[1], 0)),
    ),
  );
  const steps = sheet.bends.map((bend) => {
    const frame = frameAffine(bend);
    return multiply(invertRigid(frame), multiply(endAffine(sheet.thickness, bend), frame));
  });
  const queue = [root];
  while (queue.length > 0) {
    const piece = queue.shift() as Component;
    for (const strip of piece.strips) {
      if (strip.placed !== undefined) continue;
      if (strip.low.has(piece) && strip.high.has(piece)) {
        return notSheet(
          'closed-loop',
          { bend: strip.bend },
          'a piece cannot lie on both sides of one bend',
        );
      }
      const step = steps[strip.bend] as Affine;
      const here = rigid.get(piece) as Affine;
      const placed = strip.low.has(piece) ? here : multiply(here, invertRigid(step));
      strip.placed = placed;
      const sides: [Set<Component>, Affine][] = [
        [strip.low, placed],
        [strip.high, multiply(placed, step)],
      ];
      for (const [group, transform] of sides) {
        for (const other of group) {
          const known = rigid.get(other);
          if (known === undefined) {
            rigid.set(other, transform);
            queue.push(other);
          } else if (!sameTransform(known, transform, extent)) {
            return notSheet(
              'closed-loop',
              { bend: strip.bend },
              'bends that form a closed loop cannot fold from a flat sheet',
            );
          }
        }
      }
    }
  }
  if (rigid.size !== pieces.length) {
    return notSheet(
      'disconnected',
      {},
      'every flat piece must connect to the largest piece through bends',
    );
  }
  const frames = sheet.bends.map((bend) => {
    const frame = frameAffine(bend);
    return { frame, back: invertRigid(frame) };
  });
  const moved = new Set<number>();
  for (const f of order) {
    const comp = classOf.get(f) as Component;
    for (const v of mesh.faceVertices(f)) {
      if (moved.has(v)) continue;
      moved.add(v);
      const p = mesh.position(v);
      let q: Tuple3;
      if (comp.kind === 'piece') {
        q = applyPoint(rigid.get(comp) as Affine, p);
      } else {
        const bend = sheet.bends[comp.bend] as ReadBend;
        const { frame, back } = frames[comp.bend] as { frame: Affine; back: Affine };
        const local = applyPoint(frame, p);
        const a = Math.min(Math.max(local[0], 0), bend.allowance);
        const [across, up] = arcPoint(sheet.thickness, bend, a / bend.neutral, local[2]);
        q = applyPoint(comp.placed as Affine, applyPoint(back, [across, local[1], up]));
      }
      mesh.setPosition(v, q[0], q[1], q[2]);
    }
  }
  const shell = requireOutwardShell(
    mesh,
    order,
    'the folded sheet turns inside out: keep flanges from overlapping and bends clear of each other',
  );
  if (!shell.ok) return shell;
  const counts: RoleCounts = {};
  for (const f of order) {
    const strip = (classOf.get(f) as Component).kind === 'strip';
    const role = wall.has(f) ? 'sheet-edge' : strip ? 'bend' : 'sheet';
    if (attribution.label !== 0) {
      mesh.fLabel[f] = attribution.label;
      mesh.fRole[f] = mesh.nameIndex(mesh.roleNames, role);
    }
    counts[role] = (counts[role] ?? 0) + 1;
  }
  return ok(counts);
}

/** The flat pattern as a drawing: outline and holes as visible lines, bend lines as guides, a bend table. */
function patternDrawing(read: ReadSheet): Drawing {
  const mm = (x: number) => Math.round(x * 1e7) / 1e4;
  const loop = (id: string, points: readonly Point2[]): DrawingItem => ({
    id,
    view: 'flat',
    role: 'visible',
    kind: 'curve',
    curve: { kind: 'polyline', points },
    closed: true,
  });
  const items: DrawingItem[] = [
    loop('outline', read.shape.outer),
    ...(read.shape.holes ?? []).map((hole, i) => loop(`hole-${i + 1}`, hole)),
    ...read.bends.map(
      (bend): DrawingItem => ({
        id: `bend-${bend.index + 1}`,
        view: 'flat',
        role: 'guide',
        kind: 'curve',
        curve: {
          kind: 'polyline',
          points: [
            bend.a,
            [bend.a[0] + bend.d[0] * bend.length, bend.a[1] + bend.d[1] * bend.length],
          ],
        },
      }),
    ),
  ];
  if (read.bends.length > 0) {
    items.push({
      id: 'bend-table',
      view: 'flat',
      role: 'guide',
      kind: 'table',
      columns: ['bend', 'direction', 'angle deg', 'radius mm', 'allowance mm'],
      rows: read.bends.map((bend) => [
        `bend-${bend.index + 1}`,
        bend.sign > 0 ? 'up' : 'down',
        Math.abs(bend.degrees),
        mm(bend.radius),
        mm(bend.allowance),
      ]),
    });
  }
  return { name: 'sheet-flat-pattern', views: [{ id: 'flat', ortho: 'front' }], items };
}

function checked(spec: SheetMetalSpec): Result<ReadSheet, ModelingError> {
  const read = readSheet(spec);
  if (!read.ok) return read;
  const developable = checkDevelopable(read.value);
  if (!developable.ok) return developable;
  return read;
}

/** Flat-pattern queries: the pattern is the primary data, so none of them folds anything. */
export const sheet = {
  /** BA = angle (rad) * (radius + kFactor * thickness) for a bend of `angle` degrees. */
  bendAllowance,
  /** The checked flat outline; `model-precondition` (`reason: 'not-sheet'`) when it cannot fold. */
  flat(spec: SheetMetalSpec): Result<Region2, ModelingError> {
    const read = checked(spec);
    return read.ok ? ok(read.value.region) : read;
  },
  /** The flat pattern as a drawing with one view `flat`: outline and holes, bend lines, a bend table. */
  drawing(spec: SheetMetalSpec): Result<Drawing, ModelingError> {
    const read = checked(spec);
    return read.ok ? ok(patternDrawing(read.value)) : read;
  },
  /** The flat pattern as DXF R12 (millimeters at 1:1) through `drawingDxf`: bend lines on layer GUIDE. */
  dxf(spec: SheetMetalSpec): Result<string, ModelingError> {
    const drawing = sheet.drawing(spec);
    if (!drawing.ok) return drawing;
    const resolved = resolveDrawing(drawing.value);
    if (!resolved.ok) return resolved;
    return drawingDxf(resolved.value);
  },
};
