import type { RhiCaps } from '@forgeax/engine-rhi';
import type { MaterialProgramAbi, MaterialSurfacePassKind } from '@forgeax/engine-types';
import { err, ok, type Result } from '@forgeax/engine-types';

export type SurfaceGpuCapability = 'compute' | 'storageBuffer' | 'indirectDrawing';
export type SurfaceGpuFallbackReason = SurfaceGpuCapability;

export type SurfaceGpuSubmissionErrorCode =
  | 'surface-abi-missing'
  | 'surface-pass-missing'
  | 'surface-producer-not-ready'
  | 'surface-generation-stale';

export interface SurfaceGpuSubmissionError {
  readonly code: SurfaceGpuSubmissionErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly pass: MaterialSurfacePassKind;
  readonly owner: 'surface-producer' | 'render-scene' | 'render-generation';
  readonly actual?: unknown;
}

export interface SurfaceGpuPassAdmission {
  readonly pass: MaterialSurfacePassKind;
  readonly lane: 'gpu-driven' | 'direct';
  readonly reason?: SurfaceGpuFallbackReason;
}

export interface SurfaceGpuSubmissionAdmission {
  readonly model: 'single-layer-medium';
  readonly lane: 'gpu-driven' | 'direct';
  readonly passes: readonly [SurfaceGpuPassAdmission, SurfaceGpuPassAdmission];
  readonly deviceGeneration: number;
}

export interface SurfaceGpuSubmissionInput {
  readonly abi: MaterialProgramAbi;
  readonly caps: Pick<RhiCaps, 'compute' | 'storageBuffer' | 'indirectDrawing'>;
  readonly sceneIndexReady: boolean;
  readonly resourcesReady: boolean;
  readonly dynamicInputReady: boolean;
  readonly deviceGeneration: number;
  readonly preparedDeviceGeneration: number;
}

const ERROR_POLICY: Readonly<
  Record<SurfaceGpuSubmissionErrorCode, { readonly expected: string; readonly hint: string }>
> = {
  'surface-abi-missing': {
    expected: 'a producer-published single-layer-medium ABI is present',
    hint: 'compose, reflect, and publish the Surface model before preparing the draw',
  },
  'surface-pass-missing': {
    expected: 'the published model contains both nearest-layer and color passes',
    hint: 'recook the complete model publication; do not synthesize a missing pass',
  },
  'surface-producer-not-ready': {
    expected: 'scene-index, resources, and dynamic input facts are ready for the published model',
    hint: 'repair the owning producer publication and retry; capability fallback does not cover stale assets',
  },
  'surface-generation-stale': {
    expected: 'prepared Surface facts belong to the current device generation',
    hint: 'rebuild the prepared surface resources for the current device generation',
  },
};

function failure(
  code: SurfaceGpuSubmissionErrorCode,
  pass: MaterialSurfacePassKind,
  owner: SurfaceGpuSubmissionError['owner'],
  actual?: unknown,
): SurfaceGpuSubmissionError {
  return {
    code,
    expected: ERROR_POLICY[code].expected,
    hint: ERROR_POLICY[code].hint,
    pass,
    owner,
    ...(actual === undefined ? {} : { actual }),
  };
}

function capabilityFallback(
  caps: SurfaceGpuSubmissionInput['caps'],
): SurfaceGpuFallbackReason | undefined {
  if (!caps.compute) return 'compute';
  if (!caps.storageBuffer) return 'storageBuffer';
  if (!caps.indirectDrawing) return 'indirectDrawing';
  return undefined;
}

/**
 * Admit the two Surface passes together. Capability fallback is explicit and
 * symmetric; a missing promised publication is a producer error and never a
 * silent direct fallback.
 */
export function admitSingleLayerMediumSubmission(
  input: SurfaceGpuSubmissionInput,
): Result<SurfaceGpuSubmissionAdmission, SurfaceGpuSubmissionError> {
  const firstPass: MaterialSurfacePassKind = 'nearest-layer';
  const surface = input.abi.surface;
  if (surface === undefined || surface.model !== 'single-layer-medium') {
    return err(failure('surface-abi-missing', firstPass, 'surface-producer', surface));
  }
  if (!surface.passes.includes('nearest-layer') || !surface.passes.includes('color')) {
    return err(failure('surface-pass-missing', firstPass, 'surface-producer', surface.passes));
  }
  if (input.deviceGeneration !== input.preparedDeviceGeneration) {
    return err(
      failure('surface-generation-stale', firstPass, 'render-generation', {
        deviceGeneration: input.deviceGeneration,
        preparedDeviceGeneration: input.preparedDeviceGeneration,
      }),
    );
  }
  const dynamicRequired = surface.dynamicInput !== undefined;
  if (
    !input.sceneIndexReady ||
    !input.resourcesReady ||
    (dynamicRequired && !input.dynamicInputReady)
  ) {
    return err(
      failure('surface-producer-not-ready', firstPass, 'surface-producer', {
        sceneIndexReady: input.sceneIndexReady,
        resourcesReady: input.resourcesReady,
        dynamicInputReady: input.dynamicInputReady,
      }),
    );
  }
  const fallback = capabilityFallback(input.caps);
  const admitted: [SurfaceGpuPassAdmission, SurfaceGpuPassAdmission] =
    fallback === undefined
      ? [
          { pass: firstPass, lane: 'gpu-driven' },
          { pass: 'color', lane: 'gpu-driven' },
        ]
      : [
          { pass: firstPass, lane: 'direct', reason: fallback },
          { pass: 'color', lane: 'direct', reason: fallback },
        ];
  return ok({
    model: 'single-layer-medium',
    lane: fallback === undefined ? 'gpu-driven' : 'direct',
    passes: admitted,
    deviceGeneration: input.deviceGeneration,
  });
}
