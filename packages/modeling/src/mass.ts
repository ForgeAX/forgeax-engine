import { err, ok, type Result } from '@forgeax/engine-types';
import { type Affine, applyPoint, invertRigid, multiply } from './affine';
import { maxOf } from './arrays';
import { type ModelingError, modelingError } from './errors';
import { add, facePoints, sub, type Tuple3, windingNumber } from './geom';
import type { EditMesh } from './mesh';
import type {
  ActuationOptions,
  ActuationReport,
  JointEffort,
  JointRecord,
  JointValue,
  Pose,
  Range,
  Rig,
} from './rig';
import { rangeOf, stopHeld } from './rig';
import type { FaceSelector } from './selectors';

const XYZ = [0, 1, 2] as const;

/** Mass properties of a closed solid at uniform density. */
export interface MassProperties {
  /** Enclosed volume (m^3). */
  readonly volume: number;
  /** volume x density (kg). */
  readonly mass: number;
  /** Centre of mass (m). */
  readonly centroid: Tuple3;
  /** Inertia tensor about the centre of mass (kg m^2), row-major 3x3. */
  readonly inertia: readonly [Tuple3, Tuple3, Tuple3];
  /** Closed shells summed; overlapping shells each add their volume (boolean them first). */
  readonly shells: number;
}

/** The faces connected to each other across shared edges, in first-face order. */
function connectedShells(mesh: EditMesh, faces: readonly number[]): number[][] {
  const seen = new Set<number>();
  const shells: number[][] = [];
  for (const start of faces) {
    if (seen.has(start)) continue;
    seen.add(start);
    const shell = [start];
    for (let i = 0; i < shell.length; i++) {
      for (const h of mesh.faceHalves(shell[i] as number)) {
        const g = mesh.hFace[h ^ 1] as number;
        if (seen.has(g)) continue;
        seen.add(g);
        shell.push(g);
      }
    }
    shells.push(shell);
  }
  return shells;
}

/**
 * @internal Exact mass properties of the closed shells the faces form, by signed tetrahedra
 * from a point of each shell to each triangle of a fan (the covariance form of Tonon /
 * Blow-Binstock). Integrating about a local point rather than the world origin keeps a part
 * far from the origin as precise as one at it.
 */
export function solidProperties(
  mesh: EditMesh,
  faces: readonly number[],
  density: number,
): Result<MassProperties, ModelingError> {
  if (!Number.isFinite(density) || density <= 0) {
    return err(modelingError('model-invalid-argument', 'a positive density (kg/m^3)', { density }));
  }
  // Only a closed shell encloses a volume: every edge of the set meets another face of it.
  const set = new Set(faces);
  const open = faces.some((f) =>
    mesh.faceHalves(f).some((h) => !set.has(mesh.hFace[h ^ 1] as number)),
  );
  if (open || faces.length === 0) {
    return err(
      modelingError(
        'model-precondition',
        'faces that form a closed shell',
        { faces: faces.length },
        'mass properties need a closed solid; select whole parts',
      ),
    );
  }
  const shells = connectedShells(mesh, faces);
  const bad: { shell: number; volume: number; faces: number }[] = [];
  let volume = 0;
  // Moments about `origin` (the first shell's first point): the first moment and the second
  // moments, integral of x_i x_j over the solid.
  const origin = facePoints(mesh, shells[0]?.[0] as number)[0] as Tuple3;
  const first = [0, 0, 0];
  const second = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const [index, shell] of shells.entries()) {
    // Each shell integrates about its own point, then moves to `origin` exactly.
    const local = facePoints(mesh, shell[0] as number)[0] as Tuple3;
    let shellVolume = 0;
    const shellFirst = [0, 0, 0];
    const shellSecond = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const f of shell) {
      const points = facePoints(mesh, f).map((p) => sub(p, local));
      for (const p of points) {
        for (const k of XYZ) {
          lo[k] = Math.min(lo[k] as number, p[k]);
          hi[k] = Math.max(hi[k] as number, p[k]);
        }
      }
      const a = points[0] as Tuple3;
      for (let i = 1; i + 1 < points.length; i++) {
        const b = points[i] as Tuple3;
        const c = points[i + 1] as Tuple3;
        const det =
          a[0] * (b[1] * c[2] - b[2] * c[1]) -
          a[1] * (b[0] * c[2] - b[2] * c[0]) +
          a[2] * (b[0] * c[1] - b[1] * c[0]);
        const v = det / 6;
        shellVolume += v;
        for (const k of XYZ) {
          shellFirst[k] = (shellFirst[k] as number) + (v * (a[k] + b[k] + c[k])) / 4;
        }
        // Over a tetrahedron (0, a, b, c): integral x_i x_j = V/20 (sum over vertices of 2 x_i x_j
        // with the cross terms), the origin vertex contributing nothing.
        for (const r of XYZ) {
          for (const s of XYZ) {
            const term =
              2 * (a[r] * a[s] + b[r] * b[s] + c[r] * c[s]) +
              a[r] * b[s] +
              a[s] * b[r] +
              a[r] * c[s] +
              a[s] * c[r] +
              b[r] * c[s] +
              b[s] * c[r];
            shellSecond[r * 3 + s] = (shellSecond[r * 3 + s] as number) + (v * term) / 20;
          }
        }
      }
    }
    // x - origin = (x - local) + d: the shell's moments about `origin`.
    const d = sub(local, origin);
    for (const r of XYZ) {
      first[r] = (first[r] as number) + (shellFirst[r] as number) + shellVolume * d[r];
      for (const t of XYZ) {
        second[r * 3 + t] =
          (second[r * 3 + t] as number) +
          (shellSecond[r * 3 + t] as number) +
          d[r] * (shellFirst[t] as number) +
          d[t] * (shellFirst[r] as number) +
          shellVolume * d[r] * d[t];
      }
    }
    // The cube of the largest extent, not the box volume, so a flat shell's box is no excuse.
    const extent = maxOf(XYZ.map((k) => (hi[k] as number) - (lo[k] as number)));
    const degenerate = !(Math.abs(shellVolume) > 1e-9 * extent * extent * extent);
    // An inward-facing shell inside another shell is a cavity: its negative volume subtracts.
    // One that nothing encloses is inside out.
    const others = shells.flatMap((other, k) => (k === index ? [] : other));
    const probe = mesh.position(mesh.faceVertices(shell[0] as number)[0] as number);
    const cavity = shellVolume < 0 && others.length > 0 && windingNumber(mesh, others, probe) > 0.5;
    if (degenerate || (shellVolume < 0 && !cavity)) {
      bad.push({ shell: index, volume: shellVolume, faces: shell.length });
    }
    volume += shellVolume;
  }
  if (bad.length > 0) {
    return err(
      modelingError(
        'model-precondition',
        'closed shells that face outward, or inward as a cavity inside another shell',
        { shells: bad },
        "flip the inside-out shell's faces (model.flip) or select only outward-facing closed shells",
      ),
    );
  }
  // The centre of mass relative to `origin`.
  const offset = first.map((m) => m / volume) as unknown as Tuple3;
  const centroid = add(origin, offset);
  const mass = volume * density;
  const cov = second.map((m) => m * density);
  // Inertia about `origin` from the covariance, then moved to the centre of mass.
  const inertia = XYZ.map((r) =>
    XYZ.map((s) => {
      const trace = (cov[0] as number) + (cov[4] as number) + (cov[8] as number);
      const atOrigin = (r === s ? trace : 0) - (cov[r * 3 + s] as number);
      const shift =
        mass *
        ((r === s ? offset[0] * offset[0] + offset[1] * offset[1] + offset[2] * offset[2] : 0) -
          offset[r] * offset[s]);
      return atOrigin - shift;
    }),
  ) as unknown as [Tuple3, Tuple3, Tuple3];
  return ok({ volume, mass, centroid, inertia, shells: shells.length });
}

/**
 * Volume, mass, centre of mass and inertia (about the centre of mass) of a session's closed
 * solid at uniform `density` (kg/m^3), or of the closed shells the `faces` select. Every shell
 * faces outward, or inward as a cavity inside another shell (which subtracts); each outward
 * shell adds its own volume, so overlapping shells count twice.
 */
export function massProperties(
  source: { readonly editMesh: EditMesh; readonly poisoned?: ModelingError | undefined },
  options: { readonly density: number; readonly faces?: FaceSelector },
): Result<MassProperties, ModelingError> {
  if (source.poisoned !== undefined) return err(source.poisoned);
  const mesh = source.editMesh;
  const faces = options.faces === undefined ? [...mesh.faces()] : options.faces.evaluate(mesh);
  return solidProperties(mesh, faces, options.density);
}

/** @internal The body of `Rig.actuation`. */
export function rigActuation(
  r: Rig,
  pose: Pose = {},
  options: ActuationOptions = {},
): Result<ActuationReport, ModelingError> {
  const resolved = r._resolve();
  if (!resolved.ok) return resolved;
  // A report on a pose other than the one asked for would mislead: reject by default.
  const posed = r.pose(pose, { ...options, limits: options.limits ?? 'reject' });
  if (!posed.ok) return posed;
  const gravity = options.gravity ?? [0, -9.81, 0];
  const weighed = r.weigh(resolved.value, options.density);
  if (!weighed.ok) return weighed;
  const { weights, massless } = weighed.value;
  const potential = (worlds: readonly Affine[]) =>
    weights.reduce((sum, w) => {
      const joint = r._table[w.joint] as JointRecord;
      const c = applyPoint(
        multiply(worlds[w.joint] as Affine, invertRigid(joint.restWorld)),
        w.rest,
      );
      return sum - w.mass * (gravity[0] * c[0] + gravity[1] * c[1] + gravity[2] * c[2]);
    }, 0);
  const named = new Set(Object.keys(pose));
  const loop = new Set(r.loopJoints());
  const driven = r._table.flatMap((j, i) =>
    j.kind !== 'fixed' && j.mimic === undefined && (!loop.has(i) || named.has(j.name)) ? [i] : [],
  );
  const coords = r.coordinatesOf(driven);
  const values = posed.value.joints.map((j) => j.value);
  const h = 1e-5;
  const efforts: JointEffort[] = [];
  for (const c of coords) {
    const x = r.coordinate(values, c);
    const joint = r._table[c.joint] as JointRecord;
    // The potential at v, or undefined past the joint's limit (the step would be clamped).
    const at = (v: number): Result<number | undefined, ModelingError> => {
      const trial = [...values];
      r._setCoordinate(trial, c, v);
      const next: Record<string, JointValue> = {};
      for (const i of driven) {
        next[(r._table[i] as JointRecord).name] = r.valueAt(trial, i) as JointValue;
      }
      const solved = r.pose(next, { limits: 'clamp' });
      if (!solved.ok) return solved;
      const out = solved.value.clamped.some(
        (k) => k.joint === joint.name && k.solved !== true && k.axis === c.axis,
      );
      return ok(out ? undefined : potential(solved.value.joints.map((j) => j.world)));
    };
    const up = at(x + h);
    if (!up.ok) return up;
    const down = at(x - h);
    if (!down.ok) return down;
    // At a limit the difference is one-sided.
    const mid = up.value === undefined || down.value === undefined ? at(x) : ok(0);
    if (!mid.ok) return mid;
    const effort =
      up.value !== undefined && down.value !== undefined
        ? (up.value - down.value) / (2 * h)
        : up.value !== undefined
          ? (up.value - (mid.value as number)) / h
          : ((mid.value as number) - (down.value as number)) / h;
    const rating = options.ratings?.[joint.name];
    // A landed stop carries an effort pushing into it: gravity drives the joint toward the
    // limit (dV/dq > 0 at min, < 0 at max) and the stop, not the actuator, holds it.
    const reach = rangeOf(joint);
    const range = Array.isArray(reach) ? (reach as Range) : undefined;
    const value = c.axis === undefined ? (r.valueAt(values, c.joint) as number) : undefined;
    const atStop =
      range === undefined || value === undefined
        ? undefined
        : stopHeld(joint, 'min') && Math.abs(value - range[0]) <= 1e-9 && effort > 0
          ? ('min' as const)
          : stopHeld(joint, 'max') && Math.abs(value - range[1]) <= 1e-9 && effort < 0
            ? ('max' as const)
            : undefined;
    efforts.push({
      joint: joint.name,
      ...(c.axis === undefined ? {} : { axis: c.axis }),
      kind: joint.kind as JointEffort['kind'],
      effort,
      ...(rating === undefined ? {} : { rating }),
      ...(atStop === undefined ? {} : { atStop }),
      exceeded: atStop === undefined && rating !== undefined && Math.abs(effort) > rating,
    });
  }
  const { mass, centroid } = r.centreOfMass(
    weights,
    posed.value.joints.map((j) => j.world),
  );
  return ok({
    mass,
    centroid,
    joints: efforts,
    exceeded: efforts.filter((e) => e.exceeded).map((e) => e.joint),
    massless,
    clamped: posed.value.clamped,
  });
}
