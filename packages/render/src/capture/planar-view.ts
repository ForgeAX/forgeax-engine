import { mat4, vec3 } from '@forgeax/engine-math';
import { PlanarReflectionInvalidError } from '../components/planar-reflection';

export interface PlanarReflectionViewInput {
  readonly world: Float32Array;
  readonly projection: Float32Array;
  readonly plane: ArrayLike<number>;
  /** World-space offset into the retained half space. */
  readonly clipBias: number;
}

/** Three Reflector's reflected eye/forward/up, with a WebGPU [0,1] oblique near plane. */
export function buildPlanarReflectionView(input: PlanarReflectionViewInput) {
  const p = Array.from(input.plane);
  const length = Math.hypot(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0);
  if (p.length !== 4 || !p.every(Number.isFinite) || length < 1e-8)
    throw new PlanarReflectionInvalidError('plane');
  if (!Number.isFinite(input.clipBias) || input.clipBias < 0)
    throw new PlanarReflectionInvalidError('clipBias');
  if (
    input.world.length !== 16 ||
    input.projection.length !== 16 ||
    !Array.from(input.world).every(Number.isFinite) ||
    !Array.from(input.projection).every(Number.isFinite)
  )
    throw new PlanarReflectionInvalidError('camera');
  const plane = p.map((v) => v / length);
  const normal = plane.slice(0, 3);
  const eye = Array.from(input.world.slice(12, 15));
  const dot = (a: ArrayLike<number>, b: ArrayLike<number>) =>
    (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
  const distance = dot(normal, eye) + (plane[3] ?? 0);
  if (distance <= 1e-6) return undefined;
  const reflectDirection = (v: number[]) =>
    v.map((x, i) => x - 2 * dot(normal, v) * (normal[i] ?? 0));
  const position = vec3.create(
    ...(eye.map((v, i) => v - 2 * distance * (normal[i] ?? 0)) as [number, number, number]),
  );
  const forward = reflectDirection([
    -(input.world[8] ?? 0),
    -(input.world[9] ?? 0),
    -(input.world[10] ?? 0),
  ]);
  const up = reflectDirection(Array.from(input.world.slice(4, 7)));
  const target = position.map((v, i) => v + (forward[i] ?? 0));
  const view = mat4.lookAt(mat4.create(), position, target, up);
  const world = mat4.invert(mat4.create(), view);
  const projection = mat4.create();
  projection.set(input.projection);
  const inverse = mat4.invert(mat4.create(), projection);
  // Covectors transform by transpose(cameraWorld). Bias is measured in world meters.
  const biasedPlane = [...normal, (plane[3] ?? 0) - input.clipBias];
  const clip = [0, 1, 2, 3].map((column) =>
    biasedPlane.reduce((sum, v, row) => sum + v * (world[column * 4 + row] ?? 0), 0),
  );
  const corner = [Math.sign(clip[0] ?? 0) || 1, Math.sign(clip[1] ?? 0) || 1, 0, 1];
  const q = [0, 1, 2, 3].map((row) =>
    corner.reduce((sum, v, col) => sum + v * (inverse[col * 4 + row] ?? 0), 0),
  );
  const denominator = clip.reduce((sum, v, i) => sum + v * (q[i] ?? 0), 0);
  if (!Number.isFinite(denominator)) throw new PlanarReflectionInvalidError('clipPlane');
  // No reflected ray reaches the retained half space (for example looking
  // upward away from water). This is an invisible capture, not invalid input.
  if (denominator <= 1e-8) return undefined;
  // Reverse-Z near plane is w - z = 0; the opposite corner lies at z = 0.
  for (let i = 0; i < 4; i++)
    projection[i * 4 + 2] = (projection[i * 4 + 3] ?? 0) - (clip[i] ?? 0) / denominator;
  const viewProjection = mat4.multiply(mat4.create(), projection, view);
  return { position, world, view, projection, viewProjection, plane };
}
