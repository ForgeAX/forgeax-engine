import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, platform } from 'node:os';
import { PerformanceObserver } from 'node:perf_hooks';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { buildProfileModel, createProfiler } from '@forgeax/engine-profiler';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
  PointLightShadow,
  SpotLight,
} from '@forgeax/engine-render';
import { summarizeGpuPassTimingIntervals } from '@forgeax/engine-render/internal';
import { ok } from '@forgeax/engine-rhi';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing perf entity');
  return value;
}

// Native query brackets the unchanged Renderer command buffers in one queue
// submit. These two 1x1 clear marker passes are identical in both measurements;
// pass intervals remain separate and no CPU clock substitutes for GPU time.
function nativeOuterProbe() {
  let native: GPUDevice | undefined;
  let query: GPUQuerySet | undefined;
  let resolved: GPUBuffer | undefined;
  let readback: GPUBuffer | undefined;
  let marker: GPUTexture | undefined;
  let original: GPUQueue['submit'] | undefined;
  let armed = false;
  let submissions = 0;
  let ticks: readonly string[] | null = null;
  let previousEnd = 0n;
  return {
    instrumentation: {
      resolveSurfaceDevice(device: import('@forgeax/engine-rhi').RhiDevice) {
        const raw = webgpu._internal_getRawDevice(device);
        if (raw === undefined) throw new Error('missing native timing device');
        if (native !== undefined) {
          if (native !== raw) throw new Error('unexpected performance device replacement');
          return ok(device);
        }
        native = raw;
        if (!raw.features.has('timestamp-query')) return ok(device);
        query = raw.createQuerySet({ type: 'timestamp', count: 2 });
        resolved = raw.createBuffer({
          size: 16,
          usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
        });
        readback = raw.createBuffer({
          size: 16,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        marker = raw.createTexture({
          size: [1, 1],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        const savedSubmit = raw.queue.submit.bind(raw.queue);
        original = raw.queue.submit;
        raw.queue.submit = (commands) => {
          if (!armed) return savedSubmit(commands);
          submissions++;
          if (
            query === undefined ||
            resolved === undefined ||
            readback === undefined ||
            marker === undefined
          )
            throw new Error('missing native timing resources');
          const before = raw.createCommandEncoder({ label: 'lighting-perf-outer-begin' });
          before
            .beginRenderPass({
              colorAttachments: [
                {
                  view: marker.createView(),
                  loadOp: 'clear',
                  storeOp: 'store',
                  clearValue: [0, 0, 0, 0],
                },
              ],
              timestampWrites: { querySet: query, endOfPassWriteIndex: 0 },
            })
            .end();
          const after = raw.createCommandEncoder({ label: 'lighting-perf-outer-end' });
          after
            .beginRenderPass({
              colorAttachments: [
                {
                  view: marker.createView(),
                  loadOp: 'clear',
                  storeOp: 'store',
                  clearValue: [0, 0, 0, 0],
                },
              ],
              timestampWrites: { querySet: query, beginningOfPassWriteIndex: 1 },
            })
            .end();
          after.resolveQuerySet(query, 0, 2, resolved, 0);
          after.copyBufferToBuffer(resolved, 0, readback, 0, 16);
          savedSubmit([before.finish(), ...commands, after.finish()]);
        };
        return ok(device);
      },
    },
    begin() {
      submissions = 0;
      ticks = null;
      armed = true;
    },
    end() {
      armed = false;
    },
    async read() {
      if (readback === undefined) return null;
      expect(submissions).toBe(1);
      await readback.mapAsync(GPUMapMode.READ);
      try {
        const values = new BigUint64Array(readback.getMappedRange());
        const begin = values[0],
          end = values[1];
        if (begin === undefined || end === undefined || end < begin)
          throw new Error('missing or reversed native outer timestamps');
        ticks = [String(begin), String(end)];
        if (begin > 0n && end > 0n) {
          if (begin < previousEnd) throw new Error('stale native outer timestamps');
          previousEnd = end;
        }
        return begin === 0n || end === 0n ? 0 : Number(end - begin);
      } finally {
        readback.unmap();
      }
    },
    ticks: () => ticks,
    dispose() {
      if (native !== undefined && original !== undefined) native.queue.submit = original;
      query?.destroy();
      resolved?.destroy();
      readback?.destroy();
      marker?.destroy();
    },
  };
}

const percentile = (values: number[], q: number) =>
  [...values].sort((a, b) => a - b)[Math.ceil(q * values.length) - 1] ?? null;

// Diagnostic carrier is opt-in, like the existing TAA/LOD performance owners.
// Its fixed workload and acceptance budgets live in the report before measurement.
it.skipIf(process.env.LIGHTING_CHANNEL_PERF !== '1')(
  'measures selective-light CPU/GPU cost with frozen workloads',
  {
    timeout: 1_800_000,
    retry: 0,
  },
  async () => {
    const reference = process.env.LIGHTING_CHANNEL_PERF_LABEL === 'reference';
    const label = reference ? 'reference' : 'channels';
    const directory = `artifacts/lighting-channels/performance-${label}`;
    mkdirSync(directory, { recursive: true });
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter === null) throw new Error('missing physical performance adapter');
    const manifest = shaderManifestUrl(await buildEngineShaderManifest({ pointShadows: true }));
    const sourceHash = createHash('sha256');
    const sourcePaths = execFileSync(
      'git',
      [
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        'packages/render/src',
        'packages/shader/src',
      ],
      { encoding: 'utf8' },
    )
      .split('\0')
      .filter(Boolean)
      .sort();
    for (const path of sourcePaths) sourceHash.update(path).update('\0').update(readFileSync(path));
    const hardware = {
      cpu: cpus()[0]?.model,
      platform: platform(),
      node: process.version,
      nodeEnvironment: process.env.NODE_ENV ?? null,
      ci: process.env.CI ?? null,
      revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      adapter: {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
        description: adapter.info.description,
      },
      sourceDiffSha256: createHash('sha256')
        .update(execFileSync('git', ['diff', '--', 'packages/render/src', 'packages/shader/src']))
        .digest('hex'),
      timestampQuery: adapter.features.has('timestamp-query'),
      sourceTreeSha256: sourceHash.digest('hex'),
      harnessSha256: createHash('sha256')
        .update(
          readFileSync('packages/runtime/src/__tests__/lighting-channels-performance.dawn.test.ts'),
        )
        .digest('hex'),
      nativeOuterTiming: {
        status: adapter.features.has('timestamp-query') ? 'requested' : 'unavailable',
        method:
          'native 1x1 clear markers around the original Renderer command buffers in one queue submit',
        units: 'nanoseconds',
        markerPassesPerSubmission: 2,
        markerTextureBytes: 4,
        queryCount: 2,
        resolveAndReadbackBytes: 32,
        cpuInstrumentationIncluded: true,
      },
    };
    const windowPaths: string[] = [];
    const gc: { began: number; duration: number }[] = [];
    const gcObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        gc.push({ began: entry.startTime, duration: entry.duration });
    });
    gcObserver.observe({ entryTypes: ['gc'] });
    for (const [size, receiverCount, localCount] of [
      [128, 16, 4],
      [512, 256, 32],
    ] as const) {
      const target = offscreenCanvas(size);
      const profiler = createProfiler();
      const outer = nativeOuterProbe();
      const host = renderValue(
        await constructRuntimeRendererHost(
          target.canvas,
          { gpuPassTiming: {}, profiler, rhiInstrumentation: outer.instrumentation },
          { shaderManifestUrl: manifest },
        ),
      );
      const renderer = host.renderer;
      const world = new World();
      const mesh = world.allocSharedRef('MeshAsset', createBoxGeometry(1, 1, 0.2).unwrap());
      const material = world.allocSharedRef(
        'MaterialAsset',
        Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1], roughness: 0.7 }),
      );
      const side = Math.sqrt(receiverCount);
      const receivers = Array.from({ length: receiverCount }, (_, i) =>
        world
          .spawn(
            {
              component: Transform,
              data: {
                pos: [
                  ((i % side) - (side - 1) / 2) * 0.14,
                  (Math.floor(i / side) - (side - 1) / 2) * 0.14,
                  -4,
                ],
                scale: [0.13, 0.13, 0.13],
              },
            },
            { component: MeshFilter, data: { assetHandle: mesh } },
            { component: MeshRenderer, data: { materials: [material] } },
          )
          .unwrap(),
      );
      world
        .spawn(
          { component: Transform, data: {} },
          {
            component: Camera,
            data: {
              aspect: 1,
              near: 0.1,
              far: 20,
              fov: Math.PI / 3,
              bloom: 0,
              antialias: 0,
              tonemap: 0,
            },
          },
        )
        .unwrap();
      const sun = world
        .spawn({
          component: DirectionalLight,
          data: { direction: [0.3, -0.3, -1], intensity: 3, castShadow: false, mapSize: 256 },
        })
        .unwrap();
      const locals = Array.from({ length: localCount }, (_, i) =>
        world
          .spawn(
            {
              component: Transform,
              data: { pos: [((i % 8) - 3.5) * 0.15, (Math.floor(i / 8) - 1.5) * 0.15, -2] },
            },
            {
              component: i % 2 === 0 ? PointLight : SpotLight,
              data: {
                intensity: 0.5,
                range: 10,
                ...(i % 2 === 1 ? { direction: [0, 0, -1], castShadow: false, mapSize: 128 } : {}),
              },
            },
          )
          .unwrap(),
      );
      const lease = renderValue(renderer.attach(world));
      const errors: unknown[] = [];
      const off = renderer.subscribe((event) => {
        if (event.kind === 'error') errors.push(event.error);
      });
      try {
        for (const path of ['forward', 'deferred'] as const) {
          renderValue(renderer.setProfile({ ...renderer.inspect().profile, renderPath: path }));
          for (const shadows of [false, true]) {
            world.set(sun, DirectionalLight, { castShadow: shadows }).unwrap();
            for (let i = 0; i < locals.length; i++)
              if (i % 2 === 1)
                world.set(required(locals[i]), SpotLight, { castShadow: shadows }).unwrap();
            for (let i = 0; i < Math.min(locals.length, 8); i += 2) {
              const entity = required(locals[i]);
              if (shadows)
                world
                  .addComponent(entity, { component: PointLightShadow, data: { mapSize: 128 } })
                  .unwrap();
              else if (world.hasComponent(entity, PointLightShadow))
                world.removeComponent(entity, PointLightShadow).unwrap();
            }
            for (let round = 0; round < 3; round++) {
              for (const variant of reference
                ? (['reference'] as const)
                : (['default', 'all-match', 'sparse'] as const)) {
                if (!reference) {
                  world
                    .set(sun, DirectionalLight, {
                      lightingChannels: variant === 'sparse' ? 1 : 0xffffffff,
                    })
                    .unwrap();
                  for (let i = 0; i < locals.length; i++)
                    world
                      .set(required(locals[i]), i % 2 === 0 ? PointLight : SpotLight, {
                        lightingChannels: variant === 'sparse' ? 2 ** (i % 4) : 0xffffffff,
                      })
                      .unwrap();
                  for (let i = 0; i < receivers.length; i++)
                    world
                      .set(required(receivers[i]), MeshRenderer, {
                        lightingChannels: variant === 'sparse' ? 2 ** (i % 4) : 0xffffffff,
                      })
                      .unwrap();
                }
                const draw = async () => {
                  const began = performance.now();
                  world.update(1 / 60).unwrap();
                  propagateTransforms(world).unwrap();
                  const drawBegan = performance.now();
                  outer.begin();
                  let receipt: import('@forgeax/engine-render').FrameReceipt;
                  try {
                    receipt = renderValue(
                      renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } }),
                    );
                  } finally {
                    outer.end();
                  }
                  const cpuMs = performance.now() - began;
                  const drawCpuMs = performance.now() - drawBegan;
                  renderValue(await receipt.completed);
                  const completedMs = performance.now() - began;
                  const nativeOuterNs = await outer.read();
                  return {
                    receipt,
                    began,
                    cpuMs,
                    drawCpuMs,
                    completedMs,
                    nativeOuterNs,
                    nativeOuterTicks: outer.ticks(),
                  };
                };
                for (let frame = 0; frame < 30; frame++) await draw();
                const session = renderValue(
                  profiler.startCapture({ frameLimit: 60, eventLimit: 16384, detail: 'nested' }),
                );
                const frames = [];
                for (let frame = 0; frame < 60; frame++) {
                  const sample = await draw();
                  const timing = renderValue(
                    await renderer.observe(sample.receipt, { include: ['timings'] }),
                  ).timings;
                  const intervals =
                    timing?.status === 'complete'
                      ? summarizeGpuPassTimingIntervals(
                          timing.frame.passes,
                          timing.frame.timestampPeriodNanoseconds,
                        ).unwrap()
                      : null;
                  frames.push({
                    began: sample.began,
                    cpuMs: sample.cpuMs,
                    drawCpuMs: sample.drawCpuMs,
                    completedMs: sample.completedMs,
                    nativeOuterNs: sample.nativeOuterNs,
                    nativeOuterTicks: sample.nativeOuterTicks,
                    timing,
                    intervals,
                  });
                }
                const capture = renderValue(session.finish());
                const name = `${size}-${path}-shadow-${shadows}-${variant}-round-${round}`;
                writeFileSync(`${directory}/${name}-profile.json`, JSON.stringify(capture));
                const inspection = renderer.inspect();
                const window = {
                  name,
                  size,
                  receiverCount,
                  localCount,
                  path,
                  shadows,
                  variant,
                  round,
                  frames,
                  cpuP50: percentile(
                    frames.map((frame) => frame.cpuMs),
                    0.5,
                  ),
                  cpuP95: percentile(
                    frames.map((frame) => frame.cpuMs),
                    0.95,
                  ),
                  gpuEnvelopeP50Ns: percentile(
                    frames.flatMap((frame) =>
                      frame.intervals === null ? [] : [frame.intervals.envelopeNanoseconds],
                    ),
                    0.5,
                  ),
                  gpuEnvelopeP95Ns: percentile(
                    frames.flatMap((frame) =>
                      frame.intervals === null ? [] : [frame.intervals.envelopeNanoseconds],
                    ),
                    0.95,
                  ),
                  profile: renderValue(buildProfileModel(capture)),
                  inspection,
                  processMemory: process.memoryUsage(),
                  hostLoadAverage: loadavg(),
                };
                const windowPath = `${directory}/${name}-window.json`;
                writeFileSync(windowPath, JSON.stringify(window));
                windowPaths.push(windowPath);
                writeFileSync(
                  `${directory}/progress.json`,
                  JSON.stringify({ hardware, warmup: 30, samples: 60, rounds: 3, windowPaths }),
                );
              }
            }
          }
        }
        expect(errors).toEqual([]);
      } finally {
        off();
        lease.dispose();
        renderValue(await renderer.dispose());
        outer.dispose();
        target.destroy();
      }
    }
    gcObserver.disconnect();
    // Assemble the review artifact after measurement. Repeatedly serializing
    // every previous window during the run creates unrelated harness garbage.
    const windows = windowPaths.map((path) => JSON.parse(readFileSync(path, 'utf8')));
    writeFileSync(
      `${directory}/raw.json`,
      JSON.stringify({
        hardware,
        warmup: 30,
        samples: 60,
        rounds: 3,
        windows,
        gc,
      }),
    );
  },
);
