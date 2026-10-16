import { expect } from 'vitest';
import { appendInjection, buildPbrMaterialUserRegionEntries } from '../pbr-pipeline';

export async function verifyMaterialVertexTexture(): Promise<void> {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('WebGPU adapter unavailable');
  const device = await adapter.requestDevice();
  try {
    const entries = buildPbrMaterialUserRegionEntries([
      { name: 'displacement', type: 'texture2d' },
    ]);
    for (const entry of appendInjection(entries, 'ibl')) expect(entry.visibility).toBe(2);
    device.pushErrorScope('validation');
    const module = device.createShaderModule({
      code: `@group(0) @binding(1) var s: sampler;
@group(0) @binding(2) var t: texture_2d<f32>;
@vertex fn vs() -> @builtin(position) vec4<f32> { return vec4<f32>(textureSampleLevel(t,s,vec2<f32>(0.5),0.0).xyz,1.0); }
@fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }`,
    });
    device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [device.createBindGroupLayout({ entries })],
      }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    });
    expect(await device.popErrorScope()).toBeNull();
  } finally {
    device.destroy();
  }
}
