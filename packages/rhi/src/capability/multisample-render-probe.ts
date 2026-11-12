import { err, ok, type Result, RhiError } from '../errors';
import type { Buffer, RhiDevice, ShaderModule, Texture } from '../index';

/** The fixed Standard Forward attachment/resolve profile, qualified on this device. */
export interface MultisampleRenderCapability {
  readonly sampleCount: 4;
  readonly colorFormat: 'rgba16float';
  readonly depthFormat: 'depth32float-stencil8';
  readonly deviceGeneration: number;
  readonly evidence: 'real';
  readonly resolvedCoverage: readonly number[];
}

type ProbeResult = Result<MultisampleRenderCapability, RhiError>;
const probes = new WeakMap<
  RhiDevice,
  { readonly pending: Promise<ProbeResult>; result?: ProbeResult }
>();

export function multisampleRenderCapability(device: RhiDevice): ProbeResult | undefined {
  return probes.get(device)?.result;
}

/** Test attachment creation, depth testing, four-sample rasterization and HDR resolve together. */
export function probeMultisampleRenderCapability(
  device: RhiDevice,
  createModule: (descriptor: GPUShaderModuleDescriptor) => Result<ShaderModule, RhiError>,
  deviceGeneration: number,
): Promise<ProbeResult> {
  const previous = probes.get(device);
  if (previous !== undefined) return previous.pending;
  const entry: { pending: Promise<ProbeResult>; result?: ProbeResult } = {
    pending: executeProbe(device, createModule, deviceGeneration),
  };
  probes.set(device, entry);
  void entry.pending.then((result) => {
    entry.result = result;
  });
  return entry.pending;
}

async function executeProbe(
  device: RhiDevice,
  createModule: (descriptor: GPUShaderModuleDescriptor) => Result<ShaderModule, RhiError>,
  deviceGeneration: number,
): Promise<ProbeResult> {
  const textures: Texture[] = [];
  let readback: Buffer | undefined;
  let stage = 'texture-create';
  try {
    if (device.caps.backendKind === 'null') throw new Error('real GPU required');
    const makeTexture = (format: GPUTextureFormat, sampleCount: number, usage: number) => {
      const texture = device
        .createTexture({
          size: { width: 4, height: 4, depthOrArrayLayers: 1 },
          format,
          sampleCount,
          usage,
        })
        .unwrap();
      textures.push(texture);
      return texture;
    };
    const color = makeTexture('rgba16float', 4, 16);
    const depth = makeTexture('depth32float-stencil8', 4, 16);
    const resolve = makeTexture('rgba16float', 1, 16 | 1);
    stage = 'pipeline-bind';
    const module = createModule({
      label: 'standard-msaa4-resolve-profile',
      code: `
      struct VertexOutput { @builtin(position) position: vec4<f32>, @location(0) @interpolate(flat) blocked: u32 }
      @vertex fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> VertexOutput {
        let p = array<vec2<f32>, 3>(vec2<f32>(-1., -1.), vec2<f32>(1., -1.), vec2<f32>(-1., 1.));
        return VertexOutput(vec4<f32>(p[vertex], select(0.25, 0.75, instance > 0u), 1.), instance);
      }
      @fragment fn fs(input: VertexOutput) -> @location(0) vec4<f32> { return vec4<f32>(select(1., 0., input.blocked > 0u)); }
    `,
    }).unwrap();
    const pipeline = device
      .createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [] }).unwrap(),
        vertex: { module, entryPoint: 'vs', buffers: [] },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
        primitive: { topology: 'triangle-list' },
        depthStencil: {
          format: 'depth32float-stencil8',
          depthWriteEnabled: true,
          depthCompare: 'less',
        },
        multisample: { count: 4 },
      })
      .unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: device.createTextureView(color, {}).unwrap(),
          resolveTarget: device.createTextureView(resolve, {}).unwrap(),
          loadOp: 'clear',
          storeOp: 'discard',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
      depthStencilAttachment: {
        view: device.createTextureView(depth, {}).unwrap(),
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
        depthClearValue: 0.5,
        stencilLoadOp: 'clear',
        stencilStoreOp: 'discard',
        stencilClearValue: 0,
      },
    });
    pass.setPipeline(pipeline);
    // The farther instance must fail depth testing; only partial coverage from the near one resolves.
    pass.draw(3, 2);
    pass.end();
    readback = device.createBuffer({ size: 4 * 256, usage: 1 | 8 }).unwrap();
    encoder.copyTextureToBuffer(
      { texture: resolve },
      { buffer: readback, bytesPerRow: 256, rowsPerImage: 4 },
      { width: 4, height: 4, depthOrArrayLayers: 1 },
    );
    stage = 'submit';
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    stage = 'completion';
    await device.queue.onSubmittedWorkDone();
    stage = 'readback';
    const mapped = (await readback.mapAsync(1)).unwrap();
    const bytes = new DataView(mapped.getMappedRange().unwrap().slice(0));
    mapped.unmap();
    const coverage: number[] = [];
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) coverage.push(bytes.getUint16(y * 256 + x * 8, true));
    // IEEE binary16: zero, one, and quarter/half/three-quarter coverage are exact.
    if (
      !coverage.includes(0) ||
      !coverage.includes(0x3c00) ||
      !coverage.some((value) => value === 0x3400 || value === 0x3800 || value === 0x3a00)
    )
      throw new Error(
        `four-sample HDR resolve has no expected partial coverage: ${coverage.join(',')}`,
      );
    return ok({
      sampleCount: 4,
      colorFormat: 'rgba16float',
      depthFormat: 'depth32float-stencil8',
      deviceGeneration,
      evidence: 'real',
      resolvedCoverage: coverage,
    });
  } catch (cause) {
    return err(
      new RhiError({
        code: 'rhi-texture-format-capability-unavailable',
        expected: `Standard MSAA4 HDR/depth resolve stage ${stage} completes`,
        hint: 'Inspect the device capability failure before requesting Camera MSAA.',
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
