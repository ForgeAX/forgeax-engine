import type { DerivedShapeInput } from '@forgeax/engine-physics';
import type { ColliderDesc, RigidBody, Shape, World } from '../pkg/rapier.mjs';
import type {
  DerivedBodyRecord,
  DerivedCandidateRecord,
  DerivedShapeRecord,
} from './derived-candidate-records.js';
import { derivedShapeHandles } from './derived-candidate-records.js';
import { spatialCompoundGroups } from './spatial-compound-groups.js';
import { voxelRegionDelta } from './voxel-region-delta.js';
import type { Rapier3DModule } from './wasm-loader.js';

const boxTriangles = [
  0, 4, 6, 6, 2, 0, 1, 3, 7, 7, 5, 1, 0, 1, 5, 5, 4, 0, 2, 6, 7, 7, 3, 2, 0, 2, 3, 3, 1, 0, 4, 5, 7,
  7, 6, 4,
] as const;
type CartesianBox = { center: number[]; half: number[] } | { indices: Uint32Array };

/** Compare detached normalized inputs before borrowing an existing collider.
 * Producer revisions alone cannot authorize reuse of mutable caller geometry. */
function sameDerivedCollider(a: DerivedShapeInput, b: DerivedShapeInput): boolean {
  const same = (x: ArrayLike<number> | undefined, y: ArrayLike<number> | undefined) => {
    if (x === undefined || y === undefined) return x === y;
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  };
  if (
    a.id !== b.id ||
    a.kind !== b.kind ||
    !same(a.origin, b.origin) ||
    !same(a.rotation, b.rotation) ||
    a.friction !== b.friction ||
    a.restitution !== b.restitution ||
    a.density !== b.density ||
    a.isSensor !== b.isSensor ||
    a.collisionGroups !== b.collisionGroups ||
    a.solverGroups !== b.solverGroups
  )
    return false;
  if (a.kind === 'voxels' && b.kind === 'voxels')
    return same(a.voxelSize, b.voxelSize) && same(a.regions, b.regions);
  if (a.kind === 'heightfield' && b.kind === 'heightfield')
    return (
      a.rows === b.rows &&
      a.columns === b.columns &&
      same(a.scale, b.scale) &&
      same(a.heights, b.heights)
    );
  return (
    a.kind === 'convex-compound' &&
    b.kind === 'convex-compound' &&
    a.nativeLayout === b.nativeLayout &&
    a.pieces.length === b.pieces.length &&
    a.pieces.every((piece, i) => same(piece, b.pieces[i]))
  );
}

/** Borrow equal committed shapes; only new disabled colliders belong to the
 * candidate's cancellation path. No committed native state changes here. */
export function stageDerivedColliders(
  inputs: readonly DerivedShapeInput[],
  owner: DerivedBodyRecord | undefined,
  create: (
    shape: DerivedShapeInput,
    previous?: DerivedShapeRecord,
  ) => { readonly handle: number; readonly colliderHandles?: readonly number[] },
  current: (handle: number) => boolean,
  remove: (handle: number) => void,
): Pick<DerivedCandidateRecord, 'nativeColliders' | 'sharedGeometry' | 'stagedShapes'> {
  const previous = new Map(owner?.shapes.map((shape) => [shape.input.id, shape]));
  const nativeColliders: { handle: number }[] = [],
    shapes: DerivedShapeRecord[] = [];
  let shared = false;
  try {
    for (const input of inputs) {
      const old = previous.get(input.id);
      if (old && sameDerivedCollider(old.input, input) && derivedShapeHandles(old).every(current)) {
        shapes.push({
          input: input as DerivedShapeRecord['input'],
          colliderHandle: old.colliderHandle,
          ...(old.colliderHandles === undefined ? {} : { colliderHandles: old.colliderHandles }),
        });
        shared = true;
      } else {
        const created = create(
          input,
          old && derivedShapeHandles(old).every(current) ? old : undefined,
        );
        for (const handle of created.colliderHandles ?? [created.handle])
          nativeColliders.push({ handle });
        shapes.push({
          input: input as DerivedShapeRecord['input'],
          colliderHandle: created.handle,
          ...(created.colliderHandles === undefined
            ? {}
            : { colliderHandles: created.colliderHandles }),
        });
      }
    }
    return {
      nativeColliders,
      stagedShapes: shapes,
      ...(shared && owner !== undefined ? { sharedGeometry: { owner, shapes } } : {}),
    };
  } catch (error) {
    for (const collider of nativeColliders) remove(collider.handle);
    throw error;
  }
}

/** Native copies retain the committed source until ordinary candidate admission.
 * Only bounded edits use this route; large changes keep complete construction. */
export function createDerivedCollider(
  RAPIER: Rapier3DModule,
  world: World,
  body: RigidBody,
  shape: DerivedShapeInput,
  previous?: DerivedShapeRecord,
) {
  const desc = createDerivedColliderDesc(RAPIER, shape);
  if (shape.kind === 'voxels' && previous?.input.kind === 'voxels') {
    const source = world.getCollider(previous.colliderHandle);
    const delta = source && voxelRegionDelta(previous.input, shape);
    if (delta)
      return world.createColliderFromVoxelEdits(desc, source, delta.removed, delta.added, body);
  }
  const collider = world.createCollider(desc, body);
  // The native collider and our normalized input own geometry and recovery.
  // Rapier can reconstruct its optional JS shape on a later public read.
  collider.clearShapeCache();
  return collider;
}

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
  if (shape.kind === 'voxels') {
    geometry = RAPIER.ColliderDesc.voxelRegions(shape.regions, {
      x: shape.voxelSize[0],
      y: shape.voxelSize[1],
      z: shape.voxelSize[2],
    });
  } else if (shape.kind === 'heightfield') {
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
    .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL)
    .setEnabled(false);
  if (shape.isSensor === true) desc.setSensor(true);
  return desc;
}

/** Build the complete disabled roster before returning it to the transaction owner.
 * An exception removes every newly allocated group; the previous publication is untouched. */
export function createDerivedColliderGroup(
  RAPIER: Rapier3DModule,
  world: World,
  body: RigidBody,
  shape: DerivedShapeInput,
  previous: DerivedShapeRecord | undefined,
  allowGroups: boolean,
) {
  const groups =
    allowGroups && shape.kind === 'convex-compound' && shape.nativeLayout === 'spatial-groups-16'
      ? spatialCompoundGroups(shape.pieces)
      : undefined;
  if (groups === undefined)
    return { colliders: [createDerivedCollider(RAPIER, world, body, shape, previous)] };
  const colliders: ReturnType<typeof createDerivedCollider>[] = [];
  try {
    for (const pieces of groups)
      colliders.push(
        createDerivedCollider(RAPIER, world, body, { ...shape, kind: 'convex-compound', pieces }),
      );
    return { colliders };
  } catch (error) {
    for (const collider of colliders) world.removeCollider(collider, false);
    throw error;
  }
}
