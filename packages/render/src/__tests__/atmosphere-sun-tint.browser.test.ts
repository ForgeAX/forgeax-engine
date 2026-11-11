/// <reference types="@webgpu/types" />
import { vec3 } from '@forgeax/engine-math';
import type { Buffer, RhiQueue } from '@forgeax/engine-rhi';
import { expect, it } from 'vitest';
import { composeShader } from '../../../naga/src/index';
import backgroundModule from '../../../shader/src/atmosphere-background.wgsl?raw';
import coordinates from '../../../shader/src/atmosphere-coordinates.wgsl?raw';
import lutsModule from '../../../shader/src/atmosphere-luts.wgsl?raw';
import optics from '../../../shader/src/atmosphere-optics.wgsl?raw';
import sampling from '../../../shader/src/atmosphere-sampling.wgsl?raw';
import tableAccess from '../../../shader/src/atmosphere-table-access.wgsl?raw';
import tableKernels from '../../../shader/src/atmosphere-table-kernels.wgsl?raw';
import visibility from '../../../shader/src/atmosphere-visibility.wgsl?raw';
import cloud from '../../../shader/src/cloud.wgsl?raw';
import common from '../../../shader/src/common.wgsl?raw';
import fogModule from '../../../shader/src/fog.wgsl?raw';
import shadowPcf from '../../../shader/src/shadow-pcf.wgsl?raw';
import { writeViewUbo } from '../record/view-ubo';
import type { CameraSnapshot } from '../render-contract';
import { earthAtmosphere } from './atmosphere-fixture';

// The shipped transmittance, multiple-scattering and sky-view tables and the
// shipped Atmosphere background, rendered on the GPU for a sun 6.9 degrees up
// behind a camera pitched 30 degrees up:
// - a white sun renders bit-for-bit as before the sky took the sun's luminance;
// - a warm sun no longer multiplies its hue over the sky: the sky keeps the
//   same chromaticity as under a white sun, instead of turning grey.

const DEFINES = {
  STORAGE_BUFFER_AVAILABLE: true,
  EXTENDED_LIGHTING_AVAILABLE: false,
  PER_INSTANCE_REGION: false,
  ATMOSPHERE_UTILITY_SHADOWS: true,
};
const SIZE = 128;
const SUN_ELEVATION = (6.9 * Math.PI) / 180;
const PITCH = (30 * Math.PI) / 180;
const WARM: readonly [number, number, number] = [1, 0.62, 0.36];
const WHITE: readonly [number, number, number] = [1, 1, 1];
const LUX = 3.2;

/** The sky before it took the sun's luminance: the authored colour multiplied over it. */
const LEGACY_OPTICS = optics.replace(
  /fn atmosphere_sun_luminance\(light: vec3<f32>\) -> vec3<f32> \{[\s\S]*?\n\}/,
  'fn atmosphere_sun_luminance(light: vec3<f32>) -> vec3<f32> { return light; }',
);

function fromHalf(half: number): number {
  const exponent = (half >>> 10) & 0x1f;
  const fraction = half & 0x3ff;
  const sign = half & 0x8000 ? -1 : 1;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function viewPayload(color: readonly [number, number, number]): Float32Array {
  const c = Math.cos(PITCH);
  const s = Math.sin(PITCH);
  const camera: CameraSnapshot = {
    entityKey: 1,
    worldId: 0,
    historyVersion: 0,
    position: vec3.create(0, 2, 0),
    world: new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 2, 0, 1]),
    fov: Math.PI / 3,
    aspect: 1,
    near: 0.1,
    far: 1000,
    projection: 'perspective',
    orthoLeft: -1,
    orthoRight: 1,
    orthoBottom: -1,
    orthoTop: 1,
    tonemap: 'none',
    exposure: 1,
    whitePoint: 4,
    antialias: 'none',
    bloom: 'off',
    bloomThreshold: 1,
    bloomIntensity: 0,
    bloomSmoothWidth: 0.01,
    bloomRadius: 0,
    clearColor: [0, 0, 0, 1],
  };
  let payload = new Float32Array();
  const queue = {
    writeBuffer: (_buffer: Buffer, offset: number, data: Float32Array) => {
      if (offset === 0 && payload.length === 0) payload = data.slice();
      return { ok: true, value: undefined } as const;
    },
  } as unknown as RhiQueue;
  // Incoming light travels toward -z: the sun stands low behind the camera (+z).
  const light = {
    kind: 'directional',
    direction: vec3.create(0, -Math.sin(SUN_ELEVATION), -Math.cos(SUN_ELEVATION)),
    color: vec3.create(color[0] * LUX, color[1] * LUX, color[2] * LUX),
    intensity: LUX,
    contactShadowLength: 0,
  } as never;
  writeViewUbo(
    queue,
    {} as Buffer,
    camera,
    light,
    { point: [], spot: [] } as never,
    [],
    0,
    undefined,
    undefined,
    undefined,
    earthAtmosphere,
  );
  return payload;
}

async function compose(entry: string, opticsSource: string): Promise<string> {
  const fog = fogModule
    .slice(0, fogModule.indexOf('fn height_fog(v:View'))
    .replace(/#import forgeax_view::atmosphere::[^\n]*\n/, '');
  return composeShader(
    entry,
    {
      'forgeax_view::common': common,
      'forgeax_view::fog': fog,
      'forgeax_cloud::layer': cloud,
      'forgeax_pbr::shadow_pcf': shadowPcf,
      'forgeax_atmosphere::visibility': visibility,
      'forgeax_atmosphere::table_access': tableAccess,
      'forgeax_atmosphere::optics': opticsSource,
      'forgeax_atmosphere::coordinates': coordinates,
      'forgeax_atmosphere::sampling': sampling,
      'forgeax_atmosphere::table_kernels': tableKernels,
    },
    DEFINES,
  );
}

function storage(device: GPUDevice, width: number, height: number): GPUTexture {
  return device.createTexture({
    size: [width, height],
    format: 'rgba16float',
    usage:
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.COPY_SRC,
  });
}

/** Group 1 of a program composed with ATMOSPHERE_UTILITY_SHADOWS: unshadowed air. */
function visibilityGroup(
  device: GPUDevice,
  pipeline: GPURenderPipeline | GPUComputePipeline,
  view: GPUBuffer,
  unit: GPUTexture,
): GPUBindGroup | undefined {
  device.pushErrorScope('validation');
  const layout = pipeline.getBindGroupLayout(1);
  const shadow = device.createTexture({
    size: [1, 1, 1],
    format: 'depth32float',
    usage: GPUTextureUsage.TEXTURE_BINDING,
  });
  const group = device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: shadow.createView({ dimension: '2d-array' }) },
      { binding: 1, resource: device.createSampler({ compare: 'greater-equal' }) },
      { binding: 2, resource: unit.createView() },
      { binding: 3, resource: device.createSampler() },
      { binding: 4, resource: { buffer: view } },
    ],
  });
  void device.popErrorScope();
  return group;
}

async function readHdr(device: GPUDevice, texture: GPUTexture): Promise<Float32Array> {
  const bytesPerRow = Math.ceil((texture.width * 8) / 256) * 256;
  const readback = device.createBuffer({
    size: bytesPerRow * texture.height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow }, [
    texture.width,
    texture.height,
  ]);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const rows = new Uint16Array(readback.getMappedRange().slice(0));
  readback.unmap();
  readback.destroy();
  const out = new Float32Array(texture.width * texture.height * 4);
  for (let y = 0; y < texture.height; y++)
    for (let i = 0; i < texture.width * 4; i++)
      out[y * texture.width * 4 + i] = fromHalf(rows[(y * bytesPerRow) / 2 + i] ?? 0);
  return out;
}

/** The sky as the renderer records it: three tables, then the background pass. */
async function renderSky(
  device: GPUDevice,
  color: readonly [number, number, number],
  opticsSource: string,
): Promise<Float32Array> {
  const payload = viewPayload(color);
  const view = device.createBuffer({
    size: payload.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(view, 0, payload);
  const unit = storage(device, 1, 1);
  const transmittance = storage(device, 256, 64);
  const multiple = storage(device, 32, 32);
  const sky = storage(device, 192, 208);
  const filtering = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  const luts = device.createShaderModule({ code: await compose(lutsModule, opticsSource) });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  for (const [entry, target, inputs] of [
    ['atmosphere_transmittance', transmittance, false],
    ['atmosphere_multiple_scattering', multiple, true],
    ['atmosphere_sky_view', sky, true],
  ] as const) {
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: luts, entryPoint: entry },
    });
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: view } },
      { binding: 4, resource: target.createView() },
    ];
    if (inputs)
      entries.push(
        { binding: 1, resource: transmittance.createView() },
        { binding: 3, resource: filtering },
      );
    if (entry === 'atmosphere_sky_view')
      entries.push({ binding: 2, resource: multiple.createView() });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }),
    );
    if (entry === 'atmosphere_sky_view') {
      const group = visibilityGroup(device, pipeline, view, unit);
      if (group !== undefined) pass.setBindGroup(1, group);
    }
    pass.dispatchWorkgroups(Math.ceil(target.width / 8), Math.ceil(target.height / 8));
  }
  pass.end();
  const module = device.createShaderModule({
    code: await compose(backgroundModule, opticsSource),
  });
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'atmosphere_background_vs' },
    fragment: {
      module,
      entryPoint: 'atmosphere_background_fs',
      targets: [{ format: 'rgba16float' }],
    },
    primitive: { topology: 'triangle-list' },
  });
  const target = storage(device, SIZE, SIZE);
  const draw = encoder.beginRenderPass({
    colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store' }],
  });
  draw.setPipeline(pipeline);
  draw.setBindGroup(
    0,
    device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sky.createView() },
        { binding: 1, resource: filtering },
        { binding: 2, resource: { buffer: view } },
        { binding: 3, resource: transmittance.createView() },
        { binding: 4, resource: multiple.createView() },
      ],
    }),
  );
  const group = visibilityGroup(device, pipeline, view, unit);
  if (group !== undefined) draw.setBindGroup(1, group);
  draw.draw(3);
  draw.end();
  device.queue.submit([encoder.finish()]);
  return readHdr(device, target);
}

/**
 * Display bytes after an auto exposure that puts the mean luminance at 0.18,
 * then ACES filmic and the sRGB OETF.
 */
function display(rgba: Float32Array): Uint8Array {
  let mean = 0;
  for (let i = 0; i < rgba.length; i += 4)
    mean += 0.2126 * (rgba[i] ?? 0) + 0.7152 * (rgba[i + 1] ?? 0) + 0.0722 * (rgba[i + 2] ?? 0);
  const exposure = 0.18 / Math.max(1e-9, mean / (rgba.length / 4));
  const encode = (v: number) => {
    const c = Math.min(1, Math.max(0, v));
    return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
  };
  const aces = (v: number) => (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14);
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    for (let k = 0; k < 3; k++) out[i + k] = encode(aces((rgba[i + k] ?? 0) * exposure));
    out[i + 3] = 255;
  }
  return out;
}

/** Mean display RGB of the top 15% of rows, its HSV saturation and blue/red ratio. */
function upperSky(bytes: Uint8Array) {
  const rows = Math.round(SIZE * 0.15);
  const sum = [0, 0, 0];
  for (let i = 0; i < rows * SIZE * 4; i += 4)
    for (let k = 0; k < 3; k++) sum[k] = (sum[k] ?? 0) + (bytes[i + k] ?? 0);
  const rgb = sum.map((v) => Math.round(v / (rows * SIZE))) as [number, number, number];
  const max = Math.max(...rgb);
  return {
    rgb,
    saturation: Math.round((max === 0 ? 0 : (max - Math.min(...rgb)) / max) * 1000) / 1000,
    blueOverRed: Math.round((rgb[2] / Math.max(1, rgb[0])) * 100) / 100,
  };
}

it('keeps a warm low sun from greying the Atmosphere sky; a white sun is unchanged', async () => {
  const adapter = await navigator.gpu?.requestAdapter();
  if (adapter === null || adapter === undefined) throw new Error('the sky programs need WebGPU');
  const device = await adapter.requestDevice();
  try {
    const legacyWhite = await renderSky(device, WHITE, LEGACY_OPTICS);
    const white = await renderSky(device, WHITE, optics);
    const legacyWarm = await renderSky(device, WARM, LEGACY_OPTICS);
    const warm = await renderSky(device, WARM, optics);
    const report = {
      legacyWhite: upperSky(display(legacyWhite)),
      white: upperSky(display(white)),
      legacyWarm: upperSky(display(legacyWarm)),
      warm: upperSky(display(warm)),
    };
    // biome-ignore lint/suspicious/noConsole: GPU sky colour evidence.
    console.log(`atmosphere sun tint: ${JSON.stringify(report)}`);
    // A white sun is bit-for-bit what it was.
    expect(Array.from(white)).toEqual(Array.from(legacyWhite));
    // The old path: blue Rayleigh sky times an orange sun reads grey.
    expect(report.legacyWarm.saturation).toBeLessThan(0.25);
    // Now the warm sun lights the sky with its luminance: same blue as the white sun.
    expect(report.warm.blueOverRed).toBeGreaterThanOrEqual(1.5);
    expect(report.warm.saturation).toBeGreaterThan(0.4);
    const warmBytes = display(warm);
    const whiteBytes = display(white);
    let drift = 0;
    for (let i = 0; i < warmBytes.length; i++)
      drift = Math.max(drift, Math.abs((warmBytes[i] ?? 0) - (whiteBytes[i] ?? 0)));
    expect(drift).toBeLessThanOrEqual(1);
  } finally {
    device.destroy();
  }
}, 60000);
