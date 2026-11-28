import type { Tuple3 } from '../../src/geom';
import { type FuzzOp, type FuzzPrimitive, scene } from '../../src/__tests__/support/fuzz';

export const GALLERY_GRID = 0.25;

export type Contact = 'coplanar' | 'face-contact' | 'sphere-tangent' | 'cap-flush';

export interface GalleryPick {
  readonly seed: number;
  readonly op: FuzzOp;
  readonly contact: Contact;
}

/**
 * Seeds of two-primitive fuzz scenes whose grid-snapped operands meet in the named exact
 * contact: boxes sharing a flush face plane of unequal extent, boxes touching face to face, a
 * sphere touching a box or cylinder, and a cylinder cap flush with a box face. Picked by
 * scanning seeds with `contact`, then keeping the first that survives the operation.
 */
export const GALLERY: readonly GalleryPick[] = [
  { seed: 8, op: 'union', contact: 'coplanar' },
  { seed: 7, op: 'union', contact: 'face-contact' },
  { seed: 24, op: 'union', contact: 'sphere-tangent' },
  { seed: 1, op: 'union', contact: 'cap-flush' },
  { seed: 9, op: 'difference', contact: 'coplanar' },
  { seed: 21, op: 'difference', contact: 'coplanar' },
  { seed: 26, op: 'difference', contact: 'cap-flush' },
  { seed: 18, op: 'intersection', contact: 'coplanar' },
];

const at = (t: Tuple3, k: number): number => t[k] as number;

/** The exact contact between a target and a tool primitive on the grid, if any. */
export function contactOf(a: FuzzPrimitive, b: FuzzPrimitive): Contact | undefined {
  for (let axis = 0; axis < 3; axis++) {
    const across = [0, 1, 2].filter((k) => k !== axis);
    const overlap = across.every(
      (k) => Math.abs(at(a.center, k) - at(b.center, k)) < at(a.half, k) + at(b.half, k),
    );
    if (!overlap) continue;
    const [ca, cb, ha, hb] = [at(a.center, axis), at(b.center, axis), at(a.half, axis), at(b.half, axis)];
    const touching = Math.abs(ca - cb) === ha + hb;
    const flush = ca + ha === cb + hb || ca - ha === cb - hb;
    const boxes = a.kind === 'box' && b.kind === 'box';
    if (boxes && touching) return 'face-contact';
    if (boxes && flush && ha !== hb) return 'coplanar';
    if ((a.kind === 'sphere') !== (b.kind === 'sphere') && touching) return 'sphere-tangent';
    if ((a.kind === 'cylinder') !== (b.kind === 'cylinder') && axis === 1 && flush) {
      return 'cap-flush';
    }
  }
  return undefined;
}

export function galleryScene(pick: GalleryPick) {
  return scene(pick.seed, { primitives: 2, grid: GALLERY_GRID, ops: [pick.op] });
}
