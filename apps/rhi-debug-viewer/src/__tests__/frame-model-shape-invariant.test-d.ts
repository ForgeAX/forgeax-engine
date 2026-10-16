import { describe, expectTypeOf, it } from 'vitest';
import type { CommandEntry, FrameModel } from '../viewer-model';

describe('canonical FrameModel shape', () => {
  it('uses eventIndex/passIndex and JSON-safe params', () => {
    expectTypeOf<CommandEntry['eventIndex']>().toEqualTypeOf<number>();
    expectTypeOf<CommandEntry['passIndex']>().toEqualTypeOf<number>();
    expectTypeOf<CommandEntry['params']>().not.toEqualTypeOf<ReadonlyMap<string, unknown>>();
  });

  it('exposes arrays for every canonical projection', () => {
    expectTypeOf<FrameModel['commands']>().toEqualTypeOf<readonly CommandEntry[]>();
    expectTypeOf<FrameModel['passes']>().toEqualTypeOf<readonly FrameModel['passes'][number][]>();
    expectTypeOf<FrameModel['resources']>().toEqualTypeOf<
      readonly FrameModel['resources'][number][]
    >();
    expectTypeOf<FrameModel['works']>().toEqualTypeOf<readonly FrameModel['works'][number][]>();
  });

  it('does not carry deleted legacy projections', () => {
    type Keys = keyof FrameModel;
    expectTypeOf<'tree' extends Keys ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<'draws' extends Keys ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<'meta' extends Keys ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<'resourceEntries' extends Keys ? true : false>().toEqualTypeOf<false>();
  });
});
