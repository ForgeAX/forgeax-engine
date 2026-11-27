import { mat4, quat, vec3 } from '@forgeax/engine-math';
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
import { stockCameraView, writePose } from './pose';

class SpriteView {
  readonly position = new Vector3();
  sx = 1;
  sy = 1;
  rotation = 0;

  read(sprite: Sprite, camera: Camera, material: SpriteMaterial, positionMaterial: Material): void {
    const positionInput = surfaceVec3(positionMaterial, 'positionNode');
    const position = this.position;
    if (positionInput === null) position.setFromMatrixPosition(sprite.matrixWorld);
    else position.copy(positionInput).applyMatrix4(sprite.matrixWorld);
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
    if (
      !Number.isFinite(sx) ||
      !Number.isFinite(sy) ||
      !Number.isFinite(rotation) ||
      !Number.isFinite(sprite.center.x) ||
      !Number.isFinite(sprite.center.y)
    )
      invalid('Sprite scale/center/rotation', sprite.uuid).unwrap();
    this.sx = sx;
    this.sy = sy;
    this.rotation = rotation;
  }
}

/** The source sprite's camera-facing author transform, using its existing quad. */
export function spriteMatrix(
  sprite: Sprite,
  camera: Camera,
  material: SpriteMaterial = sprite.material,
  positionMaterial: Material = material,
): Matrix4 {
  const view = new SpriteView();
  view.read(sprite, camera, material, positionMaterial);
  const local = new Matrix4().makeRotationZ(view.rotation).scale(new Vector3(view.sx, view.sy, 1));
  const center = new Vector3(0.5 - sprite.center.x, 0.5 - sprite.center.y, 0)
    .applyMatrix4(local)
    .add(view.position);
  local.setPosition(center);
  return camera.matrixWorldInverse.clone().invert().multiply(local);
}

/** Resolve the rigid camera basis once per submission. */
export class SpritePoseReader {
  private readonly view = new SpriteView();
  private readonly basis = new Matrix4();
  private readonly center = new Vector3();
  private readonly rotation = quat.create();
  private readonly translation = vec3.create();
  private readonly scale = vec3.create();
  private readonly shear = vec3.create();
  private rigid: boolean | undefined;

  begin(): void {
    this.rigid = undefined;
  }

  read(
    sprite: Sprite,
    camera: Camera,
    material: SpriteMaterial,
    positionMaterial: Material,
    pose: number[],
  ): boolean {
    if (this.rigid === undefined) {
      this.rigid =
        stockCameraView(camera, this.basis).equals(camera.matrixWorldInverse) &&
        mat4.decomposeAffine(
          this.translation,
          this.rotation,
          this.scale,
          this.shear,
          this.basis.invert().elements,
        );
    }
    if (!this.rigid) return false;
    const view = this.view;
    view.read(sprite, camera, material, positionMaterial);
    const { sx, sy, rotation, position } = view;
    const x = (0.5 - sprite.center.x) * sx;
    const y = (0.5 - sprite.center.y) * sy;
    const c = Math.cos(rotation);
    const s = Math.sin(rotation);
    const center = this.center
      .set(position.x + c * x - s * y, position.y + s * x + c * y, position.z)
      .applyMatrix4(this.basis);
    const qx = this.rotation[0] as number;
    const qy = this.rotation[1] as number;
    const qz = this.rotation[2] as number;
    const qw = this.rotation[3] as number;
    const hc = Math.cos(rotation / 2);
    const hs = Math.sin(rotation / 2);
    return writePose(
      pose,
      center.x,
      center.y,
      center.z,
      qx * hc + qy * hs,
      qy * hc - qx * hs,
      qz * hc + qw * hs,
      qw * hc - qz * hs,
      sx,
      sy,
      1,
    );
  }
}
