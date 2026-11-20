import { err, type Result, RhiError, type ShaderModule } from '@forgeax/engine-rhi';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import type { GpuDrivenViewCreationStep } from './view-gpu';

/** Await only the original producer's exact pending module receipt. */
export function* prepareViewModule(
  factory: PipelineBuilderShaderModuleFactory,
  descriptor: Parameters<PipelineBuilderShaderModuleFactory['createShaderModule']>[0],
  current: () => boolean,
): Generator<GpuDrivenViewCreationStep, Result<ShaderModule, RhiError>> {
  const invalid = () =>
    err(
      new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'current native View module demand',
        hint: 'retry the actual current View owner',
      }),
    );
  for (;;) {
    if (!current()) return invalid();
    const module = factory.createShaderModule(descriptor);
    if (!current()) return invalid();
    if (module.ok) {
      yield;
      return current() ? module : invalid();
    }
    const completion = factory.pendingShaderModuleCompletion?.(module.error);
    if (completion === undefined) return module;
    yield completion.then((result) => {
      result.unwrap();
    });
  }
}
