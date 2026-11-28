import type { DeviceCapabilities, DeviceLimits } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import {
  defaultViewportOutputInspection,
  isViewportOutputMode,
  VIEWPORT_OUTPUT_MODES,
  type ViewportOutputMode,
} from '../../viewport-output-contract';
import { createViewportOutputExtension } from '../index';

const WEBGPU_CAPS: DeviceCapabilities = {
  backendKind: 'webgpu',
  storageBuffer: true,
  compute: true,
  multisample: true,
  timestampQuery: true,
  float32Filterable: true,
  rgba16floatRenderable: true,
  maxColorAttachments: 8,
  maxBindGroups: 4,
  depthClipControl: true,
  indirectFirstInstance: true,
  textureCompressionBc: false,
  textureCompressionEtc2: false,
  textureCompressionAstc: false,
  shaderF16: false,
  dualSourceBlending: false,
  rg11b10ufloatRenderable: true,
  bgra8unormStorage: false,
  subgroups: false,
};

const WEBGPU_LIMITS: DeviceLimits = {
  maxTextureDimension1D: 8192,
  maxTextureDimension2D: 8192,
  maxTextureDimension3D: 2048,
  maxTextureArrayLayers: 256,
  maxBindGroups: 4,
  maxBindingsPerBindGroup: 1000,
  maxDynamicUniformBuffersPerPipelineLayout: 8,
  maxDynamicStorageBuffersPerPipelineLayout: 4,
  maxSampledTexturesPerShaderStage: 16,
  maxSamplersPerShaderStage: 16,
  maxStorageBuffersPerShaderStage: 8,
  maxStorageTexturesPerShaderStage: 4,
  maxUniformBuffersPerShaderStage: 12,
  maxUniformBufferBindingSize: 65536,
  maxStorageBufferBindingSize: 134217728,
  minUniformBufferOffsetAlignment: 256,
  minStorageBufferOffsetAlignment: 256,
  maxVertexBuffers: 8,
  maxBufferSize: 268435456,
  maxVertexAttributes: 16,
  maxVertexBufferArrayStride: 2048,
  maxColorAttachments: 8,
  maxColorAttachmentBytesPerSample: 64,
  maxComputeWorkgroupStorageSize: 16384,
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupSizeX: 256,
  maxComputeWorkgroupSizeY: 256,
  maxComputeWorkgroupSizeZ: 64,
  maxComputeWorkgroupsPerDimension: 65535,
};

const WEBGL2_CAPS: DeviceCapabilities = {
  ...WEBGPU_CAPS,
  backendKind: 'wgpu-webgl2',
  storageBuffer: false,
  compute: false,
  maxColorAttachments: 4,
};

describe('viewport output extension contract and resolution', () => {
  it('validates all 12 modes and rejects unknown modes', () => {
    expect(VIEWPORT_OUTPUT_MODES).toHaveLength(12);
    for (const mode of VIEWPORT_OUTPUT_MODES) {
      expect(isViewportOutputMode(mode)).toBe(true);
    }
    expect(isViewportOutputMode('wireframe')).toBe(false);
    expect(isViewportOutputMode('')).toBe(false);
    expect(isViewportOutputMode(null)).toBe(false);

    const ext = createViewportOutputExtension();
    expect(ext.getMode()).toBe('lit');
    expect(() => ext.setMode('invalid' as ViewportOutputMode)).toThrow(RangeError);
  });

  it('returns disabled native inspection by default when uninstalled', () => {
    expect(defaultViewportOutputInspection()).toEqual({
      enabled: false,
      requestedMode: 'lit',
      effectiveMode: 'lit',
      activePath: 'native',
      caveats: [],
    });
  });

  it('stays on native path with zero caveats and no AA suspension in lit mode', () => {
    const ext = createViewportOutputExtension();
    const res = ext.resolveView({
      deviceCaps: WEBGPU_CAPS,
      deviceLimits: WEBGPU_LIMITS,
      antialias: 'msaa',
      ambientOcclusionEnabled: false,
      compactGbuffer: false,
      hasReceiverGeometry: true,
    });
    expect(res).toEqual({
      enabled: true,
      requestedMode: 'lit',
      effectiveMode: 'lit',
      activePath: 'native',
      caveats: [],
      suspendMsaa: false,
      suspendTemporalAa: false,
    });
  });

  it('maps all 8 pure surface buffer modes into one shared surface-only topology bucket', () => {
    const ext = createViewportOutputExtension();
    const surfaceModes: readonly ViewportOutputMode[] = [
      'base-color',
      'world-normal',
      'geometric-normal',
      'metallic',
      'roughness',
      'material-ao',
      'emissive',
      'depth',
    ];
    for (const mode of surfaceModes) {
      ext.setMode(mode);
      const res = ext.resolveView({
        deviceCaps: WEBGPU_CAPS,
        deviceLimits: WEBGPU_LIMITS,
        antialias: 'none',
        ambientOcclusionEnabled: true,
        compactGbuffer: false,
        hasReceiverGeometry: true,
      });
      expect(res.activePath).toBe('gbuffer-visualizer');
      expect(res.effectiveMode).toBe(mode);
      expect(res.topologyBucket).toBe('surface-only');
    }
  });

  it('assigns distinct topology buckets for screen-ao, lighting-only, and overview', () => {
    const ext = createViewportOutputExtension();
    const expected: readonly [ViewportOutputMode, string][] = [
      ['screen-ao', 'surface-with-ao'],
      ['lighting-only', 'lighting-only'],
      ['overview', 'overview'],
    ];
    for (const [mode, bucket] of expected) {
      ext.setMode(mode);
      const res = ext.resolveView({
        deviceCaps: WEBGPU_CAPS,
        deviceLimits: WEBGPU_LIMITS,
        antialias: 'taa',
        ambientOcclusionEnabled: true,
        compactGbuffer: false,
        hasReceiverGeometry: true,
      });
      expect(res.topologyBucket).toBe(bucket);
      expect(res.suspendTemporalAa).toBe(true);
    }
  });

  it('reports structured unavailable state when device lacks GBuffer capability', () => {
    const ext = createViewportOutputExtension('base-color');
    const res = ext.resolveView({
      deviceCaps: WEBGL2_CAPS,
      deviceLimits: { ...WEBGPU_LIMITS, maxColorAttachmentBytesPerSample: 16 },
      antialias: 'msaa',
      ambientOcclusionEnabled: false,
      compactGbuffer: false,
      hasReceiverGeometry: false,
    });
    expect(res).toEqual({
      enabled: true,
      requestedMode: 'base-color',
      effectiveMode: 'lit',
      activePath: 'unavailable',
      unavailableReason: 'device-lacks-gbuffer',
      caveats: [],
      suspendMsaa: false,
      suspendTemporalAa: false,
    });
  });

  it('emits accurate caveats for MSAA suspension, disabled AO, specular AA roughness, and compact geometric normal', () => {
    const ext = createViewportOutputExtension('geometric-normal');
    const geoCompact = ext.resolveView({
      deviceCaps: WEBGPU_CAPS,
      deviceLimits: WEBGPU_LIMITS,
      antialias: 'msaa',
      ambientOcclusionEnabled: false,
      compactGbuffer: true,
      hasReceiverGeometry: false,
    });
    expect(geoCompact.suspendMsaa).toBe(true);
    expect(geoCompact.caveats).toContain('msaa-suspended-for-gbuffer');
    expect(geoCompact.caveats).toContain('geometric-normal-unavailable-in-compact-gbuffer');

    ext.setMode('overview');
    const overviewNoAo = ext.resolveView({
      deviceCaps: WEBGPU_CAPS,
      deviceLimits: WEBGPU_LIMITS,
      antialias: 'none',
      ambientOcclusionEnabled: false,
      compactGbuffer: false,
      hasReceiverGeometry: true,
    });
    expect(overviewNoAo.caveats).toContain('screen-ao-disabled');
    expect(overviewNoAo.caveats).toContain('roughness-includes-specular-aa');
    expect(overviewNoAo.caveats).toContain('forward-only-omitted');
  });
});
