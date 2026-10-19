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
  ACESFilmicToneMapping,
  AgXToneMapping,
  type Camera,
  CineonToneMapping,
  LinearToneMapping,
  NeutralToneMapping,
  NoToneMapping,
  OrthographicCamera,
  PerspectiveCamera,
  ReinhardToneMapping,
  WebGLCoordinateSystem,
} from 'three/src/Three.Core.js';
import { invalid, unsupported } from './errors';

export function cameraData(camera: Camera, toneMapping: number, exposure: number): CameraData {
  if (!(camera instanceof PerspectiveCamera || camera instanceof OrthographicCamera))
    return unsupported(camera.type, camera.uuid).unwrap();
  if (camera.coordinateSystem !== WebGLCoordinateSystem)
    return unsupported('Camera.coordinateSystem', camera.uuid).unwrap();
  const modes: Readonly<Record<number, number>> = {
    [NoToneMapping]: TONEMAP_NONE,
    [LinearToneMapping]: TONEMAP_LINEAR,
    [ReinhardToneMapping]: TONEMAP_REINHARD,
    [CineonToneMapping]: TONEMAP_CINEON,
    [ACESFilmicToneMapping]: TONEMAP_ACES_FILMIC,
    [AgXToneMapping]: TONEMAP_AGX,
    [NeutralToneMapping]: TONEMAP_NEUTRAL,
  };
  const tonemap = modes[toneMapping];
  if (tonemap === undefined) return unsupported('Renderer.toneMapping').unwrap();
  if (!Number.isFinite(exposure) || exposure < 0)
    return invalid('Renderer.toneMappingExposure').unwrap();
  // Read the cached projection: changing fov/zoom without updateProjectionMatrix must stay stale.
  const e = camera.projectionMatrix.elements;
  if (!e.every(Number.isFinite) || e[0] <= 0 || e[5] <= 0)
    return invalid('Camera.projectionMatrix', camera.uuid).unwrap();
  if ([1, 2, 3, 4, 6, 7].some((i) => e[i] !== 0))
    return unsupported('Camera off-axis/custom projection', camera.uuid).unwrap();
  const isPerspective = camera instanceof PerspectiveCamera;
  if (
    e[11] !== (isPerspective ? -1 : 0) ||
    e[15] !== (isPerspective ? 0 : 1) ||
    (isPerspective && (e[12] !== 0 || e[13] !== 0)) ||
    (!isPerspective && (e[8] !== 0 || e[9] !== 0))
  )
    return unsupported('Camera custom projection', camera.uuid).unwrap();
  const near = isPerspective ? e[14] / (e[10] - 1) : (e[14] + 1) / e[10];
  const far = isPerspective ? e[14] / (e[10] + 1) : (e[14] - 1) / e[10];
  if (!Number.isFinite(near) || !Number.isFinite(far) || near <= 0 || far <= near)
    return unsupported(
      'Camera near/far: prototype requires 0 < near < far < Infinity',
      camera.uuid,
    ).unwrap();
  return {
    ...(isPerspective
      ? perspective({
          fov: 2 * Math.atan(1 / e[5]),
          aspect: e[5] / e[0],
          near,
          far,
          autoAspect: false,
          projectionOffset: [-e[8], -e[9]],
        })
      : orthographic({
          left: (-1 - e[12]) / e[0],
          right: (1 - e[12]) / e[0],
          bottom: (-1 - e[13]) / e[5],
          top: (1 - e[13]) / e[5],
          near,
          far,
        })),
    tonemap,
    exposure,
  };
}
