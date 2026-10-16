import {
  createUnavailableR32FloatReceipt,
  err,
  type Result,
  RhiError,
  type RhiTextureFormatCapabilityReceipt,
} from '@forgeax/engine-rhi';

/** CPU/WebGL2 wgpu lanes cannot provide pixel evidence for this profile. */
export function probeR32FloatCapability(
  deviceGeneration: number,
): Promise<Result<RhiTextureFormatCapabilityReceipt, RhiError>> {
  const receipt = createUnavailableR32FloatReceipt({
    deviceGeneration,
    failedStage: 'texture-create',
    detail: 'the wgpu CPU/WebGL2 lane has no real r32float profile executor',
  });
  return Promise.resolve(
    err(
      new RhiError({
        code: 'rhi-texture-format-capability-unavailable',
        expected: 'a real r32float profile executor for the active wgpu lane',
        hint: 'retain fallback-only rendering; use a real WebGPU or Dawn device',
        detail: {
          stage: 'texture-create',
          deviceGeneration,
          reason: receipt.stages[0]?.detail ?? 'real executor unavailable',
        },
      }),
    ),
  );
}
