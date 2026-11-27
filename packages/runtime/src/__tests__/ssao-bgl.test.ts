import { clusterViewLayoutEntries } from '../../../render/src/environment/bindings';
// Cluster lighting and SSAO resource ownership.

import type {
  BindGroupLayout,
  Buffer,
  RhiCaps,
  RhiDevice,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import {
  packTestClusterUniform as packClusterUniform,
  STANDARD_CLUSTER_TEST_ABI,
} from '../../../render/src/__tests__/cluster-test-abi';
import type { HdrpBuffers } from '../../../render/src/hdrp-buffers';
import {
  createHdrpClusterMembershipBindGroup,
  createHdrpClusterMembershipBindGroupLayoutDescriptor,
  createHdrpUnifiedBindGroup,
  getOrCreateSsaoFallbackTexture,
} from '../../../render/src/hdrp-buffers';
import { createHdrpBindGroupLayoutDescriptor } from '../../../render/src/pipeline-spec';
import type { RenderSystemRuntime } from '../../../render/src/render-system';

const COMPUTE_VISIBILITY = 0x4;

function mockTexture(label: string): Texture {
  return { label } as unknown as Texture;
}

function mockTextureView(label: string): TextureView {
  return { label } as unknown as TextureView;
}

function mockBuffer(label: string): Buffer {
  return { label } as unknown as Buffer;
}

function makeMockRuntime(capsOverride: Partial<RhiCaps> = {}): {
  runtime: RenderSystemRuntime;
  createBuffer: ReturnType<typeof vi.fn>;
  createTexture: ReturnType<typeof vi.fn>;
  createTextureView: ReturnType<typeof vi.fn>;
  createSampler: ReturnType<typeof vi.fn>;
  createBindGroup: ReturnType<typeof vi.fn>;
  writeBuffer: ReturnType<typeof vi.fn>;
  writeTexture: ReturnType<typeof vi.fn>;
} {
  const createBuffer = vi.fn().mockImplementation((desc: { label?: string }) => ({
    ok: true,
    value: mockBuffer(desc.label ?? 'mock-buf'),
  }));
  const createTexture = vi.fn().mockImplementation((desc: { label?: string }) => ({
    ok: true,
    value: mockTexture(desc.label ?? 'mock-tex'),
  }));
  const createTextureView = vi
    .fn()
    .mockImplementation((_tex: unknown, desc: { label?: string }) => ({
      ok: true,
      value: mockTextureView(desc?.label ?? 'mock-view'),
    }));
  const createSampler = vi.fn().mockReturnValue({ ok: true, value: { label: 'mock-sampler' } });
  const createBindGroup = vi.fn().mockImplementation((desc: { label?: string }) => ({
    ok: true,
    value: { label: desc.label ?? 'mock-bg', _entries: desc },
  }));
  const writeBuffer = vi.fn().mockReturnValue({ ok: true, value: undefined });
  const writeTexture = vi.fn().mockReturnValue({ ok: true, value: undefined });

  const device = {
    caps: {
      backendKind: 'webgpu' as const,
      storageBuffer: true,
      float32Filterable: true,
      textureImport: false,
      externalTexture: false,
      maxColorAttachments: 8,
      maxStorageBuffersPerShaderStage: 8,
      ...capsOverride,
    },
    createBuffer,
    createTexture,
    createTextureView,
    createSampler,
    createBindGroup,
    queue: {
      writeBuffer,
      writeTexture,
    },
  } as unknown as RhiDevice;

  const errorRegistry = {
    fire: vi.fn(),
    listeners: new Set(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };

  const runtime = { device, errorRegistry } as unknown as RenderSystemRuntime;
  return {
    runtime,
    createBuffer,
    createTexture,
    createTextureView,
    createSampler,
    createBindGroup,
    writeBuffer,
    writeTexture,
  };
}

function fakeHdrpBuffers(): HdrpBuffers {
  return {
    kind: 'storage',
    device: {} as HdrpBuffers['device'],
    lightDataBuffer: mockBuffer('hdrp-light-data'),
    lightDataBytes: 256 * STANDARD_CLUSTER_TEST_ABI.directLightSlot.byteSize,
    clusterGridBuffer: mockBuffer('hdrp-cluster-grid'),
    clusterGridBytes: 1024,
    lightIndexListBuffer: mockBuffer('hdrp-light-index-list'),
    lightIndexListBytes: 4096,
    clusterUniformBuffer: mockBuffer('hdrp-cluster-uniform'),
    clusterUniformBytes: 96,
    lightBoundsBuffer: mockBuffer('hdrp-light-bounds'),
    lightBoundsBytes: 6144,
    grid: { x: 16, y: 9, z: 24 },
  };
}

describe('HDRP GPU membership producer bind-group contract', () => {
  it('preserves the full 256-light Standard count in the cluster UBO', () => {
    const payload = new Uint32Array(
      packClusterUniform({
        grid: { x: 16, y: 9, z: 24 },
        near: 0.1,
        far: 50,
        ssaoIntensity: 0,
        lightCount: 256,
      }),
    );
    expect(payload[3]).toBe(256);
  });

  it('keeps enabled SSAO intensity in the zero-punctual-light uniform path', () => {
    const payload = new Float32Array(
      packClusterUniform({
        grid: { x: 16, y: 9, z: 24 },
        near: 0.1,
        far: 50,
        ssaoIntensity: 1,
        lightCount: 0,
      }),
    );
    expect(payload[3]).toBe(0);
    expect(payload[7]).toBe(1);
  });

  it('uses four compute-only bindings with read-write membership output', () => {
    const desc = createHdrpClusterMembershipBindGroupLayoutDescriptor();
    expect(desc.entries?.map((entry) => entry.binding)).toEqual([0, 1, 2, 3]);
    expect(desc.entries?.every((entry) => entry.visibility === COMPUTE_VISIBILITY)).toBe(true);
    // The exact-froxel cull writes each cell's kept count back to cluster_grid.
    expect(desc.entries?.find((entry) => entry.binding === 0)?.buffer?.type).toBe('storage');
    expect(desc.entries?.find((entry) => entry.binding === 1)?.buffer?.type).toBe('storage');
    expect(desc.entries?.find((entry) => entry.binding === 2)?.buffer?.type).toBe('uniform');
    expect(desc.entries?.find((entry) => entry.binding === 3)?.buffer?.type).toBe(
      'read-only-storage',
    );
  });

  it('binds cluster grid, membership output, uniform, and CPU bounds in that order', () => {
    const { runtime, createBindGroup } = makeMockRuntime();
    const hdrp = fakeHdrpBuffers();
    const layout = { label: 'membership-layout' } as unknown as BindGroupLayout;

    const bindGroup = createHdrpClusterMembershipBindGroup(runtime, hdrp, layout);
    expect(bindGroup).not.toBeNull();
    const desc = createBindGroup.mock.calls[0]?.[0] as
      | { layout?: BindGroupLayout; entries?: Array<{ binding: number; resource: unknown }> }
      | undefined;
    expect(desc?.layout).toBe(layout);
    expect(desc?.entries?.map((entry) => entry.binding)).toEqual([0, 1, 2, 3]);
    const resources = desc?.entries?.map(
      (entry) => (entry.resource as { value?: { buffer?: Buffer } }).value?.buffer,
    );
    expect(resources).toEqual([
      hdrp.clusterGridBuffer,
      hdrp.lightIndexListBuffer,
      hdrp.clusterUniformBuffer,
      hdrp.lightBoundsBuffer,
    ]);
  });
});

it('declares Cluster separately from the dynamic Mesh layout', () => {
  const desc = createHdrpBindGroupLayoutDescriptor();
  expect(desc.entries?.map(({ binding }) => binding)).toEqual([0]);
  expect(clusterViewLayoutEntries(true).map(({ binding }) => binding)).toEqual([30, 31, 32, 33]);
  expect(clusterViewLayoutEntries(false).map(({ binding }) => binding)).toEqual([30, 33]);
  expect(desc.entries?.every(({ buffer }) => buffer !== undefined)).toBe(true);
  expect(desc.entries?.[0]?.buffer?.hasDynamicOffset).toBe(true);
});

// ── w29: 1x1 white fallback texture lazy alloc + cached ───────────────────

describe('w29 — 1x1 white fallback texture lazy alloc', () => {
  it('first call creates 1x1 r8unorm fallback texture with hdrp-ssao-fallback-white label', () => {
    const { runtime, createTexture, writeTexture } = makeMockRuntime();
    const tex = getOrCreateSsaoFallbackTexture(runtime);
    expect(tex).not.toBeNull();
    expect(createTexture).toHaveBeenCalledTimes(1);
    const desc = createTexture.mock.calls[0]?.[0] as
      | { label?: string; format?: string; size?: { width: number; height: number } }
      | undefined;
    expect(desc?.label).toBe('hdrp-ssao-fallback-white');
    expect(desc?.format).toBe('r8unorm');
    expect(desc?.size?.width).toBe(1);
    expect(desc?.size?.height).toBe(1);
    // Single byte 0xFF written for "white" (AO = 1.0).
    expect(writeTexture).toHaveBeenCalledTimes(1);
    const writeArgs = writeTexture.mock.calls[0];
    const data = writeArgs?.[1] as Uint8Array | undefined;
    expect(data).toBeInstanceOf(Uint8Array);
    expect(data?.[0]).toBe(255);
  });

  it('second call returns cached instance (createTexture called only once)', () => {
    const { runtime, createTexture } = makeMockRuntime();
    const tex1 = getOrCreateSsaoFallbackTexture(runtime);
    const tex2 = getOrCreateSsaoFallbackTexture(runtime);
    expect(tex1).toBe(tex2);
    expect(createTexture).toHaveBeenCalledTimes(1);
  });

  it('returns null when device.createTexture fails (charter P3 explicit failure)', () => {
    const { runtime } = makeMockRuntime();
    // Override createTexture to fail.
    (runtime.device as unknown as { createTexture: ReturnType<typeof vi.fn> }).createTexture = vi
      .fn()
      .mockReturnValue({
        ok: false,
        error: { code: 'webgpu-runtime-error', expected: 'createTexture ok', hint: 'boom' },
      });
    const tex = getOrCreateSsaoFallbackTexture(runtime);
    expect(tex).toBeNull();
  });
});

it('creates one clustered mesh group with no scene texture or sampler', () => {
  const { runtime, createBindGroup, createTexture } = makeMockRuntime();
  const group = createHdrpUnifiedBindGroup(runtime, {} as BindGroupLayout, mockBuffer('mesh-ssbo'));
  expect(group).not.toBeNull();
  const desc = createBindGroup.mock.calls[0]?.[0] as
    | { entries: Array<{ binding: number; resource: { kind: string } }> }
    | undefined;
  expect(desc?.entries.map(({ binding }) => binding)).toEqual([0]);
  expect(desc?.entries.every(({ resource }) => resource.kind === 'buffer')).toBe(true);
  expect(createTexture).not.toHaveBeenCalled();
});
