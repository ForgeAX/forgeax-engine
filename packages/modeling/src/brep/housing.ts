import { err, type Result } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import { booleanSolids } from './boolean';
import { box, cylinder } from './build';
import { IDENTITY_PLACEMENT, transformShape } from './transform';
import { brepError, type Shape } from './types';

export interface HousingOptions {
  /** Base box size [x, y, z], centred on the origin. */
  readonly size: readonly [number, number, number];
  /** Boss on the top and bottom of the base at this x position, centred on y = 0. */
  readonly bossX: number;
  readonly bossRadius: number;
  /** Total boss height; the boss is raised to z = H/2 and must extend past both faces. */
  readonly bossHeight: number;
  /** Through-bore at the same x position as the boss. */
  readonly boreRadius: number;
  readonly label?: string;
}

/**
 * A rectangular base with one cylindrical boss unioned on and one through-bore cut through it,
 * built from E1c booleans with a placed cylinder. The housing is an exact composition: the union
 * adds the boss volume outside the base, the difference removes the bore's column through the
 * base and the boss.
 */
export function housing(options: HousingOptions): Result<Shape, ModelingError> {
  const bad = (why: string) => err(brepError('brep-bad-argument', why));
  const { size, bossX, bossRadius, bossHeight, boreRadius } = options;
  if (!size.every((s) => Number.isFinite(s) && s > 0)) return bad('size is positive');
  if (!(Number.isFinite(bossRadius) && bossRadius > 0)) return bad('bossRadius is positive');
  if (!(Number.isFinite(boreRadius) && boreRadius > 0 && boreRadius < bossRadius)) {
    return bad('boreRadius is positive and less than bossRadius');
  }
  if (!(Number.isFinite(bossHeight) && bossHeight > size[2])) {
    return bad('bossHeight extends past both faces of the base');
  }
  if (!(Math.abs(bossX) + bossRadius < size[0] / 2 && bossRadius < size[1] / 2)) {
    return bad('boss footprint inside the base');
  }

  const base = box({ size: [size[0], size[1], size[2]] });
  if (!base.ok) return base;
  const boss = cylinder({ radius: bossRadius, height: bossHeight });
  if (!boss.ok) return boss;
  const bore = cylinder({ radius: boreRadius, height: bossHeight + 1 });
  if (!bore.ok) return bore;

  // The base is centred on the origin, but the boss and bore are raised to z = H / 2. A boss
  // centred on the base mid-plane is rejected by the union (measured: model-precondition), while
  // the raised boss still spans past both faces, so the outside volume is still Hb - H.
  const lift = size[2] / 2;
  const place = (s: Shape): Result<Shape, ModelingError> =>
    transformShape(s, { ...IDENTITY_PLACEMENT, t: [bossX, 0, lift] });
  const bossPlaced = place(boss.value);
  if (!bossPlaced.ok) return bossPlaced;
  const bored = place(bore.value);
  if (!bored.ok) return bored;

  const united = booleanSolids(base.value, bossPlaced.value, 'union');
  if (!united.ok) return united;
  return booleanSolids(united.value, bored.value, 'difference');
}
