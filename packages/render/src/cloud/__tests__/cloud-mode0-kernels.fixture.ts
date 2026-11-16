/// <reference types="@webgpu/types" />

// Read production functions, not a second implementation of their math.
const sources = {
  reconstruct: new URL('../../../../shader/src/cloud/reconstruct.wgsl', import.meta.url),
  compose: new URL('../../../../shader/src/cloud/compose.wgsl', import.meta.url),
  coordinates: new URL('../../../../shader/src/cloud/coordinates.wgsl', import.meta.url),
  medium: new URL('../../../../shader/src/cloud/medium.wgsl', import.meta.url),
  lighting: new URL('../../../../shader/src/cloud/lighting.wgsl', import.meta.url),
  common: new URL('../../../../shader/src/common.wgsl', import.meta.url),
};
export async function loadCloudKernel(name: keyof typeof sources): Promise<string> {
  const url = sources[name];
  const source =
    url.protocol === 'file:'
      ? await (await import('node:fs/promises')).readFile(url, 'utf8')
      : await (await fetch(url)).text();
  return source
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n');
}
export async function cloudKernelVertex(): Promise<string> {
  const common = await loadCloudKernel('common');
  const start = common.indexOf('struct FullscreenOutput {');
  const end = common.indexOf('// Stable screen-space noise', start);
  if (start < 0 || end < 0) throw new Error('Production fullscreen vertex contract missing');
  return `${common.slice(start, end)}
@vertex fn vs_main(@builtin(vertex_index) id:u32)->FullscreenOutput { return fullscreen_triangle(id); }`;
}

/** Kernel probe; complete Mode0 adapters retain their separate Dawn gates. */
export async function readCloudComposition(
  device: GPUDevice,
  options: {
    readonly width?: number;
    readonly height?: number;
    readonly transport?: readonly [number, number, number, number];
    readonly sceneMeters?: number;
    readonly cloudMeters?: number;
    readonly opacity?: number;
  } = {},
): Promise<Float32Array> {
  const width = options.width ?? 4,
    height = options.height ?? 4;
  const transport = options.transport ?? [0, 0, 0, 1];
  const module = device.createShaderModule({
    code: `${await loadCloudKernel('reconstruct')}\n${await loadCloudKernel('compose')}
${await cloudKernelVertex()}
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var<uniform> params:array<vec4f,2>;
@fragment fn fs_main(input:FullscreenOutput)->@location(0) vec4f {
  let background=textureLoad(source,vec2i(input.uv*vec2f(textureDimensions(source))),0);
  let d=params[1].y;
  let sample=CloudReconstructionSample(params[0],params[0],vec4f(d));
  let samples=array<CloudReconstructionSample,4>(sample,sample,sample,sample);
  let cloud=cloud_bilateral_upsample(samples,params[1].x,vec4f(0.25),5000.0);
  return vec4f(cloud_compose_transport(background.rgb,cloud),background.a);
}`,
  });
  const errors = (await module.getCompilationInfo()).messages.filter(
    (entry) => entry.type === 'error',
  );
  if (errors.length) throw new Error(JSON.stringify(errors));
  const pipeline = await device.createRenderPipelineAsync({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs_main' },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba32float' }] },
  });
  const source = device.createTexture({
    size: [width, height],
    format: 'rgba32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const output = device.createTexture({
    size: [width, height],
    format: 'rgba32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const params = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const readback = device.createBuffer({
    size: 256 * height,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  try {
    const pixels = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        pixels.set(
          [(20 + y * 60) / 255, (7 + x * 31) / 255, (240 - y * 40) / 255, options.opacity ?? 1],
          (y * width + x) * 4,
        );
    device.queue.writeTexture({ texture: source }, pixels, { bytesPerRow: width * 16 }, [
      width,
      height,
    ]);
    device.queue.writeBuffer(
      params,
      0,
      new Float32Array([
        ...transport,
        options.sceneMeters ?? 10000,
        options.cloudMeters ?? 1000,
        0,
        0,
      ]),
    );
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: source.createView() },
        { binding: 1, resource: { buffer: params } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: output.createView(), loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer({ texture: output }, { buffer: readback, bytesPerRow: 256 }, [
      width,
      height,
    ]);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const result = new Float32Array(width * height * 4);
    const mapped = new Float32Array(readback.getMappedRange());
    for (let y = 0; y < height; y++)
      result.set(mapped.subarray(y * 64, y * 64 + width * 4), y * width * 4);
    readback.unmap();
    return result;
  } finally {
    source.destroy();
    output.destroy();
    params.destroy();
    readback.destroy();
  }
}
