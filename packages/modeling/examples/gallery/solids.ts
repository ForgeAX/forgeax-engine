// The planar-boolean solids of the gallery, each with the element size used for every quad mode.
import { booleanSolids } from '../../src/brep/boolean.ts';
import type { Shape } from '../../src/brep/types.ts';
import { block, buildBracket } from '../planar-boolean/bracket.ts';
import { must } from './common.ts';

export interface Solid {
  readonly name: string;
  readonly shape: Shape;
  readonly size: number;
}

const HOST = (): Shape => block([4, 4, 4], [0, 0, 0]);
const BAR = (): Shape => block([4, 1, 1], [0, 0, 0]);

export const slotBlock = (): Shape =>
  must(booleanSolids(HOST(), block([0.6, 1.4, 6], [0, 0, 0]), 'difference'));
export const blindPocketBlock = (): Shape =>
  must(booleanSolids(HOST(), block([1.2, 1.2, 1.4], [0, 0, 1.4]), 'difference'));
export const tUnion = (): Shape =>
  must(booleanSolids(BAR(), block([1, 2, 1.3], [0.13, 1.2, 0.17]), 'union'));
export const steppedL = (): Shape =>
  must(booleanSolids(BAR(), block([1, 2, 1.3], [1.45, 1, 0.17]), 'union'));
export const tIntersect = (): Shape =>
  must(booleanSolids(BAR(), block([1, 2, 1.3], [0.13, 1.2, 0.17]), 'intersect'));
export const steppedLIntersect = (): Shape =>
  must(booleanSolids(BAR(), block([1, 2, 1.3], [1.45, 1, 0.17]), 'intersect'));

const BRACKET_SIZE = 0.8;
const SMALL_SIZE = 0.4;

/** Bracket steps (the pocket step is the end state) and the three single-boolean solids, one equal size per solid. */
export function modeSolids(): Solid[] {
  const stages = buildBracket();
  return [
    ...stages
      .filter((s) => s.name !== 'plate')
      .map((s): Solid => ({ name: `bracket-${s.name}`, shape: s.shape, size: BRACKET_SIZE })),
    { name: 'through-slot', shape: slotBlock(), size: SMALL_SIZE },
    { name: 'T-union', shape: tUnion(), size: SMALL_SIZE },
    { name: 'stepped-L-union', shape: steppedL(), size: SMALL_SIZE },
  ];
}
