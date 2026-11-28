import { err, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import { type LoopEdge, ShapeAssembler } from './assembler';
import type { ToleranceOptions } from './tolerance';
import { brepError, type Frame, type Shape } from './types';
import { HALF_PI, type P3 } from './vec';

const TWO_PI = 2 * Math.PI;

export interface FilletCylinderOptions extends ToleranceOptions {
  /** Cylinder radius about the z axis. */
  readonly radius: number;
  /** Height from z = 0 to z = height. */
  readonly height: number;
  /** Radius of the rounded circular edge at both the bottom and the top rim. */
  readonly fillet: number;
  readonly label?: string;
}

/**
 * A solid cylinder with both circular rim edges rounded by one radius. Faces: two planar disks of
 * radius `radius - fillet`, two quarter-torus bands (major `radius - fillet`, minor `fillet`) and
 * the straight side between the fillet tangent circles. Volume is Pappus on the profile: the
 * rectangle minus two corner regions, each with area r^2 (1 - pi/4) and first moment
 * (R - r) r^2 (1 - pi/4) + r^3 / 6.
 */
export function filletCylinder(options: FilletCylinderOptions): Result<Shape, ModelingError> {
  const bad = (why: string, ids?: Record<string, unknown>) =>
    err(brepError('brep-bad-argument', why, ids));
  const { radius: R, height: H, fillet: r } = options;
  if (!(Number.isFinite(R) && R > 0)) return bad('radius is a finite number greater than 0');
  if (!(Number.isFinite(H) && H > 0)) return bad('height is a finite number greater than 0');
  if (!(Number.isFinite(r) && r > 0)) return bad('fillet is a finite number greater than 0');
  if (!(r < R)) return bad('fillet is less than radius', { reason: 'fillet-too-large' });
  if (!(2 * r < H)) return bad('fillet leaves a straight side', { reason: 'fillet-too-large' });

  const a = R - r;
  const made = ShapeAssembler.create(2 * (R + H), options);
  if (!made.ok) return made;
  const asm = made.value;
  const label = options.label ?? 'filleted-cylinder';

  const lines = new Map<string, number>();
  const circles = new Map<string, number>();
  const arcs = new Map<string, number>();
  const circle = (key: string, frame: Frame, radius: number): LoopEdge => {
    let edge = circles.get(key);
    if (edge === undefined) {
      edge = asm.edge(asm.curve({ kind: 'circle', frame, radius }), 0, TWO_PI);
      circles.set(key, edge);
    }
    return { edge };
  };
  const seam = (key: string, start: P3, length: number): LoopEdge => {
    let edge = lines.get(key);
    if (edge === undefined) {
      edge = asm.edge(asm.curve({ kind: 'line', o: start, d: [0, 0, 1] }), 0, length);
      lines.set(key, edge);
    }
    return { edge };
  };
  // Meridian arc of the fillet at u = 0, a quarter circle of radius r in the xz plane.
  const meridian = (key: string, frame: Frame): LoopEdge => {
    let edge = arcs.get(key);
    if (edge === undefined) {
      edge = asm.edge(asm.curve({ kind: 'circle', frame, radius: r }), 0, HALF_PI);
      arcs.set(key, edge);
    }
    return { edge };
  };

  const up: Frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const atZ = (z: number, f: Frame): Frame => ({ ...f, o: [0, 0, z] });
  const sideFrame: Frame = { o: [0, 0, r], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

  const faces: number[] = [];
  const failures: (ModelingError | undefined)[] = [];

  // Bottom disk, outward normal -z. Frame y = z x x = -y so the boundary is counter-clockwise.
  const bottomPlane: Frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, -1, 0], z: [0, 0, -1] };
  const bottomDisk = asm.surface({ kind: 'plane', frame: bottomPlane });
  const bottomOuter = asm.loop(bottomDisk, [circle('z0-a', atZ(0, up), a)], true);
  if (bottomOuter.ok)
    faces.push(asm.face(bottomDisk, [bottomOuter.value], false, `${label}.bottom`));
  else failures.push(bottomOuter.error);

  // Top disk, outward normal +z.
  const topDisk = asm.surface({ kind: 'plane', frame: atZ(H, up) });
  const topOuter = asm.loop(topDisk, [circle(`z${H}-a`, atZ(H, up), a)], true);
  if (topOuter.ok) faces.push(asm.face(topDisk, [topOuter.value], false, `${label}.top`));
  else failures.push(topOuter.error);

  // Side cylinder between the two fillet tangent circles at z = r and z = H - r.
  const side = asm.surface({ kind: 'cylinder', frame: sideFrame, radius: R });
  const sideLoop = asm.loop(
    side,
    [
      circle(`z${r}-R`, atZ(r, up), R),
      seam('side-seam', [R, 0, r], H - 2 * r),
      circle(`z${H - r}-R`, atZ(H - r, up), R),
      seam('side-seam', [R, 0, r], H - 2 * r),
    ],
    true,
  );
  if (sideLoop.ok) faces.push(asm.face(side, [sideLoop.value], false, `${label}.side`));
  else failures.push(sideLoop.error);

  // Quarter-torus bands. The fillet centre sits at (a, 0, zc) for u = 0; v runs from the outer
  // equator (radius R) to the flat rim (radius a). Bottom: v in [-pi/2, 0]; top: v in [0, pi/2].
  const bands: [number, number, string, number, number][] = [
    [r, -1, 'bottom', 0, r],
    [H - r, 1, 'top', H, H - r],
  ];
  for (const [zc, sign, name, zRim, zEquator] of bands) {
    const torusFrame: Frame = { o: [0, 0, zc], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const torus = asm.surface({ kind: 'torus', frame: torusFrame, major: a, minor: r });
    const meridianFrame: Frame = {
      o: [a, 0, zc],
      x: [1, 0, 0],
      y: [0, 0, sign],
      z: [0, -sign, 0],
    };
    const rimCircle = circle(`z${zRim}-a`, atZ(zRim, up), a);
    const equatorCircle = circle(`z${zEquator}-R`, atZ(zEquator, up), R);
    const rim = meridian(`meridian-${name}`, meridianFrame);
    const loop = asm.loop(torus, [equatorCircle, rim, rimCircle, rim], true);
    if (loop.ok) faces.push(asm.face(torus, [loop.value], false, `${label}.${name}-fillet`));
    else failures.push(loop.error);
  }

  const first = failures.find((f) => f !== undefined);
  if (first !== undefined) return err(first);
  asm.shell(faces);
  return asm.finish();
}
