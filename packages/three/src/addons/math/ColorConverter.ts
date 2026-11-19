import { ColorConverter as OriginalColorConverter } from 'three/examples/jsm/math/ColorConverter.js';
import type { Color } from 'three/src/Three.Core.js';

export type { CMYK, HSL } from 'three/examples/jsm/math/ColorConverter.js';
export interface HSV {
  h: number;
  s: number;
  v: number;
}
/** getHSV writes v, and returns the caller's original output object. */
export const ColorConverter = OriginalColorConverter as unknown as Omit<
  typeof OriginalColorConverter,
  'getHSV'
> & { getHSV<T extends HSV>(color: Color, target: T): T };
