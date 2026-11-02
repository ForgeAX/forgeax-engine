import type { Buffer, RhiDevice, Texture } from '@forgeax/engine-rhi';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_STORAGE,
} from '../gpu-usage';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import { COOKIE_MIP_LEVEL_COUNT } from '../prepare/extended-lighting/resources';

const SAMPLES_BYTE_LENGTH = COOKIE_MIP_LEVEL_COUNT * 16;

async function readFloatSamples(buffer: Buffer): Promise<Float32Array> {
  const mapped = (await buffer.mapAsync(1)).unwrap();
  const range = mapped.getMappedRange().unwrap();
  const samples = new Float32Array(range.slice(0));
  mapped.unmap();
  return samples;
}

/** Read every published Mip through ordinary sampled-texture GPU work. */
export async function consumePublishedResampleMips(
  device: RhiDevice,
  target: Texture,
  slice: number,
  factory: PipelineBuilderShaderModuleFactory,
): Promise<Float32Array> {
  const sourceView = device
    .createTextureView(target, {
      label: 'light-texture-resample-dawn-published-consumer-source',
      dimension: '2d-array',
      baseMipLevel: 0,
      mipLevelCount: COOKIE_MIP_LEVEL_COUNT,
      baseArrayLayer: slice,
      arrayLayerCount: 1,
    })
    .unwrap();
  const layout = device
    .createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: 4,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' },
        },
        { binding: 1, visibility: 4, buffer: { type: 'storage', hasDynamicOffset: false } },
      ],
    })
    .unwrap();
  const module = factory
    .createShaderModule({
      label: 'light-texture-resample-dawn-published-consumer',
      code: `
@group(0) @binding(0) var source: texture_2d_array<f32>;
@group(0) @binding(1) var<storage, read_write> sampled: array<vec4<f32>>;
@compute @workgroup_size(1)
fn samplePublishedMips(@builtin(global_invocation_id) id: vec3<u32>) {
  let level = id.x;
  if (level >= ${COOKIE_MIP_LEVEL_COUNT}u) { return; }
  let dimensions = textureDimensions(source, i32(level));
  let coordinate = vec2<i32>(dimensions / vec2<u32>(2u));
  sampled[level] = textureLoad(source, coordinate, 0, i32(level));
}
`,
    })
    .unwrap();
  const pipeline = device
    .createComputePipeline({
      label: 'light-texture-resample-dawn-published-consumer',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
      compute: { module, entryPoint: 'samplePublishedMips' },
    })
    .unwrap();
  const output = device
    .createBuffer({
      label: 'light-texture-resample-dawn-published-consumer-output',
      size: SAMPLES_BYTE_LENGTH,
      usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC,
    })
    .unwrap();
  const readback = device
    .createBuffer({
      label: 'light-texture-resample-dawn-published-consumer-readback',
      size: SAMPLES_BYTE_LENGTH,
      usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
    })
    .unwrap();
  try {
    const group = device
      .createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { kind: 'textureView', value: sourceView } },
          { binding: 1, resource: { kind: 'buffer', value: { buffer: output } } },
        ],
      })
      .unwrap();
    const encoder = device.createCommandEncoder({ label: 'sample-produced-light-mips' }).unwrap();
    const pass = encoder.beginComputePass({ label: 'sample-produced-light-mips' });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(COOKIE_MIP_LEVEL_COUNT);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, SAMPLES_BYTE_LENGTH);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    return await readFloatSamples(readback);
  } finally {
    device.destroyBuffer(readback).unwrap();
    device.destroyBuffer(output).unwrap();
  }
}
