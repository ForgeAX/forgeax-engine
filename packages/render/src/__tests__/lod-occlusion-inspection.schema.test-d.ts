import { expectTypeOf, test } from 'vitest';
import type { LodOcclusionInspection } from '../scene/visibility/inspection';

test('LOD occlusion inspection is detached JSON-safe POD', () => {
  const inspection = {} as LodOcclusionInspection;
  expectTypeOf(inspection.root.guid).toEqualTypeOf<string>();
  expectTypeOf(inspection.samples).toEqualTypeOf<
    readonly LodOcclusionInspection['samples'][number][]
  >();
  // @ts-expect-error live GPU handles must not cross the inspection boundary
  inspection.device;
  // @ts-expect-error mutable renderer state must not cross the inspection boundary
  inspection.mutableState;
});
