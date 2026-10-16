import {
  createUnavailableR32FloatReceipt,
  err,
  ok,
  R32FLOAT_PROBE_STAGES,
  type Result,
  RhiError,
  type RhiTextureFormatCapabilityReceipt,
  type RhiTextureFormatProbeStage,
  validateR32FloatReceipt,
} from '@forgeax/engine-rhi';

const TEXTURE_BINDING = 0x04;
const STORAGE_BINDING = 0x08;
const COPY_SRC = 0x01;
const COPY_DST = 0x02;
const MAP_READ = 0x0001;
const BUFFER_COPY_DST = 0x0008;

type RawDevice = GPUDevice;

/** Execute the complete real-device r32float profile without exposing raw handles. */
export async function probeR32FloatCapability(
  rawDevice: RawDevice,
  deviceGeneration: number,
): Promise<Result<RhiTextureFormatCapabilityReceipt, RhiError>> {
  let stage: RhiTextureFormatProbeStage = 'texture-create';
  let texture: GPUTexture | undefined;
  let readback: GPUBuffer | undefined;
  rawDevice.pushErrorScope('validation');
  try {
    texture = rawDevice.createTexture({
      size: { width: 2, height: 2, depthOrArrayLayers: 1 },
      format: 'r32float',
      mipLevelCount: 2,
      usage: TEXTURE_BINDING | STORAGE_BINDING | COPY_SRC | COPY_DST,
    });

    stage = 'mip-view';
    const sourceView = texture.createView({ baseMipLevel: 0, mipLevelCount: 1 });
    const destinationView = texture.createView({ baseMipLevel: 1, mipLevelCount: 1 });

    stage = 'sampled-storage-bind-group';
    const layout = rawDevice.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: 4,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
        {
          binding: 1,
          visibility: 4,
          storageTexture: { access: 'write-only', format: 'r32float', viewDimension: '2d' },
        },
      ],
    });
    const bindGroup = rawDevice.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: sourceView },
        { binding: 1, resource: destinationView },
      ],
    });

    stage = 'pipeline-bind';
    const shader = rawDevice.createShaderModule({
      code: `
        @group(0) @binding(0) var source: texture_2d<f32>;
        @group(0) @binding(1) var destination: texture_storage_2d<r32float, write>;
        @compute @workgroup_size(1) fn main() {
          let value = textureLoad(source, vec2i(0, 0), 0).r;
          textureStore(destination, vec2i(0, 0), vec4f(value));
        }
      `,
    });
    const pipeline = rawDevice.createComputePipeline({
      layout: rawDevice.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module: shader, entryPoint: 'main' },
    });

    const encoder = rawDevice.createCommandEncoder({ label: 'r32float-profile' });
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();

    stage = 'finish';
    readback = rawDevice.createBuffer({ size: 256, usage: MAP_READ | BUFFER_COPY_DST });
    encoder.copyTextureToBuffer(
      { texture, mipLevel: 1 },
      { buffer: readback, bytesPerRow: 256, rowsPerImage: 1 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
    const commandBuffer = encoder.finish();

    stage = 'submit';
    rawDevice.queue.submit([commandBuffer]);

    stage = 'completion';
    await rawDevice.queue.onSubmittedWorkDone();
    const validationError = await rawDevice.popErrorScope();
    if (validationError !== null) {
      throw new Error(`WebGPU validation: ${validationError.message}`);
    }

    stage = 'readback';
    await readback.mapAsync(MAP_READ);
    const values = Array.from(new Float32Array(readback.getMappedRange(0, 4).slice(0)));
    readback.unmap();
    const receipt: RhiTextureFormatCapabilityReceipt = {
      profile: 'r32float-mip-sampled-storage',
      verdict: 'admitted',
      evidence: 'real',
      deviceGeneration,
      stages: R32FLOAT_PROBE_STAGES.map((entry) => ({
        stage: entry,
        verdict: 'admitted',
        evidence: 'real',
      })),
      sampleType: 'unfilterable-float',
      usages: ['texture-binding', 'storage-binding', 'copy-src'],
      readback: { byteLength: 4, values },
      probeExecutions: 1,
    };
    const validated = validateR32FloatReceipt(receipt);
    return validated.ok ? ok(validated.value) : validated;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const receipt = createUnavailableR32FloatReceipt({
      deviceGeneration,
      failedStage: stage,
      detail: message,
    });
    void receipt;
    return err(
      new RhiError({
        code: 'rhi-texture-format-capability-unavailable',
        expected: `r32float profile stage ${stage} to complete on the live WebGPU device`,
        hint: 'retain fallback-only rendering and inspect the device validation error',
        detail: {
          stage,
          deviceGeneration,
          reason: message,
        },
      }),
    );
  } finally {
    texture?.destroy();
    readback?.destroy();
  }
}
