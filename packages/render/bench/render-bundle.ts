// Native CPU diagnostic. GPU completion is awaited outside both timed regions.
// Build: node node_modules/tsup/dist/cli-default.js packages/render/bench/render-bundle.ts --format esm --external webgpu --out-dir artifacts/render-bundle/bench
// Run: node scripts/ci/local-graphics.mjs --probe dawn -- node artifacts/render-bundle/bench/render-bundle.js artifacts/render-bundle/performance-1.json
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, loadavg, platform, release } from 'node:os';
import { dirname } from 'node:path';
import type { Result, RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { create, globals } from '@forgeax/engine-dawn-node';
import { makeRhiDevice } from '../../rhi-webgpu/src/device';
import { createShaderModule } from '../../rhi-webgpu/src/index';
import { RenderBundleCache } from '../src/record/render-bundle-cache';

function value<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

function quantile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * fraction;
  const low = sorted[Math.floor(index)];
  const high = sorted[Math.ceil(index)];
  if (low === undefined || high === undefined) throw new Error('Empty sample');
  return low + (high - low) * (index - Math.floor(index));
}

type Sample = { encodingMs: number; cpuSubmitMs: number };
type State = 'stable' | 'first-frame' | 'bundle-build' | 'every-frame-invalidated';
function summarize(samples: readonly Sample[]) {
  const metric = (key: keyof Sample) => ({
    p50: quantile(
      samples.map((sample) => sample[key]),
      0.5,
    ),
    p95: quantile(
      samples.map((sample) => sample[key]),
      0.95,
    ),
  });
  return { encodingMs: metric('encodingMs'), cpuSubmitMs: metric('cpuSubmitMs') };
}

async function main() {
  const output = process.argv[2];
  if (!output) throw new Error('Pass an unused output JSON path');
  const loadStart = loadavg();
  Object.assign(globalThis, globals);
  const gpu = create([]);
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error('Dawn adapter unavailable');
  const raw = await adapter.requestDevice();
  const errors: string[] = [];
  raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const device = makeRhiDevice(raw).device;
  const texture = value(device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 0x10 }));
  const view = value(device.createTextureView(texture, {}));
  const vertices = value(device.createBuffer({ size: 24, usage: 0x28 }));
  value(device.queue.writeBuffer(vertices, 0, new Float32Array([-1, -1, 3, -1, -1, 3])));
  const indices = value(device.createBuffer({ size: 8, usage: 0x18 }));
  value(device.queue.writeBuffer(indices, 0, new Uint16Array([0, 1, 2, 0])));
  const uniformStride = raw.limits.minUniformBufferOffsetAlignment;
  const uniform = value(device.createBuffer({ size: uniformStride * 64, usage: 0x48 }));
  for (let i = 0; i < 64; i++) {
    value(device.queue.writeBuffer(uniform, i * uniformStride, new Float32Array([0, 1, 0, 1])));
  }
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
  const group = value(
    device.createBindGroup({
      layout: bgl,
      entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: uniform, size: 16 } } }],
    }),
  );
  const results = [];
  const warmupPairs = 40;
  const measuredPairs = 120;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu } });
  try {
    for (const workload of ['draw-only', 'indexed-bindings'] as const) {
      const indexed = workload === 'indexed-bindings';
      const shader = value(
        await createShaderModule(device, {
          code: indexed
            ? `
@group(0) @binding(0) var<uniform> color: vec4f;
@vertex fn vs(@location(0) p:vec2f)->@builtin(position) vec4f{return vec4f(p,0.,1.);}
@fragment fn fs()->@location(0) vec4f{return color;}`
            : `
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
var p=array<vec2f,3>(vec2f(-1.,-1.),vec2f(3.,-1.),vec2f(-1.,3.));return vec4f(p[i],0.,1.);}
@fragment fn fs()->@location(0) vec4f{return vec4f(0.,1.,0.,1.);}`,
        }),
      );
      const layout = value(device.createPipelineLayout({ bindGroupLayouts: indexed ? [bgl] : [] }));
      const pipeline = value(
        device.createRenderPipeline({
          layout,
          vertex: {
            module: shader,
            entryPoint: 'vs',
            buffers: indexed
              ? [
                  {
                    arrayStride: 8,
                    attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
                  },
                ]
              : [],
          },
          fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
        }),
      );
      const offsets = Array.from(
        { length: 64 },
        (_, index) =>
          // Include a real typed-array slice: the cache must compare a copied offset.
          new Uint32Array([0, index * uniformStride, 0]),
      );
      const cases: { drawCount: number; state: State }[] = [
        { drawCount: 64, state: 'stable' },
        { drawCount: 512, state: 'stable' },
        { drawCount: 2048, state: 'stable' },
        { drawCount: 2048, state: 'first-frame' },
        { drawCount: 2048, state: 'bundle-build' },
        { drawCount: 2048, state: 'every-frame-invalidated' },
      ];
      for (const { drawCount, state } of cases) {
        const makeCache = () => new RenderBundleCache({ colorFormats: ['rgba8unorm'] });
        let cache = makeCache();
        let revision = 0;
        const record = (pass: RhiRenderPassEncoder) => {
          pass.setPipeline(pipeline);
          for (let i = 0; i < drawCount; i++) {
            // Change the final command so invalidation measures a long matching prefix.
            // Both paths still render exactly the same triangle, with the same instance count.
            const firstInstance = i === drawCount - 1 ? revision : 0;
            if (indexed) {
              const dynamicOffset = offsets[i % 64];
              if (dynamicOffset === undefined) throw new Error('Missing dynamic offset');
              pass.setVertexBuffer(0, vertices, 0, 24);
              pass.setIndexBuffer(indices, 'uint16', 0, 6);
              pass.setBindGroup(0, group, dynamicOffset, 1, 1);
              pass.drawIndexed(3, 1, 0, 0, firstInstance);
            } else {
              pass.draw(3, 1, 0, firstInstance);
            }
          }
        };
        const sample = async (cached: boolean): Promise<Sample> => {
          const cpuStart = performance.now();
          const encoder = value(device.createCommandEncoder());
          const pass = encoder.beginRenderPass({
            colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
          });
          const encodeStart = performance.now();
          if (cached) cache.encode(device, pass, record);
          else record(pass);
          const encodingMs = performance.now() - encodeStart;
          pass.end();
          value(device.queue.submit([value(encoder.finish())]));
          const cpuSubmitMs = performance.now() - cpuStart;
          await device.queue.onSubmittedWorkDone();
          return { encodingMs, cpuSubmitMs };
        };
        const direct: Sample[] = [];
        const cached: Sample[] = [];
        raw.pushErrorScope('validation');
        for (let pair = -warmupPairs; pair < measuredPairs; pair++) {
          if (state === 'every-frame-invalidated') revision = (revision + 1) % 2;
          if (state === 'first-frame' || state === 'bundle-build') cache = makeCache();
          // Seed one matching direct frame outside timing; the next frame builds the bundle.
          if (state === 'bundle-build') await sample(true);
          const order = pair % 2 === 0 ? [false, true] : [true, false];
          for (const useCache of order) {
            const timing = await sample(useCache);
            if (pair >= 0) (useCache ? cached : direct).push(timing);
          }
        }
        const validation = await raw.popErrorScope();
        if (validation) throw new Error(validation.message);
        const stats = { direct: summarize(direct), cached: summarize(cached) };
        results.push({
          workload,
          drawCount,
          state,
          stats,
          encodingReduction: 1 - stats.cached.encodingMs.p50 / stats.direct.encodingMs.p50,
          cpuSubmitReduction: 1 - stats.cached.cpuSubmitMs.p50 / stats.direct.cpuSubmitMs.p50,
          samples: { direct, cached },
        });
        process.stdout.write(`${workload} ${drawCount} ${state}: ${JSON.stringify(stats)}\n`);
      }
    }
    if (errors.length) throw new Error(errors.join('\n'));
    const result = {
      scope: 'software-gpu-diagnostic',
      recordedAt: new Date().toISOString(),
      bundleSha256: createHash('sha256')
        .update(await readFile(process.argv[1] ?? ''))
        .digest('hex'),
      adapter: {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
        description: adapter.info.description,
      },
      host: {
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        os: `${platform()} ${release()}`,
        node: process.version,
        loadStart,
        loadEnd: loadavg(),
        ownership: 'shared; no exclusive CPU or GPU reservation',
      },
      protocol: {
        warmupPairs,
        measuredPairs,
        order: 'AB/BA alternates each pair, no discarded measured samples',
        quantile: 'linear interpolation at (n - 1) * p; even-n p50 averages the middle pair',
        target: '1x1 rgba8unorm, one pass, one pipeline, 3 vertices and one instance per draw',
        encodingMs: 'record(pass) or RenderBundleCache.encode, including comparison and recording',
        cpuSubmitMs: 'command encoder creation through queue.submit return, including encoding',
        excluded: 'resource setup, cache object creation, frame extraction, GPU completion and FPS',
        validation:
          'Dawn validation error scopes and uncaptured errors checked; pixel fixtures separate',
      },
      results,
    };
    await mkdir(dirname(output), { recursive: true });
    // Refuse to replace prior measurements.
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`Saved ${output}\n`);
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
