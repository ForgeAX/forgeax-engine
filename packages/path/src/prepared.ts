import {
  curve3,
  type Mat4,
  mat4,
  quat,
  type Vec3,
  type Vec3Like,
  vec3,
} from '@forgeax/engine-math';
import { err, ok, type Result } from '@forgeax/engine-types';
import { type PathDefinition, PathParameterization } from './components';
import { invalidPath, type PathError } from './errors';
import { createPathSample, orientSample, type PathSample, projectNormal } from './frame';

export const PATH_MAX_POINTS = 4096;
export const PATH_MAX_SUBDIVISIONS = 65536;
const MODES = Object.keys(PathParameterization) as (keyof typeof PathParameterization)[];

/** Derived, private buffers; all followers share the same immutable preparation. */
export class PreparedPath {
  readonly length: number;
  private readonly points: readonly Vec3Like[];
  private readonly linear: Mat4;
  private readonly lengths: Float64Array;
  private readonly normals: Float32Array;
  private readonly tangents: Float32Array;
  private readonly options: curve3.CatmullRomOptions;

  constructor(definition: PathDefinition, instance: Mat4) {
    if (
      !Number.isInteger(definition.points.length / 3) ||
      definition.points.length < 6 ||
      definition.points.length > PATH_MAX_POINTS * 3
    )
      throw invalidPath('points', `2..${PATH_MAX_POINTS} local XYZ control points`);
    for (const value of definition.points)
      if (!Number.isFinite(value)) throw invalidPath('points', 'Finite Float32 coordinates');
    const parameterization = MODES.find(
      (mode) => PathParameterization[mode] === definition.parameterization,
    );
    if (typeof definition.closed !== 'boolean' || parameterization === undefined)
      throw invalidPath('curve options', 'Boolean closed and declared parameterization');
    if (
      !Number.isInteger(definition.subdivisions) ||
      definition.subdivisions < 16 ||
      definition.subdivisions > PATH_MAX_SUBDIVISIONS
    )
      throw invalidPath('subdivisions', `Integer 16..${PATH_MAX_SUBDIVISIONS}`);
    if (
      definition.up.length !== 3 ||
      !Array.from(definition.up).every(Number.isFinite) ||
      !(Math.hypot(...definition.up) > 0)
    )
      throw invalidPath('up', 'Finite nonzero local up vector');
    if (
      instance.length !== 16 ||
      !Array.from(instance).every(Number.isFinite) ||
      instance[3] !== 0 ||
      instance[7] !== 0 ||
      instance[11] !== 0 ||
      instance[15] !== 1
    )
      throw invalidPath('instance transform', 'Finite affine matrix');
    this.linear = mat4.clone(instance);
    this.linear[12] = this.linear[13] = this.linear[14] = 0;
    this.points = Array.from({ length: definition.points.length / 3 }, (_, i) =>
      vec3.create(
        definition.points[i * 3] as number,
        definition.points[i * 3 + 1] as number,
        definition.points[i * 3 + 2] as number,
      ),
    );
    this.options = {
      closed: definition.closed,
      parameterization,
    };
    const segments = definition.closed ? this.points.length : this.points.length - 1;
    if (definition.subdivisions < segments)
      throw invalidPath('subdivisions', 'At least one subdivision per curve segment');
    // Align knots with table rows: chordal speed can jump at a knot.
    const count = Math.floor(definition.subdivisions / segments) * segments + 1;
    this.lengths = new Float64Array(count);
    this.normals = new Float32Array(count * 3);
    this.tangents = new Float32Array(count * 3);
    const sample = createPathSample(),
      previous = vec3.create(),
      previousTangent = vec3.create(),
      previousNormal = vec3.create();
    let sum = 0;
    for (let i = 0; i < count; i++) {
      this.point(sample, i / (count - 1));
      if (i > 0) sum += vec3.distance(sample.position, previous);
      if (
        !Number.isFinite(sum) ||
        !Number.isFinite(sample.position[0]) ||
        !Number.isFinite(sample.position[1]) ||
        !Number.isFinite(sample.position[2])
      )
        throw invalidPath('instance transform', 'Finite transformed curve');
      this.lengths[i] = sum;
      previous.set(sample.position);
      this.tangent(sample, i / (count - 1));
      if (
        !Number.isFinite(sample.tangent[0]) ||
        !Number.isFinite(sample.tangent[1]) ||
        !Number.isFinite(sample.tangent[2])
      )
        throw invalidPath('instance transform', 'Finite transformed tangent');
      if (vec3.length(sample.tangent) === 0) {
        // A stationary derivative uses a bounded symmetric chord, then the last
        // nonzero frame. A genuine cusp has no unique continuous tangent.
        const t = i / (count - 1),
          h = 0.5 / (count - 1);
        this.point(sample, Math.max(0, t - h));
        sample.right.set(sample.position);
        this.point(sample, Math.min(1, t + h));
        vec3.sub(sample.tangent, sample.position, sample.right);
        vec3.normalize(sample.tangent, sample.tangent);
        if (vec3.length(sample.tangent) === 0)
          sample.tangent.set(i === 0 ? [0, 0, 1] : previousTangent);
      }
      this.tangents.set(sample.tangent, i * 3);
      if (i === 0) {
        // Up has direction semantics; its authored magnitude must not multiply
        // the instance scale into a Float32 overflow before normalization.
        vec3.normalize(sample.normal, definition.up);
        mat4.transformDirection(sample.normal, this.linear, sample.normal);
        if (
          !Number.isFinite(sample.normal[0]) ||
          !Number.isFinite(sample.normal[1]) ||
          !Number.isFinite(sample.normal[2])
        )
          throw invalidPath('instance transform', 'Finite transformed initial up direction');
      } else {
        sample.normal.set(previousNormal);
        // At antiparallel tangents rotate around the previous normal: it stays
        // fixed and remains perpendicular; no arbitrary random rotation axis.
        if (vec3.dot(previousTangent, sample.tangent) > -0.999999) {
          quat.fromUnitVectors(sample.rotation, previousTangent, sample.tangent);
          quat.transformVec3(sample.normal, sample.rotation, sample.normal);
        }
      }
      projectNormal(sample.normal, sample.normal, sample.tangent);
      this.normals.set(sample.normal, i * 3);
      previousNormal.set(sample.normal);
      previousTangent.set(sample.tangent);
    }
    if (!(sum > 0)) throw invalidPath('points', 'A nonzero transformed path length');
    this.length = sum;
    if (definition.closed) {
      sample.normal.set(this.normals.subarray(0, 3));
      sample.right.set(this.normals.subarray((count - 1) * 3));
      sample.tangent.set(this.tangents.subarray(0, 3));
      vec3.cross(sample.local, sample.right, sample.normal);
      const correction = Math.atan2(
        vec3.dot(sample.tangent, sample.local),
        vec3.dot(sample.right, sample.normal),
      );
      for (let i = 0; i < count; i++) {
        sample.tangent.set(this.tangents.subarray(i * 3, i * 3 + 3));
        sample.normal.set(this.normals.subarray(i * 3, i * 3 + 3));
        quat.fromAxisAngle(
          sample.rotation,
          sample.tangent,
          (correction * (this.lengths[i] as number)) / sum,
        );
        quat.transformVec3(sample.normal, sample.rotation, sample.normal);
        this.normals.set(sample.normal, i * 3);
      }
    }
  }

  private point(out: PathSample, t: number): void {
    curve3.catmullRom(out.local, this.points, t, this.options);
    mat4.transformVec3(out.position, this.linear, out.local);
  }
  private tangent(out: PathSample, t: number): void {
    curve3.catmullRomTangent(out.local, this.points, t, this.options);
    mat4.transformDirection(out.tangent, this.linear, out.local);
    vec3.normalize(out.tangent, out.tangent);
  }

  /** The prepared curve's topology; derives from its immutable source options. */
  get closed(): boolean {
    return this.options.closed ?? false;
  }

  /** Position-only sampling for bounded geometry queries; no frame work or allocation. */
  positionAtDistance(out: Vec3, distance: number): Vec3 {
    curve3.catmullRom(out, this.points, this.parameterAtDistance(distance), this.options);
    return mat4.transformVec3(out, this.linear, out);
  }

  parameterAtDistance(distance: number): number {
    if (!Number.isFinite(distance)) throw invalidPath('distance', 'Finite world distance');
    if (distance <= 0) return 0;
    if (distance >= this.length) return 1;
    let low = 0,
      high = this.lengths.length - 1;
    while (low + 1 < high) {
      const mid = (low + high) >>> 1;
      if ((this.lengths[mid] as number) <= distance) low = mid;
      else high = mid;
    }
    const a = this.lengths[low] as number,
      b = this.lengths[high] as number;
    return (low + (b > a ? (distance - a) / (b - a) : 0)) / (this.lengths.length - 1);
  }

  /** Writes instance-linear coordinates; caller adds current world translation. */
  sample(
    out: PathSample,
    distance: number,
    direction = 1,
    forwardAxis = 4,
    upAxis = 2,
    roll = 0,
  ): PathSample {
    const t = this.parameterAtDistance(distance);
    this.point(out, t);
    this.tangent(out, t);
    const scaled = t * (this.lengths.length - 1),
      low = Math.min(this.lengths.length - 2, Math.floor(scaled)),
      fraction = scaled - low;
    if (vec3.length(out.tangent) === 0)
      for (let j = 0; j < 3; j++) out.tangent[j] = this.tangents[low * 3 + j] as number;
    for (let j = 0; j < 3; j++)
      out.normal[j] =
        (this.normals[low * 3 + j] as number) * (1 - fraction) +
        (this.normals[(low + 1) * 3 + j] as number) * fraction;
    orientSample(out, direction, forwardAxis, upAxis, roll);
    return out;
  }
}

export function preparePath(
  definition: PathDefinition,
  instance: Mat4 = mat4.identity(mat4.create()),
): Result<PreparedPath, PathError> {
  try {
    return ok(new PreparedPath(definition, instance));
  } catch (error) {
    return err(error as PathError);
  }
}

export function advancePathDistance(
  distance: number,
  speed: number,
  delta: number,
  length: number,
  loop: boolean,
): number {
  if (
    !Number.isFinite(distance) ||
    !Number.isFinite(speed) ||
    !Number.isFinite(delta) ||
    !Number.isFinite(length) ||
    delta < 0 ||
    !(length > 0) ||
    typeof loop !== 'boolean'
  )
    throw invalidPath(
      'distance step',
      'Finite distance/speed, nonnegative seconds and positive path length',
    );
  const next = distance + speed * delta;
  if (!Number.isFinite(next)) throw invalidPath('distance step', 'Finite travel distance');
  return loop ? ((next % length) + length) % length : Math.max(0, Math.min(length, next));
}
