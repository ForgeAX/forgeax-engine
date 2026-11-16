/// <reference types="@webgpu/types" />
import { expect, it } from 'vitest';
import { composeShader } from '../../../naga/src/index';
import compositeModule from '../../../shader/src/volume/volume-composite.wgsl?raw';

// The shipped volume composite upsamples a coarse resolved image whose texels
// were each integrated to the scene depth of one pixel: the pixel containing
// the texel centre (volume-integrate.wgsl). At a depth step that crosses a
// texel block, the fog term of every full-resolution pixel must follow the
// pixel's own surface, not the texel grid. Otherwise bright in-scattering
// meets a foreground silhouette as a staircase of screen tiles.

const TILE = 8; // tileSize 16 resolves at 8 source pixels per texel.
const RESOLVED = 4;
const SIZE = RESOLVED * TILE;
const BACKGROUND = [0.9, 0.45, 0.2, 0.35] as const; // long ray through bright glow
const FOREGROUND = [0.02, 0.01, 0.005, 0.95] as const; // short ray in front of it

const FLOAT_VIEW = new Float32Array(1);
const BITS_VIEW = new Uint32Array(FLOAT_VIEW.buffer);
function toHalf(value: number): number {
  FLOAT_VIEW[0] = value;
  const bits = BITS_VIEW[0] ?? 0;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  if (exponent <= 0) return sign;
  if (exponent >= 31) return sign | 0x7c00;
  return sign | (exponent << 10) | ((bits >>> 13) & 0x3ff);
}
function fromHalf(half: number): number {
  const exponent = (half >>> 10) & 0x1f;
  const fraction = half & 0x3ff;
  const sign = half & 0x8000 ? -1 : 1;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/** Foreground polygon in NDC (two triangles) and its exact pixel-centre predicate. */
interface DepthStep {
  readonly triangles: readonly (readonly [number, number])[];
  readonly foreground: (x: number, y: number) => boolean;
}

// Vertical silhouette at x = 13: inside texel column 1 (pixels 8..15), whose
// representative pixel 12 is foreground while pixels 13..15 are background.
const VERTICAL: DepthStep = {
  triangles: [
    [-1, -1],
    [13 / 16 - 1, -1],
    [13 / 16 - 1, 1],
    [-1, -1],
    [13 / 16 - 1, 1],
    [-1, 1],
  ],
  foreground: (x) => x + 0.5 < 13,
};

// Slanted silhouette from pixel (6, 0) to (26, 32). No pixel centre lies on it.
const SLANTED: DepthStep = {
  triangles: [
    [-1, 1],
    [6 / 16 - 1, 1],
    [26 / 16 - 1, -1],
    [-1, 1],
    [26 / 16 - 1, -1],
    [-1, -1],
  ],
  foreground: (x, y) => x + 0.5 < 6 + (y + 0.5) * 0.625,
};

const DEPTH_FILL = (step: DepthStep) => `
@vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> {
  let p = array<vec2<f32>, 6>(${step.triangles.map(([x, y]) => `vec2<f32>(${x}, ${y})`).join(', ')})[i];
  return vec4<f32>(p, 0.75, 1.0);
}`;

/** View UBO prefix whose inverse view-projection maps device depth d to z = 10 - 8d. */
function viewUniform(): Float32Array {
  const values = new Float32Array(60);
  values[44] = 0.1;
  values[49] = 0.1;
  values[54] = -8;
  values[58] = 10;
  values[59] = 1;
  return values;
}

async function gpu(): Promise<GPUDevice> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (adapter === null || adapter === undefined) throw new Error('volume composite needs WebGPU');
  const device = await adapter.requestDevice();
  device.addEventListener('uncapturederror', (event) => {
    throw new Error((event as GPUUncapturedErrorEvent).error.message);
  });
  return device;
}

/** Texel is foreground exactly when the integrator's representative pixel is. */
function resolvedField(step: DepthStep): Uint16Array {
  const data = new Uint16Array(RESOLVED * RESOLVED * 4);
  for (let y = 0; y < RESOLVED; y++)
    for (let x = 0; x < RESOLVED; x++) {
      const value = step.foreground(x * TILE + TILE / 2, y * TILE + TILE / 2)
        ? FOREGROUND
        : BACKGROUND;
      data.set(value.map(toHalf), (y * RESOLVED + x) * 4);
    }
  return data;
}

async function composite(
  device: GPUDevice,
  step: DepthStep | undefined,
  neighbors: 2 | 4 | 8,
  field: Uint16Array = step === undefined ? new Uint16Array() : resolvedField(step),
  uniform: Float32Array = viewUniform(),
): Promise<Float32Array> {
  const volume = device.createTexture({
    size: [RESOLVED, RESOLVED, 1],
    format: 'rgba16float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: volume },
    field,
    { bytesPerRow: RESOLVED * 8, rowsPerImage: RESOLVED },
    [RESOLVED, RESOLVED, 1],
  );
  const depth = device.createTexture({
    size: [SIZE, SIZE, 1],
    format: 'depth32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const target = device.createTexture({
    size: [SIZE, SIZE, 1],
    format: 'rgba16float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const view = device.createBuffer({
    size: 240,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(view, 0, uniform);
  const fill =
    step === undefined
      ? undefined
      : device.createRenderPipeline({
          layout: 'auto',
          vertex: {
            module: device.createShaderModule({ code: DEPTH_FILL(step) }),
            entryPoint: 'vs',
          },
          primitive: { topology: 'triangle-list' },
          depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
        });
  const module = device.createShaderModule({ code: await composeShader(compositeModule, {}, {}) });
  // Unblended: the target receives the reconstructed (scatter, 1 - T) term.
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'volume_vs' },
    fragment: {
      module,
      entryPoint: 'volume_fs',
      constants: { VOLUME_COMPOSITE_NEIGHBORS: neighbors },
      targets: [{ format: 'rgba16float' }],
    },
    primitive: { topology: 'triangle-list' },
  });
  const bindings = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: volume.createView() },
      {
        binding: 1,
        resource: device.createSampler({ minFilter: 'linear', magFilter: 'linear' }),
      },
      { binding: 2, resource: depth.createView() },
      { binding: 3, resource: { buffer: view } },
    ],
  });
  const bytesPerRow = 256;
  const readback = device.createBuffer({
    size: bytesPerRow * SIZE,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  const depthPass = encoder.beginRenderPass({
    colorAttachments: [],
    depthStencilAttachment: {
      view: depth.createView(),
      depthClearValue: 0,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
    },
  });
  if (fill !== undefined) {
    depthPass.setPipeline(fill);
    depthPass.draw(6);
  }
  depthPass.end();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      { view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
    ],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindings);
  pass.draw(3);
  pass.end();
  encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow }, [SIZE, SIZE]);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const rows = new Uint16Array(readback.getMappedRange().slice(0));
  readback.unmap();
  for (const resource of [volume, depth, target, view, readback]) resource.destroy();
  const pixels = new Float32Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++)
    for (let i = 0; i < SIZE * 4; i++)
      pixels[y * SIZE * 4 + i] = fromHalf(rows[(y * bytesPerRow) / 2 + i] ?? 0);
  return pixels;
}

/** Pixels whose bilinear texel footprint holds at least one texel of their own surface. */
function reconstructible(step: DepthStep, x: number, y: number): boolean {
  const px = (x + 0.5) / TILE - 0.5;
  const py = (y + 0.5) / TILE - 0.5;
  const own = step.foreground(x, y);
  for (const [cx, cy] of [
    [Math.floor(px), Math.floor(py)],
    [Math.floor(px) + 1, Math.floor(py)],
    [Math.floor(px), Math.floor(py) + 1],
    [Math.floor(px) + 1, Math.floor(py) + 1],
  ] as const) {
    const tx = Math.min(Math.max(cx, 0), RESOLVED - 1);
    const ty = Math.min(Math.max(cy, 0), RESOLVED - 1);
    if (step.foreground(tx * TILE + TILE / 2, ty * TILE + TILE / 2) === own) return true;
  }
  return false;
}

/** 0 = foreground fog term, 1 = background fog term, from in-scattered red. */
const fogSide = (pixels: Float32Array, x: number, y: number): number =>
  ((pixels[(y * SIZE + x) * 4] ?? Number.NaN) - FOREGROUND[0]) / (BACKGROUND[0] - FOREGROUND[0]);

for (const [name, step] of [
  ['vertical', VERTICAL],
  ['slanted', SLANTED],
] as const) {
  it(`follows a ${name} depth silhouette inside one resolved tile, not the tile grid`, async () => {
    const device = await gpu();
    for (const neighbors of [2, 4, 8] as const) {
      const pixels = await composite(device, step, neighbors);
      const wrong: string[] = [];
      let checked = 0;
      for (let y = 0; y < SIZE; y++)
        for (let x = 0; x < SIZE; x++) {
          if (!reconstructible(step, x, y)) continue;
          checked++;
          const side = fogSide(pixels, x, y);
          const expected = step.foreground(x, y) ? 0 : 1;
          if (!(Math.abs(side - expected) <= 0.1)) wrong.push(`(${x},${y})=${side.toFixed(2)}`);
        }
      expect(checked).toBeGreaterThan(SIZE * SIZE * 0.9);
      expect(wrong, `neighbors ${neighbors}: ${wrong.length} pixels off-surface`).toEqual([]);
    }
    if (step === VERTICAL) {
      // Same resolved texel, opposite sides of the silhouette.
      const pixels = await composite(device, step, 4);
      expect(fogSide(pixels, 12, 16)).toBeLessThan(0.1);
      expect(fogSide(pixels, 13, 16)).toBeGreaterThan(0.9);
    }
    device.destroy();
  });
}

// One continuous far surface: no silhouette, only a smooth fog gradient. At
// these distances adjacent resolved texels lie ~50 000 units apart, well inside
// the relative same-surface threshold, but exp(-delta * 0.08) underflows to 0.
// The composite must keep the filtered reconstruction, not freeze each 8 px
// texel to one value.

/**
 * Smooth resolved gradient along x only. Same-depth neighbours of the shipped
 * filter (the vertical axis here) then see the filtered centre value, so the
 * expected output is exactly the hardware-bilinear reconstruction.
 */
function smoothField(): Uint16Array {
  const data = new Uint16Array(RESOLVED * RESOLVED * 4);
  for (let y = 0; y < RESOLVED; y++)
    for (let x = 0; x < RESOLVED; x++)
      data.set(
        [0.2 + 0.15 * x, 0.1 + 0.02 * x, 0.05, 0.8 - 0.1 * x].map(toHalf),
        (y * RESOLVED + x) * 4,
      );
  return data;
}

/** CPU reference of the hardware-bilinear (clamp-to-edge) red channel. */
function bilinearRed(field: Uint16Array, x: number, y: number): number {
  const px = (x + 0.5) / TILE - 0.5;
  const py = (y + 0.5) / TILE - 0.5;
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const fx = px - x0;
  const fy = py - y0;
  const red = (tx: number, ty: number): number => {
    const cx = Math.min(Math.max(tx, 0), RESOLVED - 1);
    const cy = Math.min(Math.max(ty, 0), RESOLVED - 1);
    return fromHalf(field[(cy * RESOLVED + cx) * 4] ?? 0);
  };
  return (
    red(x0, y0) * (1 - fx) * (1 - fy) +
    red(x0 + 1, y0) * fx * (1 - fy) +
    red(x0, y0 + 1) * (1 - fx) * fy +
    red(x0 + 1, y0 + 1) * fx * fy
  );
}

/** Distance = 1e6 + 1e5 * ndc.x: finite, smooth, ~5% across one texel. */
function farSurfaceUniform(): Float32Array {
  const values = new Float32Array(60);
  values[46] = 1e5; // column 0 .z
  values[58] = 1e6; // column 3 .z
  values[59] = 1; // column 3 .w
  return values;
}

/**
 * Infinite-far reverse-Z: device depth 0 maps to w = 0 (sky at infinity), so
 * the reconstructed distance is |xyz| / 1e-30. A scale of 1e-12 keeps it finite
 * (~1e18); 1e9 overflows f32 to an infinite distance and an inf - inf = NaN delta.
 */
function infiniteFarUniform(farScale: number): () => Float32Array {
  return () => {
    const values = new Float32Array(60);
    values[44] = 0.01 * farScale; // column 0 .x
    values[49] = 0.01 * farScale; // column 1 .y
    values[55] = 1; // column 2 .w: w = device depth
    values[58] = farScale; // column 3 .z
    return values;
  };
}

for (const [name, uniform] of [
  ['finite far surface', farSurfaceUniform],
  ['infinite-far sky at ~1e18 (device depth 0)', infiniteFarUniform(1e-12)],
  ['infinite-far sky with non-finite distance', infiniteFarUniform(1e9)],
] as const) {
  it(`keeps the filtered fog gradient on one ${name}`, async () => {
    const device = await gpu();
    const field = smoothField();
    for (const neighbors of [2, 4, 8] as const) {
      const pixels = await composite(device, undefined, neighbors, field, uniform());
      const wrong: string[] = [];
      for (let y = 0; y < SIZE; y++)
        for (let x = 0; x < SIZE; x++) {
          const actual = pixels[(y * SIZE + x) * 4] ?? Number.NaN;
          const expected = bilinearRed(field, x, y);
          if (!(Math.abs(actual - expected) <= 0.01))
            wrong.push(`(${x},${y})=${actual.toFixed(3)}/${expected.toFixed(3)}`);
        }
      expect(wrong, `neighbors ${neighbors}: ${wrong.length} pixels not filtered`).toEqual([]);
      // Strictly increasing across the interior of one texel row, not stepped.
      for (let x = 5; x < 27; x++)
        expect(pixels[(16 * SIZE + x + 1) * 4] ?? 0).toBeGreaterThan(
          pixels[(16 * SIZE + x) * 4] ?? 0,
        );
    }
    device.destroy();
  });
}

// Silhouette under a real infinite-far camera: the cleared background (device
// depth 0) reconstructs to an infinite distance (distance() overflows f32),
// while the foreground at device depth 0.75 is ~1.3 units away. Sky-side pixels
// next to the silhouette must take the sky term, not the tile grid.
for (const [name, step] of [
  ['vertical', VERTICAL],
  ['slanted', SLANTED],
] as const) {
  it(`follows a ${name} silhouette against infinite-distance sky`, async () => {
    const device = await gpu();
    for (const neighbors of [2, 4, 8] as const) {
      const pixels = await composite(
        device,
        step,
        neighbors,
        resolvedField(step),
        infiniteFarUniform(1)(),
      );
      const wrong: string[] = [];
      let checked = 0;
      for (let y = 0; y < SIZE; y++)
        for (let x = 0; x < SIZE; x++) {
          if (!reconstructible(step, x, y)) continue;
          checked++;
          const side = fogSide(pixels, x, y);
          const expected = step.foreground(x, y) ? 0 : 1;
          if (!(Math.abs(side - expected) <= 0.1)) wrong.push(`(${x},${y})=${side.toFixed(2)}`);
        }
      expect(checked).toBeGreaterThan(SIZE * SIZE * 0.9);
      expect(wrong, `neighbors ${neighbors}: ${wrong.length} pixels off-surface`).toEqual([]);
    }
    device.destroy();
  });
}
