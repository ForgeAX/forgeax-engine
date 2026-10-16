import type { DerivedShapeInput } from '@forgeax/engine-physics';
import type { ColliderDesc, Shape } from '../pkg/rapier.mjs';
import type { Rapier3DModule } from './wasm-loader.js';

const boxTriangles = [
  0, 4, 6, 6, 2, 0, 1, 3, 7, 7, 5, 1, 0, 1, 5, 5, 4, 0, 2, 6, 7, 7, 3, 2, 0, 2, 3, 3, 1, 0, 4, 5, 7,
  7, 6, 4,
] as const;
type CartesianBox = { center: number[]; half: number[] } | { indices: Uint32Array };

/** Recognize complete boxes only, without snapping or expanding any input corner. */
function cartesianBox(vertices: Float32Array): CartesianBox | undefined {
  if (vertices.length !== 24) return undefined;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i++) {
    const value = vertices[i] as number;
    if (!Number.isFinite(value)) return undefined;
    const axis = i % 3;
    min[axis] = Math.min(min[axis] as number, value);
    max[axis] = Math.max(max[axis] as number, value);
  }
  let corners = 0;
  for (let i = 0; i < vertices.length; i += 3) {
    let corner = 0;
    for (let axis = 0; axis < 3; axis++) {
      const value = vertices[i + axis];
      if (value === max[axis]) corner |= 1 << axis;
      else if (value !== min[axis]) return undefined;
    }
    corners |= 1 << corner;
  }
  if (corners !== 255) return undefined;
  const center = min.map((value, axis) => value / 2 + (max[axis] as number) / 2);
  const half = min.map((value, axis) => (max[axis] as number) / 2 - value / 2);
  // Rapier stores primitive dimensions and offsets as f32. Some f32 endpoint
  // pairs cannot be represented exactly by a center/half pair; retain their points.
  for (let axis = 0; axis < 3; axis++) {
    const c = center[axis] as number,
      h = half[axis] as number;
    if (
      h <= 0 ||
      Math.fround(c) !== c ||
      Math.fround(h) !== h ||
      c - h !== min[axis] ||
      c + h !== max[axis]
    ) {
      // Keep the original hull's numerical treatment of ill-conditioned boxes.
      // This limits only the fast path; primitive eligibility is unchanged.
      const spans = half.map((value) => value * 2);
      const smallest = Math.min(...spans),
        largest = Math.max(...spans);
      if (
        smallest < largest * 1e-4 ||
        Math.max(...min.map(Math.abs), ...max.map(Math.abs)) > smallest * 65536 ||
        Math.fround(smallest ** 3) === 0 ||
        !Number.isFinite(Math.fround(largest ** 3))
      )
        return undefined;
      // All eight distinct Cartesian corners already proved convexity above.
      // Keep their exact f32 coordinates when center/half cannot represent them:
      // the supplied outward surface avoids rebuilding the same convex hull.
      const byCorner = new Uint8Array(8);
      for (let vertex = 0; vertex < 8; vertex++) {
        let corner = 0;
        for (let component = 0; component < 3; component++)
          if (vertices[vertex * 3 + component] === max[component]) corner |= 1 << component;
        byCorner[corner] = vertex;
      }
      const indices = new Uint32Array(boxTriangles.length);
      boxTriangles.forEach((corner, triangle) => {
        indices[triangle] = byCorner[corner] as number;
      });
      return { indices };
    }
  }
  return { center, half };
}

/** Native descriptors consume ordinary geometry; producers own decomposition. */
export function createDerivedColliderDesc(
  RAPIER: Rapier3DModule,
  shape: DerivedShapeInput,
): ColliderDesc {
  let geometry: ColliderDesc;
  if (shape.kind === 'heightfield') {
    geometry = RAPIER.ColliderDesc.heightfield(
      shape.rows,
      shape.columns,
      new Float32Array(shape.heights),
      { x: shape.scale[0], y: shape.scale[1], z: shape.scale[2] },
    );
  } else {
    const positions: { x: number; y: number; z: number }[] = [];
    const parts: Shape[] = shape.pieces.map((vertices) => {
      const box = cartesianBox(vertices);
      const primitive = box !== undefined && 'center' in box ? box : undefined;
      positions.push(
        primitive
          ? {
              x: primitive.center[0] as number,
              y: primitive.center[1] as number,
              z: primitive.center[2] as number,
            }
          : { x: 0, y: 0, z: 0 },
      );
      return primitive
        ? new RAPIER.Cuboid(primitive.half[0], primitive.half[1], primitive.half[2])
        : new RAPIER.ConvexPolyhedron(
            vertices,
            box !== undefined && 'indices' in box ? box.indices : undefined,
          );
    });
    // Keep primitive recentering inside the shape. Moving the collider frame
    // changes an empty body's native COM even while density is zero/disabled.
    const centered =
      parts.length === 1 && positions[0]?.x === 0 && positions[0]?.y === 0 && positions[0]?.z === 0;
    geometry = centered
      ? new RAPIER.ColliderDesc(parts[0])
      : RAPIER.ColliderDesc.compound(
          parts,
          positions,
          parts.map(() => ({ x: 0, y: 0, z: 0, w: 1 })),
        );
  }
  const desc = geometry
    .setTranslation(shape.origin?.[0] ?? 0, shape.origin?.[1] ?? 0, shape.origin?.[2] ?? 0)
    .setRotation({
      x: shape.rotation?.[0] ?? 0,
      y: shape.rotation?.[1] ?? 0,
      z: shape.rotation?.[2] ?? 0,
      w: shape.rotation?.[3] ?? 1,
    })
    .setFriction(shape.friction ?? 0.5)
    .setRestitution(shape.restitution ?? 0)
    // Disabled colliders still contribute native mass. Staging must be
    // massless; admission assigns density only to its committed shape set.
    .setDensity(0)
    .setCollisionGroups(shape.collisionGroups ?? 0xffffffff)
    .setSolverGroups(shape.solverGroups ?? 0xffffffff)
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
    .setActiveHooks(
      RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS | RAPIER.ActiveHooks.FILTER_INTERSECTION_PAIRS,
    )
    .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL)
    .setEnabled(false);
  if (shape.isSensor === true) desc.setSensor(true);
  return desc;
}
