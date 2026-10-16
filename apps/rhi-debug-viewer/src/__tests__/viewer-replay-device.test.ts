import { replayDeviceRequest, type V7Tape } from '@forgeax/engine-rhi-debug';
import { describe, expect, it } from 'vitest';

function tape(rhiCaps: V7Tape['header']['rhiCaps']): V7Tape {
  return {
    header: { formatVersion: 7, rhiCaps, eventCount: 0, blobCount: 0 },
    bootstrap: [],
    events: [],
    blobs: [],
  };
}

describe('viewer fresh replay device request', () => {
  it('enables every recorded WebGPU feature that the adapter exposes', () => {
    const request = replayDeviceRequest(
      tape({
        timestampQuery: true,
        textureCompressionBc: true,
        textureCompressionEtc2: true,
        textureCompressionAstc: true,
        firstInstanceIndirect: true,
        float32Filterable: true,
        textureImport: false,
        externalTexture: false,
        rg11b10ufloatRenderable: true,
      }),
      new Set<GPUFeatureName>([
        'timestamp-query',
        'texture-compression-bc',
        'texture-compression-etc2',
        'texture-compression-astc',
        'indirect-first-instance',
        'float32-filterable',
        'rg11b10ufloat-renderable',
      ]),
      { maxUniformBufferBindingSize: 262_144, maxTextureDimension2D: 16_384 },
    );

    expect(request.requiredFeatures).toEqual([
      'timestamp-query',
      'texture-compression-bc',
      'texture-compression-etc2',
      'texture-compression-astc',
      'indirect-first-instance',
      'float32-filterable',
      'rg11b10ufloat-renderable',
    ]);
    expect(request.requiredLimits).toEqual({
      maxUniformBufferBindingSize: 262_144,
      maxTextureDimension2D: 16_384,
    });
  });

  it('never requests a feature that the adapter does not expose', () => {
    const request = replayDeviceRequest(
      tape({
        textureCompressionBc: true,
        textureCompressionEtc2: true,
        textureCompressionAstc: false,
      }),
      new Set<GPUFeatureName>(['texture-compression-bc', 'texture-compression-astc']),
      {},
    );

    expect(request.requiredFeatures).toEqual(['texture-compression-bc']);
    expect(request).not.toHaveProperty('requiredLimits');
  });
});
