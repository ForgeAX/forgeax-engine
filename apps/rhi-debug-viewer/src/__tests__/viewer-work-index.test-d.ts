import { describe, expectTypeOf, it } from 'vitest';
import type { ViewerModel } from '../viewer-model';

describe('viewer workIndex contract', () => {
  it('is the readonly FrameModel work projection', () => {
    expectTypeOf<ViewerModel['works'][number]['workIndex']>().toEqualTypeOf<number>();
    expectTypeOf<ViewerModel['works'][number]['eventIndex']>().toEqualTypeOf<number>();
  });

  it('selects a work without introducing an event-specific alias', () => {
    function selectWork(model: ViewerModel, workIndex: number) {
      const work = model.works[workIndex];
      return work?.eventIndex;
    }

    expectTypeOf(selectWork).returns.toEqualTypeOf<number | undefined>();
  });
});
