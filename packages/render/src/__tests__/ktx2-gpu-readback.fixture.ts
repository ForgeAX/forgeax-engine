import type { RhiDevice, Texture } from '@forgeax/engine-rhi';
import type { TextureAsset } from '@forgeax/engine-types';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';

export async function readbackTexture(
  device: RhiDevice,
  texture: TextureAsset,
  gpuTexture: { readonly handle: Texture },
  createShaderModule: typeof import('@forgeax/engine-rhi-webgpu').createShaderModule,
  mipLevel = 0,
): Promise<Uint8Array> {
  const width = Math.max(1, texture.shape.extent.width >> mipLevel);
  const height = Math.max(1, texture.shape.extent.height >> mipLevel);
  const hdr = texture.format === 'rgba16float' || texture.format.startsWith('bc6h');
  const outputFormat: GPUTextureFormat = hdr
    ? 'rgba16float'
    : texture.colorSpace === 'srgb'
      ? 'rgba8unorm-srgb'
      : 'rgba8unorm';
  const outputBytesPerPixel = hdr ? 8 : 4;
  const shader = await createShaderModule(device, {
    label: 'ktx2-basis-normalize',
    code: `
@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;

@vertex fn vs(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(positions[vertex], 0.0, 1.0);
}

@fragment fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let dimensions = vec2f(textureDimensions(source_texture));
  return textureSampleLevel(source_texture, source_sampler, position.xy / dimensions, 0.0);
}
`,
  });
  if (!shader.ok) throw new Error(`${shader.error.code}:${shader.error.hint}`);
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: 0x2, texture: { sampleType: 'float', viewDimension: '2d' } },
      { binding: 1, visibility: 0x2, sampler: { type: 'filtering' } },
    ],
  });
  if (!layout.ok) throw new Error(`${layout.error.code}:${layout.error.hint}`);
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout.value] });
  if (!pipelineLayout.ok)
    throw new Error(`${pipelineLayout.error.code}:${pipelineLayout.error.hint}`);
  const pipeline = device.createRenderPipeline({
    layout: pipelineLayout.value as never,
    vertex: { module: shader.value as never, entryPoint: 'vs', buffers: [] },
    fragment: {
      module: shader.value as never,
      entryPoint: 'fs',
      targets: [{ format: outputFormat }],
    },
    primitive: { topology: 'triangle-list' },
  });
  if (!pipeline.ok) throw new Error(`${pipeline.error.code}:${pipeline.error.hint}`);
  const sourceView = device.createTextureView(gpuTexture.handle, {
    baseMipLevel: mipLevel,
    mipLevelCount: 1,
  });
  if (!sourceView.ok) throw new Error(`${sourceView.error.code}:${sourceView.error.hint}`);
  const sampler = device.createSampler({ minFilter: 'nearest', magFilter: 'nearest' });
  if (!sampler.ok) throw new Error(`${sampler.error.code}:${sampler.error.hint}`);
  const bindings = device.createBindGroup({
    layout: layout.value,
    entries: [
      { binding: 0, resource: { kind: 'textureView', value: sourceView.value } },
      { binding: 1, resource: { kind: 'sampler', value: sampler.value } },
    ],
  });
  if (!bindings.ok) throw new Error(`${bindings.error.code}:${bindings.error.hint}`);
  const normalizedTexture = device.createTexture({
    size: { width, height, depthOrArrayLayers: 1 },
    format: outputFormat,
    usage: 0x10 | 0x01,
  } as never);
  if (!normalizedTexture.ok)
    throw new Error(`${normalizedTexture.error.code}:${normalizedTexture.error.hint}`);
  const normalizedView = device.createTextureView(normalizedTexture.value, {});
  if (!normalizedView.ok)
    throw new Error(`${normalizedView.error.code}:${normalizedView.error.hint}`);
  const readback = device.createBuffer({
    size: 256 * height,
    usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
  });
  if (!readback.ok) throw new Error(`${readback.error.code}:${readback.error.hint}`);
  const encoder = device.createCommandEncoder({ label: 'ktx2-basis-gpu-readback' });
  if (!encoder.ok) throw new Error(`${encoder.error.code}:${encoder.error.hint}`);
  const pass = encoder.value.beginRenderPass({
    colorAttachments: [
      {
        view: normalizedView.value as never,
        loadOp: 'clear',
        clearValue: [0, 0, 0, 0],
        storeOp: 'store',
      },
    ],
  });
  pass.setPipeline(pipeline.value);
  pass.setBindGroup(0, bindings.value);
  pass.draw(3, 1, 0, 0);
  pass.end();
  encoder.value.copyTextureToBuffer(
    { texture: normalizedTexture.value },
    {
      buffer: readback.value,
      offset: 0,
      bytesPerRow: 256,
      rowsPerImage: height,
    },
    { width, height, depthOrArrayLayers: 1 },
  );
  const command = encoder.value.finish();
  if (!command.ok) throw new Error(`${command.error.code}:${command.error.hint}`);
  const submitted = device.queue.submit([command.value]);
  if (!submitted.ok) throw new Error(`${submitted.error.code}:${submitted.error.hint}`);
  await device.queue.onSubmittedWorkDone();
  const mapped = (await readback.value.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
  const mappedBytes = new Uint8Array(mapped.getMappedRange().unwrap());
  const bytes = new Uint8Array(width * height * outputBytesPerPixel);
  for (let row = 0; row < height; row += 1) {
    bytes.set(
      mappedBytes.subarray(row * 256, row * 256 + width * outputBytesPerPixel),
      row * width * outputBytesPerPixel,
    );
  }
  mapped.unmap();
  device.destroyBuffer(readback.value);
  device.destroyTexture(normalizedTexture.value);
  return bytes;
}
