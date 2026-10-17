import type {
  ComputePipelineDescriptor,
  RenderPipelineDescriptor,
  RhiDevice,
} from '@forgeax/engine-rhi';
import { disposeDevice, makeRhiDevice } from '../device';
import { createShaderModule, createShaderModuleImmediate } from '../index';

const graphics = `
@vertex fn vs(@builtin(vertex_index) index:u32)->@builtin(position) vec4f {
  let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  return vec4f(p[index],0,1);
}
@fragment fn fs()->@location(0) vec4f { return vec4f(0.25,0.5,0.75,1); }
`;
const computation =
  '@group(0) @binding(0) var<storage,read_write> value:array<u32>; @compute @workgroup_size(1) fn cs(){value[0]=73u;}';

/** Real native creation, fresh-device import and pixel/storage readback. */
export async function verifyPipelineLibraryGpu(
  gpu: GPU,
  verifyReady?: (
    device: RhiDevice,
    render: RenderPipelineDescriptor,
    compute: ComputePipelineDescriptor,
  ) => Promise<unknown>,
) {
  const adapter = await gpu.requestAdapter(),
    nextAdapter = await gpu.requestAdapter();
  if (adapter === null || nextAdapter === null) throw new Error('WebGPU adapter unavailable');
  const rawA = await adapter.requestDevice(),
    rawB = await nextAdapter.requestDevice();
  const a = makeRhiDevice(rawA).device,
    b = makeRhiDevice(rawB).device;
  const libraryA = a.pipelineLibrary,
    libraryB = b.pipelineLibrary;
  if (libraryA === undefined || libraryB === undefined)
    throw new Error('Missing WebGPU pipeline library');
  const errors: string[] = [];
  for (const raw of [rawA, rawB])
    raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const descriptor = (device: typeof a, code = graphics) => {
    const module = createShaderModuleImmediate(device, {
      code,
      label: 'pipeline-library-fixture',
    }).unwrap();
    return {
      layout: device.createPipelineLayout({ bindGroupLayouts: [] }).unwrap(),
      vertex: { module, entryPoint: 'vs', buffers: [] },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' as const }] },
    };
  };
  try {
    const firstShader = (await createShaderModule(a, { code: graphics, label: 'first' })).unwrap();
    const sameShader = (
      await createShaderModule(a, { code: graphics, label: 'later alias' })
    ).unwrap();
    if (firstShader !== sameShader)
      throw new Error('Shader source aliases did not share completed diagnostics');
    a.createRenderPipeline(descriptor(a)).unwrap();
    a.createComputePipeline({
      layout: 'auto',
      compute: {
        module: createShaderModuleImmediate(a, { code: computation }).unwrap(),
        entryPoint: 'cs',
      },
    }).unwrap();
    const manifest = JSON.parse(JSON.stringify(libraryA.export().unwrap()));
    const started = performance.now();
    const prepared = (await libraryB.prepare(manifest)).unwrap();
    const warmupMs = performance.now() - started;
    const pipeline = b.createRenderPipeline(descriptor(b)).unwrap() as unknown as GPURenderPipeline;
    const texture = rawB.createTexture({
      size: [8, 8],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const readback = rawB.createBuffer({
      size: 256 * 8,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const storage = rawB.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const storageRead = rawB.createBuffer({
      size: 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = rawB.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
      ],
    });
    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow: 256 }, [8, 8]);
    const compute = b
      .createComputePipeline({
        layout: 'auto',
        compute: {
          module: createShaderModuleImmediate(b, { code: computation }).unwrap(),
          entryPoint: 'cs',
        },
      })
      .unwrap() as unknown as GPUComputePipeline;
    const computePass = encoder.beginComputePass();
    computePass.setPipeline(compute);
    computePass.setBindGroup(
      0,
      rawB.createBindGroup({
        layout: compute.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: storage } }],
      }),
    );
    computePass.dispatchWorkgroups(1);
    computePass.end();
    encoder.copyBufferToBuffer(storage, 0, storageRead, 0, 4);
    rawB.queue.submit([encoder.finish()]);
    await Promise.all([readback.mapAsync(GPUMapMode.READ), storageRead.mapAsync(GPUMapMode.READ)]);
    const pixel = Array.from(
      new Uint8Array(readback.getMappedRange()).slice(4 * 256 + 4 * 4, 4 * 256 + 4 * 4 + 4),
    );
    const computed = new Uint32Array(storageRead.getMappedRange())[0];
    readback.unmap();
    storageRead.unmap();
    const reused = libraryB.inspect();
    const admission = await verifyReady?.(b, descriptor(b), {
      layout: 'auto',
      compute: {
        module: createShaderModuleImmediate(b, { code: computation }).unwrap(),
        entryPoint: 'cs',
      },
    });
    const changed = b
      .createRenderPipeline(descriptor(b, graphics.replace('0.25,0.5,0.75,1', '0.75,0.25,0.0,1')))
      .unwrap();
    if ((changed as unknown) === pipeline)
      throw new Error('Changed same-label shader reused the previous pipeline');
    await rawB.queue.onSubmittedWorkDone();
    if (pixel.some((v, i) => Math.abs(v - ([64, 128, 191, 255][i] ?? -999)) > 1) || computed !== 73)
      throw new Error('Warm library changed rendered/compute output');
    if (
      reused.synchronousCreations !== 0 ||
      reused.compilationCompleted !== 2 ||
      reused.pipelineHits !== 2
    )
      throw new Error('Gameplay did not reuse the completed imported pipelines');
    if (errors.length) throw new Error(errors.join('\n'));
    texture.destroy();
    readback.destroy();
    storage.destroy();
    storageRead.destroy();
    return {
      pixel,
      computed,
      warmupMs,
      admission,
      prepared,
      reused,
      sourceInvalidation: libraryB.inspect(),
      errors,
    };
  } finally {
    disposeDevice(a);
    disposeDevice(b);
  }
}
