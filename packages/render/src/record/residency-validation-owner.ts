import type { RhiDevice } from '@forgeax/engine-rhi';
import type { DispatchEntry, RenderableSnapshot } from '../render-system-extract';
import type { ValidatedRenderable } from './frame-snapshot';
import type { PipelineState } from './render-context';

export interface GpuDrivenResidencyValidationInput {
  readonly cacheKey: string;
  readonly renderables: readonly RenderableSnapshot[];
  readonly transparentDispatch: readonly DispatchEntry[];
  readonly pipelineState: PipelineState;
  readonly pipelineHandle: number;
  readonly meshResidencyEpoch: number;
  readonly deviceGeneration: number;
  readonly assetCatalogEpoch: number;
}
interface ValidationCache extends GpuDrivenResidencyValidationInput {
  readonly value: readonly ValidatedRenderable[];
  readonly dispatchRenderableIndices: readonly (number | undefined)[];
}

/** The original complete residency publication and its existing lifetime fences. */
export class ResidencyValidationOwner {
  private cached: ValidationCache | undefined;
  hits = 0;
  scans = 0;

  reuse(
    input: GpuDrivenResidencyValidationInput,
    device: RhiDevice,
  ): readonly ValidatedRenderable[] | undefined {
    const cached = this.cached;
    if (
      cached === undefined ||
      cached.cacheKey !== input.cacheKey ||
      cached.pipelineState !== input.pipelineState ||
      cached.pipelineState.device !== device ||
      cached.pipelineHandle !== input.pipelineHandle ||
      cached.meshResidencyEpoch !== input.meshResidencyEpoch ||
      cached.deviceGeneration !== input.deviceGeneration ||
      cached.assetCatalogEpoch !== input.assetCatalogEpoch ||
      !same(cached.renderables, input.renderables) ||
      !same(cached.transparentDispatch, input.transparentDispatch) ||
      !sameIndices(cached.dispatchRenderableIndices, input.transparentDispatch)
    )
      return undefined;
    this.hits++;
    return cached.value;
  }
  remember(input: GpuDrivenResidencyValidationInput, value: readonly ValidatedRenderable[]): void {
    this.cached = {
      ...input,
      value,
      dispatchRenderableIndices: input.transparentDispatch.map((entry) => entry.renderableIndex),
    };
    this.scans++;
  }
  clear(): void {
    this.cached = undefined;
  }
}
function same<T>(expected: readonly T[], actual: readonly T[]): boolean {
  if (expected.length !== actual.length) return false;
  for (let index = 0; index < expected.length; index++)
    if (expected[index] !== actual[index]) return false;
  return true;
}
function sameIndices(
  expected: readonly (number | undefined)[],
  actual: readonly DispatchEntry[],
): boolean {
  if (expected.length !== actual.length) return false;
  for (let index = 0; index < expected.length; index++)
    if (expected[index] !== actual[index]?.renderableIndex) return false;
  return true;
}
