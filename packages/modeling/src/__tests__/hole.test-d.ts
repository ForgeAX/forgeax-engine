import { expectTypeOf, it } from 'vitest';
import type { HoleCutOptions, ThreadDesignation } from '../index';

it('closes thread designations and the segments or tolerance choice', () => {
  expectTypeOf<'M8'>().toExtend<ThreadDesignation>();
  expectTypeOf<'M8x9'>().not.toExtend<ThreadDesignation>();
  expectTypeOf<{
    kind: 'tapped';
    thread: 'M8';
    depth: 'through';
    centers: [];
    segments: 12;
    tolerance: 1e-4;
  }>().not.toExtend<HoleCutOptions>();
});
