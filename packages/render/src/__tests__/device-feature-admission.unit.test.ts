import type { RhiAdapter, RhiDevice } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import {
  deriveDeviceFeatureAdmission,
  isTimestampQueryAdmitted,
} from '../assembly/device-feature-admission.js';

function adapter(
  features: string[],
  limits?: Readonly<Record<string, number>>,
): Pick<RhiAdapter, 'features'> & Partial<Pick<RhiAdapter, 'limits'>> {
  return {
    features: new Set(features) as RhiAdapter['features'],
    ...(limits === undefined ? {} : { limits }),
  };
}

function deviceCaps(
  timestampQuery: boolean,
  timestampPeriodNanoseconds: number | null,
): Pick<RhiDevice['caps'], 'timestampQuery' | 'timestampPeriodNanoseconds'> {
  return { timestampQuery, timestampPeriodNanoseconds };
}

describe('shared device feature admission', () => {
  it('admits precise HDR and bounded scratch only within adapter capabilities', () => {
    const full = deriveDeviceFeatureAdmission(
      adapter(['float32-filterable', 'float32-blendable', 'texture-formats-tier2'], {
        maxComputeWorkgroupStorageSize: 65536,
      }),
    );
    expect(full.requiredFeatures).toEqual([
      'depth32float-stencil8',
      'float32-filterable',
      'float32-blendable',
    ]);
    // The SSS compute shader writes rgba32float storage; its tier2 read-write
    // access is not part of this pipeline's capability contract.
    expect(full.requiredFeatures).not.toContain('texture-formats-tier2');
    expect(full.requiredLimits).toEqual({ maxComputeWorkgroupStorageSize: 32768 });
    const minimum = deriveDeviceFeatureAdmission(
      adapter([], { maxComputeWorkgroupStorageSize: 16384 }),
    );
    expect(minimum.requiredFeatures).toEqual(['depth32float-stencil8']);
    expect(minimum.requiredLimits).toBeUndefined();
    const partial = deriveDeviceFeatureAdmission(adapter(['float32-filterable']));
    expect(partial.requiredFeatures).toEqual(['depth32float-stencil8', 'float32-filterable']);
    expect(partial.requiredLimits).toBeUndefined();
  });
  it('admits visible-surface features only with the complete attachment capability', () => {
    const limits = { maxColorAttachments: 8, maxColorAttachmentBytesPerSample: 52 };
    const admitted = deriveDeviceFeatureAdmission(adapter(['primitive-index'], limits));
    expect(admitted.requiredFeatures).toContain('primitive-index');
    expect(admitted.requiredLimits?.maxColorAttachmentBytesPerSample).toBe(52);
    // The seven-target opt-in must not lower WebGPU's ordinary eight-target default.
    expect(admitted.requiredLimits).toEqual({ maxColorAttachmentBytesPerSample: 52 });
    for (const [features, supported] of [
      [[], limits],
      [['primitive-index'], { ...limits, maxColorAttachmentBytesPerSample: 32 }],
      [['primitive-index'], { ...limits, maxColorAttachments: 6 }],
    ] as const) {
      expect(
        deriveDeviceFeatureAdmission(adapter([...features], supported)).requiredFeatures,
      ).not.toContain('primitive-index');
    }
  });
  it.each([
    [[], 32, undefined],
    [[], 36, 36],
    [[], 40, 40],
    [[], 44, 44],
    [[], 48, 48],
    [[], 52, 52],
    [[], 64, 56],
    [['primitive-index'], 48, 48],
    [['primitive-index'], 52, 52],
    [['primitive-index'], 56, 56],
    [['primitive-index'], 60, 60],
    [['primitive-index'], 64, 64],
    [['primitive-index'], 68, 68],
    [['primitive-index'], 72, 72],
    [['primitive-index'], 128, 72],
  ] as const)('requests supported temporal MRT capacity for %j / %i bytes', (features, bytes, requested) => {
    const admitted = deriveDeviceFeatureAdmission(
      adapter([...features], {
        maxColorAttachments: 8,
        maxColorAttachmentBytesPerSample: bytes,
      }),
    );
    expect(admitted.requiredLimits?.maxColorAttachmentBytesPerSample).toBe(requested);
    expect(admitted.requiredLimits ?? {}).not.toHaveProperty('maxColorAttachments');
  });
  it('admits supported timestamps for a late DRS component and omits unsupported features', () => {
    const supported = adapter(['timestamp-query', 'texture-compression-bc']);
    const available = deriveDeviceFeatureAdmission(supported);
    const unsupported = deriveDeviceFeatureAdmission(adapter(['texture-compression-bc']));

    expect(available.requiredFeatures).toEqual([
      'depth32float-stencil8',
      'texture-compression-bc',
      'timestamp-query',
    ]);
    expect(unsupported.requiredFeatures).toEqual([
      'depth32float-stencil8',
      'texture-compression-bc',
    ]);
  });

  it('admits adapter-supported indirect-first-instance for two-phase GPU occlusion', () => {
    expect(
      deriveDeviceFeatureAdmission(adapter(['indirect-first-instance'])).requiredFeatures,
    ).toEqual(['depth32float-stencil8', 'indirect-first-instance']);
  });

  it('adds only adapter-supported timestamp-query once for either timing producer', () => {
    const result = deriveDeviceFeatureAdmission(adapter(['timestamp-query']));

    expect(result.requiredFeatures).toEqual(['depth32float-stencil8', 'timestamp-query']);
  });

  it.each([
    [48, 32],
    [32, 32],
    [31, 27],
    [27, 27],
    [26, 25],
    [25, 25],
    [24, 21],
    [23, 21],
    [21, 21],
    [20, undefined],
    [18, undefined],
    [17, undefined],
    [16, undefined],
  ])('requests an admitted topology within adapter limit %s', (limit, requested) => {
    expect(
      deriveDeviceFeatureAdmission(
        adapter([], { maxSampledTexturesPerShaderStage: limit as number }),
      ),
    ).toEqual({
      requiredFeatures: ['depth32float-stencil8'],
      ...(requested === undefined
        ? {}
        : { requiredLimits: { maxSampledTexturesPerShaderStage: requested } }),
    });
  });

  it('requires both device capability and a finite positive period before admission', () => {
    expect(isTimestampQueryAdmitted(deviceCaps(true, 1))).toBe(true);
    expect(isTimestampQueryAdmitted(deviceCaps(false, 1))).toBe(false);
    expect(isTimestampQueryAdmitted(deviceCaps(true, null))).toBe(false);
    expect(isTimestampQueryAdmitted(deviceCaps(true, Number.NaN))).toBe(false);
    expect(isTimestampQueryAdmitted(deviceCaps(true, 0))).toBe(false);
  });

  it('derives byte-identical initial and recovery request descriptors', () => {
    const supported = adapter(['texture-compression-etc2', 'timestamp-query']);

    expect(deriveDeviceFeatureAdmission(supported)).toEqual(
      deriveDeviceFeatureAdmission(supported),
    );
  });
});
