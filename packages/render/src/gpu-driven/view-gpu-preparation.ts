import {
  type ComputePipeline,
  err,
  ok,
  type Result,
  type RhiDevice,
  RhiError,
} from '@forgeax/engine-rhi';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';

export type GpuDrivenViewCreationInput = {
  readonly device: RhiDevice;
  readonly shaderModuleFactory: PipelineBuilderShaderModuleFactory;
  readonly labelPrefix?: string;
  /**
   * @internal
   * Falsifier hook: scales the HZB screen footprint. Production uses 1.
   */
  readonly occlusionFootprintScale?: number;
  /** Compile the shadow caster cull against the main camera's pyramid. */
  readonly shadowCameraCull?: boolean;
  /** Stock shadow consumers need only batch counters; detailed LOD reads are unavailable. */
  readonly readback?: 'complete' | 'culling-counts';
};
export type GpuDrivenViewCreationStep = void | Promise<void>;

export function viewCreationInvalid(): RhiError {
  return new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'the original live View construction demand and device',
    hint: 'discard this candidate and prepare again for the current owner',
  });
}

export function viewCreationSupported(
  device: RhiDevice,
  completion: boolean,
): Result<void, RhiError> {
  if (!device.caps.compute || !device.caps.storageBuffer || !device.caps.indirectDrawing) {
    return err(
      new RhiError({
        code: 'feature-not-enabled',
        expected: 'compute && storageBuffer && indirectDrawing',
        hint: 'use the CPU projection and direct submission fallback on this device',
      }),
    );
  }
  if (completion && device.createComputePipelineAsync === undefined)
    return err(
      new RhiError({
        code: 'feature-not-enabled',
        expected: 'completion-qualified native compute pipeline construction',
        hint: 'use a backend with asynchronous pipeline preparation before qualifying this View',
      }),
    );
  return ok(undefined);
}

export function* createViewResource<T>(
  current: () => boolean,
  create: () => Result<T, RhiError>,
): Generator<void, Result<T, RhiError>> {
  if (!current()) return err(viewCreationInvalid());
  const result = create();
  if (!result.ok) return result;
  if (!current()) return err(viewCreationInvalid());
  yield;
  return current() ? result : err(viewCreationInvalid());
}

export function* prepareViewPipeline(
  device: RhiDevice,
  descriptor: import('@forgeax/engine-rhi').ComputePipelineDescriptor,
  completion: boolean,
  current: () => boolean,
): Generator<GpuDrivenViewCreationStep, Result<ComputePipeline, RhiError>> {
  if (!current()) return err(viewCreationInvalid());
  const prepare = device.createComputePipelineAsync;
  if (completion && prepare === undefined)
    return err(
      new RhiError({
        code: 'feature-not-enabled',
        expected: 'completion-qualified native compute pipeline construction',
        hint: 'use a backend with asynchronous pipeline preparation before qualifying this View',
      }),
    );
  const requested = completion
    ? prepare?.call(device, descriptor)
    : device.createComputePipeline(descriptor);
  let result: Result<ComputePipeline, RhiError> | undefined;
  if (requested instanceof Promise) {
    const done = requested.then(
      (value) => {
        result = value;
      },
      (cause) => {
        result = err(
          cause instanceof RhiError
            ? cause
            : new RhiError({
                code: 'webgpu-runtime-error',
                expected: 'successful completion of the requested native View pipeline',
                hint: cause instanceof Error ? cause.message : String(cause),
              }),
        );
      },
    );
    while (result === undefined) yield done;
  } else result = requested;
  if (!current()) return err(viewCreationInvalid());
  yield;
  return result ?? err(viewCreationInvalid());
}
