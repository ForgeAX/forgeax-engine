// ssao-bgl.test.ts — feat-20260612-hdrp-ssao M7 (round 2),
// scope-amend-webgl2-ubo (intensity folded into cluster_uniform.near_far_log.w).
//
// Covers w28 / w29 / w44:
//   w28 — HDRP unified BGL gains 2 SSAO entries (binding 7 texture_2d<f32>,
//         binding 8 sampler). Existing 5 entries (binding 0 + 3..6) remain
//         unchanged. Total = 7 entries. Intensity is read by the lighting
//         shader from cluster_uniform.near_far_log.w (binding 6) — the
//         dedicated @binding(9) UBO was removed to keep the fragment-stage
//         UBO count under WebGL2's max_uniform_buffers_per_shader_stage=11.
//   w29 — A 1x1 r8unorm white fallback texture is lazy-allocated on the
//         RenderSystemRuntime under label 'hdrp-ssao-fallback-white'; it is
//         created exactly once and reused on subsequent calls. SSAO disabled
//         path binds the fallback texture at binding 7.
//   w44 — createHdrpUnifiedBindGroup always emits 7 bind-group entries
//         (single-PSO invariant, plan-strategy D-B). Enabled path binds the
//         real ssaoBlurred texture view + ssaoSampler at bindings 7/8;
//         disabled path swaps binding 7 to the fallback white texture and
//         the host writes intensity=0 into cluster_uniform.
//
// plan-strategy §D-B / §D-C / §D-F :: tests live in this dedicated file so
// the existing 5-entry assertions in pipeline.unit.test.ts are migrated
// holistically (one-cut, no v1/v2 dual fixture).

import type {
  BindGroupLayout,
  Buffer,
  RhiCaps,
  RhiDevice,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import type { HdrpBuffers } from '../../../render/src/hdrp-buffers';
import {
  createHdrpClusterMembershipBindGroup,
  createHdrpClusterMembershipBindGroupLayoutDescriptor,
  createHdrpUnifiedBindGroup,
  getOrCreateSsaoFallbackTexture,
  packClusterUniform,
} from '../../../render/src/hdrp-buffers';
import { BYTES_PER_DIRECT_LIGHT_SLOT } from '../../../render/src/light-buffer-layout';
import { createHdrpBindGroupLayoutDescriptor } from '../../../render/src/pipeline-spec';
import type { RenderSystemRuntime } from '../../../render/src/render-system';

const FRAGMENT_VISIBILITY = 0x2;
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
    lightDataBytes: 256 * BYTES_PER_DIRECT_LIGHT_SLOT,
    clusterGridBuffer: mockBuffer('hdrp-cluster-grid'),
    clusterGridBytes: 1024,
    lightIndexListBuffer: mockBuffer('hdrp-light-index-list'),
    lightIndexListBytes: 4096,
    clusterUniformBuffer: mockBuffer('hdrp-cluster-uniform'),
    clusterUniformBytes: 32,
    lightBoundsBuffer: mockBuffer('hdrp-light-bounds'),
    lightBoundsBytes: 6144,
    grid: { x: 16, y: 9, z: 24 },
    unifiedBindGroupLayout: {
      label: 'hdrp-unified-bgl',
    } as unknown as HdrpBuffers['unifiedBindGroupLayout'],
  };
}

describe('HDRP GPU membership producer bind-group contract', () => {
  it('preserves the full 256-light Standard count in the cluster UBO', () => {
    const payload = new Uint32Array(packClusterUniform({ x: 16, y: 9, z: 24 }, 0.1, 50, 0, 256));
    expect(payload[3]).toBe(256);
  });

  it('keeps enabled SSAO intensity in the zero-punctual-light uniform path', () => {
    const payload = new Float32Array(packClusterUniform({ x: 16, y: 9, z: 24 }, 0.1, 50, 1, 0));
    expect(payload[3]).toBe(0);
    expect(payload[7]).toBe(1);
  });

  it('uses four compute-only bindings with read-write membership output', () => {
    const desc = createHdrpClusterMembershipBindGroupLayoutDescriptor();
    expect(desc.entries?.map((entry) => entry.binding)).toEqual([0, 1, 2, 3]);
    expect(desc.entries?.every((entry) => entry.visibility === COMPUTE_VISIBILITY)).toBe(true);
    expect(desc.entries?.find((entry) => entry.binding === 0)?.buffer?.type).toBe(
      'read-only-storage',
    );
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

// ── w28: BGL descriptor 7 entries (5 cluster + 2 ssao) ────────────────────

describe('w28 — HDRP unified BGL SSAO entries (binding 7/8)', () => {
  it('descriptor entries.length === 7 (5 cluster + 2 ssao)', () => {
    const desc = createHdrpBindGroupLayoutDescriptor();
    expect(desc.entries?.length).toBe(7);
  });

  it('binding 7 is texture_2d<f32> with FRAGMENT visibility (ssaoBlurred)', () => {
    const desc = createHdrpBindGroupLayoutDescriptor();
    const b7 = desc.entries?.find((e) => e.binding === 7);
    expect(b7).toBeDefined();
    expect(b7?.visibility).toBe(FRAGMENT_VISIBILITY);
    expect(b7?.texture?.sampleType).toBe('float');
    expect(b7?.texture?.viewDimension ?? '2d').toBe('2d');
  });

  it('binding 8 is sampler with FRAGMENT visibility (ssaoSampler)', () => {
    const desc = createHdrpBindGroupLayoutDescriptor();
    const b8 = desc.entries?.find((e) => e.binding === 8);
    expect(b8).toBeDefined();
    expect(b8?.visibility).toBe(FRAGMENT_VISIBILITY);
    expect(b8?.sampler).toBeDefined();
  });

  it('binding 9 is absent (scope-amend-webgl2-ubo: intensity folded into binding 6)', () => {
    const desc = createHdrpBindGroupLayoutDescriptor();
    const bindings = desc.entries?.map((e) => e.binding) ?? [];
    expect(bindings).not.toContain(9);
  });

  it('existing bindings 0/3/4/5/6 remain unchanged', () => {
    const desc = createHdrpBindGroupLayoutDescriptor();
    const b0 = desc.entries?.find((e) => e.binding === 0);
    expect(b0?.buffer?.hasDynamicOffset).toBe(true);
    for (const b of [3, 4, 5, 6]) {
      const e = desc.entries?.find((x) => x.binding === b);
      expect(e, `binding ${b} present`).toBeDefined();
    }
  });

  it('all bindings exactly { 0, 3, 4, 5, 6, 7, 8 }', () => {
    const desc = createHdrpBindGroupLayoutDescriptor();
    const bindings = new Set(desc.entries?.map((e) => e.binding));
    expect(bindings).toEqual(new Set([0, 3, 4, 5, 6, 7, 8]));
  });
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

// ── w44: createHdrpUnifiedBindGroup 7-entry invariant (enabled vs disabled) ──

describe('w44 — createHdrpUnifiedBindGroup SSAO entries (binding 7/8)', () => {
  it('enabled path: bind group has 7 entries with real ssaoBlurred view at binding 7', () => {
    const { runtime, createBindGroup } = makeMockRuntime();
    const hdrp = fakeHdrpBuffers();
    const ssaoBlurredView = mockTextureView('ssao-blurred-view');
    const meshSsbo = mockBuffer('mesh-ssbo');

    const bg = createHdrpUnifiedBindGroup(runtime, hdrp, meshSsbo, {
      enabled: true,
      ssaoBlurredView,
    });
    expect(bg).not.toBeNull();
    const desc = createBindGroup.mock.calls[0]?.[0] as
      | {
          entries?: Array<{ binding: number; resource: unknown }>;
        }
      | undefined;
    expect(desc?.entries?.length).toBe(7);
    const b7 = desc?.entries?.find((e) => e.binding === 7);
    const b7res = b7?.resource as { kind?: string; value?: unknown } | undefined;
    expect(b7res?.kind).toBe('textureView');
    expect(b7res?.value).toBe(ssaoBlurredView);
    const b8 = desc?.entries?.find((e) => e.binding === 8);
    expect((b8?.resource as { kind?: string } | undefined)?.kind).toBe('sampler');
    // scope-amend-webgl2-ubo: binding 9 is gone; intensity flows via
    // cluster_uniform.near_far_log.w on binding 6.
    const bindings = new Set(desc?.entries?.map((e) => e.binding));
    expect(bindings).not.toContain(9);
  });

  it('disabled path: bind group still has 7 entries; binding 7 = fallback white texture', () => {
    const { runtime, createBindGroup } = makeMockRuntime();
    const hdrp = fakeHdrpBuffers();
    const meshSsbo = mockBuffer('mesh-ssbo');

    const bg = createHdrpUnifiedBindGroup(runtime, hdrp, meshSsbo, { enabled: false });
    expect(bg).not.toBeNull();
    const desc = createBindGroup.mock.calls[0]?.[0] as
      | {
          entries?: Array<{ binding: number; resource: unknown }>;
        }
      | undefined;
    expect(desc?.entries?.length).toBe(7);
    const bindings = new Set(desc?.entries?.map((e) => e.binding));
    expect(bindings).toEqual(new Set([0, 3, 4, 5, 6, 7, 8]));
    // Binding 7 must resolve to a texture-view of the fallback white texture
    // (single-PSO invariant; plan-strategy §D-B).
    const b7 = desc?.entries?.find((e) => e.binding === 7);
    const b7res = b7?.resource as { kind?: string } | undefined;
    expect(b7res?.kind).toBe('textureView');
  });
});
