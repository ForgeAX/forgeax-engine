import { mat4, quat, type Vec3, vec3 } from '@forgeax/engine-math';
import type { SpringBoneChain } from './skeletal-motion-definition';
import type { SkeletonPose } from './skeleton-pose';

interface SpringSegment {
  readonly joint: number;
  readonly tail: number;
  readonly point: Vec3;
  readonly velocity: Vec3;
}

/** Retained simulation state; the shared pose remains scratch, not skeleton authority. */
export class SpringBoneSimulation {
  readonly segments: SpringSegment[];
  weight = 1;
  needsReset = true;
  maxLengthError = 0;
  maxPenetration = 0;
  private readonly origin = vec3.create();
  private readonly target = vec3.create();
  private readonly direction = vec3.create();
  private readonly restDirection = vec3.create();
  private readonly oldPoint = vec3.create();
  private readonly center = vec3.create();
  private readonly offset = vec3.create();
  private readonly tangent = vec3.create();
  private readonly swing = quat.create();
  private readonly global = quat.create();
  private readonly inverse = quat.create();
  private readonly identity = quat.create();
  private readonly translationOrigin = vec3.create();
  private readonly collisionSpheres: Float64Array;

  constructor(
    readonly definition: SpringBoneChain,
    indices: readonly number[],
    readonly collisionIndices: readonly number[],
  ) {
    // Per-segment derived inputs, refreshed after each preceding joint commit.
    // Centers retain transformPoint's Float32 rounding; radii retain Float64.
    this.collisionSpheres = new Float64Array(collisionIndices.length * 4);
    this.segments = indices.slice(0, -1).map((joint, index) => ({
      joint,
      tail: indices[index + 1] as number,
      point: vec3.create(),
      velocity: vec3.create(),
    }));
  }

  /** Only invoked by World FixedUpdate. No accumulated host clock or substeps. */
  step(pose: SkeletonPose, dt: number): void {
    const anchor = pose.matrices[(this.segments[0] as SpringSegment).joint] as Float32Array;
    const x = anchor[12] as number;
    const y = anchor[13] as number;
    const z = anchor[14] as number;
    if (!this.needsReset) {
      for (let segmentIndex = 0; segmentIndex < this.segments.length; segmentIndex++) {
        const segment = this.segments[segmentIndex] as SpringSegment;
        segment.point[0] =
          (segment.point[0] as number) + ((this.translationOrigin[0] as number) - x);
        segment.point[1] =
          (segment.point[1] as number) + ((this.translationOrigin[1] as number) - y);
        segment.point[2] =
          (segment.point[2] as number) + ((this.translationOrigin[2] as number) - z);
      }
    }
    vec3.set(this.translationOrigin, x, y, z);
    try {
      pose.update(0, undefined, this.translationOrigin);
      this.stepRelative(pose, dt);
    } finally {
      // Restore the sole scratch pose's ordinary world frame before its owner commits.
      pose.update(0);
    }
  }

  private stepRelative(pose: SkeletonPose, dt: number): void {
    this.maxLengthError = 0;
    this.maxPenetration = 0;
    const def = this.definition;
    for (let segmentIndex = 0; segmentIndex < this.segments.length; segmentIndex++) {
      const segment = this.segments[segmentIndex] as SpringSegment;
      const matrix = pose.matrices[segment.joint] as Float32Array;
      vec3.set(this.origin, matrix[12] as number, matrix[13] as number, matrix[14] as number);
      mat4.transformPoint(
        this.target,
        matrix,
        pose.positions[segment.tail] as (typeof pose.positions)[number],
      );
      vec3.sub(this.restDirection, this.target, this.origin);
      const length = vec3.length(this.restDirection);
      vec3.normalize(this.restDirection, this.restDirection);
      if (this.needsReset || this.weight === 0) {
        segment.point.set(this.target);
        segment.velocity.fill(0);
      }
      this.oldPoint.set(segment.point);
      if (dt > 0 && this.weight > 0 && !this.needsReset) {
        // Implicit Euler attraction and damping are stable at high authored stiffness.
        const denominator = 1 + def.damping * dt + def.stiffness * dt * dt;
        for (let axis = 0; axis < 3; axis++) {
          segment.velocity[axis] =
            ((segment.velocity[axis] as number) +
              dt *
                ((def.gravity[axis] as number) +
                  def.stiffness *
                    ((this.target[axis] as number) - (segment.point[axis] as number)))) /
            denominator;
          segment.point[axis] =
            (segment.point[axis] as number) + dt * (segment.velocity[axis] as number);
        }
      }
      this.constrain(segment.point, length, def.maxAngle);
      if (def.collisions !== undefined && def.collisions.length > 0) {
        // The bone matrix stays fixed until the rotation commit below.
        const boneScale = Math.hypot(matrix[0] as number, matrix[1] as number, matrix[2] as number);
        for (let index = 0; index < def.collisions.length; index++) {
          const collision = def.collisions[index] as (typeof def.collisions)[number];
          const collisionMatrix = pose.matrices[
            this.collisionIndices[index] as number
          ] as Float32Array;
          mat4.transformPoint(this.center, collisionMatrix, collision.center);
          const scale = Math.hypot(
            collisionMatrix[0] as number,
            collisionMatrix[1] as number,
            collisionMatrix[2] as number,
          );
          const offset = index * 4;
          this.collisionSpheres[offset] = this.center[0] as number;
          this.collisionSpheres[offset + 1] = this.center[1] as number;
          this.collisionSpheres[offset + 2] = this.center[2] as number;
          this.collisionSpheres[offset + 3] = collision.radius * scale + def.radius * boneScale;
        }
        for (let iteration = 0; iteration < (def.iterations ?? 8); iteration++) {
          for (let index = 0; index < def.collisions.length; index++) {
            const offset = index * 4;
            vec3.set(
              this.center,
              this.collisionSpheres[offset] as number,
              this.collisionSpheres[offset + 1] as number,
              this.collisionSpheres[offset + 2] as number,
            );
            const radius = this.collisionSpheres[offset + 3] as number;
            if (vec3.distance(segment.point, this.center) >= radius) continue;
            this.contact(segment.point, length, radius);
            this.constrain(segment.point, length, def.maxAngle);
          }
        }
      }
      if (dt > 0 && !this.needsReset) {
        vec3.sub(segment.velocity, segment.point, this.oldPoint);
        vec3.scale(segment.velocity, segment.velocity, 1 / dt);
        // Remove radial velocity introduced by moving length constraints.
        vec3.sub(this.direction, segment.point, this.origin);
        vec3.normalize(this.direction, this.direction);
        vec3.scale(this.offset, this.direction, vec3.dot(segment.velocity, this.direction));
        vec3.sub(segment.velocity, segment.velocity, this.offset);
      }
      if (this.weight > 0) {
        vec3.sub(this.direction, segment.point, this.origin);
        vec3.normalize(this.direction, this.direction);
        quat.fromUnitVectors(this.swing, this.restDirection, this.direction);
        quat.slerp(this.swing, this.identity, this.swing, this.weight);
        quat.multiply(
          this.global,
          this.swing,
          pose.globalRotations[segment.joint] as (typeof pose.globalRotations)[number],
        );
        const parent = pose.parents[segment.joint] as number;
        if (parent >= 0) {
          quat.invert(
            this.inverse,
            pose.globalRotations[parent] as (typeof pose.globalRotations)[number],
          );
          quat.multiply(
            pose.rotations[segment.joint] as (typeof pose.rotations)[number],
            this.inverse,
            this.global,
          );
        } else (pose.rotations[segment.joint] as (typeof pose.rotations)[number]).set(this.global);
        quat.normalize(
          pose.rotations[segment.joint] as (typeof pose.rotations)[number],
          pose.rotations[segment.joint] as (typeof pose.rotations)[number],
        );
        // Only descendant contacts change with this joint; unrelated contacts
        // retain the current pose read at entry or refreshed by an earlier joint.
        let end = segment.tail + 1;
        for (let index = 0; index < this.collisionIndices.length; index++) {
          const contact = this.collisionIndices[index] as number;
          let ancestor = contact;
          while (ancestor > segment.joint) ancestor = pose.parents[ancestor] as number;
          if (ancestor === segment.joint) end = Math.max(end, contact + 1);
        }
        pose.update(segment.joint, end, this.translationOrigin);
      }
      mat4.transformPoint(
        this.target,
        pose.matrices[segment.joint] as Float32Array,
        pose.positions[segment.tail] as (typeof pose.positions)[number],
      );
      this.maxLengthError = Math.max(
        this.maxLengthError,
        Math.abs(vec3.distance(this.origin, this.target) - length),
      );
      if (def.collisions !== undefined)
        for (let index = 0; index < def.collisions.length; index++) {
          const collision = def.collisions[index] as (typeof def.collisions)[number];
          const m = pose.matrices[this.collisionIndices[index] as number] as Float32Array;
          mat4.transformPoint(this.center, m, collision.center);
          const radius =
            collision.radius * Math.hypot(m[0] as number, m[1] as number, m[2] as number) +
            def.radius * Math.hypot(matrix[0] as number, matrix[1] as number, matrix[2] as number);
          this.maxPenetration = Math.max(
            this.maxPenetration,
            radius - vec3.distance(this.target, this.center),
          );
        }
    }
    this.needsReset = false;
  }

  /** Project onto the bone-length sphere outside the collision sphere, including axial contact. */
  private contact(point: Vec3, length: number, radius: number): void {
    vec3.sub(this.offset, this.center, this.origin);
    const distance = vec3.length(this.offset);
    if (distance < 1e-8) return; // Concentric impossible contact is measured, never iterated forever.
    vec3.scale(this.offset, this.offset, 1 / distance);
    vec3.sub(this.direction, point, this.origin);
    vec3.normalize(this.direction, this.direction);
    const along = vec3.dot(this.direction, this.offset);
    vec3.scale(this.tangent, this.offset, along);
    vec3.sub(this.tangent, this.direction, this.tangent);
    if (vec3.lengthSq(this.tangent) < 1e-12) {
      // A deterministic tangent when the two centers and endpoint are collinear.
      const axis = Math.abs(this.offset[0] as number) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      vec3.cross(this.tangent, this.offset, axis);
    }
    vec3.normalize(this.tangent, this.tangent);
    const cosine = Math.max(
      -1,
      Math.min(
        1,
        (length * length + distance * distance - radius * radius) / (2 * length * distance),
      ),
    );
    const sine = Math.sqrt(Math.max(0, 1 - cosine * cosine));
    for (let axis = 0; axis < 3; axis++)
      point[axis] =
        (this.origin[axis] as number) +
        length * (cosine * (this.offset[axis] as number) + sine * (this.tangent[axis] as number));
  }

  private constrain(point: Vec3, length: number, maxAngle: number): void {
    vec3.sub(this.direction, point, this.origin);
    if (vec3.lengthSq(this.direction) < 1e-16) this.direction.set(this.restDirection);
    vec3.normalize(this.direction, this.direction);
    const angle = Math.acos(
      Math.max(-1, Math.min(1, vec3.dot(this.direction, this.restDirection))),
    );
    if (angle > maxAngle) {
      vec3.scale(this.tangent, this.restDirection, vec3.dot(this.direction, this.restDirection));
      vec3.sub(this.tangent, this.direction, this.tangent);
      if (vec3.lengthSq(this.tangent) < 1e-12) {
        const axis = Math.abs(this.restDirection[0] as number) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        vec3.cross(this.tangent, this.restDirection, axis);
      }
      vec3.normalize(this.tangent, this.tangent);
      const cosine = Math.cos(maxAngle),
        sine = Math.sin(maxAngle);
      for (let axis = 0; axis < 3; axis++)
        this.direction[axis] =
          cosine * (this.restDirection[axis] as number) + sine * (this.tangent[axis] as number);
    }
    vec3.scale(this.direction, this.direction, length);
    vec3.add(point, this.origin, this.direction);
  }
}
