import { readFileSync } from 'node:fs';
import {
  type GpuPassTimingIntervalSummary,
  summarizeGpuPassTimingIntervals,
} from '@forgeax/engine-render/internal';
import { expect, it } from 'vitest';
import { renderValue } from './standard-gbuffer-replay.fixture';
import { error, json, quantile, resolveManifestUrl, save, scene } from './taa-maturity.fixture';

it.skipIf(process.env.TAA_MATURITY !== 'hotspot')(
  'measures the accepted bounds reduction against its pinned array implementation',
  { timeout: 600_000, retry: 0 },
  async () => {
    const production = readFileSync('packages/shader/src/taa-resolve.wgsl', 'utf8');
    const pinned = readFileSync(
      'packages/render/src/__tests__/fixtures/taa-resolve-pinned-baseline.wgsl',
      'utf8',
    );
    // Change only the already accepted bounds implementation. Geometry,
    // reconstruction, stability and secondary 7x7 support remain identical.
    const oldBounds = pinned.slice(
      pinned.indexOf('fn taaNeighborhood'),
      pinned.indexOf('struct TaaClipDecision'),
    );
    const baseline =
      production.slice(0, production.indexOf('struct TaaBounds')) +
      oldBounds +
      production.slice(production.indexOf('struct TaaClipDecision'));
    const source = baseline.replace(
      'clipTaaHistory(taaNeighborhood(',
      'clipTaaHistory(current.rgb, taaNeighborhood(',
    );
    expect(source).toContain('neighbors : array<vec3<f32>, 25>');
    const baselineUrl = await resolveManifestUrl(source);
    const windows = [];
    for (const [width, height] of [
      [1920, 1080],
      [2560, 1440],
      [3840, 2160],
    ] as const) {
      const before = await scene(width, height, { timing: true, shaderManifestUrl: baselineUrl });
      const after = await scene(width, height, { timing: true });
      before.mode(undefined);
      after.mode(undefined);
      try {
        const pictures = [];
        for (const [name, carrier] of [
          ['array-A1', before],
          ['bounds-B1', after],
          ['bounds-B2', after],
          ['array-A2', before],
        ] as const) {
          for (let f = 0; f < 180; f++) await carrier.draw();
          const frames: {
            cpuMs: number;
            gpuMs: number;
            resolveMs: number;
            timing: unknown;
            intervals: GpuPassTimingIntervalSummary;
          }[] = [];
          for (let f = 0; f < 60; f++) {
            const sample = await carrier.draw();
            const observed = renderValue(
              await carrier.renderer.observe(sample.receipt, { include: ['timings'] }),
            ).timings;
            if (observed?.status !== 'complete' || observed.frame.droppedPassCount !== 0)
              throw new Error('partial GPU timing');
            const timing = observed.frame;
            const ticks = timing.passes.filter((p) => p.status === 'measured');
            if (timing.passes.some((p) => p.status !== 'measured'))
              throw new Error('unmeasured pass');
            const intervals = summarizeGpuPassTimingIntervals(
              timing.passes,
              timing.timestampPeriodNanoseconds,
            ).unwrap();
            const resolve = ticks.find((p) => p.passName === 'taa-resolve');
            if (!resolve) throw new Error('missing TAA resolve');
            frames.push({
              cpuMs: sample.cpuMs,
              gpuMs: intervals.envelopeNanoseconds / 1e6,
              resolveMs: resolve.durationNanoseconds / 1e6,
              intervals,
              timing,
            });
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          const image = await carrier.pixels();
          save(`hotspot-${width}-${name}.rgba`, image);
          pictures.push(image);
          windows.push({
            width,
            height,
            name,
            frames,
            summary: Object.fromEntries(
              ['cpuMs', 'gpuMs', 'resolveMs'].map((key) => [
                key,
                {
                  p50: quantile(
                    frames.map(
                      (f) => f[key as keyof Pick<typeof f, 'cpuMs' | 'gpuMs' | 'resolveMs'>],
                    ),
                    0.5,
                  ),
                  p95: quantile(
                    frames.map(
                      (f) => f[key as keyof Pick<typeof f, 'cpuMs' | 'gpuMs' | 'resolveMs'>],
                    ),
                    0.95,
                  ),
                },
              ]),
            ),
          });
          json('hotspot.json', {
            reference:
              'pinned 25-element array/reduction substituted into otherwise identical current resolve',
            warmupFrames: 180,
            sampleFrames: 60,
            sequence: 'ABBA',
            windows,
          });
        }
        // Independent MRT byte equivalence is mandatory in the low-level GPU
        // regression. Here final scene images provide an additional practical check.
        const a = pictures[0],
          b = pictures[1];
        if (!a || !b) throw new Error('missing paired images');
        const difference = error(a, b);
        json(`hotspot-${width}-image.json`, difference);
        expect(difference.mean).toBeLessThan(0.005);
        expect(difference.maximum).toBeLessThanOrEqual(0.05);
      } finally {
        await before.dispose();
        await after.dispose();
      }
    }
  },
);
