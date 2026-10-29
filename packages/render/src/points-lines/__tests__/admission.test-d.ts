import { expectTypeOf } from 'vitest';
import type { PointsLinesAdmission } from '../admission';

declare const admitted: PointsLinesAdmission;
if (admitted.component === 'Points') {
  expectTypeOf(admitted.shape).toEqualTypeOf<'square' | 'circle' | 'soft'>();
  expectTypeOf(admitted.sizeUnits).toEqualTypeOf<'pixels' | 'world'>();
  expectTypeOf(admitted.size).toEqualTypeOf<number>();
  // @ts-expect-error Line width is not a point admission fact.
  admitted.width;
} else {
  expectTypeOf(admitted.width).toEqualTypeOf<number>();
  expectTypeOf(admitted.widthUnits).toEqualTypeOf<'pixels' | 'world'>();
  expectTypeOf(admitted.cap).toEqualTypeOf<'butt' | 'round'>();
  expectTypeOf(admitted.dashSize).toEqualTypeOf<number>();
  // @ts-expect-error Point shape is not a line admission fact.
  admitted.shape;
}
