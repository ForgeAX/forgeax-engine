import { err, ok, type Result } from '@forgeax/engine-types';
import {
  type BarrelDistortionData,
  validateBarrelDistortionParameters,
} from './components/barrel-distortion';
import { BarrelDistortionInvalidParameterError } from './errors/render';

/** One immutable mapping used by the output pass and display interaction. */
export interface BarrelDistortionMapping {
  readonly width: number;
  readonly height: number;
  readonly aspect: number;
  readonly strength: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly radiusSquared: number;
  /** Unjittered camera facts from the submitted frame, when available. */
  readonly camera?: BarrelDistortionCameraFrame;
}

/** Camera matrices paired with the mapping's accepted render frame. */
export interface BarrelDistortionCameraFrame {
  readonly projection: 'perspective' | 'orthographic';
  /** Far plane from the same submitted camera snapshot as the matrices. */
  readonly far: number;
  readonly viewMatrix: ArrayLike<number>;
  readonly projectionMatrix: ArrayLike<number>;
}

// The equations below are evaluated in JavaScript's binary64 domain. Keep the
// public input domain strict, then absorb only a handful of binary64 ulps at
// the computed UV boundary. A real crop miss is orders of magnitude larger
// and remains rejected.
const COMPUTED_UV_BOUNDARY_EPSILON = Number.EPSILON * 16;

/**
 * Detach and deep-freeze a mapping before it crosses a public or realm
 * boundary. Worker structured cloning drops the source object's frozen state,
 * so every receiving boundary must call this helper again.
 */
export function freezeBarrelDistortionMapping(
  mapping: BarrelDistortionMapping,
): BarrelDistortionMapping {
  const camera = mapping.camera;
  return Object.freeze({
    ...mapping,
    ...(camera === undefined
      ? {}
      : {
          camera: Object.freeze({
            projection: camera.projection,
            far: camera.far,
            viewMatrix: Object.freeze(Array.from(camera.viewMatrix)),
            projectionMatrix: Object.freeze(Array.from(camera.projectionMatrix)),
          }),
        }),
  });
}

/** Attach the unjittered camera facts at the queue-submit publication boundary. */
export function attachBarrelDistortionCameraFrame(
  mapping: BarrelDistortionMapping,
  camera: BarrelDistortionCameraFrame,
): BarrelDistortionMapping {
  return freezeBarrelDistortionMapping({
    ...mapping,
    camera: {
      projection: camera.projection,
      far: camera.far,
      viewMatrix: camera.viewMatrix,
      projectionMatrix: camera.projectionMatrix,
    },
  });
}

/** Continuous output-viewport pixel coordinate. */
export interface DisplayPoint {
  x: number;
  y: number;
}

function invalidExtent(
  field: 'width' | 'height',
  value: number,
): BarrelDistortionInvalidParameterError {
  return new BarrelDistortionInvalidParameterError({
    field,
    value,
    expected: 'finite and greater than 0',
  });
}

/** Derive the output-sized mapping, including the auto-crop normalization. */
export function createBarrelDistortionMapping(
  width: number,
  height: number,
  input: Partial<BarrelDistortionData> | undefined,
): Result<BarrelDistortionMapping, BarrelDistortionInvalidParameterError> {
  if (!Number.isFinite(width) || width <= 0) return err(invalidExtent('width', width));
  if (!Number.isFinite(height) || height <= 0) return err(invalidExtent('height', height));
  const parameters = validateBarrelDistortionParameters(input);
  if (!parameters.ok) return parameters;
  const { strength, centerX, centerY } = parameters.value;
  const aspect = width / height;
  const radiusSquared =
    4 *
    (aspect * aspect * Math.max(centerX, 1 - centerX) ** 2 + Math.max(centerY, 1 - centerY) ** 2);
  return ok(
    Object.freeze({
      width,
      height,
      aspect,
      strength,
      centerX,
      centerY,
      radiusSquared,
    }),
  );
}

function displayToSceneScale(mapping: BarrelDistortionMapping, ux: number, uy: number): number {
  const px = 2 * mapping.aspect * (ux - mapping.centerX);
  const py = 2 * (uy - mapping.centerY);
  const t = (px * px + py * py) / mapping.radiusSquared;
  return (1 - mapping.strength) / (1 - mapping.strength * t);
}

/**
 * Accept a computed UV only when it is inside the unit interval or within a
 * machine-precision boundary. Inputs are checked before the equation runs;
 * this helper must never turn an out-of-domain caller input into a valid UV.
 */
function normalizeComputedUv(out: DisplayPoint, x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (
    x < -COMPUTED_UV_BOUNDARY_EPSILON ||
    x > 1 + COMPUTED_UV_BOUNDARY_EPSILON ||
    y < -COMPUTED_UV_BOUNDARY_EPSILON ||
    y > 1 + COMPUTED_UV_BOUNDARY_EPSILON
  ) {
    return false;
  }
  out.x = Math.min(1, Math.max(0, x));
  out.y = Math.min(1, Math.max(0, y));
  return true;
}

/** Shared display UV -> source UV equation used by the GPU and CPU paths. */
export function mapDisplayUvToSceneUv(
  out: DisplayPoint,
  mapping: BarrelDistortionMapping,
  ux: number,
  uy: number,
): boolean {
  if (!Number.isFinite(ux) || !Number.isFinite(uy) || ux < 0 || ux > 1 || uy < 0 || uy > 1)
    return false;
  if (mapping.strength === 0) {
    out.x = ux;
    out.y = uy;
    return ux >= 0 && ux <= 1 && uy >= 0 && uy <= 1;
  }
  const scale = displayToSceneScale(mapping, ux, uy);
  return normalizeComputedUv(
    out,
    mapping.centerX + (ux - mapping.centerX) * scale,
    mapping.centerY + (uy - mapping.centerY) * scale,
  );
}

/** Analytic source UV -> display UV inverse of the shared barrel model. */
export function mapSceneUvToDisplayUv(
  out: DisplayPoint,
  mapping: BarrelDistortionMapping,
  ux: number,
  uy: number,
): boolean {
  if (!Number.isFinite(ux) || !Number.isFinite(uy) || ux < 0 || ux > 1 || uy < 0 || uy > 1)
    return false;
  if (mapping.strength === 0) {
    out.x = ux;
    out.y = uy;
    return ux >= 0 && ux <= 1 && uy >= 0 && uy <= 1;
  }
  const px = 2 * mapping.aspect * (ux - mapping.centerX);
  const py = 2 * (uy - mapping.centerY);
  const sourceRadius = Math.hypot(px, py);
  if (sourceRadius === 0) {
    out.x = mapping.centerX;
    out.y = mapping.centerY;
    return true;
  }
  const discriminant =
    (1 - mapping.strength) ** 2 +
    (4 * mapping.strength * sourceRadius * sourceRadius) / mapping.radiusSquared;
  const displayRadius =
    (2 * sourceRadius) / (1 - mapping.strength + Math.sqrt(Math.max(0, discriminant)));
  const scale = displayRadius / sourceRadius;
  return normalizeComputedUv(
    out,
    mapping.centerX + (ux - mapping.centerX) * scale,
    mapping.centerY + (uy - mapping.centerY) * scale,
  );
}

function validPixel(point: DisplayPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

/** Map an output display pixel to the unwarped scene pixel. */
export function mapDisplayToScene(
  out: DisplayPoint,
  mapping: BarrelDistortionMapping,
  displayX: number,
  displayY: number,
): boolean {
  if (!Number.isFinite(displayX) || !Number.isFinite(displayY)) return false;
  if (displayX < 0 || displayX > mapping.width || displayY < 0 || displayY > mapping.height) {
    return false;
  }
  const scene = { x: 0, y: 0 };
  if (!mapDisplayUvToSceneUv(scene, mapping, displayX / mapping.width, displayY / mapping.height)) {
    return false;
  }
  out.x = scene.x * mapping.width;
  out.y = scene.y * mapping.height;
  return validPixel(out);
}

/** Map an unwarped scene pixel to its visible output display pixel. */
export function mapSceneToDisplay(
  out: DisplayPoint,
  mapping: BarrelDistortionMapping,
  sceneX: number,
  sceneY: number,
): boolean {
  if (!Number.isFinite(sceneX) || !Number.isFinite(sceneY)) return false;
  if (sceneX < 0 || sceneX > mapping.width || sceneY < 0 || sceneY > mapping.height) {
    return false;
  }
  const display = { x: 0, y: 0 };
  if (!mapSceneUvToDisplayUv(display, mapping, sceneX / mapping.width, sceneY / mapping.height)) {
    return false;
  }
  out.x = display.x * mapping.width;
  out.y = display.y * mapping.height;
  return validPixel(out);
}
