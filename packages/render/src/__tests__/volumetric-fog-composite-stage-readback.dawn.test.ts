import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { describe, expect, it } from 'vitest';

const SIZE = 4;
const ROW_BYTES = 256;
const MAP_READ = 0x0001;
const COPY_DST = 0x0008;
const COPY_SRC = 0x0001;
const TEXTURE_COPY_DST = 0x0002;
const TEXTURE_BINDING = 0x0004;
const RENDER_ATTACHMENT = 0x0010;
const engineManifest = await buildEngineShaderManifest();

function floatToHalf(value: number): number {
  if (!Number.isFinite(value)) return value < 0 ? 0xfc00 : 0x7c00;
  const sign = value < 0 ? 0x8000 : 0;
  const absolute = Math.abs(value);
  if (absolute === 0) return sign;
  const exponent = Math.floor(Math.log2(absolute));
  if (exponent < -14) return sign | Math.round(absolute / 2 ** -24);
  if (exponent > 15) return sign | 0x7c00;
  return sign | ((exponent + 15) << 10) | Math.round((absolute / 2 ** exponent - 1) * 1024);
}

function encodeHalfPixels(
  values: readonly (readonly [number, number, number, number])[],
): Uint8Array {
  const bytes = new Uint8Array(ROW_BYTES * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const pixel = values[y * SIZE + x] ?? [0, 0, 0, 1];
      const offset = y * ROW_BYTES + x * 8;
      const channels = pixel.map(floatToHalf);
      for (let channel = 0; channel < 4; channel += 1) {
        bytes[offset + channel * 2] = (channels[channel] ?? 0) & 0xff;
        bytes[offset + channel * 2 + 1] = (channels[channel] ?? 0) >>> 8;
      }
    }
  }
  return bytes;
}

function decodeHalf(bytes: Uint8Array, offset: number): number {
  const bits = (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits >>> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function shader(marker: string): string {
  const entry = engineManifest.entries.find(({ wgsl }) => wgsl.includes(marker));
  if (entry === undefined) throw new Error(`missing cooked shader entry: ${marker}`);
  return entry.wgsl;
}

function viewUniform(): Float32Array {
  const values = new Float32Array(60);
  values[44] = 1;
  values[49] = 1;
  values[54] = -1;
  values[58] = 1;
  values[59] = 1;
  return values;
}

async function requestDevice(): Promise<GPUDevice> {
  const adapter = await globalThis.navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Dawn composite readback unavailable: no adapter');
  return adapter.requestDevice();
}

interface CompositeReadback {
  readonly pixels: Float32Array;
  readonly center: [number, number, number, number];
}

type CompositeMode = 'production' | 'single-bilinear';

async function runComposite(
  device: GPUDevice,
  volumeValues: readonly (readonly [number, number, number, number])[],
  edgeDepth: boolean,
  mode: CompositeMode = 'production',
): Promise<CompositeReadback> {
  const volume = device.createTexture({
    label: 'composite-readback.resolved-volume',
    size: { width: SIZE, height: SIZE, depthOrArrayLayers: 1 },
    dimension: '2d',
    format: 'rgba16float',
    usage: TEXTURE_BINDING | TEXTURE_COPY_DST,
  });
  const depth = device.createTexture({
    label: 'composite-readback.scene-depth',
    size: { width: SIZE, height: SIZE, depthOrArrayLayers: 1 },
    format: 'depth32float',
    usage: TEXTURE_BINDING | RENDER_ATTACHMENT | TEXTURE_COPY_DST,
  });
  const target = device.createTexture({
    label: 'composite-readback.linear-hdr',
    size: { width: SIZE, height: SIZE, depthOrArrayLayers: 1 },
    format: 'rgba16float',
    usage: RENDER_ATTACHMENT | COPY_SRC | TEXTURE_COPY_DST,
  });
  const volumeView = volume.createView({ dimension: '2d' });
  const depthView = depth.createView();
  const targetView = target.createView();
  const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  const uniform = device.createBuffer({ size: 240, usage: 0x40 | COPY_DST });
  const readback = device.createBuffer({ size: ROW_BYTES * SIZE, usage: MAP_READ | COPY_DST });
  const background = Array.from({ length: SIZE * SIZE }, () => [0.2, 0.3, 0.4, 1] as const);
  device.queue.writeTexture(
    { texture: volume },
    encodeHalfPixels(volumeValues),
    { bytesPerRow: ROW_BYTES, rowsPerImage: SIZE },
    { width: SIZE, height: SIZE, depthOrArrayLayers: 1 },
  );
  device.queue.writeTexture(
    { texture: target },
    encodeHalfPixels(background),
    { bytesPerRow: ROW_BYTES, rowsPerImage: SIZE },
    { width: SIZE, height: SIZE, depthOrArrayLayers: 1 },
  );
  device.queue.writeBuffer(uniform, 0, viewUniform());
  const productionSource = shader('fn volume_fs');
  const source =
    mode === 'single-bilinear'
      ? productionSource.replace(
          'let sample = edge_aware_resolved_volume(input.uv);',
          'let sample = textureSampleLevel(resolved_volume, volume_sampler, input.uv, 0.0);',
        )
      : productionSource;
  const module = device.createShaderModule({ code: source });
  const depthEdgePipeline = edgeDepth
    ? device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module: device.createShaderModule({
            code: `@vertex fn edge_vs(@builtin(vertex_index) index : u32) -> @builtin(position) vec4<f32> {
              var points = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(0.0, -1.0), vec2<f32>(-1.0, 1.0));
              return vec4<f32>(points[index], 0.75, 1.0);
            }`,
          }),
          entryPoint: 'edge_vs',
          buffers: [],
        },
        primitive: { topology: 'triangle-list' },
        depthStencil: {
          format: 'depth32float',
          depthWriteEnabled: true,
          depthCompare: 'always',
        },
      })
    : undefined;
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
      { binding: 1, visibility: 2, sampler: { type: 'filtering' } },
      { binding: 2, visibility: 2, texture: { sampleType: 'depth', viewDimension: '2d' } },
      { binding: 3, visibility: 2, buffer: { type: 'uniform' } },
    ],
  });
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: 'volume_vs', buffers: [] },
    fragment: {
      module,
      entryPoint: 'volume_fs',
      targets: [
        {
          format: 'rgba16float',
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        },
      ],
    },
    primitive: { topology: 'triangle-list' },
  });
  const bindings = device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: volumeView },
      { binding: 1, resource: sampler },
      { binding: 2, resource: depthView },
      { binding: 3, resource: { buffer: uniform } },
    ],
  });
  const encoder = device.createCommandEncoder();
  const depthClear = encoder.beginRenderPass({
    colorAttachments: [],
    depthStencilAttachment: {
      view: depthView,
      depthClearValue: 0,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
    },
  });
  depthClear.end();
  if (edgeDepth && depthEdgePipeline !== undefined) {
    const edge = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: depthView,
        depthLoadOp: 'load',
        depthStoreOp: 'store',
      },
    });
    edge.setPipeline(depthEdgePipeline);
    edge.draw(3);
    edge.end();
  }
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: targetView,
        loadOp: 'load',
        storeOp: 'store',
      },
    ],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindings);
  pass.draw(3);
  pass.end();
  encoder.copyTextureToBuffer(
    { texture: target },
    { buffer: readback, bytesPerRow: ROW_BYTES, rowsPerImage: SIZE },
    { width: SIZE, height: SIZE, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  await readback.mapAsync(MAP_READ);
  const bytes = new Uint8Array(readback.getMappedRange().slice(0));
  const pixels = new Float32Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const source = y * ROW_BYTES + x * 8;
      const targetOffset = (y * SIZE + x) * 4;
      for (let channel = 0; channel < 4; channel += 1)
        pixels[targetOffset + channel] = decodeHalf(bytes, source + channel * 2);
    }
  }
  readback.unmap();
  volume.destroy();
  depth.destroy();
  target.destroy();
  uniform.destroy();
  readback.destroy();
  const centerOffset = (2 * SIZE + 2) * 4;
  return {
    pixels,
    center: [
      pixels[centerOffset] ?? Number.NaN,
      pixels[centerOffset + 1] ?? Number.NaN,
      pixels[centerOffset + 2] ?? Number.NaN,
      pixels[centerOffset + 3] ?? Number.NaN,
    ],
  };
}

describe('volumetric fog composite HDR stage on Dawn', () => {
  it('preserves premultiplied scatter over HDR and survives depth edges', async () => {
    const device = await requestDevice();
    const scatter = Array.from({ length: SIZE * SIZE }, () => [0.25, 0.1, 0.05, 0.5] as const);
    const off = Array.from({ length: SIZE * SIZE }, () => [0, 0, 0, 1] as const);
    const onFar = await runComposite(device, scatter, false);
    const offFar = await runComposite(device, off, false);
    const onEdge = await runComposite(device, scatter, true);
    // biome-ignore lint/suspicious/noConsole: composite stage evidence
    console.log(
      JSON.stringify({ onFar: onFar.center, offFar: offFar.center, onEdge: onEdge.center }),
    );
    expect(onFar.center.every(Number.isFinite)).toBe(true);
    expect(onFar.center.every((value) => value >= 0)).toBe(true);
    expect(onFar.center[3]).toBeGreaterThanOrEqual(0);
    const expectedScatter = [1, 0.4, 0.2] as const;
    for (let channel = 0; channel < 3; channel += 1) {
      const expected = (onFar.center[channel] ?? 0) - (offFar.center[channel] ?? 0) * 0.5;
      expect(expected).toBeGreaterThan(0);
      expect(Math.abs(expected - 0.25 * (expectedScatter[channel] ?? 0))).toBeLessThan(0.03);
    }
    expect(onEdge.center.every(Number.isFinite)).toBe(true);
    expect(onEdge.center[0]).toBeGreaterThan(0);
    const source = shader('fn volume_fs');
    expect(source).toContain('linear_scene_depth');
    expect(source).toContain('depth_weight');
    expect(source).toContain('scene_depth');
  });

  it('compares production 9-tap reconstruction with a single-bilinear A/B', async () => {
    const device = await requestDevice();
    const values = Array.from({ length: SIZE * SIZE }, (_, index) =>
      index % SIZE < 2 ? ([0.9, 0.45, 0.2, 0.35] as const) : ([0.02, 0.01, 0.005, 0.95] as const),
    );
    const nineTap = await runComposite(device, values, false, 'production');
    const single = await runComposite(device, values, false, 'single-bilinear');
    const luma = (pixels: Float32Array, x: number, y: number): number => {
      const offset = (y * SIZE + x) * 4;
      return (
        0.2126 * (pixels[offset] ?? 0) +
        0.7152 * (pixels[offset + 1] ?? 0) +
        0.0722 * (pixels[offset + 2] ?? 0)
      );
    };
    const edgeGradient = (pixels: Float32Array): number =>
      Math.abs(luma(pixels, 1, 2) - luma(pixels, 2, 2));
    const sideContrast = (pixels: Float32Array): number =>
      Math.abs(luma(pixels, 0, 2) - luma(pixels, 3, 2));
    const profile = (pixels: Float32Array): number[] =>
      Array.from({ length: SIZE }, (_, x) => luma(pixels, x, 2));
    const transitionWidth = (pixels: Float32Array): number => {
      const samples = profile(pixels);
      const low = Math.min(samples[0] ?? 0, samples[3] ?? 0);
      const high = Math.max(samples[0] ?? 0, samples[3] ?? 0);
      const span = Math.max(high - low, 1e-6);
      return samples.filter((value) => value > low + span * 0.1 && value < low + span * 0.9).length;
    };
    const plateauCv = (pixels: Float32Array, start: number, end: number): number => {
      const samples = profile(pixels).slice(start, end);
      const mean = samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length);
      const variance =
        samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, samples.length);
      return Math.sqrt(variance) / Math.max(Math.abs(mean), 1e-6);
    };
    const nineGradient = edgeGradient(nineTap.pixels);
    const singleGradient = edgeGradient(single.pixels);
    const nineContrast = sideContrast(nineTap.pixels);
    const singleContrast = sideContrast(single.pixels);
    const nineTransition = transitionWidth(nineTap.pixels);
    const singleTransition = transitionWidth(single.pixels);
    const ninePlateauCv = Math.max(
      plateauCv(nineTap.pixels, 0, 2),
      plateauCv(nineTap.pixels, 2, 4),
    );
    const singlePlateauCv = Math.max(
      plateauCv(single.pixels, 0, 2),
      plateauCv(single.pixels, 2, 4),
    );
    const peakRatio =
      Math.min(nineGradient, singleGradient) / Math.max(nineGradient, singleGradient, 1e-6);
    // Both paths use the same pending volume, depth, and HDR background. The
    // A/B is deliberately test-owned: production remains the exact shader
    // until this measured edge and halo evidence identifies its owner.
    expect(nineTap.pixels.every(Number.isFinite)).toBe(true);
    expect(single.pixels.every(Number.isFinite)).toBe(true);
    expect(singleContrast).toBeGreaterThan(0.1);
    expect(nineContrast).toBeGreaterThan(0.1);
    expect(peakRatio).toBeGreaterThan(0.25);
    expect(nineTransition).toBeLessThanOrEqual(2);
    expect(singleTransition).toBeLessThanOrEqual(2);
    expect(ninePlateauCv).toBeLessThanOrEqual(0.05);
    expect(singlePlateauCv).toBeLessThanOrEqual(0.05);
    // Premultiplied output must not create a negative or overshooting edge.
    expect(Math.max(...nineTap.pixels)).toBeLessThanOrEqual(1.01);
    expect(Math.max(...single.pixels)).toBeLessThanOrEqual(1.01);
    // biome-ignore lint/suspicious/noConsole: composite A/B evidence
    console.log(
      JSON.stringify({
        compositeAB: {
          nineGradient,
          singleGradient,
          nineContrast,
          singleContrast,
          nineTransition,
          singleTransition,
          ninePlateauCv,
          singlePlateauCv,
          gradientPreservation: peakRatio,
        },
      }),
    );
  });
});
