import { CONVOY_SURFACE_IDS } from './convoy-surfaces.ts';
import { hash2, mipChain, packTextureWithGpuMips, valueNoise } from '@forgeax/engine/modeling';
import type { TextureAsset } from '@forgeax/engine/types';

const clamp = (n: number) => Math.max(0, Math.min(1, n));
const byte = (n: number) => Math.round(clamp(n) * 255);


function packedTexture(texture: TextureAsset, options: Parameters<typeof mipChain>[1]): TextureAsset {
  const chain = mipChain(texture, options);
  if (!chain.ok) throw chain.error;
  const data = new Uint8Array(chain.value.levels.reduce((sum, level) => sum + level.length, 0));
  let offset = 0;
  for (const level of chain.value.levels) { data.set(level, offset); offset += level.length; }
  return { ...texture, data, mips: { kind: 'packed', levelCount: chain.value.levels.length } };
}

/** Repeating hardware shares microfinish; it does not consume the armor's unique bake atlas. */
export function convoyHardwareTextures(): Record<string, TextureAsset> {
  const size = 256, brushed = new Uint8Array(size * size * 4), rubber = brushed.slice(), ormh = brushed.slice();
  const putNormal = (data: Uint8Array, i: number, x: number, y: number) => {
    data.set([byte(x * 0.5 + 0.5), byte(y * 0.5 + 0.5), byte(Math.sqrt(1 - x * x - y * y) * 0.5 + 0.5), 255], i);
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4, grain = hash2(x, y, 83) - 0.5;
    putNormal(brushed, i, (hash2(0, y, 31) - 0.5) * 0.14, grain * 0.018);
    putNormal(rubber, i, grain * 0.2, (hash2(x, y, 91) - 0.5) * 0.2);
    ormh.set([255, byte(0.9 + grain * 0.18), 255, 128], i);
  }
  const texture = (data: Uint8Array): TextureAsset => ({ kind: 'texture', format: 'rgba8unorm', colorSpace: 'linear', shape: { viewDimension: '2d', extent: { width: size, height: size } }, data, mips: { kind: 'none' } });
  return {
    'texture/convoy-brushed-normal': packedTexture(texture(brushed), { layout: 'normal' }),
    'texture/convoy-rubber-normal': packedTexture(texture(rubber), { layout: 'normal' }),
    'texture/convoy-hardware-ormh': packedTexture(texture(ormh), { layout: 'ormh', roughnessFromNormal: texture(brushed) }),
  };
}

const surfaceKey = (r: number, g: number, b: number) => r | (g << 8) | (b << 16);
const surfaceFamilies = new Map(Object.entries(CONVOY_SURFACE_IDS).map(([family, color]) => [surfaceKey(...color.map(value => value * 255) as [number, number, number]), family]));

function blendMicroNormal(normal: Uint8Array, i: number, dx: number, dy: number) {
  // Reoriented normal mapping layers microfinish over the actual baked high surface.
  const nx = normal[i]! / 127.5 - 1, ny = normal[i + 1]! / 127.5 - 1, nz = normal[i + 2]! / 127.5 - 1;
  const dz = Math.sqrt(Math.max(0, 1 - dx * dx - dy * dy));
  const dot = -nx * dx - ny * dy + (nz + 1) * dz;
  const rx = nz > -0.99999 ? nx * dot / (nz + 1) + dx : dx, ry = nz > -0.99999 ? ny * dot / (nz + 1) + dy : -dy, rz = nz > -0.99999 ? dot - dz : -dz;
  const length = Math.hypot(rx, ry, rz);
  normal[i] = byte(rx / length * 0.5 + 0.5); normal[i + 1] = byte(ry / length * 0.5 + 0.5); normal[i + 2] = byte(rz / length * 0.5 + 0.5);
}

function finishWeathering(position: Uint8Array, wear: Uint8Array, cavity: Uint8Array, i: number, painted: boolean) {
  const x = position[i]! / 255, y = position[i + 1]! / 255, z = position[i + 2]! / 255;
  // Object-space patches remain attached to each rigid part when it folds.
  const patch = valueNoise(x + z * 0.73, y, 16, 71);
  const grain = valueNoise(x - z * 0.41, y * 0.7, 48, 19);
  const streak = valueNoise(x + z * 0.29, y * 0.15, 24, 31);
  const edge = wear[i]! / 255;
  const chip = painted ? clamp((edge - 0.7) * 4) * clamp((patch - 0.67) * 7) : 0;
  const scratch = painted && grain > 0.66 && streak > 0.59 ? (grain - 0.66) * 1.4 : 0;
  const exposed = clamp(chip * 0.32 + scratch * 0.5);
  const dirt = clamp(cavity[i]! / 255 * 0.48 + (streak - 0.36) * 0.22);
  return { patch, exposed, dirt };
}

function deliveryMips(raw: Readonly<Record<string, TextureAsset>>) {
  const out: Record<string, TextureAsset> = {};
  for (const name of ['normal', 'ormh', 'baseColor', 'emissive', 'coat']) {
    const texture = raw[name]!;
    out[name] = packedTexture(texture, { layout: name === 'normal' ? 'normal' : name === 'ormh' ? 'ormh' : 'color', ...(name === 'ormh' ? { roughnessFromNormal: raw.normal } : {}) });
  }
  return out;
}

/** Surface paint stays in the baked atlas: no runtime noise or per-part materials. */
export function finishConvoyTextures(maps: Readonly<Record<string, TextureAsset>>) {
  const pixels = (name: string) => maps[name]!.data as Uint8Array;
  const color = pixels('baseColor').slice(), ormh = pixels('ormh').slice();
  const coat = new Uint8Array(color.length), normal = pixels('normal').slice();
  const width = maps.baseColor!.shape.extent.width;
  const ids = pixels('materialId');
  const position = pixels('position'), wear = pixels('edgeWear'), cavity = pixels('cavity');
  for (let i = 0; i < color.length; i += 4) {
    const family = surfaceFamilies.get(surfaceKey(ids[i]!, ids[i + 1]!, ids[i + 2]!));
    if (family === undefined) throw new Error('Unknown Convoy material family ID');
    const painted = family === 'painted', metal = family === 'metal', glass = family === 'glass', rubber = family === 'rubber';
    const pixel = i / 4, px = pixel % width, py = Math.floor(pixel / width);
    const grit = hash2(px, py, 17);
    const brushed = valueNoise(px * 0.035, py, 1, 31);
    const pore = valueNoise(px, py, 0.35, 49);
    const fine = rubber ? (pore - 0.5) * 0.2 : metal ? (brushed - 0.5) * 0.1 : painted ? (grit - 0.5) * 0.03 : 0;
    const dx = fine, dy = metal ? fine * 0.15 : (hash2(px, py, 73) - 0.5) * (rubber ? 0.16 : painted ? 0.03 : 0);
    blendMicroNormal(normal, i, dx, dy);
    const { patch, exposed, dirt } = finishWeathering(position, wear, cavity, i, painted);
    for (let c = 0; c < 3; c++) {
      const paint = color[i + c]! / 255;
      const steel = [0.46, 0.49, 0.51][c]!;
      const surfaceGrain = rubber ? 0.8 + pore * 0.3 : metal ? 0.94 + brushed * 0.1 : 0.98 + grit * 0.035;
      color[i + c] = byte((paint * (1 - exposed) + steel * exposed) * (1 - dirt) * surfaceGrain);
    }
    const rough = ormh[i + 1]! / 255;
    const micro = (grit - 0.5) * (rubber ? 0.1 : painted ? 0.035 : 0.075) + (metal ? (brushed - 0.5) * 0.12 : 0);
    ormh[i + 1] = byte(rough + (patch - 0.5) * (painted ? 0.08 : 0.04) + micro + dirt * 0.2 + exposed * 0.17);
    ormh[i + 2] = byte(ormh[i + 2]! / 255 * (1 - exposed) + exposed * 0.92);
    // Clearcoat is restricted to intact enamel and glass; rubber and bare steel stay dry.
    coat[i] = byte(painted ? 1 - exposed : glass ? 0.75 : 0);
    coat[i + 1] = byte((glass ? 0.035 : 0.09) + dirt * 0.35 + exposed * 0.25);
    coat[i + 3] = 255;
  }
  const raw: Record<string, TextureAsset> = { ...maps,
    baseColor: { ...maps.baseColor!, data: color },
    normal: { ...maps.normal!, data: normal },
    ormh: { ...maps.ormh!, data: ormh },
    coat: { ...maps.ormh!, data: coat },
  };
  return deliveryMips(raw);
}

const GPU_USAGE = {
  MAP_READ: 0x0001,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
} as const;

const WGSL_CONVOY_FINISH = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  texels: u32,
  _pad: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
// 7 packed input maps: [0:baseColor, 1:normal, 2:ormh, 3:materialId, 4:position, 5:edgeWear, 6:cavity]
@group(0) @binding(1) var<storage, read> in_maps: array<u32>;
// 4 packed output maps: [0:baseColor, 1:normal, 2:ormh, 3:coat]
@group(0) @binding(2) var<storage, read_write> out_maps: array<u32>;

fn hash2(x: i32, y: i32, seed: i32) -> f32 {
  var h: u32 = (bitcast<u32>(x) * 0x27d4eb2du) ^ (bitcast<u32>(y) * 0x165667b1u) ^ (bitcast<u32>(seed) * 0x9e3779b1u);
  h = (h ^ (h >> 15u)) * 0x85ebca6bu;
  h = (h ^ (h >> 13u)) * 0xc2b2ae35u;
  h = h ^ (h >> 16u);
  return f32(h) / 4294967296.0;
}

fn wrap_period_i32(i: f32, period: f32) -> i32 {
  let r = i - trunc(i / period) * period;
  let w = r + period;
  let w2 = w - trunc(w / period) * period;
  return i32(w2);
}

fn smooth_t(t: f32) -> f32 { return t * t * (3.0 - 2.0 * t); }

fn value_noise(u: f32, v: f32, period: f32, seed: i32) -> f32 {
  let x = u * period;
  let y = v * period;
  let ix = floor(x);
  let iy = floor(y);
  let fx = smooth_t(x - ix);
  let fy = smooth_t(y - iy);
  let x0 = wrap_period_i32(ix, period);
  let x1 = wrap_period_i32(ix + 1.0, period);
  let y0 = wrap_period_i32(iy, period);
  let y1 = wrap_period_i32(iy + 1.0, period);
  let a0 = hash2(x0, y0, seed);
  let a1 = hash2(x1, y0, seed);
  let b0 = hash2(x0, y1, seed);
  let b1 = hash2(x1, y1, seed);
  let a = a0 + (a1 - a0) * fx;
  let b = b0 + (b1 - b0) * fx;
  return a + (b - a) * fy;
}

fn unpack_u8x4(w: u32) -> vec4<f32> {
  return vec4<f32>(
    f32(w & 255u),
    f32((w >> 8u) & 255u),
    f32((w >> 16u) & 255u),
    f32((w >> 24u) & 255u),
  );
}

fn pack_byte(v: f32) -> u32 {
  return u32(round(clamp(v, 0.0, 1.0) * 255.0));
}

fn pack_u8x4(r: f32, g: f32, b: f32, a: f32) -> u32 {
  return pack_byte(r) | (pack_byte(g) << 8u) | (pack_byte(b) << 16u) | (pack_byte(a) << 24u);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) { return; }
  let pixel = gid.y * params.width + gid.x;
  let n_tex = params.texels;

  let col_w = in_maps[pixel];
  let norm_w = in_maps[n_tex + pixel];
  let ormh_w = in_maps[2u * n_tex + pixel];
  let id_w = in_maps[3u * n_tex + pixel];
  let pos_w = in_maps[4u * n_tex + pixel];
  let wear_w = in_maps[5u * n_tex + pixel];
  let cav_w = in_maps[6u * n_tex + pixel];

  // Family ID matches CONVOY_SURFACE_IDS:
  // painted=(255,0,0), metal=(0,255,0), glass=(0,0,255), rubber=(255,255,0), other=(0,0,0)
  let id_rgb = id_w & 0x00ffffffu;
  let painted = id_rgb == 0x000000ffu;
  let metal   = id_rgb == 0x0000ff00u;
  let glass   = id_rgb == 0x00ff0000u;
  let rubber  = id_rgb == 0x0000ffffu;

  let px = i32(gid.x);
  let py = i32(gid.y);
  let grit = hash2(px, py, 17);
  let brushed = value_noise(f32(px) * 0.035, f32(py), 1.0, 31);
  let pore = value_noise(f32(px), f32(py), 0.35, 49);

  var fine = 0.0;
  if (rubber) { fine = (pore - 0.5) * 0.2; }
  else if (metal) { fine = (brushed - 0.5) * 0.1; }
  else if (painted) { fine = (grit - 0.5) * 0.03; }

  let dx = fine;
  var dy = 0.0;
  if (metal) { dy = fine * 0.15; }
  else if (rubber) { dy = (hash2(px, py, 73) - 0.5) * 0.16; }
  else if (painted) { dy = (hash2(px, py, 73) - 0.5) * 0.03; }

  // RNM micro-normal blend
  let n_raw = unpack_u8x4(norm_w);
  let nx = n_raw.x / 127.5 - 1.0;
  let ny = n_raw.y / 127.5 - 1.0;
  let nz = n_raw.z / 127.5 - 1.0;
  let dz = sqrt(max(0.0, 1.0 - dx * dx - dy * dy));
  let d = -nx * dx - ny * dy + (nz + 1.0) * dz;
  let rx = select(dx, nx * d / (nz + 1.0) + dx, nz > -0.99999);
  let ry = select(-dy, ny * d / (nz + 1.0) + dy, nz > -0.99999);
  let rz = select(-dz, d - dz, nz > -0.99999);
  let rlen = sqrt(rx * rx + ry * ry + rz * rz);
  out_maps[n_tex + pixel] = pack_u8x4(rx / rlen * 0.5 + 0.5, ry / rlen * 0.5 + 0.5, rz / rlen * 0.5 + 0.5, n_raw.w / 255.0);

  // Weathering
  let pos_raw = unpack_u8x4(pos_w) / 255.0;
  let patch_n = value_noise(pos_raw.x + pos_raw.z * 0.73, pos_raw.y, 16.0, 71);
  let grain_n = value_noise(pos_raw.x - pos_raw.z * 0.41, pos_raw.y * 0.7, 48.0, 19);
  let streak_n = value_noise(pos_raw.x + pos_raw.z * 0.29, pos_raw.y * 0.15, 24.0, 31);
  let edge_v = f32(wear_w & 255u) / 255.0;
  let cav_v = f32(cav_w & 255u) / 255.0;

  let chip = select(0.0, clamp((edge_v - 0.7) * 4.0, 0.0, 1.0) * clamp((patch_n - 0.67) * 7.0, 0.0, 1.0), painted);
  let scratch = select(0.0, (grain_n - 0.66) * 1.4, painted && grain_n > 0.66 && streak_n > 0.59);
  let exposed = clamp(chip * 0.32 + scratch * 0.5, 0.0, 1.0);
  let dirt = clamp(cav_v * 0.48 + (streak_n - 0.36) * 0.22, 0.0, 1.0);

  let surface_grain = select(select(0.98 + grit * 0.035, 0.94 + brushed * 0.1, metal), 0.8 + pore * 0.3, rubber);
  let c_raw = unpack_u8x4(col_w) / 255.0;
  let cr = (c_raw.x * (1.0 - exposed) + 0.46 * exposed) * (1.0 - dirt) * surface_grain;
  let cg = (c_raw.y * (1.0 - exposed) + 0.49 * exposed) * (1.0 - dirt) * surface_grain;
  let cb = (c_raw.z * (1.0 - exposed) + 0.51 * exposed) * (1.0 - dirt) * surface_grain;
  out_maps[pixel] = pack_u8x4(cr, cg, cb, c_raw.w);

  let o_raw = unpack_u8x4(ormh_w) / 255.0;
  let micro_r = (grit - 0.5) * select(select(0.075, 0.035, painted), 0.1, rubber) + select(0.0, (brushed - 0.5) * 0.12, metal);
  let out_rough = o_raw.y + (patch_n - 0.5) * select(0.04, 0.08, painted) + micro_r + dirt * 0.2 + exposed * 0.17;
  let out_metal = o_raw.z * (1.0 - exposed) + exposed * 0.92;
  out_maps[2u * n_tex + pixel] = pack_u8x4(o_raw.x, out_rough, out_metal, o_raw.w);

  let coat_r = select(select(0.0, 0.75, glass), 1.0 - exposed, painted);
  let coat_g = select(0.09, 0.035, glass) + dirt * 0.35 + exposed * 0.25;
  out_maps[3u * n_tex + pixel] = pack_u8x4(coat_r, coat_g, 0.0, 1.0);
}
`;

const finishPipelineCache = new WeakMap<object, GPUComputePipeline>();

/**
 * WebGPU Compute-accelerated Convoy weathering, micro-normal, clearcoat, and delivery mip-chain pass.
 * Falls back cleanly to CPU `finishConvoyTextures` when no GPU device is available.
 */
export async function finishConvoyTexturesWithGpu(
  maps: Readonly<Record<string, TextureAsset>>,
  device: GPUDevice | undefined,
): Promise<Record<string, TextureAsset>> {
  if (device === undefined) return finishConvoyTextures(maps);
  const baseColorTex = maps.baseColor!;
  const width = baseColorTex.shape.extent.width;
  const height = baseColorTex.shape.extent.height;
  const texels = width * height;
  const mapBytes = texels * 4;

  let pipeline = finishPipelineCache.get(device);
  if (pipeline === undefined) {
    pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: WGSL_CONVOY_FINISH }), entryPoint: 'main' },
    });
    finishPipelineCache.set(device, pipeline);
  }

  const inputBytes = new Uint8Array(mapBytes * 7);
  const names = ['baseColor', 'normal', 'ormh', 'materialId', 'position', 'edgeWear', 'cavity'] as const;
  for (let i = 0; i < names.length; i++) {
    inputBytes.set((maps[names[i]]!.data as Uint8Array).subarray(0, mapBytes), i * mapBytes);
  }

  const outTotalBytes = mapBytes * 4;
  const uBuf = device.createBuffer({ size: 16, usage: GPU_USAGE.UNIFORM | GPU_USAGE.COPY_DST });
  const inBuf = device.createBuffer({ size: inputBytes.byteLength, usage: GPU_USAGE.STORAGE | GPU_USAGE.COPY_DST });
  const outBuf = device.createBuffer({ size: outTotalBytes, usage: GPU_USAGE.STORAGE | GPU_USAGE.COPY_SRC });
  const readBuf = device.createBuffer({ size: outTotalBytes, usage: GPU_USAGE.MAP_READ | GPU_USAGE.COPY_DST });

  let packedOut: Uint8Array;
  try {
    device.queue.writeBuffer(uBuf, 0, new Uint32Array([width, height, texels, 0]));
    device.queue.writeBuffer(inBuf, 0, inputBytes);
    const bg = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uBuf } },
        { binding: 1, resource: { buffer: inBuf } },
        { binding: 2, resource: { buffer: outBuf } },
      ],
    });
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8), 1);
    pass.end();
    enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, outTotalBytes);
    device.queue.submit([enc.finish()]);
    await readBuf.mapAsync(GPU_USAGE.MAP_READ);
    packedOut = new Uint8Array(readBuf.getMappedRange().slice(0));
    readBuf.unmap();
  } finally {
    uBuf.destroy();
    inBuf.destroy();
    outBuf.destroy();
    readBuf.destroy();
  }

  const raw: Record<string, TextureAsset> = {
    ...maps,
    baseColor: { ...baseColorTex, data: packedOut.subarray(0, mapBytes) },
    normal: { ...maps.normal!, data: packedOut.subarray(mapBytes, mapBytes * 2) },
    ormh: { ...maps.ormh!, data: packedOut.subarray(mapBytes * 2, mapBytes * 3) },
    coat: { ...maps.ormh!, data: packedOut.subarray(mapBytes * 3, mapBytes * 4) },
  };

  const mapNames = ['normal', 'ormh', 'baseColor', 'emissive', 'coat'] as const;
  const packedResults = await Promise.all(
    mapNames.map((name) =>
      packTextureWithGpuMips(
        raw[name]!,
        {
          layout: name === 'normal' ? 'normal' : name === 'ormh' ? 'ormh' : 'color',
          ...(name === 'ormh' ? { roughnessFromNormal: raw.normal } : {}),
        },
        device,
      ),
    ),
  );
  const out: Record<string, TextureAsset> = {};
  for (let i = 0; i < mapNames.length; i++) {
    const res = packedResults[i]!;
    if (!res.ok) throw res.error;
    out[mapNames[i]!] = res.value;
  }
  return out;
}

/** GPU-accelerated mip packing for hardware microfinish textures (reuses build GPUDevice). */
export async function convoyHardwareTexturesWithGpu(device: GPUDevice | undefined): Promise<Record<string, TextureAsset>> {
  if (device === undefined) return convoyHardwareTextures();
  const size = 256, brushed = new Uint8Array(size * size * 4), rubber = brushed.slice(), ormh = brushed.slice();
  const putNormal = (data: Uint8Array, i: number, x: number, y: number) => {
    data.set([byte(x * 0.5 + 0.5), byte(y * 0.5 + 0.5), byte(Math.sqrt(1 - x * x - y * y) * 0.5 + 0.5), 255], i);
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4, grain = hash2(x, y, 83) - 0.5;
    putNormal(brushed, i, (hash2(0, y, 31) - 0.5) * 0.14, grain * 0.018);
    putNormal(rubber, i, grain * 0.2, (hash2(x, y, 91) - 0.5) * 0.2);
    ormh.set([255, byte(0.9 + grain * 0.18), 255, 128], i);
  }
  const tex = (data: Uint8Array): TextureAsset => ({ kind: 'texture', format: 'rgba8unorm', colorSpace: 'linear', shape: { viewDimension: '2d', extent: { width: size, height: size } }, data, mips: { kind: 'none' } });
  const brushedTex = tex(brushed);
  const [bNorm, rNorm, hOrmh] = await Promise.all([
    packTextureWithGpuMips(brushedTex, { layout: 'normal' }, device),
    packTextureWithGpuMips(tex(rubber), { layout: 'normal' }, device),
    packTextureWithGpuMips(tex(ormh), { layout: 'ormh', roughnessFromNormal: brushedTex }, device),
  ]);
  if (!bNorm.ok) throw bNorm.error;
  if (!rNorm.ok) throw rNorm.error;
  if (!hOrmh.ok) throw hOrmh.error;
  return {
    'texture/convoy-brushed-normal': bNorm.value,
    'texture/convoy-rubber-normal': rNorm.value,
    'texture/convoy-hardware-ormh': hOrmh.value,
  };
}
