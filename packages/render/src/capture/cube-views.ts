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

function cubeView(
  out: Mat4,
  position: Vec3Like,
  orientation: (typeof FACE_ORIENTATION)[number],
  target: number[],
): Mat4 {
  for (let axis = 0; axis < 3; axis++)
    target[axis] = (position[axis] ?? 0) + (orientation.direction[axis] as number);
  return mat4.lookAt(out, position, target, orientation.up);
}

function cubeProjection(near: number, far: number): Mat4 {
  assertRange(near, far);
  return mat4.perspectiveReverseZ(mat4.create(), Math.PI / 2, 1, near, far);
}

/** Produce the six reflected shadow faces in their upload layout. */
export function packedPointShadowMatrices(
  position: Vec3Like,
  near: number,
  far: number,
): Float32Array {
  const projection = cubeProjection(near, far);
  const matrix = mat4.create();
  const target = [0, 0, 0];
  const packed = new Float32Array(CUBE_CAMERA_FACE_ORDER.length * 16);
  let offset = 0;
  for (const orientation of FACE_ORIENTATION) {
    cubeView(matrix, position, orientation, target);
    mat4.multiply(matrix, projection, matrix);
    for (let column = 0; column < 16; column += 4) matrix[column] = -(matrix[column] as number);
    packed.set(matrix, offset);
    offset += 16;
  }
  return packed;
}

/** Build the only supported +X,-X,+Y,-Y,+Z,-Z cube orientation. */
export function buildCubeCameraFaceViews(input: CubeCameraFaceViewInput): CubeCameraFaceView[] {
  const projectionTemplate = cubeProjection(input.near, input.far);
  const views: CubeCameraFaceView[] = [];
  const target = [0, 0, 0];
  for (const [index, face] of CUBE_CAMERA_FACE_ORDER.entries()) {
    const orientation = FACE_ORIENTATION[index];
    if (orientation === undefined)
      throw new Error(`CubeCamera face orientation missing at ${index}`);
    const view = cubeView(mat4.create(), input.position, orientation, target);
    const projection = index === 0 ? projectionTemplate : mat4.clone(projectionTemplate);
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
