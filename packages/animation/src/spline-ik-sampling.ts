import { type Quat, type Vec3, type Vec3Like, vec3 } from '@forgeax/engine-math';
import { createPathSample, type PreparedPath } from '@forgeax/engine-path';
import { SplineIKError } from './spline-ik-errors';

/** Distance-space queries use the existing prepared curve; scratch belongs to one chain. */
export class SplineCurveSampler {
  private readonly frame = createPathSample();
  private readonly point = vec3.create();
  private path!: PreparedPath;
  private direction = 1;
  private origin: Vec3Like = [0, 0, 0];
  private forward = 4;
  private up = 2;

  begin(
    path: PreparedPath,
    direction: number,
    origin: Vec3Like,
    forward: number,
    up: number,
  ): void {
    this.path = path;
    this.direction = direction;
    this.origin = origin;
    this.forward = forward;
    this.up = up;
  }

  private curveDistance(distance: number): number {
    const length = this.path.length;
    const d = this.path.closed
      ? ((distance % length) + length) % length
      : Math.min(length, distance);
    return this.direction < 0 ? length - d : d;
  }

  private position(out: Vec3, distance: number): void {
    this.path.positionAtDistance(out, this.curveDistance(distance));
    if (!this.path.closed && distance > this.path.length) {
      this.path.sample(
        this.frame,
        this.curveDistance(distance),
        this.direction,
        this.forward,
        this.up,
      );
      for (let i = 0; i < 3; i++)
        out[i] =
          (out[i] as number) + (distance - this.path.length) * (this.frame.tangent[i] as number);
    }
    for (let i = 0; i < 3; i++) out[i] = (out[i] as number) + (this.origin[i] as number);
  }

  sample(position: Vec3, rotation: Quat, distance: number, twist: number): void {
    this.path.sample(
      this.frame,
      this.curveDistance(distance),
      this.direction,
      this.forward,
      this.up,
      twist,
    );
    position.set(this.frame.position);
    if (!this.path.closed && distance > this.path.length)
      for (let i = 0; i < 3; i++)
        position[i] =
          (position[i] as number) +
          (distance - this.path.length) * (this.frame.tangent[i] as number);
    for (let i = 0; i < 3; i++) position[i] = (position[i] as number) + (this.origin[i] as number);
    rotation.set(this.frame.rotation);
  }

  /** First forward chord crossing, bounded scan + 24 bisections. Open ends extend.
   * A closed curve entirely inside the segment sphere has no solution and rejects.
   */
  next(origin: Vec3, start: number, radius: number): number {
    const end = start + (this.path.closed ? this.path.length : this.path.length + radius * 2);
    const step = Math.min(radius / 4, this.path.length / 64);
    let low = start,
      high = Math.min(start + radius, end);
    let found = false;
    for (let i = 0; i < 4096; i++) {
      this.position(this.point, high);
      if (vec3.distance(this.point, origin) >= radius) {
        found = true;
        break;
      }
      if (high >= end) break;
      low = high;
      high = Math.min(end, high + step);
    }
    if (!found)
      throw new SplineIKError('spline-ik-length-unreachable', {
        reason: 'no chord intersection within one closed lap or bounded scan',
      });
    for (let i = 0; i < 24; i++) {
      const middle = (low + high) / 2;
      this.position(this.point, middle);
      if (vec3.distance(this.point, origin) >= radius) high = middle;
      else low = middle;
    }
    return (low + high) / 2;
  }
}
