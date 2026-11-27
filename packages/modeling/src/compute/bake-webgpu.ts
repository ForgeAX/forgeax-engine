import type { TextureBakeFilterInput } from './bake-ts';

const STORAGE = 0x80;
const UNIFORM = 0x40;
const COPY_SRC = 0x4;
const COPY_DST = 0x8;
const MAP_READ = 0x1;
const SIZE = 8;

// The CPU owns correspondence. Each guide here is one sampled texel, and each
// output lane is one map at that texel. Separate passes preserve the CPU filter
// order: denoise AO / estimate curvature, then apply crease-aware B-spline.
const source = `
struct Config {
  width: u32, height: u32, texels: u32, radius: i32,
  spline: u32, kind: vec4<u32>, rest: vec4<u32>,
}
struct Guide {
  point: vec3<f32>, weight: f32, normal: vec3<f32>, chart: i32,
}
@group(0) @binding(0) var<uniform> cfg: Config;
@group(0) @binding(1) var<storage, read> guides: array<Guide>;
@group(0) @binding(2) var<storage, read> sampled: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> scratch: array<f32>;
@group(0) @binding(4) var<storage, read_write> result: array<vec4<f32>>;

fn neighbor(p: vec2<i32>, chart: i32) -> i32 {
  if (any(p < vec2<i32>(0)) || p.x >= i32(cfg.width) || p.y >= i32(cfg.height)) {
    return -1;
  }
  let j = p.y * i32(cfg.width) + p.x;
  if (guides[j].weight <= 0.0 || guides[j].chart != chart) { return -1; }
  return j;
}

fn tag(map: u32) -> u32 {
  if (map < 4u) { return cfg.kind[map]; }
  return cfg.rest[map - 4u];
}

fn curvature(p: vec2<i32>, g: Guide) -> f32 {
  var sum = 0.0;
  var count = 0.0;
  let offsets = array(vec2(1, 0), vec2(-1, 0), vec2(0, 1), vec2(0, -1));
  for (var n = 0u; n < 4u; n++) {
    let j = neighbor(p + offsets[n], g.chart);
    if (j < 0) { continue; }
    let dq = guides[j].point - g.point;
    let l2 = dot(dq, dq);
    if (l2 > 0.0) {
      sum += dot(guides[j].normal - g.normal, dq) / l2;
      count += 1.0;
    }
  }
  return sum / max(1.0, count);
}

fn denoise(p: vec2<i32>, g: Guide, base: u32, own: f32) -> f32 {
  var sum = 0.0;
  var total = 0.0;
  let r = cfg.radius;
  let reach = f32((r + 1) * (r + 1));
  for (var y = -r; y <= r; y++) {
    for (var x = -r; x <= r; x++) {
      let j = neighbor(p + vec2(x, y), g.chart);
      if (j < 0) { continue; }
      let agree = dot(g.normal, guides[j].normal);
      let fall = 1.0 - f32(x*x + y*y) / reach;
      if (agree <= 0.0 || fall <= 0.0) { continue; }
      let a2 = agree * agree;
      let a4 = a2 * a2;
      let w = fall * fall * a4 * a4;
      sum += w * (sampled[base + u32(j)].x / guides[j].weight);
      total += w;
    }
  }
  if (total > 0.0) { return sum / total; }
  return own;
}

@compute @workgroup_size(${SIZE}, ${SIZE})
fn prefilter(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= cfg.width || id.y >= cfg.height) { return; }
  let kind = tag(id.z);
  if (kind != 1u && kind != 2u) { return; }
  let i = id.y * cfg.width + id.x;
  let g = guides[i];
  if (g.weight <= 0.0) { return; }
  let base = id.z * cfg.texels;
  let p = vec2<i32>(id.xy);
  if (kind == 1u) {
    scratch[base + i] = curvature(p, g);
  } else {
    scratch[base + i] = denoise(p, g, base, sampled[base + i].x / g.weight);
  }
}

fn value(i: u32, base: u32, kind: u32) -> vec4<f32> {
  var channels = sampled[base + i] / guides[i].weight;
  if (kind == 1u || kind == 2u) { channels.x = scratch[base + i]; }
  return channels;
}

@compute @workgroup_size(${SIZE}, ${SIZE})
fn splineFilter(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= cfg.width || id.y >= cfg.height) { return; }
  let i = id.y * cfg.width + id.x;
  let g = guides[i];
  if (g.weight <= 0.0) { return; }
  let base = id.z * cfg.texels;
  let kind = tag(id.z);
  if (kind == 3u) {
    result[base + i] = sampled[base + i];
    return;
  }
  if (cfg.spline == 0u) {
    result[base + i] = value(i, base, kind);
    return;
  }
  var sum = vec4<f32>(0);
  var total = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let j = neighbor(vec2<i32>(id.xy) + vec2(x, y), g.chart);
      if (j < 0) { continue; }
      let n = guides[j].normal;
      if (u32(j) != i && dot(g.normal, g.normal) > 0.5 &&
        dot(n, n) > 0.5 && dot(g.normal, n) < 0.9396926207859084) { continue; }
      let w = select(1.0, 4.0, x == 0) * select(1.0, 4.0, y == 0);
      sum += w * value(u32(j), base, kind);
      total += w;
    }
  }
  result[base + i] = sum / total;
}
`;

export async function filterBakeTexture(device: GPUDevice, input: TextureBakeFilterInput) {
  const {
    grid: { w, h },
    maps,
    sums,
    island,
    weight,
    point,
    normal,
    denoise,
    bspline,
  } = input;
  const texels = w * h;
  const guideBytes = texels * 32;
  const mapBytes = texels * 16;
  const atlasBytes = mapBytes * maps.length;
  if (
    maps.length > 8 ||
    Math.max(guideBytes, atlasBytes) > device.limits.maxStorageBufferBindingSize ||
    [w, h].some((n) => Math.ceil(n / SIZE) > device.limits.maxComputeWorkgroupsPerDimension) ||
    device.limits.maxStorageBuffersPerShaderStage < 4
  )
    return undefined;
  return withBakeGpuBuffers(device, async ({ make }) => {
    const config = make(64, UNIFORM, (range) => {
      const words = new Uint32Array(range);
      words.set([w, h, texels, denoise, Number(bspline)]);
      for (const [index, map] of maps.entries())
        words[4 * (2 + (index >> 2)) + (index % 4)] =
          map === 'materialId'
            ? 3
            : map === 'curvature' || map === 'cavity' || map === 'edgeWear'
              ? 1
              : denoise > 0 && (map === 'ao' || map === 'ormh')
                ? 2
                : 0;
    });
    const guides = make(guideBytes, STORAGE, (range) => {
      const values = new Float32Array(range);
      const tags = new Int32Array(range);
      for (let i = 0, at = 0, pixel = 0; i < texels; i++, at += 3, pixel += 8) {
        const count = weight[i] as number;
        if (count <= 0) continue;
        const nx = normal[at] as number,
          ny = normal[at + 1] as number,
          nz = normal[at + 2] as number;
        const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (length > 0) {
          values[pixel + 4] = nx / length;
          values[pixel + 5] = ny / length;
          values[pixel + 6] = nz / length;
        }
        values[pixel] = (point[at] as number) / count;
        values[pixel + 1] = (point[at + 1] as number) / count;
        values[pixel + 2] = (point[at + 2] as number) / count;
        values[pixel + 3] = count;
        tags[pixel + 7] = island[i] as number;
      }
    });
    const sampled = make(atlasBytes, STORAGE, (range) => {
      const values = new Float32Array(range);
      for (const [i, sum] of sums.entries()) values.set(sum, i * texels * 4);
    });
    const scratch = make(atlasBytes / 4, STORAGE);
    const result = make(atlasBytes, STORAGE | COPY_SRC);
    const readback = make(atlasBytes, MAP_READ | COPY_DST);
    const layout = device.createBindGroupLayout({
      entries: [config, guides, sampled, scratch, result].map((_, binding) => ({
        binding,
        visibility: 4,
        buffer: { type: binding === 0 ? 'uniform' : binding < 3 ? 'read-only-storage' : 'storage' },
      })),
    });
    const bindings = device.createBindGroup({
      layout,
      entries: [config, guides, sampled, scratch, result].map((buffer, binding) => ({
        binding,
        resource: { buffer },
      })),
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const module = device.createShaderModule({ label: 'Modeling bake UV filters', code: source });
    const commands = device.createCommandEncoder();
    for (const entryPoint of ['prefilter', 'splineFilter']) {
      const pipeline = device.createComputePipeline({
        layout: pipelineLayout,
        compute: { module, entryPoint },
      });
      const pass = commands.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindings);
      pass.dispatchWorkgroups(Math.ceil(w / SIZE), Math.ceil(h / SIZE), maps.length);
      pass.end();
    }
    commands.copyBufferToBuffer(result, 0, readback, 0, atlasBytes);
    device.queue.submit([commands.finish()]);
    // Keep one owned output for all maps. No view outlives its mapped GPU buffer.
    await readback.mapAsync(MAP_READ);
    const bytes = readback.getMappedRange().slice(0);
    readback.unmap();
    return maps.map((_, i) => new Float32Array(bytes, i * mapBytes, texels * 4));
  });
}

export async function withBakeGpuBuffers<T>(
  device: GPUDevice,
  run: (buffers: ReturnType<typeof createBakeGpuBuffers>) => Promise<T>,
): Promise<T> {
  const buffers = createBakeGpuBuffers(device);
  device.pushErrorScope('validation');
  try {
    const result = await run(buffers).then(
      (value) => ({ ok: true, value }) as const,
      (error: unknown) => ({ ok: false, error }) as const,
    );
    const validation = await device.popErrorScope();
    if (validation !== null) throw new Error(validation.message);
    if (!result.ok) throw result.error;
    return result.value;
  } finally {
    buffers.close();
  }
}

function createBakeGpuBuffers(device: GPUDevice) {
  const buffers: GPUBuffer[] = [];
  function make(size: number, usage: number, fill?: (range: ArrayBuffer) => void) {
    const buffer = device.createBuffer({ size, usage, mappedAtCreation: fill !== undefined });
    buffers.push(buffer);
    if (fill !== undefined) {
      fill(buffer.getMappedRange());
      buffer.unmap();
    }
    return buffer;
  }
  return {
    make,
    input: (size: number, fill: (range: ArrayBuffer) => void) => make(size, STORAGE, fill),
    uniform: (size: number, fill: (range: ArrayBuffer) => void) => make(size, UNIFORM, fill),
    readStorage: (size: number) => make(size, STORAGE | COPY_SRC),
    async dispatch(
      code: string,
      entryPoint: string,
      inputs: readonly GPUBuffer[],
      output: GPUBuffer,
      width: number,
      height: number,
    ) {
      const module = device.createShaderModule({ code });
      const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint },
      });
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: inputs.map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
      const commands = device.createCommandEncoder();
      const pass = commands.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(width, height);
      pass.end();
      const read = make(output.size, MAP_READ | COPY_DST);
      commands.copyBufferToBuffer(output, 0, read, 0, output.size);
      device.queue.submit([commands.finish()]);
      await read.mapAsync(MAP_READ);
      const bytes = read.getMappedRange().slice(0);
      read.unmap();
      return bytes;
    },
    close() {
      for (const buffer of buffers) buffer.destroy();
    },
  };
}
