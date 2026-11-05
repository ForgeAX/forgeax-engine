import { err, ok, type Result, RhiError } from '../errors';
import type { Buffer, RhiDevice, ShaderModule, Texture } from '../index';
import {
  R32FLOAT_MIP_SAMPLED_RENDER_PROFILE,
  R32FLOAT_RENDER_PROBE_STAGES,
  type RhiTextureFormatCapabilityReceipt,
  type RhiTextureFormatProbeStage,
} from './texture-format';

const probes = new WeakMap<
  RhiDevice,
  Promise<Result<RhiTextureFormatCapabilityReceipt, RhiError>>
>();

/** Qualify the raster/copy/sample chain through opaque RHI handles on either backend. */
export async function probeR32FloatRenderCapability(
  device: RhiDevice,
  createModule: (descriptor: GPUShaderModuleDescriptor) => Result<ShaderModule, RhiError>,
  deviceGeneration: number,
): Promise<Result<RhiTextureFormatCapabilityReceipt, RhiError>> {
  const prior = probes.get(device);
  if (prior !== undefined) return prior;
  const probe = executeProbe(device, createModule, deviceGeneration);
  probes.set(device, probe);
  return probe;
}

async function executeProbe(
  device: RhiDevice,
  createModule: (descriptor: GPUShaderModuleDescriptor) => Result<ShaderModule, RhiError>,
  deviceGeneration: number,
): Promise<Result<RhiTextureFormatCapabilityReceipt, RhiError>> {
  let stage: RhiTextureFormatProbeStage = 'texture-create';
  const textures: Texture[] = [];
  let readback: Buffer | undefined;
  try {
    if (device.caps.backendKind === 'null') throw new Error('real GPU required');
    const source = device
      .createTexture({
        format: 'r32float',
        size: { width: 2, height: 2, depthOrArrayLayers: 1 },
        mipLevelCount: 2,
        usage: 1 | 2 | 4,
      })
      .unwrap();
    textures.push(source);
    const scratch = device
      .createTexture({
        format: 'r32float',
        size: { width: 1, height: 1, depthOrArrayLayers: 1 },
        usage: 1 | 16,
      })
      .unwrap();
    textures.push(scratch);
    device.queue
      .writeTexture(
        { texture: source },
        new Float32Array([37.25, 1, 2, 3]),
        { bytesPerRow: 8, rowsPerImage: 2 },
        { width: 2, height: 2, depthOrArrayLayers: 1 },
      )
      .unwrap();
    stage = 'mip-view';
    const view = device.createTextureView(source, { baseMipLevel: 0, mipLevelCount: 1 }).unwrap();
    const output = device.createTextureView(scratch, {}).unwrap();
    stage = 'sampled-render-bind-group';
    const layout = device
      .createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: 2,
            texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
          },
        ],
      })
      .unwrap();
    const group = device
      .createBindGroup({
        layout,
        entries: [{ binding: 0, resource: { kind: 'textureView', value: view } }],
      })
      .unwrap();
    stage = 'pipeline-bind';
    const module = createModule({
      label: 'r32float-render-profile',
      code: `
      @group(0) @binding(0) var source: texture_2d<f32>;
      @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
        let p = array<vec2<f32>, 3>(vec2<f32>(-1., -1.), vec2<f32>(3., -1.), vec2<f32>(-1., 3.));
        return vec4<f32>(p[i], 0., 1.);
      }
      @fragment fn fs() -> @location(0) f32 { return textureLoad(source, vec2<i32>(0), 0).r; }
    `,
    }).unwrap();
    const pipeline = device
      .createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
        vertex: { module, entryPoint: 'vs', buffers: [] },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'r32float' }] },
        primitive: { topology: 'triangle-list' },
      })
      .unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: output, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
    encoder.copyTextureToTexture(
      { texture: scratch },
      { texture: source, mipLevel: 1 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
    readback = device.createBuffer({ size: 256, usage: 1 | 8 }).unwrap();
    encoder.copyTextureToBuffer(
      { texture: source, mipLevel: 1 },
      { buffer: readback, bytesPerRow: 256, rowsPerImage: 1 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
    stage = 'finish';
    const command = encoder.finish().unwrap();
    stage = 'submit';
    device.queue.submit([command]).unwrap();
    stage = 'completion';
    await device.queue.onSubmittedWorkDone();
    stage = 'readback';
    const mapped = (await readback.mapAsync(1)).unwrap();
    const value = new Float32Array(mapped.getMappedRange().unwrap().slice(0))[0];
    mapped.unmap();
    if (value !== 37.25) throw new Error(`r32float raster/copy readback mismatch: ${value}`);
    return ok({
      profile: R32FLOAT_MIP_SAMPLED_RENDER_PROFILE,
      verdict: 'admitted',
      evidence: 'real',
      deviceGeneration,
      stages: R32FLOAT_RENDER_PROBE_STAGES.map((stage) => ({
        stage,
        verdict: 'admitted',
        evidence: 'real',
      })),
      sampleType: 'unfilterable-float',
      usages: ['texture-binding', 'render-attachment', 'copy-src'],
      readback: { byteLength: 4, values: [value] },
      probeExecutions: 1,
    });
  } catch (cause) {
    return err(
      new RhiError({
        code: 'rhi-texture-format-capability-unavailable',
        expected: `r32float raster profile stage ${stage} completes`,
        hint: 'retain fallback-only rendering and inspect the live device failure',
        detail: {
          stage,
          deviceGeneration,
          reason: cause instanceof Error ? cause.message : String(cause),
        },
      }),
    );
  } finally {
    for (const texture of textures) device.destroyTexture(texture);
    if (readback !== undefined) device.destroyBuffer(readback);
  }
}
