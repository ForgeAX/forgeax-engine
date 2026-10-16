import { describe, expectTypeOf, it } from 'vitest';
import type { ViewerModel } from '../viewer-model';

describe('ViewerModel canonical field inference', () => {
  it('infers arrays and JSON values at panel boundaries', () => {
    function panelBody(vm: ViewerModel) {
      const command = vm.commands[0];
      const resource = vm.resources[0];
      const work = vm.works[0];
      return {
        commandKind: command?.kind ?? '',
        resourceId: resource?.resourceId,
        workIndex: work?.workIndex,
      };
    }

    expectTypeOf(panelBody).returns.toMatchTypeOf<{
      commandKind: string;
      resourceId: string | undefined;
      workIndex: number | undefined;
    }>();
  });

  it('keeps bindings and pipeline facts structured without Map access', () => {
    function panelBody(vm: ViewerModel) {
      const work = vm.works[0];
      return {
        binding: work?.bindings[0]?.binding,
        pipelineStatus: work?.pipeline.status,
      };
    }

    expectTypeOf(panelBody).returns.toMatchTypeOf<{
      binding: number | undefined;
      pipelineStatus: 'available' | 'unavailable' | undefined;
    }>();
  });
});
