import { defineComponent, type SchemaOf, type ShapeOf } from '@forgeax/engine-ecs';
import { mat4, vec3 } from '@forgeax/engine-math';
import { StereoCameraInvalidError } from '../errors/render';
import type { CameraSnapshot } from '../render-contract';

/** Numeric labels stored by the StereoCamera layout enum column. */
export const StereoLayoutValue = Object.freeze({
  'side-by-side': 0,
  'top-bottom': 1,
  anaglyph: 2,
} as const);

/** How the two eye pictures share the camera's CameraView rectangle. */
export type StereoLayout = keyof typeof StereoLayoutValue;

/** Closed eye identity of a derived stereo view. */
export type StereoEye = 'left' | 'right';

/** Eye expansion order; left precedes right at equal CameraView order. */
export const STEREO_EYES: readonly StereoEye[] = Object.freeze(['left', 'right']);

/** The StereoCamera or Camera fact rejected by `stereo-camera-invalid`. */
export type StereoCameraInvalidField =
  | 'eyeSeparation'
  | 'convergence'
  | 'layout'
  | 'projection'
  | 'target'
  | 'planarReflection';

/**
 * Non-XR stereo output for a perspective Camera. The renderer expands the camera
 * into two CameraView eyes offset by +/- eyeSeparation/2 along the camera's local
 * X axis, each with an off-axis frustum whose zero-parallax plane lies at
 * `convergence` world units in front of the camera.
 */
export const StereoCamera = defineComponent(
  'StereoCamera',
  {
    eyeSeparation: { type: 'f32', default: 0.064 },
    convergence: { type: 'f32', default: 10 },
    layout: { type: 'enum', default: StereoLayoutValue['side-by-side'], labels: StereoLayoutValue },
    swapEyes: { type: 'bool', default: false },
  },
  {
    meta: {
      quickStart:
        'Attach StereoCamera to a perspective Camera; it renders two eyes into the CameraView rectangle (full screen by default).',
      diagnostics:
        'renderer.inspect().views reports one row per eye with its eye, viewport, and temporal history.',
      recovery:
        'stereo-camera-invalid names the rejected field: eyeSeparation >= 0, convergence > Camera.near, perspective projection, no Camera.target or PlanarReflection.',
      boundaries:
        'StereoCamera owns eye offset, convergence, and output layout; CameraView owns the outer rectangle, order, scale, and cadence.',
    },
  },
);
export type StereoCameraData = ShapeOf<SchemaOf<typeof StereoCamera>>;

/** Validated StereoCamera facts carried by World extraction and publication. */
export interface StereoCameraSnapshot {
  readonly eyeSeparation: number;
  readonly convergence: number;
  readonly layout: StereoLayout;
  readonly swapEyes: boolean;
}

/** Derived per-eye facts on an eye CameraSnapshot. */
export interface StereoEyeSnapshot {
  readonly side: StereoEye;
  /** Off-axis projection term written to projection element [8] (column 2, row 0). */
  readonly frustumShift: number;
}

export function stereoLayoutFromU32(value: number): StereoLayout | undefined {
  switch (value) {
    case StereoLayoutValue['side-by-side']:
      return 'side-by-side';
    case StereoLayoutValue['top-bottom']:
      return 'top-bottom';
    case StereoLayoutValue.anaglyph:
      return 'anaglyph';
    default:
      return undefined;
  }
}

/** Validate StereoCamera against its Camera. Throws the structured render error. */
export function resolveStereoCamera(
  data: StereoCameraData,
  camera: {
    readonly projection: 'perspective' | 'orthographic';
    readonly near: number;
    readonly target: boolean;
    readonly planarReflection: boolean;
  },
): StereoCameraSnapshot {
  if (!Number.isFinite(data.eyeSeparation) || data.eyeSeparation < 0)
    throw new StereoCameraInvalidError(
      'eyeSeparation',
      data.eyeSeparation,
      'a finite distance >= 0',
    );
  if (!Number.isFinite(data.convergence) || data.convergence <= camera.near)
    throw new StereoCameraInvalidError(
      'convergence',
      data.convergence,
      `a finite distance > Camera.near (${camera.near})`,
    );
  const layout = stereoLayoutFromU32(data.layout);
  if (layout === undefined)
    throw new StereoCameraInvalidError('layout', data.layout, 'a StereoLayoutValue');
  if (camera.projection !== 'perspective')
    throw new StereoCameraInvalidError('projection', camera.projection, 'a perspective Camera');
  if (camera.target)
    throw new StereoCameraInvalidError('target', 'RenderTarget', 'a screen Camera (target 0)');
  if (camera.planarReflection)
    throw new StereoCameraInvalidError(
      'planarReflection',
      'PlanarReflection',
      'a Camera without PlanarReflection',
    );
  return {
    eyeSeparation: data.eyeSeparation,
    convergence: data.convergence,
    layout,
    swapEyes: data.swapEyes,
  };
}

/** Slot 0 is left/top/red; `swapEyes` exchanges placement (cross-eyed viewing). */
export function stereoEyeSlot(stereo: StereoCameraSnapshot, eye: StereoEye): 0 | 1 {
  return (eye === 'left') !== stereo.swapEyes ? 0 : 1;
}

/** The normalized sub-rectangle of an outer CameraView viewport covered by one eye. */
export function stereoEyeViewport(
  viewport: ArrayLike<number>,
  stereo: StereoCameraSnapshot,
  eye: StereoEye,
): Float32Array {
  const x = viewport[0] ?? 0,
    y = viewport[1] ?? 0,
    w = viewport[2] ?? 1,
    h = viewport[3] ?? 1;
  const slot = stereoEyeSlot(stereo, eye);
  switch (stereo.layout) {
    case 'side-by-side':
      return new Float32Array([x + slot * w * 0.5, y, w * 0.5, h]);
    case 'top-bottom':
      return new Float32Array([x, y + slot * h * 0.5, w, h * 0.5]);
    case 'anaglyph':
      return new Float32Array([x, y, w, h]);
  }
}

/**
 * Off-axis frustum term, identical to Three.js StereoCamera:
 * `(xmax + xmin) / (xmax - xmin)` with `xmin/xmax = -/+ ymax * aspect +/- eyeSep/2 * near / focus`.
 * Positive for the left eye, which shifts its frustum toward the camera centre.
 */
export function stereoFrustumShift(
  stereo: Pick<StereoCameraSnapshot, 'eyeSeparation' | 'convergence'>,
  eye: StereoEye,
  fov: number,
  aspect: number,
): number {
  const sign = eye === 'left' ? 1 : -1;
  return (sign * stereo.eyeSeparation * 0.5) / (stereo.convergence * Math.tan(fov * 0.5) * aspect);
}

/** Derive one eye from a camera whose aspect is already the eye's physical aspect. */
export function stereoEyeCamera(camera: CameraSnapshot, eye: StereoEye): CameraSnapshot {
  const stereo = camera.stereo;
  if (stereo === undefined) return camera;
  const offset = mat4.fromTranslation(
    mat4.create(),
    vec3.create((eye === 'left' ? -0.5 : 0.5) * stereo.eyeSeparation, 0, 0),
  );
  const world = mat4.multiply(mat4.create(), camera.world, offset);
  return {
    ...camera,
    world,
    position: mat4.getTranslation(vec3.create(), world),
    eye: { side: eye, frustumShift: stereoFrustumShift(stereo, eye, camera.fov, camera.aspect) },
  };
}

/** Eye views of a camera, or the camera itself when it is not stereo. */
export function stereoEyeCameras(camera: CameraSnapshot): readonly CameraSnapshot[] {
  return camera.stereo === undefined
    ? [camera]
    : STEREO_EYES.map((eye) => stereoEyeCamera(camera, eye));
}
