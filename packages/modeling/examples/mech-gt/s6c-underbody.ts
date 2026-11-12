import type { Result } from '@forgeax/engine-types';
import { type ModelingError, type Point2, sel } from '@forgeax/engine-modeling';
import type { StencilSpec } from './s6b-paint.ts';
import { by, chaikin, type DetailPart, detailSession, ellipse, finishDetail, ranged, roundedRect, stencilOn } from './s6c-kit.ts';

/**
 * Case C-100 stage S6c (code name mech-gt): underbody detail recipes, built in their anchor
 * frame with Y out of the floor (down, toward the road), X across the car and Z = X x Y
 * along the flow (rearward). Panels sit between the anchor plane and -Y.
 */

export interface FloorPanelOptions {
  readonly name: string;
  /** Size across (X) and along the flow (Z). */
  readonly width: number;
  readonly length: number;
  /** Longitudinal guide channels (pairs of ribs). */
  readonly channels?: number;
  /** Strakes hanging into the flow over the rear third. */
  readonly strakes?: number;
  /** Vortex generators across the leading edge. */
  readonly vortex?: number;
  /** Button-head fasteners per long edge. */
  readonly fasteners?: number;
  /** Stencil plate along the panel's middle (12c). */
  readonly stencil?: StencilSpec;
}

export const FLOOR_RANGES = { width: [0.12, 1.8], length: [0.3, 2], channels: [0, 4], strakes: [0, 8], vortex: [0, 12], fasteners: [2, 12] } as const;

/**
 * One underbody floor panel: a 4 mm carbon plate with rounded corners and a chamfered
 * edge, button-head fasteners along both long edges and the ends, optional guide channels
 * (rib pairs along the flow), strakes into the flow and a row of angled vortex
 * generators across the leading edge.
 */
export function floorPanel(o: FloorPanelOptions): Result<DetailPart, ModelingError> {
  const channels = o.channels ?? 0;
  const strakes = o.strakes ?? 0;
  const vortex = o.vortex ?? 0;
  const fasteners = o.fasteners ?? 6;
  const checked = ranged({ width: [o.width, ...FLOOR_RANGES.width], length: [o.length, ...FLOOR_RANGES.length], channels: [channels, ...FLOOR_RANGES.channels], strakes: [strakes, ...FLOOR_RANGES.strakes], vortex: [vortex, ...FLOOR_RANGES.vortex], fasteners: [fasteners, ...FLOOR_RANGES.fasteners] });
  if (!checked.ok) return checked;
  const { m, piece, pieces } = detailSession(o.name);
  const t = 0.004;
  const [w, l] = [o.width / 2, o.length / 2];
  m.extrudePolygon({ points: roundedRect(o.width, o.length, 0.04, 4), depth: t, label: piece('plate'), material: 'carbon' });
  m.rotate(by(`${o.name}-plate`), 'x', 90);
  m.bevel(by(`${o.name}-plate`).and(sel.facing('+y', 5)).boundary(), { width: 0.0012, segments: 1, label: piece('edge') });
  // Fasteners: button heads proud of the road face (+Y), 25 mm in from the edges.
  const heads: [number, number][] = [];
  for (let i = 0; i < fasteners; i++) {
    const z = -l + 0.06 + ((2 * l - 0.12) * i) / (fasteners - 1);
    heads.push([w - 0.025, z], [-w + 0.025, z]);
  }
  for (const x of [-w * 0.5, 0, w * 0.5]) heads.push([x, -l + 0.025], [x, l - 0.025]);
  for (const [k, [x, z]] of heads.entries()) {
    m.revolve({ points: [[0, 0.0005], [0.0075, 0.0005], [0.0072, 0.0015], [0.0055, 0.003], [0, 0.0035]], segments: 16, label: piece(`fastener-${k}`), material: 'steel' });
    m.translate(by(`${o.name}-fastener-${k}`), [x, 0, z]);
  }
  // Guide channels: rib pairs along the flow.
  for (let c = 0; c < channels; c++) {
    const xc = (c - (channels - 1) / 2) * (o.width / (channels + 1));
    for (const [k, dx] of [['a', -0.035], ['b', 0.035]] as const) {
      const label = piece(`channel-${c}-${k}`);
      m.sweep({ profile: chaikin([[-0.005, 0], [0.005, 0], [0.003, 0.012], [-0.003, 0.012]], 1), path: [[xc + dx, 0.0004, -l + (vortex > 0 ? 0.24 : 0.12)], [xc + dx, 0.0004, l - 0.12]], up: [0, 1, 0], frame: 'up', label, material: 'carbon' });
    }
  }
  // Strakes: thin fins along the flow over the rear third, tallest at the trailing edge.
  for (let s = 0; s < strakes; s++) {
    const x = (s - (strakes - 1) / 2) * (o.width / (strakes + 0.5));
    const label = piece(`strake-${s}`);
    const side: Point2[] = chaikin([[0, 0.0005], [o.length * 0.33, 0.0005], [o.length * 0.2, 0.014], [0, 0.035]], 1);
    m.extrudePolygon({ points: side.map(([f, h]): Point2 => [-(l - 0.06 - f), h]), depth: 0.006, label, material: 'carbon' });
    m.rotate(by(label), 'y', 90);
    m.translate(by(label), [x - 0.003, 0, 0]);
  }
  // Vortex generators: small angled blades across the leading edge.
  for (let v = 0; v < vortex; v++) {
    const x = (v - (vortex - 1) / 2) * (o.width / (vortex + 1));
    const label = piece(`vortex-${v}`);
    m.extrudePolygon({ points: [[0, 0.0005], [0.06, 0.0005], [0.06, 0.018]], depth: 0.003, label, material: 'carbon' });
    m.rotate(by(label), 'y', 90 + (v % 2 === 0 ? 15 : -15));
    m.translate(by(label), [x, 0, -l + 0.15]);
  }
  // Stencil along the flow at the panel's middle, its width running with the flow.
  if (o.stencil !== undefined) stencilOn(m, o.stencil, [0, 0, 0], [0, 1, 0], [0, 0, 1], piece('stencil'));
  return finishDetail(o.name, m, pieces, { width: o.width, length: o.length, fasteners: heads.length });
}

export const TOW_RANGES = { width: [0.03, 0.12] } as const;

export interface TowCoverOptions {
  readonly name: string;
  readonly width?: number;
}

/** A tow-hook cover (X along the panel, Y out of it): an oval cap with its release notch and the hinge tab. */
export function towCover(o: TowCoverOptions): Result<DetailPart, ModelingError> {
  const width = o.width ?? 0.06;
  const checked = ranged({ width: [width, ...TOW_RANGES.width] });
  if (!checked.ok) return checked;
  const { m, piece, pieces } = detailSession(o.name);
  const outline = ellipse(width / 2, width * 0.36, 28);
  m.extrudePolygon({ points: outline, depth: 0.003, label: piece('cap'), material: 'paint' });
  m.rotate(by(`${o.name}-cap`), 'x', -90);
  m.translate(by(`${o.name}-cap`), [0, 0.0005, 0]);
  m.bevel(by(`${o.name}-cap`).and(sel.facing('+y', 5)).boundary(), { width: 0.0008, segments: 1, label: piece('cap-edge') });
  m.extrudePolygon({ points: roundedRect(0.012, 0.004, 0.0015, 1), depth: 0.0012, label: piece('notch'), material: 'trim' });
  m.rotate(by(`${o.name}-notch`), 'x', -90);
  m.translate(by(`${o.name}-notch`), [width / 2 - 0.012, 0.0036, 0]);
  m.extrudePolygon({ points: roundedRect(0.008, 0.016, 0.002, 1), depth: 0.002, label: piece('tab'), material: 'trim' });
  m.rotate(by(`${o.name}-tab`), 'x', -90);
  m.translate(by(`${o.name}-tab`), [-width / 2 - 0.0045, 0.0005, 0]);
  return finishDetail(o.name, m, pieces, { width });
}
