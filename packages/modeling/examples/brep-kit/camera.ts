import { cos, sin } from '../../src/dmath.ts';
import type { P3 } from './scene.ts';

/** A named standard view or an explicit orthographic direction, in degrees. Z is up. */
export type ViewSpec =
  | 'iso'
  | 'iso-back'
  | 'front'
  | 'back'
  | 'side'
  | 'left'
  | 'top'
  | 'bottom'
  | { readonly name: string; readonly azimuth: number; readonly elevation: number };

const NAMED: Readonly<Record<string, { azimuth: number; elevation: number }>> = {
  // Viewer sits at azimuth 0 on -y looking along +y; azimuth turns the viewer counter-clockwise seen from +z.
  iso: { azimuth: 35, elevation: 25 },
  'iso-back': { azimuth: 215, elevation: 25 },
  front: { azimuth: 0, elevation: 0 },
  back: { azimuth: 180, elevation: 0 },
  side: { azimuth: 90, elevation: 0 },
  left: { azimuth: -90, elevation: 0 },
  top: { azimuth: 0, elevation: 90 },
  bottom: { azimuth: 0, elevation: -90 },
};

export const STANDARD_VIEWS: readonly ViewSpec[] = ['iso', 'front', 'top', 'side'];

export interface ViewBasis {
  readonly name: string;
  readonly right: P3;
  readonly up: P3;
  /** Unit vector from the model toward the viewer; larger dot product is nearer. */
  readonly toward: P3;
}

export function viewName(view: ViewSpec): string {
  return typeof view === 'string' ? view : view.name;
}

export function viewBasis(view: ViewSpec): ViewBasis {
  const angles = typeof view === 'string' ? NAMED[view] : view;
  if (angles === undefined) throw new Error(`unknown view ${String(view)}`);
  const az = (angles.azimuth * Math.PI) / 180;
  const el = (angles.elevation * Math.PI) / 180;
  const right: P3 = [cos(az), sin(az), 0];
  const toward: P3 = [sin(az) * cos(el), -cos(az) * cos(el), sin(el)];
  // up = toward x right, snapped so the poles stay exactly axis aligned.
  const up: P3 = [
    toward[1] * right[2] - toward[2] * right[1],
    toward[2] * right[0] - toward[0] * right[2],
    toward[0] * right[1] - toward[1] * right[0],
  ];
  const clean = (v: P3): P3 => [snap(v[0]), snap(v[1]), snap(v[2])];
  return { name: viewName(view), right: clean(right), up: clean(up), toward: clean(toward) };
}

function snap(x: number): number {
  return Math.abs(x) < 1e-12 ? 0 : x;
}
