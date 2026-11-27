import {
  type CameraData,
  orthographic,
  perspective,
  TONEMAP_ACES_FILMIC,
  TONEMAP_AGX,
  TONEMAP_CINEON,
  TONEMAP_LINEAR,
  TONEMAP_NEUTRAL,
  TONEMAP_NONE,
  TONEMAP_REINHARD,
} from '@forgeax/engine-render';
import {
  assertCameraProjectionOffset,
  validateCameraPerspectiveFov,
} from '@forgeax/engine-render/internal';
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  type Camera,
  CineonToneMapping,
  Color,
  LinearToneMapping,
  NeutralToneMapping,
  NoToneMapping,
  type Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  ReinhardToneMapping,
  Scene,
  WebGLCoordinateSystem,
  WebGPUCoordinateSystem,
} from 'three/src/Three.Core.js';
import { invalid, unsupported } from './errors';

/** Shared source background semantics; the caller owns the synchronous output window. */
export function writeSceneClearColor(
  output: Float32Array,
  scene: Object3D,
  fallback: Color,
  alpha: number,
): Float32Array {
  const background =
    scene instanceof Scene && scene.background instanceof Color ? scene.background : undefined;
  const color = background ?? fallback;
  const coverage = background === undefined ? alpha : 1;
  output[0] = color.r * coverage;
  output[1] = color.g * coverage;
  output[2] = color.b * coverage;
  output[3] = coverage;
  return output;
}

const modes: Readonly<Record<number, number>> = {
  [NoToneMapping]: TONEMAP_NONE,
  [LinearToneMapping]: TONEMAP_LINEAR,
  [ReinhardToneMapping]: TONEMAP_REINHARD,
  [CineonToneMapping]: TONEMAP_CINEON,
  [ACESFilmicToneMapping]: TONEMAP_ACES_FILMIC,
  [AgXToneMapping]: TONEMAP_AGX,
  [NeutralToneMapping]: TONEMAP_NEUTRAL,
};

type SourceCameraData = { -readonly [K in keyof CameraData]: CameraData[K] };

const perspectiveRow = (): SourceCameraData =>
  perspective({ fov: 1, aspect: 1, autoAspect: false });
const orthographicRow = (): SourceCameraData =>
  orthographic({ left: -1, right: 1, bottom: -1, top: 1 });

/** One synchronous consumer owns the current camera columns and their writable arrays. */
export class SourceCameraRows {
  readonly perspective = perspectiveRow();
  readonly orthographic = orthographicRow();
}

export function cameraData(
  camera: Camera,
  toneMapping: number,
  exposure: number,
  rows?: SourceCameraRows,
): SourceCameraData {
  if (!(camera instanceof PerspectiveCamera || camera instanceof OrthographicCamera))
    return unsupported(camera.type, camera.uuid).unwrap();
  if (
    camera.coordinateSystem !== WebGLCoordinateSystem &&
    camera.coordinateSystem !== WebGPUCoordinateSystem
  )
    return unsupported('Camera.coordinateSystem', camera.uuid).unwrap();
  const tonemap = modes[toneMapping];
  if (tonemap === undefined) return unsupported('Renderer.toneMapping').unwrap();
  if (!Number.isFinite(exposure) || exposure < 0)
    return invalid('Renderer.toneMappingExposure').unwrap();
  // Read the cached projection: changing fov/zoom without updateProjectionMatrix must stay stale.
  const e = camera.projectionMatrix.elements;
  if (!e.every(Number.isFinite) || e[0] <= 0 || e[5] <= 0)
    return invalid('Camera.projectionMatrix', camera.uuid).unwrap();
  if (e[1] !== 0 || e[2] !== 0 || e[3] !== 0 || e[4] !== 0 || e[6] !== 0 || e[7] !== 0)
    return unsupported('Camera off-axis/custom projection', camera.uuid).unwrap();
  const isPerspective = camera instanceof PerspectiveCamera;
  if (
    e[11] !== (isPerspective ? -1 : 0) ||
    e[15] !== (isPerspective ? 0 : 1) ||
    (isPerspective && (e[12] !== 0 || e[13] !== 0)) ||
    (!isPerspective && (e[8] !== 0 || e[9] !== 0))
  )
    return unsupported('Camera custom projection', camera.uuid).unwrap();
  const nearZ = camera.reversedDepth
    ? 1
    : camera.coordinateSystem === WebGPUCoordinateSystem
      ? 0
      : -1;
  const farZ = camera.reversedDepth ? 0 : 1;
  const near = isPerspective ? e[14] / (e[10] + nearZ) : (e[14] - nearZ) / e[10];
  const far = isPerspective ? e[14] / (e[10] + farZ) : (e[14] - farZ) / e[10];
  if (
    !Number.isFinite(near) ||
    !Number.isFinite(far) ||
    (isPerspective ? near <= 0 : near < 0) ||
    far <= near
  )
    return unsupported(
      'Camera near/far: requires finite near < far; near > 0 for perspective, near >= 0 for orthographic',
      camera.uuid,
    ).unwrap();
  const data = isPerspective
    ? (rows?.perspective ?? perspectiveRow())
    : (rows?.orthographic ?? orthographicRow());
  if (isPerspective) {
    data.fov = validateCameraPerspectiveFov(2 * Math.atan(1 / e[5]));
    data.aspect = e[5] / e[0];
    data.projectionOffset[0] = -e[8];
    data.projectionOffset[1] = -e[9];
    assertCameraProjectionOffset(data.projectionOffset);
  } else {
    data.left = (-1 - e[12]) / e[0];
    data.right = (1 - e[12]) / e[0];
    data.bottom = (-1 - e[13]) / e[5];
    data.top = (1 - e[13]) / e[5];
  }
  data.near = near;
  data.far = far;
  data.cullMask = camera.layers.mask >>> 0;
  data.tonemap = tonemap;
  data.exposure = exposure;
  return data;
}
