import { quat, vec3 } from '@forgeax/engine-math';
import {
  finitePhysicsVector,
  type PhysicsBodyObbQuery,
  type PhysicsColliderPrimitive,
  type PhysicsColliderPrimitives,
  type PhysicsVector,
  unitPhysicsQuaternion,
} from '@forgeax/engine-physics';
import type {
  Ball,
  Capsule,
  Collider,
  Compound,
  ConvexPolyhedron,
  Cuboid,
  Cylinder,
  RigidBody,
  Rotation,
  RoundCuboid,
  Shape,
  ShapeType,
  Vector,
} from '../pkg/rapier.mjs';
import type { Rapier3DModule } from './wasm-loader.js';

type Geometry = Pick<
  PhysicsColliderPrimitives['elements'][number],
  'positionM' | 'rotation' | 'shape' | 'elementIndex'
>;
type ShapeBounds = Readonly<{ shape: PhysicsColliderPrimitive; center: PhysicsVector }>;
const ZERO = Object.freeze([0, 0, 0]) as PhysicsVector;
const tuple = (v: Vector): PhysicsVector => Object.freeze([v.x, v.y, v.z]);
const rotationTuple = (q: Rotation) =>
  Object.freeze([q.x, q.y, q.z, q.w]) as readonly [number, number, number, number];

/** Complex surface geometry is not a member of the simple aggregate. */
function aggregateShape(type: ShapeType, types: typeof ShapeType): boolean {
  return [
    types.Ball,
    types.Cuboid,
    types.Capsule,
    types.ConvexPolyhedron,
    types.Cylinder,
    types.Cone,
    types.RoundCuboid,
    types.RoundCylinder,
    types.RoundCone,
    types.RoundConvexPolyhedron,
  ].includes(type);
}

function aggregateParts(collider: Collider, types: typeof ShapeType) {
  const type = collider.shapeType();
  if (type !== types.Compound && !aggregateShape(type, types)) return [];
  if (type === types.ConvexPolyhedron || type === types.RoundConvexPolyhedron)
    return [
      {
        bounds: convexBounds(
          collider.vertices(),
          type === types.RoundConvexPolyhedron ? collider.roundRadius() : 0,
        ),
        index: 0,
        position: ZERO,
        rotation: [0, 0, 0, 1] as const,
      },
    ];
  // Dimension edits update native geometry without invalidating Rapier's JS shape cache.
  collider.clearShapeCache();
  const root = collider.shape;
  if (type !== types.Compound)
    return [
      {
        bounds: primitiveBounds(root, types),
        index: 0,
        position: ZERO,
        rotation: [0, 0, 0, 1] as const,
      },
    ];
  const compound = root as Compound;
  return compound.shapes.flatMap((shape, index) => {
    if (!aggregateShape(shape.type, types)) return [];
    const position = compound.positions[index],
      rotation = compound.rotations[index];
    if (position === undefined || rotation === undefined)
      throw new Error('Rapier compound child geometry requires its matching native pose');
    return [
      {
        bounds: primitiveBounds(shape, types),
        index,
        position: tuple(position),
        rotation: rotationTuple(rotation),
      },
    ];
  });
}

export function aggregateColliderCount(collider: Collider, types: typeof ShapeType): number {
  const type = collider.shapeType();
  if (type !== types.Compound) return aggregateShape(type, types) ? 1 : 0;
  collider.clearShapeCache();
  return (collider.shape as Compound).shapes.reduce(
    (count, shape) => count + (aggregateShape(shape.type, types) ? 1 : 0),
    0,
  );
}

export function validBodyObbQuery(input: PhysicsBodyObbQuery): boolean {
  const bounds = input.emptyAggregateLocalBounds;
  const extents = (v: PhysicsVector) => finitePhysicsVector(v, 3) && v.every((value) => value >= 0);
  return (
    finitePhysicsVector(input.positionM, 3) &&
    unitPhysicsQuaternion(input.rotation) &&
    extents(input.fullExtentsM) &&
    (bounds === undefined ||
      (finitePhysicsVector(bounds.centerM, 3) && extents(bounds.halfExtentsM)))
  );
}

/** Uses native shape intersection, including exact zero-thickness query cuboids. */
export function intersectsBodyObb(
  module: Rapier3DModule,
  body: RigidBody,
  colliders: readonly Collider[],
  scale: PhysicsVector,
  input: PhysicsBodyObbQuery,
): boolean {
  if (!body.isEnabled()) return false;
  const query = new module.Cuboid(
    input.fullExtentsM[0] / 2,
    input.fullExtentsM[1] / 2,
    input.fullExtentsM[2] / 2,
  );
  const position = { x: input.positionM[0], y: input.positionM[1], z: input.positionM[2] };
  const rotation = {
    x: input.rotation[0],
    y: input.rotation[1],
    z: input.rotation[2],
    w: input.rotation[3],
  };
  if (colliders.some((collider) => aggregateColliderCount(collider, module.ShapeType) > 0))
    return colliders.some(
      (collider) => collider.isEnabled() && collider.intersectsShape(query, position, rotation),
    );
  const bounds = input.emptyAggregateLocalBounds;
  if (bounds === undefined) return false;
  const bodyRotation = body.rotation();
  const center = quat.transformVec3(vec3.create(), rotationTuple(bodyRotation), [
    bounds.centerM[0] * scale[0],
    bounds.centerM[1] * scale[1],
    bounds.centerM[2] * scale[2],
  ]);
  const [centerX, centerY, centerZ] = center;
  if (centerX === undefined || centerY === undefined || centerZ === undefined)
    throw new Error('A transformed body bounds center requires three components');
  const bodyPosition = body.translation();
  return new module.Cuboid(
    bounds.halfExtentsM[0] * scale[0],
    bounds.halfExtentsM[1] * scale[1],
    bounds.halfExtentsM[2] * scale[2],
  ).intersectsShape(
    {
      x: bodyPosition.x + centerX,
      y: bodyPosition.y + centerY,
      z: bodyPosition.z + centerZ,
    },
    bodyRotation,
    query,
    position,
    rotation,
  );
}

function convexBounds(points: Float32Array, borderRadius = 0): ShapeBounds | undefined {
  if (points.length < 3 || points.length % 3 !== 0) return undefined;
  const low: [number, number, number] = [Infinity, Infinity, Infinity],
    high: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const [index, value] of points.entries()) {
    const axis = index % 3 === 0 ? 0 : index % 3 === 1 ? 1 : 2;
    low[axis] = Math.min(low[axis], value);
    high[axis] = Math.max(high[axis], value);
  }
  return {
    center: [(low[0] + high[0]) / 2, (low[1] + high[1]) / 2, (low[2] + high[2]) / 2],
    shape: {
      kind: 'box',
      representation: 'bounds',
      halfExtentsM: [
        (high[0] - low[0]) / 2 + borderRadius,
        (high[1] - low[1]) / 2 + borderRadius,
        (high[2] - low[2]) / 2 + borderRadius,
      ],
    },
  };
}

function primitiveBounds(source: Shape, types: typeof ShapeType): ShapeBounds | undefined {
  if (source.type === types.Ball)
    return { center: ZERO, shape: { kind: 'sphere', radiusM: (source as Ball).radius } };
  if (source.type === types.Capsule) {
    const capsule = source as Capsule;
    return {
      center: ZERO,
      shape: { kind: 'capsule', radiusM: capsule.radius, halfHeightM: capsule.halfHeight },
    };
  }
  if (source.type === types.Cuboid)
    return {
      center: ZERO,
      shape: {
        kind: 'box',
        halfExtentsM: tuple((source as Cuboid).halfExtents),
        representation: 'native',
      },
    };
  if (source.type === types.RoundCuboid) {
    const box = source as RoundCuboid;
    return {
      center: ZERO,
      shape: {
        kind: 'box',
        halfExtentsM: tuple(box.halfExtents).map((value) => value + box.borderRadius) as [
          number,
          number,
          number,
        ],
        representation: 'bounds',
      },
    };
  }
  const border = 'borderRadius' in source ? (source.borderRadius as number) : 0;
  if (
    source.type === types.Cylinder ||
    source.type === types.Cone ||
    source.type === types.RoundCylinder ||
    source.type === types.RoundCone
  ) {
    const cylinder = source as Cylinder;
    return {
      center: ZERO,
      shape: {
        kind: 'box',
        halfExtentsM: [
          cylinder.radius + border,
          cylinder.halfHeight + border,
          cylinder.radius + border,
        ],
        representation: 'bounds',
      },
    };
  }
  return convexBounds((source as ConvexPolyhedron).vertices, border);
}

function finitePrimitive(value: ShapeBounds): boolean {
  const shape = value.shape;
  const dimensions =
    shape.kind === 'box'
      ? shape.halfExtentsM
      : shape.kind === 'sphere'
        ? [shape.radiusM]
        : [shape.radiusM, shape.halfHeightM];
  return (
    finitePhysicsVector(value.center, 3) && dimensions.every((v) => Number.isFinite(v) && v >= 0)
  );
}

/** Projects each accepted compound child without exposing backend handles. */
export function readColliderPrimitives(
  collider: Collider,
  types: typeof ShapeType,
): readonly Geometry[] | undefined {
  const position = collider.translation(),
    rotation = rotationTuple(collider.rotation());
  const result: Geometry[] = [];
  for (const part of aggregateParts(collider, types)) {
    const bounds = part.bounds;
    if (!bounds || !finitePrimitive(bounds)) return undefined;
    const localCenter = quat.transformVec3(vec3.create(), part.rotation, bounds.center);
    const [localX, localY, localZ] = localCenter;
    if (localX === undefined || localY === undefined || localZ === undefined) return undefined;
    const offset = quat.transformVec3(vec3.create(), rotation, [
      part.position[0] + localX,
      part.position[1] + localY,
      part.position[2] + localZ,
    ]);
    const q = quat.multiply(quat.create(), rotation, part.rotation);
    const [offsetX, offsetY, offsetZ] = offset;
    const [qx, qy, qz, qw] = q;
    if (
      offsetX === undefined ||
      offsetY === undefined ||
      offsetZ === undefined ||
      qx === undefined ||
      qy === undefined ||
      qz === undefined ||
      qw === undefined
    )
      return undefined;
    if (bounds.shape.kind === 'box') Object.freeze(bounds.shape.halfExtentsM);
    result.push({
      elementIndex: part.index,
      positionM: Object.freeze([position.x + offsetX, position.y + offsetY, position.z + offsetZ]),
      rotation: Object.freeze([qx, qy, qz, qw]),
      shape: Object.freeze(bounds.shape),
    });
  }
  return result;
}
