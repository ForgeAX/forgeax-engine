import { type Camera, Matrix4, type Sprite, Vector3 } from 'three/src/Three.Core.js';
import { invalid } from './errors';

/** The source sprite's camera-facing author transform, using its existing quad. */
export function spriteMatrix(sprite: Sprite, camera: Camera): Matrix4 {
  const position = new Vector3()
    .setFromMatrixPosition(sprite.matrixWorld)
    .applyMatrix4(camera.matrixWorldInverse);
  const matrix = sprite.matrixWorld.elements;
  const attenuation =
    'isPerspectiveCamera' in camera && !sprite.material.sizeAttenuation ? -position.z : 1;
  const sx = Math.hypot(matrix[0], matrix[1], matrix[2]) * attenuation;
  const sy = Math.hypot(matrix[4], matrix[5], matrix[6]) * attenuation;
  if (![sx, sy, sprite.material.rotation, ...sprite.center.toArray()].every(Number.isFinite))
    return invalid('Sprite scale/center/rotation', sprite.uuid).unwrap();
  const local = new Matrix4().makeRotationZ(sprite.material.rotation).scale(new Vector3(sx, sy, 1));
  const center = new Vector3(0.5 - sprite.center.x, 0.5 - sprite.center.y, 0)
    .applyMatrix4(local)
    .add(position);
  local.setPosition(center);
  return camera.matrixWorldInverse.clone().invert().multiply(local);
}
