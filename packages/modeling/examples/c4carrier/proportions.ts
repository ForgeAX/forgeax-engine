import type { Point2, Tuple3 } from '@forgeax/engine-modeling';

/**
 * Case C-600 heavy twin turret: dimensions of design/heavy-turret.json (draft-01) in the
 * modeling frame. The sheet is drawn X forward / Z starboard; the model is Y up, barrels
 * toward +Z and +X to port (a pure turn about Y, so handedness is kept): sheet (x, z) is
 * model (X, Z) = (-z, x). Metres and degrees; grade P values may move once a sweep or the
 * sheet's fixed values change them.
 */
export const RING_RADIUS = 9;
export const COLLAR_WALL = 1;
export const DECK_Y = -2;
export const WELL_Y = -4.6;
export const TRUNNION: Tuple3 = [0, 3, 4.5];
export const BARREL_X = 2.5;
export const BARREL_LENGTH = 26;
export const BREECH_Z = TRUNNION[2] - 6.5;
export const RECOIL = 1.5;
export const ELEVATION: readonly [number, number] = [-5, 45];
export const TRAVERSE = 150;
export const HOUSE_HEIGHT = 7;

/** Sheet [x, z] to model [X, Z]. */
export const toModel = ([x, z]: Point2): Point2 => [-z, x];

/** Plan at the ring plane and at the roof, sheet [x, z] (counter-clockwise from above). */
export const PLAN_BASE: readonly Point2[] = [
  [-8, -8], [7, -8], [10, -5], [10, 5], [7, 8], [-8, 8], [-10, 6], [-10, -6],
].map(([x, z]) => toModel([x as number, z as number]));
export const PLAN_ROOF: readonly Point2[] = [
  [-5, -6], [3.9, -6], [5.4, -4.5], [5.4, 4.5], [3.9, 6], [-5, 6], [-6.5, 4.5], [-6.5, -4.5],
].map(([x, z]) => toModel([x as number, z as number]));

/** Radius along the barrel from its breech face: [u, radius], linear between rows. */
export const BARREL_PROFILE: readonly Point2[] = [[0, 1.1], [8, 1.1], [22, 0.55], [22.01, 0.7], [26, 0.7]];
/** Sleeve span from the breech face: shortened from the sheet's 10.5 so it ends inside the mantlet's inner radius. */
export const SLEEVE_FROM: readonly [number, number] = [2, 7.6];
export const SLEEVE_RADIUS = 1.7;
export const SLEEVE_BORE = 1.2;
/** The mantlet plate runs `thickness` inward of its outer `radius` and carries a raised boss; both stand inside the window's side running gap. */
export const MANTLET = { radius: 3.62, thickness: 0.32, halfSpan: 24.62, halfWidth: 4.15, slotWidth: 2.4, slotHeight: 2.5, boss: { radius: 3.86, halfSpan: 22, halfWidth: 4.0 } } as const;
export const WINDOW = { radius: 3.75, from: -32.62, to: 85, halfWidth: 4.3 } as const;
/** Rigid apron on the cradle: +-90 degrees about the barrel axis keeps the window (-32.6 to 85 degrees) closed over the whole -5 to 45 degree elevation. */
export const APRON = { radius: 3.25, thickness: 0.3, halfSpan: 90, halfWidth: 4.2, center: 0 } as const;
/** Recoil cylinders fixed on the apron, one above and below each barrel: offset from the barrel axis, body end z, bore. */
export const RECOIL_CYLINDER = { offset: 1.7, radius: 0.3, from: 8.0, to: 9.7, bore: 0.2, boreFrom: 8.2 } as const;
export const ARC = { radius: 5, halfSpan: 35, thickness: 0.4, center: -150 } as const;
export const PIT = { z: [-3, 2.98] as const, halfWidth: 3.9 } as const;
export const CHEEK_X: readonly [number, number] = [5.35, 6.65];

/**
 * Barrel radius by distance from the breech face: breech ring, evacuator bulge, recoil collar
 * (u 13.5 to 14.1, ahead of the recoil cylinders by the full stroke), thermal jacket with two
 * clamp rings, taper, muzzle brake body.
 */
export const BARREL_SHAPE: readonly Point2[] = [
  [0, 0], [1.0, 0], [1.1, 0.35], [1.1, 8], [0.96, 10.9], [1.06, 11.1], [1.06, 13.5], [1.3, 13.6], [1.3, 14.0], [1.06, 14.1],
  [1.06, 14.9], [0.96, 15.1], [0.96, 15.3], [1.05, 15.4], [1.05, 15.8], [0.96, 15.9], [0.96, 17.2], [1.05, 17.3], [1.05, 17.7], [0.96, 17.8],
  [0.96, 18.0], [0.78, 18.4], [0.55, 22], [0.8, 22.01], [0.92, 22.4], [0.92, 25.5], [0.78, 26], [0, 26],
];
/** Muzzle brake side ports: first port start along the barrel, pitch, count. */
export const BRAKE_PORTS = { from: 22.75, pitch: 0.75, count: 4, width: 0.4, height: 0.7 } as const;
/** Recoil collar centre along the barrel. */
export const COLLAR_U = 13.8;
