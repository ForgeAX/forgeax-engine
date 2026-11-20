import { expect, it } from 'vitest';
import { SINGLE_LAYER_MEDIUM_MSAA_SURFACE_PROGRAMS } from '../pipeline/single-layer-medium-passes';

const seedSource = `
@vertex fn vs_main(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4f {
  let corners = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(corners[vertex], 0, 1);
}
struct Output {
  @location(0) motion: vec4f,
  @builtin(frag_depth) depth: f32,
}
@fragment fn fs_main(@builtin(sample_index) sample: u32) -> Output {
  let depths = array(0.25, 0.5, 0.875, 0.125);
  return Output(vec4f(f32(sample + 1u), 0, 0, 1), depths[sample]);
}
`;

it.each([
  false,
  true,
])('resolves the same nearest Water sample with motion demand %s', async (motion) => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Dawn adapter unavailable');
  const device = await adapter.requestDevice({
    requiredFeatures: ['depth32float-stencil8'],
  });
  const size = { width: 1, height: 1 };
  const depthFormat = 'depth32float-stencil8';
  const textures: GPUTexture[] = [];
  const make = (format: GPUTextureFormat, sampleCount: number, copy: boolean) => {
    const texture = device.createTexture({
      size,
      format,
      sampleCount,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        (sampleCount === 4 ? GPUTextureUsage.TEXTURE_BINDING : 0) |
        (copy ? GPUTextureUsage.COPY_SRC : 0),
    });
    textures.push(texture);
    return texture;
  };
  const stride = 256;
  const readback = device.createBuffer({
    size: 3 * stride,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    device.pushErrorScope('validation');
    const sourceDepth = make(depthFormat, 4, false);
    const sourceMotion = make('rgba16float', 4, false);
    const selected = make('r32uint', 1, true);
    const rawDepth = make('r32float', 1, true);
    const resolvedDepth = make(depthFormat, 1, false);
    const resolvedMotion = motion ? make('rgba16float', 1, true) : undefined;
    const seed = device.createShaderModule({ code: seedSource });
    const resolveProgram = SINGLE_LAYER_MEDIUM_MSAA_SURFACE_PROGRAMS.find(
      ({ name }) =>
        name ===
        (motion
          ? 'forgeax.single-layer-medium-msaa-surface'
          : 'forgeax.single-layer-medium-msaa-depth'),
    );
    if (resolveProgram === undefined) throw new Error('Water resolve program unavailable');
    const resolve = device.createShaderModule({ code: resolveProgram.source });
    const depthStencil = {
      format: depthFormat,
      depthWriteEnabled: true,
      depthCompare: 'always',
    } as const;
    const seedPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: seed, entryPoint: 'vs_main' },
      fragment: { module: seed, entryPoint: 'fs_main', targets: [{ format: 'rgba16float' }] },
      depthStencil,
      multisample: { count: 4 },
    });
    const resolvePipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: resolve, entryPoint: 'vs_main' },
      fragment: {
        module: resolve,
        entryPoint: 'fs_main',
        targets: [
          { format: 'r32uint' },
          ...(motion ? [{ format: 'rgba16float' as const }] : []),
          { format: 'r32float' },
        ],
      },
      depthStencil,
    });
    const color = (texture: GPUTexture): GPURenderPassColorAttachment => ({
      view: texture.createView(),
      loadOp: 'clear',
      storeOp: 'store',
    });
    const depth = (texture: GPUTexture): GPURenderPassDepthStencilAttachment => ({
      view: texture.createView(),
      depthClearValue: 0,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
      stencilClearValue: 0,
      stencilLoadOp: 'clear',
      stencilStoreOp: 'discard',
    });
    const encoder = device.createCommandEncoder();
    const seedPass = encoder.beginRenderPass({
      colorAttachments: [color(sourceMotion)],
      depthStencilAttachment: depth(sourceDepth),
    });
    seedPass.setPipeline(seedPipeline);
    seedPass.draw(3);
    seedPass.end();
    const resolvePass = encoder.beginRenderPass({
      colorAttachments: [
        color(selected),
        ...(resolvedMotion === undefined ? [] : [color(resolvedMotion)]),
        color(rawDepth),
      ],
      depthStencilAttachment: depth(resolvedDepth),
    });
    resolvePass.setPipeline(resolvePipeline);
    resolvePass.setBindGroup(
      1,
      device.createBindGroup({
        layout: resolvePipeline.getBindGroupLayout(1),
        entries: [
          { binding: 3, resource: sourceDepth.createView({ aspect: 'depth-only' }) },
          ...(motion ? [{ binding: 5, resource: sourceMotion.createView() }] : []),
        ],
      }),
    );
    resolvePass.draw(3);
    resolvePass.end();
    for (const [index, texture] of [selected, rawDepth, resolvedMotion].entries()) {
      if (texture !== undefined)
        encoder.copyTextureToBuffer(
          { texture },
          { buffer: readback, offset: index * stride, bytesPerRow: stride },
          size,
        );
    }
    device.queue.submit([encoder.finish()]);
    const validation = await device.popErrorScope();
    if (validation !== null) throw new Error(validation.message);
    await readback.mapAsync(GPUMapMode.READ);
    const result = new DataView(readback.getMappedRange());
    expect(result.getUint32(0, true)).toBe(2);
    expect(result.getFloat32(stride, true)).toBe(0.875);
    if (motion) expect(result.getUint16(2 * stride, true)).toBe(0x4200); // fp16 3
  } finally {
    readback.destroy();
    for (const texture of textures) texture.destroy();
    device.destroy();
  }
});
