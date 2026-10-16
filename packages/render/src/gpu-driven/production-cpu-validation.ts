import type { GpuDrivenDrawReceipts } from '../record/gpu-draw-receipts';
import type { RenderableSnapshot } from '../render-system-extract';

export interface GpuDrivenCpuValidationTelemetryCache {
  readonly cacheKey: string;
  readonly validatedSources: readonly RenderableSnapshot[];
  readonly gpuOwnedDrawKeys: ReadonlySet<string>;
  readonly worldKeys: readonly number[] | undefined;
  readonly gpuOwnedDrawCount: number;
  readonly totalDrawItems: number;
  readonly gpuOwnedRows: number;
  readonly cpuFallbackDrawItems: number;
  readonly cpuSemanticFallbackDrawItems: number;
  readonly cpuDeformationFallbackDrawItems: number;
  readonly cpuDeformationReasons: ReadonlyMap<
    'skin-bounds-missing' | 'skin-address-missing' | 'resource-not-ready',
    number
  >;
  readonly blockedDrawItems: number;
  readonly drawReceipts: GpuDrivenDrawReceipts;
}

export function sameValidatedSourceSequence(
  expected: readonly RenderableSnapshot[],
  actual: readonly { readonly source: RenderableSnapshot }[],
): boolean {
  if (expected.length !== actual.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index] !== actual[index]?.source) return false;
  }
  return true;
}
