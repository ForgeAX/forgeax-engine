// Three-way native diagnostic: direct / archived cache / current cache.
// Build an archived cache first, then pass its .js path as the second argument.
// GPU completion, input mutation, validation scopes and explicit GC are outside timing.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Result, RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { create, globals } from '@forgeax/engine-dawn-node';
import { makeRhiDevice } from '../../rhi-webgpu/src/device';
import { createShaderModule } from '../../rhi-webgpu/src/index';
import { RenderBundleCache } from '../src/record/render-bundle-cache';

const variants = ['direct', 'before', 'after'] as const;
type Variant = (typeof variants)[number];
type Sample = { encodingMs: number; finishMs: number; submitMs: number; cpuSubmitMs: number };
const cases = [
  { name: 'stable', draws: 512, passes: 1 },
  { name: 'first-change', draws: 2048, passes: 1 },
  { name: 'last-change', draws: 2048, passes: 1 },
  { name: 'sparse-change', draws: 2048, passes: 1 },
  { name: 'count-churn', draws: 512, passes: 1 },
  { name: 'empty-refill', draws: 512, passes: 1 },
  { name: 'reverse-order', draws: 512, passes: 1 },
  { name: 'resource-churn', draws: 512, passes: 1 },
  { name: 'offset-churn', draws: 512, passes: 1 },
  { name: 'large-offset-slice', draws: 128, passes: 1 },
  { name: 'live-buffer-data', draws: 512, passes: 1 },
  { name: 'two-frame-runs', draws: 512, passes: 1 },
  { name: 'eight-frame-runs', draws: 512, passes: 1 },
  { name: 'mixed-passes', draws: 256, passes: 8 },
  { name: 'draw-pressure-stable', draws: 8192, passes: 1 },
  { name: 'draw-pressure-churn', draws: 8192, passes: 1 },
  { name: 'resource-soak', draws: 128, passes: 4 },
] as const;
function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw result.error;
  return result.value;
}
function quantile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const low = sorted[Math.floor(position)],
    high = sorted[Math.ceil(position)];
  if (low === undefined || high === undefined) throw new Error('No samples');
  return low + (high - low) * (position - Math.floor(position));
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function main() {
  const output = process.argv[2],
    baselinePath = process.argv[3];
  if (!output || !baselinePath)
    throw new Error('Usage: render-bundle-stress.js OUTPUT.json ARCHIVED-CACHE.js');
  const Before = (await import(pathToFileURL(resolve(baselinePath)).href))
    .RenderBundleCache as typeof RenderBundleCache;
  if (typeof Before !== 'function') throw new Error('Baseline must export RenderBundleCache');
  Object.assign(globalThis, globals);
  const gpu = create([]);
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error('No Dawn adapter');
  const raw = await adapter.requestDevice();
  const errors: string[] = [];
  raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const device = makeRhiDevice(raw).device;
  const texture = value(device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 0x10 }));
  const view = value(device.createTextureView(texture, {}));
  const vertexData = new Float32Array([-1, -1, 3, -1, -1, 3]);
  const makeVertex = () => {
    const result = value(device.createBuffer({ size: 24, usage: 0x28 }));
    value(device.queue.writeBuffer(result, 0, vertexData));
    return result;
  };
  let vertices = makeVertex();
  const indices = value(device.createBuffer({ size: 8, usage: 0x18 }));
  value(device.queue.writeBuffer(indices, 0, new Uint16Array([0, 1, 2, 0])));
  const stride = raw.limits.minUniformBufferOffsetAlignment;
  const uniform = value(device.createBuffer({ size: 64 * stride, usage: 0x48 }));
  for (let i = 0; i < 64; i++)
    value(device.queue.writeBuffer(uniform, i * stride, new Float32Array([0, 1, 0, 1])));
  const bgl = value(
    device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: 2,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 },
        },
      ],
    }),
  );
  const makeGroup = () =>
    value(
      device.createBindGroup({
        layout: bgl,
        entries: [
          { binding: 0, resource: { kind: 'buffer', value: { buffer: uniform, size: 16 } } },
        ],
      }),
    );
  const selectedCases = process.argv[4]?.split(',');
  if (selectedCases?.some((name) => !cases.some((scenario) => scenario.name === name))) {
    throw new Error('Unknown stress case');
  }
  const selectedVariants = variants.filter(
    (variant) => !process.argv[5] || process.argv[5].split(',').includes(variant),
  );
  if (selectedVariants.length === 0) throw new Error('No selected variants');
  let group = makeGroup();
  const layout = value(device.createPipelineLayout({ bindGroupLayouts: [bgl] }));
  const shader = value(
    await createShaderModule(device, {
      code: `
@group(0) @binding(0) var<uniform> color:vec4f;
@vertex fn vs(@location(0) p:vec2f)->@builtin(position) vec4f{return vec4f(p,0.,1.);}
@fragment fn fs()->@location(0) vec4f{return color;}`,
    }),
  );
  const pipeline = value(
    device.createRenderPipeline({
      layout,
      vertex: {
        module: shader,
        entryPoint: 'vs',
        buffers: [
          { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
        ],
      },
      fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    }),
  );
  const orders: readonly (readonly Variant[])[] = [
    ['direct', 'before', 'after'],
    ['before', 'after', 'direct'],
    ['after', 'direct', 'before'],
    ['after', 'before', 'direct'],
    ['before', 'direct', 'after'],
    ['direct', 'after', 'before'],
  ];
  const results = [];
  const loadStart = loadavg();
  // dawn.node owns its background runtime through create()'s returned object.
  // Match the real backend/setup lifetime, including collections during the soak.
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu } });
  try {
    for (const scenario of cases) {
      if (selectedCases && !selectedCases.includes(scenario.name)) continue;
      const { name, draws, passes } = scenario;
      const caches = {
        before: Array.from({ length: passes }, () => new Before({ colorFormats: ['rgba8unorm'] })),
        after: Array.from(
          { length: passes },
          () => new RenderBundleCache({ colorFormats: ['rgba8unorm'] }),
        ),
      };
      const offsets = new Uint32Array(name === 'large-offset-slice' ? 65_536 : 64);
      const sliceStart = name === 'large-offset-slice' ? 32_768 : 0;
      let epoch = 0,
        count: number = draws;
      const record = (pass: RhiRenderPassEncoder, passIndex: number) => {
        pass.setPipeline(pipeline);
        const changes =
          name === 'draw-pressure-churn' ||
          name === 'first-change' ||
          name === 'last-change' ||
          name === 'sparse-change' ||
          name === 'two-frame-runs' ||
          name === 'eight-frame-runs' ||
          (name === 'mixed-passes' && passIndex % 2 === 1);
        for (let draw = 0; draw < count; draw++) {
          const number = name === 'reverse-order' && epoch % 2 === 1 ? count - draw - 1 : draw;
          const offsetIndex = name === 'large-offset-slice' ? sliceStart : number % 64;
          const selected =
            name === 'first-change' || name === 'draw-pressure-churn'
              ? draw === 0
              : name === 'sparse-change'
                ? draw % 16 === 0
                : draw === count - 1;
          pass.setVertexBuffer(0, vertices, 0, 24);
          pass.setIndexBuffer(indices, 'uint16', 0, 6);
          pass.setBindGroup(0, group, offsets, offsetIndex, 1);
          pass.drawIndexed(3, 1, 0, 0, changes && selected ? epoch % 2 : 0);
        }
      };
      const samples: Record<Variant, Sample[]> = { direct: [], before: [], after: [] };
      const memory: { frame: number; heapUsed: number; external: number; rss: number }[] = [];
      const sample = async (variant: Variant): Promise<Sample> => {
        const start = performance.now();
        const encoder = value(device.createCommandEncoder());
        let encodingMs = 0;
        for (let passIndex = 0; passIndex < passes; passIndex++) {
          const pass = encoder.beginRenderPass({
            colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
          });
          const encodeStart = performance.now();
          if (variant === 'direct') record(pass, passIndex);
          else {
            const cache = caches[variant][passIndex];
            if (!cache) throw new Error('Missing cache');
            cache.encode(device, pass, (p) => record(p, passIndex));
          }
          encodingMs += performance.now() - encodeStart;
          pass.end();
        }
        const finishStart = performance.now();
        const command = value(encoder.finish());
        const finishMs = performance.now() - finishStart;
        const submitStart = performance.now();
        value(device.queue.submit([command]));
        const submitMs = performance.now() - submitStart;
        const cpuSubmitMs = performance.now() - start;
        await device.queue.onSubmittedWorkDone();
        return { encodingMs, finishMs, submitMs, cpuSubmitMs };
      };
      const warmupTriads = 12,
        measuredTriads = name === 'resource-soak' ? 300 : 60;
      process.stdout.write(`Starting ${name}: ${selectedVariants.join('/')}\n`);
      raw.pushErrorScope('validation');
      for (let frame = -warmupTriads; frame < measuredTriads; frame++) {
        const serial = frame + warmupTriads;
        epoch =
          name === 'two-frame-runs'
            ? Math.floor(serial / 2)
            : name === 'eight-frame-runs'
              ? Math.floor(serial / 8)
              : serial;
        count =
          name === 'count-churn'
            ? draws + (serial % 2 === 0 ? 16 : -16)
            : name === 'empty-refill' && Math.floor(serial / 4) % 2 === 0
              ? 0
              : draws;
        if (name === 'resource-churn' || name === 'resource-soak') {
          const old = vertices;
          vertices = makeVertex();
          group = makeGroup();
          value(device.destroyBuffer(old));
        }
        for (let i = 0; i < 64; i++)
          offsets[i] = ((i + (name === 'offset-churn' ? serial : 0)) % 64) * stride;
        if (name === 'large-offset-slice') offsets[sliceStart] = 0;
        if (name === 'live-buffer-data')
          value(device.queue.writeBuffer(uniform, 0, new Float32Array([serial % 2, 1, 0, 1])));
        if (name === 'resource-soak' && serial % 50 === 0) {
          globalThis.gc?.();
          const { heapUsed, external, rss } = process.memoryUsage();
          memory.push({ frame, heapUsed, external, rss });
        }
        const order = orders[serial % orders.length];
        if (!order) throw new Error('Missing balanced order');
        for (const variant of order) {
          if (!selectedVariants.includes(variant)) continue;
          const result = await sample(variant);
          if (frame >= 0) samples[variant].push(result);
        }
      }
      const validation = await raw.popErrorScope();
      if (validation) throw new Error(`${name}: ${validation.message}`);
      const stats = Object.fromEntries(
        selectedVariants.map((variant) => [
          variant,
          Object.fromEntries(
            (['encodingMs', 'finishMs', 'submitMs', 'cpuSubmitMs'] as const).map((metric) => [
              metric,
              {
                p50: quantile(
                  samples[variant].map((s) => s[metric]),
                  0.5,
                ),
                p95: quantile(
                  samples[variant].map((s) => s[metric]),
                  0.95,
                ),
              },
            ]),
          ),
        ]),
      );
      results.push({ scenario, warmupTriads, measuredTriads, stats, samples, memory });
      await mkdir(dirname(output), { recursive: true });
      await writeFile(`${output}.partial`, JSON.stringify({ complete: false, results }, null, 2));
      process.stdout.write(`${name}: ${JSON.stringify(stats)}\n`);
    }
    if (errors.length) throw new Error(errors.join('\n'));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(
      output,
      JSON.stringify(
        {
          scope: 'software-gpu-diagnostic',
          recordedAt: new Date().toISOString(),
          benchmarkSha256: hash(await readFile(process.argv[1] ?? '')),
          baselineSha256: hash(await readFile(baselinePath)),
          adapter: {
            vendor: adapter.info.vendor,
            architecture: adapter.info.architecture,
            device: adapter.info.device,
            description: adapter.info.description,
          },
          host: {
            cpu: cpus()[0]?.model,
            logicalCpus: cpus().length,
            loadStart,
            loadEnd: loadavg(),
            node: process.version,
            exclusive: false,
            explicitGc: typeof globalThis.gc === 'function',
          },
          protocol: {
            variants: selectedVariants,
            orders,
            target: '1x1 RGBA8, indexed triangle with per-draw vertex/index/group binds',
            encoding: 'sum of record/cache.encode only',
            finish: 'encoder.finish only',
            submit: 'queue.submit call only',
            cpuSubmit: 'encoder creation through queue.submit return',
            excluded:
              'input mutation, resource setup, explicit GC, GPU completion, whole Renderer and FPS',
            quantile: 'linear interpolation at (n-1)*p; no measured samples discarded',
            memory:
              'combined-process post-GC diagnostic during the resource soak, not per-variant GPU memory',
          },
          results,
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
  } finally {
    for (const buffer of [vertices, indices, uniform]) value(device.destroyBuffer(buffer));
    value(device.destroyTexture(texture));
    raw.destroy();
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
