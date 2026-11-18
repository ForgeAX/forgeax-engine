import {
  type Camera,
  type Material,
  Matrix4,
  type Sprite,
  type SpriteMaterial,
  Vector3,
} from 'three/src/Three.Core.js';
import { invalid } from './errors';
import { surfaceScalar, surfaceVec2, surfaceVec3 } from './node-inputs';
import { nodeDefinition } from './node-material-instance';

/** The source sprite's camera-facing author transform, using its existing quad. */
export function spriteMatrix(
  sprite: Sprite,
  camera: Camera,
  material: SpriteMaterial = sprite.material,
  positionMaterial: Material = material,
): Matrix4 {
  const positionInput = surfaceVec3(positionMaterial, 'positionNode');
  const position =
    positionInput === null
      ? new Vector3().setFromMatrixPosition(sprite.matrixWorld)
      : new Vector3().copy(positionInput).applyMatrix4(sprite.matrixWorld);
  position.applyMatrix4(camera.matrixWorldInverse);
  const scale = surfaceVec2(material, 'scaleNode');
  const rotation = surfaceScalar(material, 'rotationNode', material.rotation);
  const matrix = sprite.matrixWorld.elements;
  const attenuation =
    'isPerspectiveCamera' in camera &&
    (nodeDefinition(material) as SpriteMaterial).sizeAttenuation === false
      ? -position.z
      : 1;
  const sx = Math.hypot(matrix[0], matrix[1], matrix[2]) * attenuation * (scale?.x ?? 1);
  const sy = Math.hypot(matrix[4], matrix[5], matrix[6]) * attenuation * (scale?.y ?? 1);
  if (![sx, sy, rotation, sprite.center.x, sprite.center.y].every(Number.isFinite))
    return invalid('Sprite scale/center/rotation', sprite.uuid).unwrap();
  const local = new Matrix4().makeRotationZ(rotation).scale(new Vector3(sx, sy, 1));
  const center = new Vector3(0.5 - sprite.center.x, 0.5 - sprite.center.y, 0)
    .applyMatrix4(local)
    .add(position);
  local.setPosition(center);
  return camera.matrixWorldInverse.clone().invert().multiply(local);
}
