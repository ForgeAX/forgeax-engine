import { expect, it } from 'vitest';
import { probeDepthTextureLoad } from '../depth-texture-load';
import { requestAdapterFrom } from '../index';

declare const __FORGEAX_COMPAT_PHASE__: string;

it('executes the native minimum without optional features and rejects a real over-budget layout', async () => {
  const compatibility =
    typeof __FORGEAX_COMPAT_PHASE__ === 'string' && __FORGEAX_COMPAT_PHASE__ === 'compatibility';
  let native: GPUDevice | undefined;
  const adapter = (
    await requestAdapterFrom(
      {
        async requestAdapter(options) {
          const raw = await navigator.gpu.requestAdapter(options);
          if (raw === null) throw new Error('Native adapter required; no fallback or skip');
          return {
            features: raw.features,
            limits: raw.limits,
            async requestDevice() {
              native = await raw.requestDevice({ requiredFeatures: [] });
              return native;
            },
          };
        },
      },
      { featureLevel: compatibility ? 'compatibility' : 'core' },
    )
  ).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  if (native === undefined) throw new Error('Missing actual native device');
  const raw = native;
  const errors: string[] = [];
  raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const texture = raw.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 6 });
  const output = raw.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 17 });
  const readback = raw.createBuffer({ size: 1024, usage: 9 });
  try {
    if (compatibility) expect(raw.features.has('core-features-and-limits')).toBe(false);
    expect(device.caps.depthTextureLoad).toBe(!compatibility);
    expect(device.caps.storageBuffer).toBe(!compatibility);
    expect(await probeDepthTextureLoad(raw)).toBe(!compatibility);
    expect(raw.features.has('timestamp-query')).toBe(false);
    expect(raw.features.has('float32-filterable')).toBe(false);
    const count = raw.limits.maxSampledTexturesPerShaderStage;
    expect(count).toBe(16);
    raw.pushErrorScope('validation');
    raw.createPipelineLayout({
      bindGroupLayouts: [
        raw.createBindGroupLayout({
          entries: Array.from({ length: count + 1 }, (_, binding) => ({
            binding,
            visibility: GPUShaderStage.FRAGMENT,
            texture: {},
          })),
        }),
      ],
    });
    expect(await raw.popErrorScope()).not.toBeNull();
    for (const [limit, resource] of [
      [raw.limits.maxSamplersPerShaderStage, { sampler: {} }],
      [raw.limits.maxUniformBuffersPerShaderStage, { buffer: { type: 'uniform' } }],
      [raw.limits.maxStorageBuffersPerShaderStage, { buffer: { type: 'read-only-storage' } }],
      [
        raw.limits.maxStorageTexturesPerShaderStage,
        { storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' } },
      ],
    ] as const) {
      raw.pushErrorScope('validation');
      raw.createPipelineLayout({
        bindGroupLayouts: [
          raw.createBindGroupLayout({
            entries: Array.from({ length: limit + 1 }, (_, binding) => ({
              binding,
              visibility: GPUShaderStage.FRAGMENT,
              ...resource,
            })),
          }),
        ],
      });
      expect(await raw.popErrorScope()).not.toBeNull();
    }
    raw.pushErrorScope('validation');
    raw.createPipelineLayout({
      bindGroupLayouts: Array.from({ length: raw.limits.maxBindGroups + 1 }, () =>
        raw.createBindGroupLayout({ entries: [] }),
      ),
    });
    expect(await raw.popErrorScope()).not.toBeNull();
    expect(() => raw.createQuerySet({ type: 'timestamp', count: 2 })).toThrow(/timestamp/i);

    raw.queue.writeTexture({ texture }, new Uint8Array([64, 128, 192, 255]), {}, [1, 1]);
    const module = raw.createShaderModule({
      code: `${Array.from({ length: count }, (_, binding) => `@group(0) @binding(${binding}) var t${binding}:texture_2d<f32>;`).join('\n')}
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3)); return vec4f(p[i],0,1);
}
@fragment fn fs()->@location(0) vec4f {
  return (${Array.from({ length: count }, (_, i) => `textureLoad(t${i},vec2i(0),0)`).join('+')})/${count}.0;
}`,
    });
    const pipeline = await raw.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    });
    const group = raw.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: Array.from({ length: count }, (_, binding) => ({
        binding,
        resource: texture.createView(),
      })),
    });
    for (let frame = 0; frame < 60; frame++) {
      const encoder = raw.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: output.createView(), loadOp: 'clear', storeOp: 'store' }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
      if (frame === 59)
        encoder.copyTextureToBuffer(
          { texture: output },
          { buffer: readback, bytesPerRow: 256 },
          [4, 4],
        );
      raw.queue.submit([encoder.finish()]);
      await raw.queue.onSubmittedWorkDone();
    }
    await readback.mapAsync(GPUMapMode.READ);
    expect(Array.from(new Uint8Array(readback.getMappedRange()).slice(0, 4))).toEqual([
      64, 128, 192, 255,
    ]);
    readback.unmap();
    expect(device.features.has('timestamp-query')).toBe(false);
    expect(errors).toEqual([]);
    // biome-ignore lint/suspicious/noConsole: Native identity and exact limits are gate evidence.
    console.log(
      JSON.stringify({
        kind: 'compatibility-profile',
        compatibility,
        adapter: {
          vendor: raw.adapterInfo.vendor,
          architecture: raw.adapterInfo.architecture,
          device: raw.adapterInfo.device,
          description: raw.adapterInfo.description,
        },
        limits: { sampledTextures: count, attachments: raw.limits.maxColorAttachments },
        completedFrames: 60,
        pixel: [64, 128, 192, 255],
      }),
    );
  } finally {
    texture.destroy();
    output.destroy();
    readback.destroy();
    raw.destroy();
  }
});
