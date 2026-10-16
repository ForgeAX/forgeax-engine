import { type CompiledRenderGraphInfo, RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type {
  BindGroupLayout,
  ComputePipeline,
  RhiCommandEncoder,
  RhiDevice,
} from '@forgeax/engine-rhi';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';

const BUFFER_USAGE_MAP_READ = 0x0001;
const BUFFER_USAGE_COPY_DST = 0x0008;
const HZB_SIZE = 8;
const HZB_MIPS = 4;

const SEED_WGSL = /* wgsl */ `
@group(0) @binding(0) var outputTexture: texture_storage_2d<r32float, write>;

@compute @workgroup_size(1)
fn seed(@builtin(global_invocation_id) id: vec3<u32>) {
  let value = f32(id.x + id.y * 8u) / 63.0;
  textureStore(outputTexture, vec2<i32>(id.xy), vec4<f32>(value, 0.0, 0.0, 1.0));
}
`;

const REDUCE_WGSL = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var outputTexture: texture_storage_2d<r32float, write>;

@compute @workgroup_size(1)
fn reduce(@builtin(global_invocation_id) id: vec3<u32>) {
  let sourceSize = textureDimensions(source);
  let base = vec2<i32>(id.xy * 2u);
  var maximum = 0.0;
  for (var y = 0; y < 2; y = y + 1) {
    for (var x = 0; x < 2; x = x + 1) {
      let coord = min(base + vec2<i32>(x, y), vec2<i32>(sourceSize) - vec2<i32>(1));
      maximum = max(maximum, textureLoad(source, coord, 0).x);
    }
  }
  textureStore(outputTexture, vec2<i32>(id.xy), vec4<f32>(maximum, 0.0, 0.0, 1.0));
}
`;

interface ComputeResources {
  readonly layout: BindGroupLayout;
  readonly pipeline: ComputePipeline;
}

async function computeResources(
  device: RhiDevice,
  code: string,
  entries: Parameters<RhiDevice['createBindGroupLayout']>[0]['entries'],
  entryPoint: string,
): Promise<ComputeResources> {
  const module = (await createShaderModule(device, { code })).unwrap();
  const layout = device.createBindGroupLayout({ entries }).unwrap();
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap();
  const pipeline = device
    .createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint } })
    .unwrap();
  return { layout, pipeline };
}

export interface HzbGraphEvidence {
  readonly graph: CompiledRenderGraphInfo;
  readonly finalDepth: number;
}

export async function runHzbGraph(): Promise<HzbGraphEvidence> {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  if (!device.caps.compute || !device.caps.storageTexture) {
    throw new Error(`required HZB capabilities unavailable: ${JSON.stringify(device.caps)}`);
  }
  const seed = await computeResources(
    device,
    SEED_WGSL,
    [
      {
        binding: 0,
        visibility: 0x4,
        storageTexture: { access: 'write-only', format: 'r32float', viewDimension: '2d' },
      },
    ],
    'seed',
  );
  const reduce = await computeResources(
    device,
    REDUCE_WGSL,
    [
      {
        binding: 0,
        visibility: 0x4,
        texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
      },
      {
        binding: 1,
        visibility: 0x4,
        storageTexture: { access: 'write-only', format: 'r32float', viewDimension: '2d' },
      },
    ],
    'reduce',
  );
  const readbackBuffer = device
    .createBuffer({
      label: 'hzb-readback',
      size: 256,
      usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
    })
    .unwrap();

  const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
  const hierarchy = graph
    .createTexture('hzb', {
      format: 'r32float',
      size: { width: HZB_SIZE, height: HZB_SIZE },
      mipLevelCount: HZB_MIPS,
    })
    .unwrap();
  const mips = Array.from({ length: HZB_MIPS }, (_, level) =>
    graph
      .view(hierarchy, {
        label: `hzb.mip-${level}`,
        baseMipLevel: level,
        mipLevelCount: 1,
      })
      .unwrap(),
  );
  const readback = graph
    .importBuffer(
      'hzb-readback',
      { size: 256, usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST },
      () => readbackBuffer,
    )
    .unwrap();
  const mip0 = mips[0];
  if (mip0 === undefined) throw new Error('HZB mip 0 is missing');
  graph
    .addComputePass('hzb-seed', {
      accesses: [{ resource: mip0, usage: 'storage-write' }],
      encode: ({ pass, resources }) => {
        const bindings = device
          .createBindGroup({
            layout: seed.layout,
            entries: [
              {
                binding: 0,
                resource: { kind: 'textureView', value: resources.textureView(mip0).unwrap() },
              },
            ],
          })
          .unwrap();
        pass.setPipeline(seed.pipeline);
        pass.setBindGroup(0, bindings);
        pass.dispatchWorkgroups(HZB_SIZE, HZB_SIZE, 1);
      },
    })
    .unwrap();
  for (let level = 1; level < HZB_MIPS; level += 1) {
    const source = mips[level - 1];
    const target = mips[level];
    if (source === undefined || target === undefined) throw new Error(`HZB mip ${level} missing`);
    const extent = HZB_SIZE >> level;
    graph
      .addComputePass(`hzb-reduce-${level}`, {
        accesses: [
          { resource: source, usage: 'sampled-read' },
          { resource: target, usage: 'storage-write' },
        ],
        encode: ({ pass, resources }) => {
          const bindings = device
            .createBindGroup({
              layout: reduce.layout,
              entries: [
                {
                  binding: 0,
                  resource: {
                    kind: 'textureView',
                    value: resources.textureView(source).unwrap(),
                  },
                },
                {
                  binding: 1,
                  resource: {
                    kind: 'textureView',
                    value: resources.textureView(target).unwrap(),
                  },
                },
              ],
            })
            .unwrap();
          pass.setPipeline(reduce.pipeline);
          pass.setBindGroup(0, bindings);
          pass.dispatchWorkgroups(extent, extent, 1);
        },
      })
      .unwrap();
  }
  const lastMip = mips[HZB_MIPS - 1];
  if (lastMip === undefined) throw new Error('HZB final mip is missing');
  graph
    .addCopyPass('hzb-readback', {
      accesses: [
        { resource: lastMip, usage: 'copy-src' },
        { resource: readback, usage: 'copy-dst' },
      ],
      encode: ({ encoder, resources }) => {
        encoder.copyTextureToBuffer(
          {
            texture: resources.texture(hierarchy).unwrap() as unknown as GPUTexture,
            mipLevel: HZB_MIPS - 1,
          },
          {
            buffer: resources.buffer(readback).unwrap() as unknown as GPUBuffer,
            bytesPerRow: 256,
            rowsPerImage: 1,
          },
          { width: 1, height: 1, depthOrArrayLayers: 1 },
        );
      },
    })
    .unwrap();

  const compiled = graph
    .compile({ device, surfaceSize: { width: HZB_SIZE, height: HZB_SIZE } })
    .unwrap();
  const encoder = device.createCommandEncoder({ label: 'hzb-frame' }).unwrap();
  compiled.execute({ encoder }).unwrap();
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  await device.queue.onSubmittedWorkDone();
  const mapped = (await readbackBuffer.mapAsync(BUFFER_USAGE_MAP_READ)).unwrap();
  const range = mapped.getMappedRange().unwrap();
  const finalDepth = new Float32Array(range.slice(0, 4))[0] ?? Number.NaN;
  mapped.unmap();
  const inspected = compiled.inspect();
  (await compiled.retire()).unwrap();
  device.destroyBuffer(readbackBuffer).unwrap();
  return { graph: inspected, finalDepth };
}
