import type { EntityHandle } from '@forgeax/engine-ecs';
import { mat4, quat, vec3 } from '@forgeax/engine-math';
import type {
  DerivedPhysicsSourceTransform,
  DerivedShapeInput,
  PhysicsQuaternion,
  PhysicsVector,
} from '@forgeax/engine-physics';

export interface SourceOwnedTypeRejection {
  readonly entity: EntityHandle;
  readonly candidateId: string;
  readonly revision: number;
  readonly requestedType: number;
}
export function projectSourceOwnedShape(
  shape: DerivedShapeInput,
  transform: DerivedPhysicsSourceTransform,
): DerivedShapeInput {
  const pose = sourceNativePose(transform);
  const origin = shape.origin ?? [0, 0, 0];
  const rotation = shape.rotation ?? [0, 0, 0, 1];
  const projectPoint = (x: number, y: number, z: number): [number, number, number] => {
    const shapePoint = rotateSourceVector(rotation, [x, y, z]);
    const bodyPoint: PhysicsVector = [
      origin[0] + shapePoint[0],
      origin[1] + shapePoint[1],
      origin[2] + shapePoint[2],
    ];
    const matrix = transform.sceneMatrix;
    const worldPoint: [number, number, number] = [
      sourceGeometryNumber(matrix[0]) * bodyPoint[0] +
        sourceGeometryNumber(matrix[4]) * bodyPoint[1] +
        sourceGeometryNumber(matrix[8]) * bodyPoint[2] +
        sourceGeometryNumber(matrix[12]),
      sourceGeometryNumber(matrix[1]) * bodyPoint[0] +
        sourceGeometryNumber(matrix[5]) * bodyPoint[1] +
        sourceGeometryNumber(matrix[9]) * bodyPoint[2] +
        sourceGeometryNumber(matrix[13]),
      sourceGeometryNumber(matrix[2]) * bodyPoint[0] +
        sourceGeometryNumber(matrix[6]) * bodyPoint[1] +
        sourceGeometryNumber(matrix[10]) * bodyPoint[2] +
        sourceGeometryNumber(matrix[14]),
    ];
    const relativeWorldPoint: [number, number, number] = [
      worldPoint[0] - pose.position[0],
      worldPoint[1] - pose.position[1],
      worldPoint[2] - pose.position[2],
    ];
    return rotateSourceVector(
      [-pose.rotation[0], -pose.rotation[1], -pose.rotation[2], pose.rotation[3]],
      relativeWorldPoint,
    );
  };
  if (shape.kind === 'convex-compound')
    return {
      ...shape,
      origin: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      pieces: shape.pieces.map(
        (piece) =>
          new Float32Array(
            Array.from({ length: piece.length / 3 }, (_, index) => {
              const point = projectPoint(
                sourceGeometryNumber(piece[index * 3]),
                sourceGeometryNumber(piece[index * 3 + 1]),
                sourceGeometryNumber(piece[index * 3 + 2]),
              );
              return point;
            }).flat(),
          ),
      ),
    };
  if (shape.kind === 'trimesh') {
    const indices = new Uint32Array(shape.indices);
    if (sourceMatrixDeterminant(transform.sceneMatrix) < 0)
      for (let index = 0; index < indices.length; index += 3) {
        const second = sourceGeometryNumber(indices[index + 1]);
        indices[index + 1] = sourceGeometryNumber(indices[index + 2]);
        indices[index + 2] = second;
      }
    return {
      ...shape,
      origin: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      vertices: new Float32Array(
        Array.from({ length: shape.vertices.length / 3 }, (_, index) =>
          projectPoint(
            sourceGeometryNumber(shape.vertices[index * 3]),
            sourceGeometryNumber(shape.vertices[index * 3 + 1]),
            sourceGeometryNumber(shape.vertices[index * 3 + 2]),
          ),
        ).flat(),
      ),
      indices,
    };
  }
  throw new Error(`Source-owned affine transform cannot project ${shape.kind} geometry`);
}

function rotateSourceVector(
  rotation: PhysicsQuaternion,
  point: PhysicsVector,
): [number, number, number] {
  const qx = rotation[0],
    qy = rotation[1],
    qz = rotation[2],
    qw = rotation[3];
  const [x, y, z] = point;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + qy * tz - qz * ty,
    y + qw * ty + qz * tx - qx * tz,
    z + qw * tz + qx * ty - qy * tx,
  ];
}

function sourceMatrixDeterminant(matrix: readonly number[]): number {
  return (
    sourceGeometryNumber(matrix[0]) *
      (sourceGeometryNumber(matrix[5]) * sourceGeometryNumber(matrix[10]) -
        sourceGeometryNumber(matrix[9]) * sourceGeometryNumber(matrix[6])) -
    sourceGeometryNumber(matrix[4]) *
      (sourceGeometryNumber(matrix[1]) * sourceGeometryNumber(matrix[10]) -
        sourceGeometryNumber(matrix[9]) * sourceGeometryNumber(matrix[2])) +
    sourceGeometryNumber(matrix[8]) *
      (sourceGeometryNumber(matrix[1]) * sourceGeometryNumber(matrix[6]) -
        sourceGeometryNumber(matrix[5]) * sourceGeometryNumber(matrix[2]))
  );
}

export function sourceNativePose(transform: DerivedPhysicsSourceTransform): {
  readonly position: PhysicsVector;
  readonly rotation: PhysicsQuaternion;
  readonly scale: PhysicsVector;
} {
  const position = vec3.create();
  const rotation = quat.create();
  const scale = vec3.create();
  const shear = vec3.create();
  if (!mat4.decomposeAffine(position, rotation, scale, shear, transform.sceneMatrix))
    throw new Error('validated source-owned Scene matrix no longer has an invertible affine pose');
  return {
    position: [
      sourceGeometryNumber(position[0]),
      sourceGeometryNumber(position[1]),
      sourceGeometryNumber(position[2]),
    ],
    rotation: [
      sourceGeometryNumber(rotation[0]),
      sourceGeometryNumber(rotation[1]),
      sourceGeometryNumber(rotation[2]),
      sourceGeometryNumber(rotation[3]),
    ],
    scale: [
      sourceGeometryNumber(scale[0]),
      sourceGeometryNumber(scale[1]),
      sourceGeometryNumber(scale[2]),
    ],
  };
}

function sourceGeometryNumber(value: number | undefined): number {
  if (value === undefined)
    throw new Error('Validated native source geometry has a missing coordinate');
  return value;
}
