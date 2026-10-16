import { type Mat4, mat4, type Vec3Like } from '@forgeax/engine-math';
import { CUBE_CAMERA_FACE_ORDER, type CubeCameraFace } from '../components/cube-camera';

export interface CubeCameraFaceView {
  readonly position: Vec3Like;
  readonly face: CubeCameraFace;
  readonly direction: readonly [number, number, number];
  readonly up: readonly [number, number, number];
  readonly near: number;
  readonly far: number;
  readonly view: Mat4;
  readonly projection: Mat4;
  readonly viewProjection: Mat4;
}

export interface CubeCameraFaceViewInput {
  readonly position: Vec3Like;
  readonly near: number;
  readonly far: number;
}

const FACE_ORIENTATION: ReadonlyArray<{
  readonly direction: readonly [number, number, number];
  readonly up: readonly [number, number, number];
}> = [
  { direction: [1, 0, 0], up: [0, 1, 0] },
  { direction: [-1, 0, 0], up: [0, 1, 0] },
  { direction: [0, 1, 0], up: [0, 0, -1] },
  { direction: [0, -1, 0], up: [0, 0, 1] },
  { direction: [0, 0, 1], up: [0, 1, 0] },
  { direction: [0, 0, -1], up: [0, 1, 0] },
];

function assertRange(near: number, far: number): void {
  if (!Number.isFinite(near) || near <= 0 || !Number.isFinite(far) || far <= near) {
    throw new RangeError('CubeCamera requires finite near > 0 and far > near.');
  }
}

/** Build the only supported +X,-X,+Y,-Y,+Z,-Z cube orientation. */
export function buildCubeCameraFaceViews(input: CubeCameraFaceViewInput): CubeCameraFaceView[] {
  assertRange(input.near, input.far);
  const views: CubeCameraFaceView[] = [];
  for (const [index, face] of CUBE_CAMERA_FACE_ORDER.entries()) {
    const orientation = FACE_ORIENTATION[index];
    if (orientation === undefined)
      throw new Error(`CubeCamera face orientation missing at ${index}`);
    const target: Vec3Like = [
      (input.position[0] ?? 0) + orientation.direction[0],
      (input.position[1] ?? 0) + orientation.direction[1],
      (input.position[2] ?? 0) + orientation.direction[2],
    ];
    const view = mat4.lookAt(mat4.create(), input.position, target, orientation.up);
    const projection = mat4.perspectiveReverseZ(
      mat4.create(),
      Math.PI / 2,
      1,
      input.near,
      input.far,
    );
    const viewProjection = mat4.multiply(mat4.create(), projection, view);
    views.push({
      position: input.position,
      face,
      direction: orientation.direction,
      up: orientation.up,
      near: input.near,
      far: input.far,
      view,
      projection,
      viewProjection,
    });
  }
  return views;
}
