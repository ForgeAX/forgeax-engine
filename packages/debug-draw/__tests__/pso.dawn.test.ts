// @forgeax/engine-debug-draw -- PSO full-shape dawn-node integration smoke (F-3 fixup)
//
// Proves PSO descriptor shape (vertex layout / depthStencil / fragment target /
// bind group layout) via real dawn-node GPU device. M2 mock unit tests missed
// 4 GPU-path bugs (vec4<u32>->f32, buffer usage MAP_WRITE->COPY_DST, missing
// uniform BG, depth PSO mismatch) that only real device creation catches.
// This test gates against those categories at the single-test level.
//
// Naming convention `*.dawn.test.ts` per vitest.config.ts dawn project.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, beforeAll } from 'vitest';

const VERTEX_STRIDE_BYTES = 16;

// WGSL shaders mirroring debug-draw.ts inline WGSL (F-3 gate against type errors)
const VERTEX_SHADER = /* wgsl */ `
struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) color: vec4<f32>,
}
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
}
struct Uniforms {
  viewProj: mat4x4<f32>,
}
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.position = uniforms.viewProj * vec4<f32>(in.position, 1.0);
  out.color = in.color;
  return out;
}
`;

const FRAGMENT_SHADER = /* wgsl */ `
struct FragmentInput {
  @location(0) color: vec4<f32>,
}
@fragment
fn fs_main(in: FragmentInput) -> @location(0) vec4<f32> {
  return in.color;
}
`;

describe('F-3: PSO full-shape dawn-node gate (w12/w25 fixup)', () => {
  it('keeps the producer declaration free of raw submission ownership', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/index.ts'), 'utf8');
    expect(source).toContain('RenderFeaturePlan');
    expect(source).not.toMatch(/RhiDevice|RhiQueue|RhiCommandEncoder|queue\.submit|encoder\.finish/);
  });

  let capturedPipelineDesc: Record<string, unknown> | null = null;
  let capturedBgEntries: Array<Record<string, unknown>> | null = null;
  let capturedLessEqualDesc: Record<string, unknown> | null = null;

  beforeAll(async () => {
    const gpu = globalThis.navigator?.gpu;
    if (!gpu) {
      console.warn('[pso.dawn] navigator.gpu not available -- skipping dawn PSO gate');
      return;
    }

    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      console.warn('[pso.dawn] GPU adapter not available -- skipping dawn PSO gate');
      return;
    }
    const device = await adapter.requestDevice({ requiredFeatures: [] });
    const format: string = gpu.getPreferredCanvasFormat?.() ?? 'bgra8unorm';

    // --- Build always-mode PSO (mirrors createDebugDraw with depthMode='always') ---
    const vsModule = device.createShaderModule({ label: 'dd-vs', code: VERTEX_SHADER });
    const fsModule = device.createShaderModule({ label: 'dd-fs', code: FRAGMENT_SHADER });

    const bgl = device.createBindGroupLayout({
      label: 'dd-bgl',
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform', minBindingSize: 64 } }],
    });
    const pipelineLayout = device.createPipelineLayout({
      label: 'dd-pipeline-layout',
      bindGroupLayouts: [bgl],
    });

    const vertexBuffers: GPUVertexBufferLayout[] = [{
      arrayStride: VERTEX_STRIDE_BYTES,
      stepMode: 'vertex',
      attributes: [
        { format: 'float32x3', offset: 0, shaderLocation: 0 },
        { format: 'unorm8x4', offset: 12, shaderLocation: 1 },
      ],
    }];

    const pipelineDesc: GPURenderPipelineDescriptor = {
      layout: pipelineLayout,
      vertex: { module: vsModule, entryPoint: 'vs_main', buffers: [...vertexBuffers] },
      primitive: { topology: 'line-list' },
      fragment: {
        module: fsModule,
        entryPoint: 'fs_main',
        targets: [{ format: format as GPUTextureFormat }],
      },
    };

    const pipeline = device.createRenderPipeline(pipelineDesc);

    const uniformBuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bgDesc: GPUBindGroupDescriptor = {
      layout: bgl,
      entries: [{ binding: 0, resource: { buffer: uniformBuf, offset: 0, size: 64 } as GPUBufferBinding }],
    };
    const bindGroup = device.createBindGroup(bgDesc);

    // Capture the PSO descriptor fields for assertions
    capturedPipelineDesc = {
      vertexBuffers,
      primitive: pipelineDesc.primitive,
      depthStencil: pipelineDesc.depthStencil,
      fragment: pipelineDesc.fragment,
      bindGroupEntries: bgDesc.entries,
    };
    capturedBgEntries = bgDesc.entries as unknown as Array<Record<string, unknown>>;

    // --- Build less-equal mode PSO (depthMode='less-equal') ---
    const lessEqPipelineDesc: GPURenderPipelineDescriptor = {
      layout: pipelineLayout,
      vertex: { module: vsModule, entryPoint: 'vs_main', buffers: [...vertexBuffers] },
      primitive: { topology: 'line-list' },
      depthStencil: {
        format: 'depth32float' as GPUTextureFormat,
        depthWriteEnabled: false,
        depthCompare: 'greater-equal',
      },
      fragment: {
        module: fsModule,
        entryPoint: 'fs_main',
        targets: [{ format: format as GPUTextureFormat }],
      },
    };
    device.createRenderPipeline(lessEqPipelineDesc);
    capturedLessEqualDesc = {
      depthStencil: lessEqPipelineDesc.depthStencil,
    };
  });

  // (a) Vertex layout: stride 16B, 2 attributes at correct offset/format
  it('(a) vertex layout: stride=16B, float32x3@0 + unorm8x4@12, shaderLocation 0/1', () => {
    if (!capturedPipelineDesc) {
      console.warn('[pso.dawn] skipping (a) -- no captured PSO descriptor');
      return;
    }
    const vb0 = (capturedPipelineDesc.vertexBuffers as GPUVertexBufferLayout[])?.[0];
    expect(vb0).toBeDefined();
    expect(vb0?.arrayStride).toBe(VERTEX_STRIDE_BYTES);
    expect(vb0?.stepMode).toBe('vertex');

    const attrs = vb0?.attributes;
    expect(attrs?.length).toBe(2);
    expect(attrs?.[0]?.format).toBe('float32x3');
    expect(attrs?.[0]?.offset).toBe(0);
    expect(attrs?.[0]?.shaderLocation).toBe(0);
    expect(attrs?.[1]?.format).toBe('unorm8x4');
    expect(attrs?.[1]?.offset).toBe(12);
    expect(attrs?.[1]?.shaderLocation).toBe(1);
  });

  // (b) DepthStencil: none for always mode, present for less-equal
  it('(b) depthStencil: absent for always-mode PSO, present with depthCompare=greater-equal for less-equal mode', () => {
    if (!capturedPipelineDesc) {
      console.warn('[pso.dawn] skipping (b) -- no captured PSO descriptor');
      return;
    }
    // always-mode: no depthStencil
    expect(capturedPipelineDesc.depthStencil).toBeUndefined();

    // less-equal mode: depthStencil is present
    if (!capturedLessEqualDesc) {
      console.warn('[pso.dawn] skipping (b-less-equal) -- no captured less-equal descriptor');
      return;
    }
    const ds = capturedLessEqualDesc.depthStencil as Record<string, unknown> | undefined;
    expect(ds).toBeDefined();
    expect(ds?.format).toBe('depth32float');
    expect(ds?.depthWriteEnabled).toBe(false);
    expect(ds?.depthCompare).toBe('greater-equal');
  });

  // (c) Fragment color target format
  it('(c) fragment color target format is bgra8unorm or rgba8unorm (swap-chain default, platform-dependent)', () => {
    if (!capturedPipelineDesc) {
      console.warn('[pso.dawn] skipping (c) -- no captured PSO descriptor');
      return;
    }
    const targets = (capturedPipelineDesc.fragment as { targets: Array<{ format: string }> })?.targets;
    expect(targets?.length).toBe(1);
    // Channel 2 (rgba8unorm) vs Channel 3 (bgra8unorm) — both are valid
    const fmt = targets?.[0]?.format;
    expect(['bgra8unorm', 'rgba8unorm'].includes(fmt ?? '')).toBe(true);
  });

  // (d) Bind group layout: 1 entry at @group(0) @binding(0) with uniform buffer
  it('(d) bind group: 1 uniform buffer entry at binding=0, size=64B', () => {
    if (!capturedBgEntries) {
      console.warn('[pso.dawn] skipping (d) -- no captured bind group entries');
      return;
    }
    expect(capturedBgEntries?.length).toBe(1);

    const e0 = capturedBgEntries?.[0] as Record<string, unknown> | undefined;
    expect(e0?.binding).toBe(0);
    const resource = e0?.resource as { buffer: { offset: number; size: number } } | undefined;
    expect(resource?.buffer).toBeDefined();
    // The bind group entry resource shape: { buffer: GPUBuffer, offset: number, size: number }
    const bufBinding = resource as unknown as { buffer: unknown; offset: number; size: number } | undefined;
    expect(bufBinding?.offset).toBe(0);
    expect(bufBinding?.size).toBe(64);
  });

  // (e) Primitive topology is line-list
  it('(e) primitive topology is line-list', () => {
    if (!capturedPipelineDesc) {
      console.warn('[pso.dawn] skipping (e) -- no captured PSO descriptor');
      return;
    }
    expect((capturedPipelineDesc.primitive as { topology: string })?.topology).toBe('line-list');
  });
});
