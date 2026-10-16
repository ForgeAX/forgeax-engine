import { expectTypeOf } from 'vitest';
import { BOUNDING_2D_TESTS, type Bounding2dTest } from '../bounding-2d.js';

expectTypeOf<Bounding2dTest>().toEqualTypeOf<(typeof BOUNDING_2D_TESTS)[number]>();
