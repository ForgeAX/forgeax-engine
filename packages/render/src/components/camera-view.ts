import { defineComponent, type SchemaOf, type ShapeOf } from '@forgeax/engine-ecs';
import { CameraViewInvalidError } from '../errors/render';

/** Opt a Camera into ordered multi-view composition. Rectangles use top-left normalized coordinates. */
export const CameraView = defineComponent('CameraView', {
  viewport: { type: 'array<f32, 4>', default: new Float32Array([0, 0, 1, 1]) },
  order: { type: 'i32', default: 0 },
  resolutionScale: { type: 'f32', default: 1 },
  updateInterval: { type: 'u32', default: 1 },
  enabled: { type: 'bool', default: true },
});
export type CameraViewData = ShapeOf<SchemaOf<typeof CameraView>>;

/** The implicit full-screen view of a StereoCamera without CameraView. */
export const CAMERA_VIEW_DEFAULTS: CameraViewData = Object.freeze({
  viewport: new Float32Array([0, 0, 1, 1]),
  order: 0,
  resolutionScale: 1,
  updateInterval: 1,
  enabled: true,
});

export function cameraViewExtent(view: CameraViewData, width: number, height: number) {
  const [x = Number.NaN, y = Number.NaN, w = Number.NaN, h = Number.NaN] = view.viewport;
  if (
    ![x, y, w, h].every(Number.isFinite) ||
    x < 0 ||
    y < 0 ||
    w <= 0 ||
    h <= 0 ||
    x + w > 1.000001 ||
    y + h > 1.000001
  ) {
    throw new CameraViewInvalidError(
      'viewport',
      Array.from(view.viewport),
      'a positive normalized rectangle contained in [0, 1]',
    );
  }
  if (
    !Number.isFinite(view.resolutionScale) ||
    view.resolutionScale <= 0 ||
    view.resolutionScale > 1
  ) {
    throw new CameraViewInvalidError(
      'resolutionScale',
      view.resolutionScale,
      'a finite number in (0, 1]',
    );
  }
  if (!Number.isInteger(view.updateInterval) || view.updateInterval < 1) {
    throw new CameraViewInvalidError('updateInterval', view.updateInterval, 'an integer >= 1');
  }
  const left = Math.min(width - 1, Math.round(x * width)),
    top = Math.min(height - 1, Math.round(y * height));
  const viewportWidth = Math.min(width - left, Math.max(1, Math.round((x + w) * width) - left));
  const viewportHeight = Math.min(height - top, Math.max(1, Math.round((y + h) * height) - top));
  return {
    x: left,
    y: top,
    width: viewportWidth,
    height: viewportHeight,
    renderWidth: Math.max(1, Math.round(viewportWidth * view.resolutionScale)),
    renderHeight: Math.max(1, Math.round(viewportHeight * view.resolutionScale)),
  };
}
