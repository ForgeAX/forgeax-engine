import { expectTypeOf, it } from 'vitest';
import type { FrameModel } from '../frame-model';

type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false;
type IsReadonlyMap<T> = T extends ReadonlyMap<unknown, unknown> ? true : false;

it('exposes only the canonical JSON-safe model shape', () => {
  expectTypeOf<HasKey<FrameModel, 'commands'>>().toEqualTypeOf<true>();
  expectTypeOf<HasKey<FrameModel, 'passes'>>().toEqualTypeOf<true>();
  expectTypeOf<HasKey<FrameModel, 'resources'>>().toEqualTypeOf<true>();
  expectTypeOf<HasKey<FrameModel, 'works'>>().toEqualTypeOf<true>();
  expectTypeOf<HasKey<FrameModel, 'tree'>>().toEqualTypeOf<false>();
  expectTypeOf<HasKey<FrameModel, 'draws'>>().toEqualTypeOf<false>();
  expectTypeOf<HasKey<FrameModel, 'meta'>>().toEqualTypeOf<false>();
  expectTypeOf<HasKey<FrameModel, 'resourceLifecycle'>>().toEqualTypeOf<true>();
  expectTypeOf<IsReadonlyMap<FrameModel['resources']>>().toEqualTypeOf<false>();
  expectTypeOf<FrameModel['works'][number]['workIndex']>().toEqualTypeOf<number>();
  expectTypeOf<FrameModel['works'][number]['eventIndex']>().toEqualTypeOf<number>();
  expectTypeOf<FrameModel['works'][number]['passIndex']>().toEqualTypeOf<number>();
});
