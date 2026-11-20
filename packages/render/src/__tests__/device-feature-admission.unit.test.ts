import type { RhiAdapter, RhiDevice } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  deriveDeviceFeatureAdmission,
  inspectDeviceCapabilities,
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
  it.each([
    undefined,
    0,
    8,
    9,
    10,
    16,
    32,
  ])('preserves the adapter storage-stage capacity %s for late material publication', (limit) => {
    const admitted = deriveDeviceFeatureAdmission(
      adapter([], limit === undefined ? {} : { maxStorageBuffersPerShaderStage: limit }),
    );
    expect(admitted.requiredLimits?.maxStorageBuffersPerShaderStage).toBe(
      limit !== undefined && limit > 8 ? limit : undefined,
    );
  });
  it('admits available float32 HDR features without requesting legacy subsurface scratch', () => {
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
    expect(full.requiredFeatures).not.toContain('texture-formats-tier2');
    expect(full.requiredLimits).toBeUndefined();
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
    [[], 52, 48],
    [[], 64, 48],
    [['primitive-index'], 48, 48],
    [['primitive-index'], 52, 52],
    [['primitive-index'], 56, 56],
    [['primitive-index'], 60, 60],
    [['primitive-index'], 64, 64],
    [['primitive-index'], 68, 64],
    [['primitive-index'], 72, 64],
    [['primitive-index'], 128, 64],
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

describe('actual renderer device inspection', () => {
  const info = (isFallbackAdapter: unknown = false) => ({
    vendor: 'actual-vendor',
    architecture: 'actual-architecture',
    device: 'actual-device',
    description: 'actual-description',
    isFallbackAdapter,
  });
  const fixture = (adapterInfo: unknown) => {
    const operations = {
      requestAdapter: vi.fn(),
      requestDevice: vi.fn(),
      submit: vi.fn(),
      probe: vi.fn(),
    };
    operations.requestAdapter.mockResolvedValue({ requestDevice: operations.requestDevice });
    const nativeDevice = vi.fn(() =>
      ok({ adapterInfo, queue: { submit: operations.submit } } as unknown as GPUDevice),
    );
    const device = {
      caps: { backendKind: 'webgpu' },
      limits: { maxTextureDimension2D: 8192 },
      nativeDevice,
      queue: { submit: operations.submit },
      probeTextureFormatCapability: operations.probe,
    } as unknown as RhiDevice;
    return { device, nativeDevice, operations };
  };

  it.each([
    false,
    true,
  ])('copies the actual native fallback flag %s without requesting GPU work', (fallback) => {
    const original = info(fallback);
    const { device, nativeDevice, operations } = fixture(original);
    vi.stubGlobal('navigator', { gpu: { requestAdapter: operations.requestAdapter } });
    try {
      const snapshot = inspectDeviceCapabilities(device, 7).deviceInfo;
      expect(snapshot).toEqual({ deviceGeneration: 7, adapterInfo: original });
      expect(nativeDevice).toHaveBeenCalledOnce();
      for (const operation of Object.values(operations)) expect(operation).not.toHaveBeenCalled();
      original.vendor = 'later';
      expect(snapshot?.adapterInfo?.vendor).toBe('actual-vendor');
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot?.adapterInfo)).toBe(true);
      expect(structuredClone(snapshot)).toEqual(snapshot);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    undefined,
    null,
    'false',
    0,
  ])('keeps an unavailable fallback flag %s unknown', (fallback) => {
    const original = info();
    Object.assign(original, { isFallbackAdapter: fallback });
    const { device } = fixture(original);
    expect(inspectDeviceCapabilities(device, 3).deviceInfo?.adapterInfo).toEqual({
      ...original,
      isFallbackAdapter: null,
    });
  });

  it.each([
    undefined,
    null,
    {},
    { vendor: 42 },
  ])('reports incomplete native adapter information %j as unavailable', (adapterInfo) => {
    const { device } = fixture(adapterInfo);
    expect(inspectDeviceCapabilities(device, 4).deviceInfo).toEqual({
      deviceGeneration: 4,
      adapterInfo: null,
    });
  });

  it('reports unavailable or throwing native access without changing device capabilities', () => {
    for (const nativeDevice of [
      () => ({ ok: false }),
      () => {
        throw new Error('native access');
      },
      () =>
        ok(
          Object.defineProperty({}, 'adapterInfo', {
            get() {
              throw new Error('native info');
            },
          }),
        ),
      () =>
        ok({
          adapterInfo: Object.defineProperty(info(), 'isFallbackAdapter', {
            get() {
              throw new Error('fallback info');
            },
          }),
        }),
    ]) {
      const { device } = fixture(info());
      Object.assign(device, { nativeDevice });
      const snapshot = inspectDeviceCapabilities(device, 6);
      expect(snapshot.deviceInfo).toEqual({ deviceGeneration: 6, adapterInfo: null });
      expect(snapshot.capabilities.backendKind).toBe('webgpu');
      expect(snapshot.limits.maxTextureDimension2D).toBe(8192);
    }
  });

  it('does not read native adapter information when its field is not selected', () => {
    const { device, nativeDevice } = fixture(info());
    const snapshot = inspectDeviceCapabilities(device, 5, false);
    expect(snapshot).not.toHaveProperty('deviceInfo');
    expect(nativeDevice).not.toHaveBeenCalled();
  });

  it('reads the current device and generation instead of retaining previous-generation facts', () => {
    const old = fixture(info(true));
    const replacement = fixture({ ...info(false), device: 'replacement-device' });
    const previous = inspectDeviceCapabilities(old.device, 8).deviceInfo;
    const current = inspectDeviceCapabilities(replacement.device, 9).deviceInfo;
    expect(previous?.deviceGeneration).toBe(8);
    expect(previous?.adapterInfo?.isFallbackAdapter).toBe(true);
    expect(current?.deviceGeneration).toBe(9);
    expect(current?.adapterInfo?.device).toBe('replacement-device');
    expect(current?.adapterInfo?.isFallbackAdapter).toBe(false);
    expect(old.nativeDevice).toHaveBeenCalledOnce();
    expect(replacement.nativeDevice).toHaveBeenCalledOnce();
  });
});
