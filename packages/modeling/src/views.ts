import { cos, hypot3, sin } from './dmath';
import type { Tuple3 } from './geom';
import type { Point2 } from './primitives';

/** The six orthographic views of a drawing sheet (Y up, the subject's front faces +Z). */
export type OrthoView = 'front' | 'back' | 'right' | 'left' | 'top' | 'bottom';

/**
 * Right-handed view frame: `right` and `up` span the drawing plane, `toward`
 * points from the subject to the viewer (`right x up = toward`). View coordinates
 * are `u = p . right`, `v = p . up`, depth `w = p . toward`.
 */
export interface ViewFrame {
  readonly right: Tuple3;
  readonly up: Tuple3;
  readonly toward: Tuple3;
}

/** Frames of the orthographic views; `model.render` orients its cameras with them. */
export const ORTHO_VIEWS: Readonly<Record<OrthoView, ViewFrame>> = {
  front: { right: [1, 0, 0], up: [0, 1, 0], toward: [0, 0, 1] },
  back: { right: [-1, 0, 0], up: [0, 1, 0], toward: [0, 0, -1] },
  right: { right: [0, 0, -1], up: [0, 1, 0], toward: [1, 0, 0] },
  left: { right: [0, 0, 1], up: [0, 1, 0], toward: [-1, 0, 0] },
  top: { right: [1, 0, 0], up: [0, 0, -1], toward: [0, 1, 0] },
  bottom: { right: [1, 0, 0], up: [0, 0, 1], toward: [0, -1, 0] },
};

export const ORTHO_VIEW_NAMES = Object.keys(ORTHO_VIEWS) as readonly OrthoView[];

function dot3(a: readonly number[], b: Tuple3): number {
  return (a[0] as number) * b[0] + (a[1] as number) * b[1] + (a[2] as number) * b[2];
}

/** An ortho view's frame, or a frame resolved elsewhere (a drawing's section view). */
function frameOf(view: OrthoView | ViewFrame): ViewFrame {
  return typeof view === 'string' ? ORTHO_VIEWS[view] : view;
}

/** `[u, v, w]` of a world point in a view. */
export function toView(view: OrthoView | ViewFrame, p: readonly number[]): Tuple3 {
  const f = frameOf(view);
  return [dot3(p, f.right), dot3(p, f.up), dot3(p, f.toward)];
}

/** World point of view coordinates `(u, v)` at depth `w`. */
export function fromView(view: OrthoView | ViewFrame, uv: Point2, w: number): Tuple3 {
  const f = frameOf(view);
  return [0, 1, 2].map(
    (k) =>
      uv[0] * (f.right[k] as number) + uv[1] * (f.up[k] as number) + w * (f.toward[k] as number),
  ) as Tuple3;
}

export function isOrthoView(value: unknown): value is OrthoView {
  return typeof value === 'string' && Object.hasOwn(ORTHO_VIEWS, value);
}

/**
 * A pinhole camera at `eye` looking at `target` (gameplay views): `up` (default +Y)
 * orients the image, `fovY` is the vertical field of view in degrees (default 50), and
 * the image is `pixels` square (default 256).
 */
export interface PerspectiveView {
  readonly eye: Tuple3;
  readonly target: Tuple3;
  readonly up?: Tuple3;
  readonly fovY?: number;
  readonly pixels?: number;
}

/**
 * The right-handed frame of a viewer standing on the `toward` side of the subject, its image
 * up as close to `up` (default +Y) as the direction allows; undefined when `toward` is zero,
 * not finite or parallel to `up`.
 */
export function lookFrame(toward: Tuple3, up: Tuple3 = [0, 1, 0]): ViewFrame | undefined {
  const unit = (a: Tuple3): Tuple3 | undefined => {
    const l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
    return Number.isFinite(l) && l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : undefined;
  };
  const cross = (a: Tuple3, b: Tuple3): Tuple3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const t = unit(toward);
  const u = unit(up);
  if (t === undefined || u === undefined) return undefined;
  const c = cross(u, t);
  if (hypot3(c[0], c[1], c[2]) < 1e-9) return undefined;
  const right = unit(c);
  if (right === undefined) return undefined;
  const upward = unit(cross(t, right));
  if (upward === undefined) return undefined;
  return { right, up: upward, toward: t };
}

/** The camera frame of a perspective view, its image half-extent and pixel count; undefined when degenerate. */
export function perspectiveFrame(
  view: PerspectiveView,
): { frame: ViewFrame; eye: Tuple3; half: number; pixels: number } | undefined {
  const fovY = view.fovY ?? 50;
  const pixels = view.pixels ?? 256;
  if (!(fovY > 0 && fovY < 170) || !Number.isInteger(pixels) || pixels < 8 || pixels > 4096) {
    return undefined;
  }
  const f = [0, 1, 2].map((k) => (view.target[k] as number) - (view.eye[k] as number)) as Tuple3;
  const frame = lookFrame([-f[0], -f[1], -f[2]], view.up);
  if (frame === undefined) return undefined;
  const a = (fovY * Math.PI) / 360;
  return { frame, eye: view.eye, half: sin(a) / cos(a), pixels };
}
