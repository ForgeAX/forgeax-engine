import { rng } from '@forgeax/engine/math';
import type { TextureAsset } from '@forgeax/engine/types';
import { create } from 'upstream-webgpu';

export type CloudBake = {
  readonly size: number;
  readonly volume?: boolean;
  readonly format: 'rgba16float' | 'bgra8unorm' | 'rgba8unorm';
  readonly shader: string;
  readonly seeds: Uint32Array;
  readonly clampHalf?: boolean;
  readonly densityFilter?: readonly number[];
  readonly weatherGrid?: number;
  readonly volumeGrid?: { readonly size: number; readonly fields: readonly string[] };
};

/** CPU prepares seeded noise control points only. Every output texel is evaluated on the GPU. */
export function noiseTables(legacyGradient: boolean) {
  const blocks: Uint32Array[] = [];
  let offset = 0;
  function add(data: Uint32Array) {
    const start = offset;
    offset += data.length;
    blocks.push(data);
    return start;
  }
  function permutation(seed: number) {
    const random = rng.create(seed);
    const order = Uint32Array.from({ length: 256 }, (_, index) => index);
    for (let i = 255; i > 0; i--) {
      const j = random.int(0, i);
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    return add(order);
  }
  function cellOffsets(seed: number, count: number, exact: boolean) {
    const random = rng.create(seed);
    const coordinates = Float32Array.from({ length: count * 3 }, () =>
      exact ? random.next() : 0.12 + random.next() * 0.76);
    return add(new Uint32Array(coordinates.buffer));
  }
  return {
    gradient(seed: number, period: number) {
      const start = permutation(seed);
      return (point: string) => `perlin(${point}, ${period}, ${start}u, ${legacyGradient})`;
    },
    gradient2d(seed: number, x: number, y: number) {
      const start = permutation(seed);
      return (point: string) => `perlin2d(${point}, vec2i(${x}, ${y}), ${start}u)`;
    },
    dawnGradient(seed: number, x: number, y: number, z: number) {
      const start = permutation(seed);
      return (point: string) => `1.38*perlin3d(${point}, vec3i(${x}, ${y}, ${z}), ${start}u, true)`;
    },
    cells(seed: number, period: number, exact = false) {
      const start = cellOffsets(seed, period ** 3, exact);
      return (point: string) => `worley(${point}, vec3i(${period}), ${start}u, ${exact})`;
    },
    dawnCells(seed: number, x: number, y: number, z: number) {
      const start = cellOffsets(seed, x * y * z, false);
      return (point: string) => `clamp(worley(${point}, vec3i(${x}, ${y}, ${z}), ${start}u, false), 0.0, 1.0)`;
    },
    data() {
      const result = new Uint32Array(Math.max(1, offset));
      let position = 0;
      for (const block of blocks) {
        result.set(block, position);
        position += block.length;
      }
      return result;
    },
  };
}

export const wgslFloat = (n: number) => Number.isInteger(n) ? `${n}.0` : String(n);
export const wgslVec = (v: readonly number[]) => `vec${v.length}f(${v.map(wgslFloat).join(', ')})`;

const noiseSource = /* wgsl */ `
@group(0) @binding(0) var<storage, read> seeds: array<u32>;
fn wrapCell(p: vec3i, period: vec3i) -> vec3i {
  return ((p % period) + period) % period;
}
fn centered(p: vec2f) -> vec2f { return fract(p + 0.5) - 0.5; }
fn gradient(p: vec3i, d: vec3f, index: u32, legacy: bool) -> f32 {
  let a = seeds[index + (u32(p.z) & 255u)];
  let b = seeds[index + ((u32(p.y) + a) & 255u)];
  let h = seeds[index + ((u32(p.x) + b) & 255u)] & 15u;
  let u = select(d.y, d.x, h < 8u);
  let v = select(select(d.z, d.x, h == 12u || h == 14u), d.y, h < 4u);
  let w = select(select(d.z, d.x, (h & 13u) == 12u), d.y, (h & 12u) == 0u);
  let y = select(v, w, legacy);
  return select(u, -u, (h & 1u) != 0u) + select(y, -y, (h & 2u) != 0u);
}
fn gradientSlice(p: vec3i, f: vec3f, t: vec3f, period: vec3i, index: u32, legacy: bool) -> f32 {
  let nx = vec3i(1, 0, 0);
  let ny = vec3i(0, 1, 0);
  return mix(
    mix(gradient(wrapCell(p, period), f, index, legacy),
      gradient(wrapCell(p+nx, period), f-vec3f(nx), index, legacy), t.x),
    mix(gradient(wrapCell(p+ny, period), f-vec3f(ny), index, legacy),
      gradient(wrapCell(p+nx+ny, period), f-vec3f(nx+ny), index, legacy), t.x), t.y);
}
fn perlin3d(position: vec3f, period: vec3i, index: u32, legacy: bool) -> f32 {
  let p = fract(position) * vec3f(period);
  let cell = vec3i(floor(p));
  let f = fract(p);
  let t = f*f*f*(f*(6.0*f-15.0)+10.0);
  let front = gradientSlice(cell, f, t, period, index, legacy);
  return mix(front,
    gradientSlice(cell+vec3i(0,0,1), f-vec3f(0,0,1), t, period, index, legacy), t.z);
}
fn perlin(position: vec3f, period: i32, index: u32, legacy: bool) -> f32 {
  return select(1.0, 1.45, legacy)*perlin3d(position, vec3i(period), index, legacy);
}
fn gradient2d(cell: vec2i, d: vec2f, period: vec2i, index: u32) -> f32 {
  let p = (cell % period + period) % period;
  let row = seeds[index + (u32(p.y) & 255u)];
  let h = seeds[index + ((u32(p.x) + row) & 255u)] & 7u;
  let axis = select(d.x, d.y, h >= 6u);
  if (h >= 4u) { return 1.4142*select(axis, -axis, (h & 1u) != 0u); }
  return select(d.x, -d.x, (h & 1u) != 0u) + select(d.y, -d.y, (h & 2u) != 0u);
}
fn perlin2d(position: vec2f, period: vec2i, index: u32) -> f32 {
  let p = fract(position)*vec2f(period);
  let cell = vec2i(floor(p));
  let f = fract(p);
  let t = f*f*f*(f*(6.0*f-15.0)+10.0);
  let x = vec2i(1, 0);
  let y = vec2i(0, 1);
  return 1.25*mix(
    mix(gradient2d(cell, f, period, index), gradient2d(cell+x, f-vec2f(x), period, index), t.x),
    mix(gradient2d(cell+y, f-vec2f(y), period, index), gradient2d(cell+x+y, f-vec2f(x+y), period, index), t.x), t.y);
}
fn pointDistance(p: vec3f, cell: vec3i, period: vec3i, index: u32) -> f32 {
  let c = wrapCell(cell, period);
  let i = index + u32((c.x + period.x*(c.y + period.y*c.z))*3);
  let offset = vec3f(bitcast<f32>(seeds[i]), bitcast<f32>(seeds[i+1u]), bitcast<f32>(seeds[i+2u]));
  let d = vec3f(cell) + offset - p;
  return dot(d,d);
}
fn worley(position: vec3f, period: vec3i, index: u32, exact: bool) -> f32 {
  let p = fract(position)*vec3f(period);
  let center = vec3i(floor(p));
  var nearest = select(2.0, 16.0, exact);
  for (var z = -1; z <= 1; z++) {
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        nearest = min(nearest, pointDistance(p, center+vec3i(x,y,z), period, index));
      }
    }
  }
  if (exact && nearest > 1.0) {
    for (var z = -2; z <= 2; z++) {
      for (var y = -2; y <= 2; y++) {
        for (var x = -2; x <= 2; x++) {
          if (abs(x) < 2 && abs(y) < 2 && abs(z) < 2) { continue; }
          let cell = center+vec3i(x,y,z);
          let d = max(vec3f(0), max(vec3f(cell)-p, p-vec3f(cell)-vec3f(1)));
          if (dot(d,d) < nearest) {
            nearest = min(nearest, pointDistance(p, cell, period, index));
          }
        }
      }
    }
  }
  return 1.0-sqrt(nearest);
}
`;

function generationSource(recipe: CloudBake, stage: 'pixels' | 'weather' | 'reconstruct' = 'pixels') {
  const { format, clampHalf = true, weatherGrid } = recipe;
  const size = stage === 'weather' ? weatherGrid! : recipe.size;
  const pixelType = stage === 'weather' ? 'vec4f' : 'u32';
  const pack = stage === 'weather' ? 'pixels[i] = sample;' : format === 'rgba16float'
    ? 'pixels[2u*i] = pack2x16float(value.rg); pixels[2u*i+1u] = pack2x16float(value.ba);'
    : `pixels[i] = pack4x8unorm(value${format === 'bgra8unorm' ? '.bgra' : ''});`;
  const grid = weatherGrid!;
  const interpolation = stage !== 'reconstruct' ? '' : `
@group(0) @binding(2) var<storage, read> weather: array<vec4f>;
fn weatherAt(p: vec2i) -> vec4f {
  let c = wrapCell(vec3i(p,0), vec3i(${grid}));
  return weather[c.x + ${grid}*c.y];
}
fn reconstruct(p: vec3f) -> vec4f {
  let q = p.xy*${grid}.0-0.5;
  let lo = vec2i(floor(q));
  let t = fract(q);
  return mix(mix(weatherAt(lo), weatherAt(lo+vec2i(1,0)), t.x),
    mix(weatherAt(lo+vec2i(0,1)), weatherAt(lo+vec2i(1,1)), t.x), t.y);
}`;
  return `${noiseSource}\n${stage === 'reconstruct' ? '' : recipe.shader}${interpolation}${recipe.volumeGrid ? volumeSamplingSource(recipe.volumeGrid) : ''}
@group(0) @binding(1) var<storage, read_write> pixels: array<${pixelType}>;
@compute @workgroup_size(8, 8)
fn bake(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${size}u || id.y >= ${size}u) { return; }
  let i = id.x + ${size}u*(id.y + ${size}u*id.z);
  let uv = (vec3f(id)+0.5)/${size}.0;
  let sample = ${stage === 'reconstruct' ? 'reconstruct' : 'field'}(uv);
  let value = ${format !== 'rgba16float' || clampHalf ? 'clamp(sample, vec4f(0), vec4f(1))' : 'sample'};
  ${pack}
}`;
}

function volumeSamplingSource({ size, fields }: NonNullable<CloudBake['volumeGrid']>) {
  return /* wgsl */ `
@group(0) @binding(2) var<storage, read> volumeGrid: array<f32>;
fn volumeGridAt(point: vec3i, lane: u32) -> f32 {
  let p = wrapCell(point, vec3i(${size}));
  return volumeGrid[lane + ${fields.length}u*u32(p.x + ${size}*(p.y + ${size}*p.z))];
}
fn volumeGridSlice(cell: vec3i, t: vec2f, lane: u32) -> f32 {
  let dx = vec3i(1, 0, 0);
  let dy = vec3i(0, 1, 0);
  return mix(mix(volumeGridAt(cell, lane), volumeGridAt(cell+dx, lane), t.x),
    mix(volumeGridAt(cell+dy, lane), volumeGridAt(cell+dx+dy, lane), t.x), t.y);
}
fn sampleVolumeGrid(point: vec3f, lane: u32) -> f32 {
  let p = fract(point)*${size}.0 - 0.5;
  let cell = vec3i(floor(p));
  let t = fract(p);
  return mix(volumeGridSlice(cell, t.xy, lane), volumeGridSlice(cell+vec3i(0,0,1), t.xy, lane), t.z);
}`;
}

function volumeGridSource({ size, fields }: NonNullable<CloudBake['volumeGrid']>) {
  return /* wgsl */ `${noiseSource}
@group(0) @binding(1) var<storage, read_write> outputGrid: array<f32>;
@compute @workgroup_size(8, 8)
fn bake(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${size}u || id.y >= ${size}u) { return; }
  let i = ${fields.length}u*(id.x + ${size}u*(id.y + ${size}u*id.z));
  let p = (vec3f(id) + 0.5)/${size}.0;
  ${fields.map((field, index) => `outputGrid[i + ${index}u] = ${field};`).join('\n  ')}
}`;
}

function filterSource(size: number, axis: number | undefined) {
  const offset = ['vec3i(1,0,0)', 'vec3i(0,1,0)', 'vec3i(0,0,1)'][axis ?? 0];
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> raw: array<u32>;
@group(0) @binding(1) var<storage, read_write> filtered: array<u32>;
@group(0) @binding(2) var<storage, read> previous: array<u32>;
fn index(p: vec3i) -> u32 {
  let q = (p+vec3i(${size})) % vec3i(${size});
  return u32(q.x + ${size}*(q.y + ${size}*q.z));
}
${axis === undefined ? '' : `fn density(p: vec3i) -> f32 { return bitcast<f32>(previous[index(p)]); }`}
@compute @workgroup_size(8, 8)
fn bake(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${size}u || id.y >= ${size}u) { return; }
  let p = vec3i(id);
  let i = index(p);
  ${axis === undefined ? `let original = f32((raw[i] >> 8u) & 255u);
    let g = u32(floor(mix(original, bitcast<f32>(previous[i]), 0.9) + 0.5));
    filtered[i] = (raw[i] & 0xffff00ffu) | (g << 8u);`
  : `let delta = ${offset};
    filtered[i] = bitcast<u32>(0.25*(density(p-delta) + 2.0*density(p) + density(p+delta)));`}
}`;
}

async function bakeTexture(device: GPUDevice, recipe: CloudBake): Promise<TextureAsset> {
  // WebGPU usage flags are numeric in the build host (Node does not define browser globals).
  const storage = 128, copySrc = 4, copyDst = 8, mapRead = 1;
  const { size, volume, format } = recipe;
  const depth = volume ? size : 1;
  const bytes = size * size * depth * (format === 'rgba16float' ? 8 : 4);
  const buffers: GPUBuffer[] = [];
  const buffer = (length: number, usage: number, label: string) => {
    const value = device.createBuffer({ size: length, usage, label });
    buffers.push(value);
    return value;
  };
  const encoder = device.createCommandEncoder();
  async function dispatch(source: string, dimension: number, slices: number, bindings: readonly (GPUBuffer | undefined)[]) {
    const module = device.createShaderModule({ code: source });
    const diagnostics = (await module.getCompilationInfo()).messages.filter(message => message.type === 'error');
    if (diagnostics.length) throw new Error(diagnostics.map(message => `${message.lineNum}: ${message.message}`).join('\n'));
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'bake' } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: bindings.flatMap((resource, binding) =>
      resource ? [{ binding, resource: { buffer: resource } }] : []) });
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(dimension / 8), Math.ceil(dimension / 8), slices);
    pass.end();
  }
  try {
    const lookup = recipe.seeds.length > 1
      ? buffer(recipe.seeds.byteLength, storage | copyDst, 'Cloud noise control points')
      : undefined;
    if (lookup) device.queue.writeBuffer(lookup, 0, recipe.seeds);
    const pixels = buffer(bytes, storage | copySrc, 'Cloud texels');
    if (recipe.weatherGrid !== undefined) {
      const grid = recipe.weatherGrid;
      const weather = buffer(grid ** 2 * 16, storage, 'Cloud weather grid');
      await dispatch(generationSource(recipe, 'weather'), grid, 1, [lookup, weather]);
      await dispatch(generationSource(recipe, 'reconstruct'), size, 1, [undefined, pixels, weather]);
    } else if (recipe.volumeGrid) {
      const grid = recipe.volumeGrid;
      const volume = buffer(grid.size ** 3 * grid.fields.length * 4, storage, 'Cloud cellular fields');
      await dispatch(volumeGridSource(grid), grid.size, grid.size, [lookup, volume]);
      await dispatch(generationSource(recipe), size, depth, [lookup, pixels, volume]);
    } else {
      await dispatch(generationSource(recipe), size, depth, [lookup, pixels]);
    }
    let result = pixels;
    if (recipe.densityFilter) {
      const scratch = [buffer(bytes, storage, 'Cloud filter A'), buffer(bytes, storage, 'Cloud filter B')] as const;
      const init = /* wgsl */ `
@group(0) @binding(0) var<storage, read> raw: array<u32>;
@group(0) @binding(1) var<storage, read_write> density: array<f32>;
@compute @workgroup_size(8,8)
fn bake(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${size}u || id.y >= ${size}u) { return; }
  let i = id.x + ${size}u*(id.y + ${size}u*id.z);
  density[i] = f32((raw[i] >> 8u) & 255u);
}`;
      await dispatch(init, size, depth, [pixels, scratch[0]]);
      let current = 0 as 0 | 1;
      for (const axis of recipe.densityFilter) {
        const next: 0 | 1 = current === 0 ? 1 : 0;
        await dispatch(filterSource(size, axis), size, depth, [undefined, scratch[next], scratch[current]]);
        current = next;
      }
      result = buffer(bytes, storage | copySrc, 'Filtered cloud texels');
      await dispatch(filterSource(size, undefined), size, depth, [pixels, result, scratch[current]]);
    }
    const readback = buffer(bytes, copyDst | mapRead, 'Cloud bake readback');
    encoder.copyBufferToBuffer(result, 0, readback, 0, bytes);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(mapRead);
    const data = new Uint8Array(readback.getMappedRange()).slice();
    readback.unmap();
    return { kind: 'texture', format, colorSpace: 'linear', data, mips: { kind: 'none' },
      shape: volume ? { viewDimension: '3d', extent: { width: size, height: size, depth } }
        : { viewDimension: '2d', extent: { width: size, height: size } } };
  } finally {
    for (const item of buffers) item.destroy();
  }
}

export async function bakeCloudTextures<K extends string>(recipes: Readonly<Record<K, CloudBake>>) {
  const gpu = create(process.platform === 'darwin' ? ['backend=metal'] : []);
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter || adapter.info.isFallbackAdapter)
    throw new Error('Cloud texture cooking requires a hardware WebGPU adapter. Enable GPU access on the build host.');
  const device = await adapter.requestDevice();
  try {
    const textures = {} as Record<K, TextureAsset>;
    for (const key of Object.keys(recipes) as K[]) {
      device.pushErrorScope('validation');
      try {
        textures[key] = await bakeTexture(device, recipes[key]);
      } catch (cause) {
        throw new Error(`GPU cloud texture bake failed for ${key}`, { cause });
      } finally {
        const invalid = await device.popErrorScope();
        if (invalid) throw new Error(`GPU cloud texture bake failed for ${key}: ${invalid.message}`);
      }
    }
    return textures;
  } finally {
    device.destroy();
  }
}
