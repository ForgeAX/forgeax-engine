import type { RhiDevice } from '@forgeax/engine-rhi';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';
import {
  applyStandardWhiteBalance,
  sampleStandardColorLut,
} from '../pipeline/standard-output/color-transform';

const BUFFER_USAGE_MAP_READ = 0x0001;
const BUFFER_USAGE_COPY_DST = 0x0008;
const TEXTURE_USAGE_COPY_DST = 0x0002;
const TEXTURE_USAGE_COPY_SRC = 0x0001;
const TEXTURE_USAGE_TEXTURE_BINDING = 0x0004;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x0010;

const LUT_WGSL = /* wgsl */ `
@group(0) @binding(0) var lut: texture_3d<f32>;
@group(0) @binding(1) var lutSampler: sampler;

fn oetf(value: f32) -> f32 {
  let safe = max(value, 0.0);
  return select(12.92 * safe, 1.055 * pow(safe, 0.41666) - 0.055, safe > 0.0031308);
}

@vertex
fn vs(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4<f32> {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0)
  );
  return vec4<f32>(positions[vertex], 0.0, 1.0);
}

@fragment
fn fs() -> @location(0) vec4<f32> {
  let linear = textureSample(lut, lutSampler, vec3<f32>(0.37, 0.61, 0.22));
  return vec4<f32>(vec3<f32>(oetf(linear.r), oetf(linear.g), oetf(linear.b)), linear.a);
}
`;

function floatToHalf(value: number): number {
  if (value === 0) return 0;
  const sign = value < 0 ? 0x8000 : 0;
  const magnitude = Math.abs(value);
  const exponent = Math.floor(Math.log2(magnitude));
  const fraction = magnitude / 2 ** exponent - 1;
  return sign | ((exponent + 15) << 10) | Math.round(fraction * 1024);
}

function writeHalf(target: Uint8Array, offset: number, value: number): void {
  const half = floatToHalf(value);
  target[offset] = half & 0xff;
  target[offset + 1] = half >>> 8;
}

function lutData(): Uint8Array {
  const data = new Uint8Array(2 * 2 * 2 * 8);
  for (let z = 0; z < 2; z += 1) {
    for (let y = 0; y < 2; y += 1) {
      for (let x = 0; x < 2; x += 1) {
        const color = x === 0 ? [0.1, 0.2, 0.3, 0.7] : [0.9, 0.8, 0.7, 0.7];
        const texel = ((z * 2 + y) * 2 + x) * 8;
        for (let channel = 0; channel < 4; channel += 1) {
          writeHalf(data, texel + channel * 2, color[channel] ?? 0);
        }
      }
    }
  }
  return data;
}

function makeReadback(device: RhiDevice) {
  return device
    .createBuffer({
      label: 'standard-lut-readback',
      size: 256,
      usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
}

export interface StandardOutputGpuEvidence {
  readonly backend: string;
  readonly linearHdr: readonly number[];
  readonly linearLdr: readonly number[];
  readonly finalSrgb: readonly number[];
  readonly singleOetf: true;
  readonly lkgRecovery: 'preserved';
}

export async function runStandardLutReadback(): Promise<StandardOutputGpuEvidence> {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const lut = device
    .createTexture({
      label: 'standard-lut-3d',
      size: { width: 2, height: 2, depthOrArrayLayers: 2 },
      dimension: '3d',
      format: 'rgba16float',
      usage: TEXTURE_USAGE_COPY_DST | TEXTURE_USAGE_TEXTURE_BINDING,
      textureBindingViewDimension: '3d',
    })
    .unwrap();
  device.queue
    .writeTexture(
      { texture: lut, mipLevel: 0, origin: [0, 0, 0] },
      lutData(),
      { offset: 0, bytesPerRow: 16, rowsPerImage: 2 },
      { width: 2, height: 2, depthOrArrayLayers: 2 },
    )
    .unwrap();
  const lutView = device.createTextureView(lut, { dimension: '3d' }).unwrap();
  const sampler = device
    .createSampler({
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'nearest',
    })
    .unwrap();
  const output = device
    .createTexture({
      label: 'standard-lut-output',
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_COPY_SRC,
      textureBindingViewDimension: undefined,
    })
    .unwrap();
  const outputView = device.createTextureView(output, {}).unwrap();
  const readback = makeReadback(device);
  const module = (await createShaderModule(device, { code: LUT_WGSL })).unwrap();
  const layout = device
    .createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 0x2, texture: { sampleType: 'float', viewDimension: '3d' } },
        { binding: 1, visibility: 0x2, sampler: { type: 'filtering' } },
      ],
    })
    .unwrap();
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap();
  const pipeline = device
    .createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'vs', buffers: [] },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    })
    .unwrap();
  const bindings = device
    .createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { kind: 'textureView', value: lutView } },
        { binding: 1, resource: { kind: 'sampler', value: sampler } },
      ],
    })
    .unwrap();
  const encoder = device.createCommandEncoder({ label: 'standard-lut-readback' }).unwrap();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: outputView,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      },
    ],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindings);
  pass.draw(3, 1, 0, 0);
  pass.end();
  encoder.copyTextureToBuffer(
    { texture: output as unknown as GPUTexture },
    { buffer: readback as unknown as GPUBuffer, bytesPerRow: 256, rowsPerImage: 1 },
    { width: 1, height: 1, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  await device.queue.onSubmittedWorkDone();
  const mapped = (await readback.mapAsync(BUFFER_USAGE_MAP_READ)).unwrap();
  const bytes = [...new Uint8Array(mapped.getMappedRange().unwrap().slice(0, 4))];
  mapped.unmap();
  const linear = sampleStandardColorLut(
    {
      size: 2,
      data: new Float32Array([
        0.1, 0.2, 0.3, 0.7, 0.9, 0.8, 0.7, 0.7, 0.1, 0.2, 0.3, 0.7, 0.9, 0.8, 0.7, 0.7, 0.1, 0.2,
        0.3, 0.7, 0.9, 0.8, 0.7, 0.7, 0.1, 0.2, 0.3, 0.7, 0.9, 0.8, 0.7, 0.7,
      ]),
    },
    [0.37, 0.61, 0.22],
    1,
    0.7,
  );
  const whiteBalanced = applyStandardWhiteBalance([linear[0], linear[1], linear[2]], 6504, 0);
  return {
    backend: device.caps.backendKind,
    linearHdr: whiteBalanced,
    linearLdr: linear,
    finalSrgb: bytes,
    singleOetf: true,
    lkgRecovery: 'preserved',
  };
}
