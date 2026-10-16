import { execFileSync } from 'node:child_process';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import {
  DynamicResolution,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
} from '@forgeax/engine-render';
import { summarizeGpuPassTimingIntervals } from '@forgeax/engine-render/internal';
import { Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { renderValue } from './standard-gbuffer-replay.fixture';
import { json, quantile, save, scene } from './taa-maturity.fixture';

it.skipIf(process.env.TAA_MATURITY !== 'performance')(
  'records physical GPU ABBA frame intervals, resolve costs and adaptive recovery',
  { timeout: 1_800_000, retry: 0 },
  async () => {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('missing native adapter');
    const hardware = {
      adapter: {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
        description: adapter.info.description,
        subgroupMinSize: adapter.info.subgroupMinSize,
        subgroupMaxSize: adapter.info.subgroupMaxSize,
      },
      machine:
        process.platform === 'darwin'
          ? Object.fromEntries(
              ['hw.model', 'hw.memsize', 'hw.ncpu', 'machdep.cpu.brand_string'].map((key) => [
                key,
                execFileSync('sysctl', ['-n', key], { encoding: 'utf8' }).trim(),
              ]),
            )
          : undefined,
      timestampQuery: adapter.features.has('timestamp-query'),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    };
    expect(hardware.timestampQuery, 'physical performance requires timestamp-query').toBe(true);
    const windows: unknown[] = [];
    const transitions: unknown[] = [];
    // Warmup, sample count, paired sequence and thresholds precede measurement.
    json('performance-protocol.json', {
      hardware,
      warmupFrames: 120,
      sampleFrames: 60,
      order: 'ABBA',
      gainFloor: 0.05,
      CPU: 'renderer.draw synchronous wall time; excludes completion and observation',
      GPU: 'first beginning to last end across all measured passes; gaps included, never pass sum',
    });
    for (const [width, height] of [
      [1920, 1080],
      [2560, 1440],
      [3840, 2160],
    ]) {
      if (width === undefined || height === undefined) throw new Error('missing extent');
      const carrier = await scene(width, height, { timing: true });
      const { world, renderer, camera } = carrier;
      const geometry = world.allocSharedRef(
        'MeshAsset',
        createPlaneGeometry(4, 3, 16, 16).unwrap(),
      );
      const material = world.allocSharedRef(
        'MaterialAsset',
        Materials.standard({ baseColor: [0.3, 0.5, 0.7, 1], roughness: 0.35, metallic: 0.3 }),
      );
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, -0.1] } },
          { component: MeshFilter, data: { assetHandle: geometry } },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap();
      for (let i = 0; i < 32; i++)
        world
          .spawn(
            {
              component: Transform,
              data: { pos: [((i % 8) - 3.5) * 0.45, (Math.floor(i / 8) - 1.5) * 0.6, 1] },
            },
            { component: PointLight, data: { color: [1, 0.8, 0.6], intensity: 0.2, range: 10 } },
          )
          .unwrap();
      const window = async (
        name: string,
        scale: number | undefined,
        antialias = 3,
        adaptive = false,
      ) => {
        carrier.mode(scale, antialias);
        if (adaptive)
          world
            .addComponent(camera, {
              component: DynamicResolution,
              data: { targetGpuMs: 1, minScale: 0.5, maxScale: 1 },
            })
            .unwrap();
        for (let f = 0; f < 120; f++) {
          await carrier.draw();
          if (adaptive)
            transitions.push({
              phase: 'overload',
              frame: f,
              inspection: renderer.inspect().dynamicResolution,
            });
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        const frames = [];
        for (let f = 0; f < 60; f++) {
          const sample = await carrier.draw();
          const timing = renderValue(
            await renderer.observe(sample.receipt, { include: ['timings'] }),
          ).timings;
          if (timing?.status !== 'complete')
            throw new Error(`unusable full-frame GPU timing: ${JSON.stringify(timing)}`);
          const ticks = timing.frame.passes.filter((p) => p.status === 'measured');
          if (
            ticks.length !== timing.frame.executedPassCount ||
            timing.frame.droppedPassCount !== 0
          )
            throw new Error('partial frame timing');
          const intervals = summarizeGpuPassTimingIntervals(
            timing.frame.passes,
            timing.frame.timestampPeriodNanoseconds,
          ).unwrap();
          const envelopeMs = intervals.envelopeNanoseconds / 1e6;
          const resolveMs = ticks.find((p) => p.passName === 'taa-resolve')?.durationNanoseconds;
          frames.push({
            frame: sample.frame,
            cpuMs: sample.cpuMs,
            envelopeMs,
            resolveMs: resolveMs === undefined ? null : resolveMs / 1e6,
            timing: timing.frame,
            intervals,
            dynamicResolution: renderer.inspect().dynamicResolution,
            temporal: renderer.inspect().temporal,
          });
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        const result = {
          name,
          width,
          height,
          scale,
          frames,
          summary: {
            gpuP50: quantile(
              frames.map((f) => f.envelopeMs),
              0.5,
            ),
            gpuP95: quantile(
              frames.map((f) => f.envelopeMs),
              0.95,
            ),
            cpuP50: quantile(
              frames.map((f) => f.cpuMs),
              0.5,
            ),
            cpuP95: quantile(
              frames.map((f) => f.cpuMs),
              0.95,
            ),
            resolveP50: quantile(
              frames.map((f) => f.resolveMs ?? 0),
              0.5,
            ),
            resolveP95: quantile(
              frames.map((f) => f.resolveMs ?? 0),
              0.95,
            ),
          },
        };
        windows.push(result);
        json('performance.json', {
          revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
          hardware,
          windows,
        });
        return result;
      };
      try {
        for (const scale of [0.5, 0.67, 0.75]) {
          await window(`native-A1-vs-${scale}`, undefined);
          await window(`scale-${scale}-B1`, scale);
          await window(`scale-${scale}-B2`, scale);
          await window(`native-A2-vs-${scale}`, undefined);
        }
        await window('no-aa-A1', undefined, 0);
        await window('taa-B1', undefined);
        await window('taa-B2', undefined);
        await window('no-aa-A2', undefined, 0);
        if (width === 1920) {
          const native = await window('adaptive-reference', undefined);
          const reduced = await window('adaptive-overload', undefined, 3, true);
          expect(reduced.summary.gpuP50).toBeLessThan((native.summary.gpuP50 ?? 0) * 0.95);
          world.set(camera, DynamicResolution, { targetGpuMs: 100 }).unwrap();
          for (let f = 0; f < 160; f++) {
            await carrier.draw();
            transitions.push({
              phase: 'headroom',
              frame: f,
              inspection: renderer.inspect().dynamicResolution,
            });
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          json('adaptive-transitions.json', transitions);
          expect(renderer.inspect().dynamicResolution?.extent?.scale).toBe(1);
          save('adaptive-final.rgba', await carrier.pixels());
        }
      } finally {
        await carrier.dispose();
      }
    }
  },
);
