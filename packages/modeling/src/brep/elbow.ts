import { err, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import { type LoopEdge, ShapeAssembler } from './assembler';
import type { ToleranceOptions } from './tolerance';
import { brepError, type Frame, type Shape } from './types';
import { HALF_PI, type P3 } from './vec';

const TWO_PI = 2 * Math.PI;

export interface PipeElbowOptions extends ToleranceOptions {
  /** Centreline bend radius about the z axis; must exceed `outer`. */
  readonly bend: number;
  /** Outer tube radius. */
  readonly outer: number;
  /** Bore radius, 0 < inner < outer. */
  readonly inner: number;
  /** Length of each straight leg measured from the bend tangent point. */
  readonly leg: number;
  readonly label?: string;
}

/**
 * A hollow 90 degree pipe elbow in the xy plane. The centreline runs along -y from (R, 0, 0) into
 * a quarter bend of radius R about the z axis, ending at (0, R, 0), then along -x. Built from six
 * bands (two straight legs and one quarter torus, for the outer wall and the bore) and two planar
 * annular end caps; the bore faces are reversed so their normals point into the bore.
 * Volume follows Pappus on the annulus: A (2 L + pi R / 2).
 */
export function pipeElbow(options: PipeElbowOptions): Result<Shape, ModelingError> {
  const bad = (why: string, ids?: Record<string, unknown>) =>
    err(brepError('brep-bad-argument', why, ids));
  const { bend: R, outer: ro, inner: ri, leg: L } = options;
  if (!(Number.isFinite(ri) && ri > 0)) return bad('inner is a finite number greater than 0');
  if (!(Number.isFinite(ro) && ri < ro)) return bad('outer is greater than inner');
  if (!(Number.isFinite(R) && ro < R)) return bad('bend is greater than outer');
  if (!(Number.isFinite(L) && L > 0)) return bad('leg is a finite number greater than 0');

  const made = ShapeAssembler.create(2 * (R + ro + L), options);
  if (!made.ok) return made;
  const asm = made.value;
  const label = options.label ?? 'pipe-elbow';

  const lines = new Map<string, number>();
  const circles = new Map<string, number>();
  const circle = (key: string, frame: Frame, radius: number): LoopEdge => {
    let edge = circles.get(key);
    if (edge === undefined) {
      edge = asm.edge(asm.curve({ kind: 'circle', frame, radius }), 0, TWO_PI);
      circles.set(key, edge);
    }
    return { edge };
  };
  const seam = (key: string, a: P3, d: P3, length: number): LoopEdge => {
    let edge = lines.get(key);
    if (edge === undefined) {
      edge = asm.edge(asm.curve({ kind: 'line', o: a, d }), 0, length);
      lines.set(key, edge);
    }
    return { edge };
  };
  const arcs = new Map<string, number>();
  const arc = (key: string, radius: number): LoopEdge => {
    let edge = arcs.get(key);
    if (edge === undefined) {
      const frame: Frame = {
        o: [0, 0, 0],
        x: [1, 0, 0],
        y: [0, 1, 0],
        z: [0, 0, 1],
      };
      edge = asm.edge(asm.curve({ kind: 'circle', frame, radius }), 0, HALF_PI);
      arcs.set(key, edge);
    }
    return { edge };
  };

  // Leg A: joint at y = 0, far end at y = -L; axis is frame z = -y. Leg B mirrors it: joint at
  // x = 0, far end at x = -L; axis is frame z = -x.
  const frameA: Frame = { o: [R, 0, 0], x: [1, 0, 0], y: [0, 0, 1], z: [0, -1, 0] };
  const frameB: Frame = { o: [0, R, 0], x: [0, 1, 0], y: [0, 0, -1], z: [-1, 0, 0] };
  const farA: Frame = { ...frameA, o: [R, -L, 0] };
  const farB: Frame = { ...frameB, o: [-L, R, 0] };
  const frameTorus: Frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

  const faces: number[] = [];

  const bands = (inside: boolean, radius: number, tag: 'o' | 'i') => {
    const reversed = inside;
    const out: (ModelingError | undefined)[] = [];
    const legs: [Frame, Frame, string][] = [
      [frameA, farA, 'a'],
      [frameB, farB, 'b'],
    ];
    for (const [near, far, name] of legs) {
      const surface = asm.surface({ kind: 'cylinder', frame: near, radius });
      const d = near.z;
      const start = [
        near.o[0] + near.x[0] * radius,
        near.o[1] + near.x[1] * radius,
        near.o[2] + near.x[2] * radius,
      ] as P3;
      const loop = asm.loop(
        surface,
        [
          circle(`joint-${tag}-${name}`, near, radius),
          seam(`seam-${tag}-${name}`, start, d, L),
          circle(`far-${tag}-${name}`, far, radius),
          seam(`seam-${tag}-${name}`, start, d, L),
        ],
        true,
      );
      if (!loop.ok) {
        out.push(loop.error);
        continue;
      }
      out.push(undefined);
      faces.push(asm.face(surface, [loop.value], reversed, `${label}.${tag}.${name}`));
    }
    const torus = asm.surface({ kind: 'torus', frame: frameTorus, major: R, minor: radius });
    const loop = asm.loop(
      torus,
      [
        circle(`joint-${tag}-a`, frameA, radius),
        arc(`arc-${tag}`, R + radius),
        circle(`joint-${tag}-b`, frameB, radius),
        arc(`arc-${tag}`, R + radius),
      ],
      true,
    );
    if (!loop.ok) {
      out.push(loop.error);
    } else {
      faces.push(asm.face(torus, [loop.value], reversed, `${label}.${tag}.bend`));
    }
    return out;
  };

  const failures = [...bands(false, ro, 'o'), ...bands(true, ri, 'i')];
  for (const [far, name] of [
    [farA, 'a'],
    [farB, 'b'],
  ] as const) {
    const cap = asm.surface({ kind: 'plane', frame: far });
    const outerLoop = asm.loop(cap, [circle(`far-o-${name}`, far, ro)], true);
    const innerLoop = asm.loop(cap, [circle(`far-i-${name}`, far, ri)], false);
    if (!outerLoop.ok) {
      failures.push(outerLoop.error);
    } else if (!innerLoop.ok) {
      failures.push(innerLoop.error);
    } else {
      faces.push(asm.face(cap, [outerLoop.value, innerLoop.value], false, `${label}.cap.${name}`));
    }
  }
  const first = failures.find((f) => f !== undefined);
  if (first !== undefined) return err(first);
  asm.shell(faces);
  return asm.finish();
}
