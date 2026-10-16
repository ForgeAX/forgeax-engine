import type { TemporalResourceInspection } from '@forgeax/engine-render';
import { Camera } from '@forgeax/engine-render';
import { propagateTransforms } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { renderValue } from './standard-gbuffer-replay.fixture';
import { json, scene } from './taa-maturity.fixture';

it.skipIf(process.env.TAA_MATURITY !== 'resources')(
  'observes physical-backend TAA allocation overlap across resize, cut and scale',
  { timeout: 240_000, retry: 0 },
  async () => {
    const results = [];
    for (const [width, height] of [
      [1920, 1080],
      [2560, 1440],
      [3840, 2160],
    ] as const) {
      const samples: { phase: string; resources: TemporalResourceInspection }[] = [];
      let phase = 'warmup';
      let carrier: Awaited<ReturnType<typeof scene>> | undefined;
      const sample = (at: string) => {
        if (carrier)
          samples.push({
            phase: `${phase}:${at}`,
            resources: carrier.renderer.inspect().temporal.resources,
          });
      };
      carrier = await scene(width, height, {
        rhiInstrumentation: {
          beforeSubmit: () => {
            sample('before-submit');
            return undefined;
          },
        },
      });
      const current = carrier;
      try {
        carrier.mode(undefined);
        for (let f = 0; f < 60; f++) await carrier.draw();
        expect(carrier.renderer.inspect().temporal.resources.activeBytes).toBe(34 * width * height);
        const submit = async () => {
          current.world.update(1 / 60).unwrap();
          propagateTransforms(current.world).unwrap();
          const receipt = renderValue(
            current.renderer.draw({
              leases: [current.lease],
              camera: { lease: current.lease },
              environment: { lease: current.lease },
            }),
          );
          sample('after-submit');
          renderValue(await receipt.completed);
          await Promise.resolve();
          sample('after-fence');
        };
        phase = 'resize-plus-eight';
        carrier.canvas.width = width + 8;
        await submit();
        phase = 'restore';
        carrier.canvas.width = width;
        await submit();
        phase = 'cut';
        carrier.world.set(carrier.camera, Camera, { historyVersion: 10000 }).unwrap();
        await submit();
        phase = 'internal-half';
        carrier.mode(0.5);
        await submit();
        expect(carrier.renderer.inspect().temporal.resources.activeBytes).toBe(34 * width * height);
        const peak = Math.max(
          ...samples.map(
            (s) => s.resources.activeBytes + s.resources.candidateBytes + s.resources.retiringBytes,
          ),
        );
        expect(
          peak,
          'observe old and replacement history together, not an extrapolation',
        ).toBeGreaterThan(34 * width * height);
        expect(
          samples.some((s) => s.resources.candidateBytes > 0 || s.resources.retiringBytes > 0),
        ).toBe(true);
        results.push({
          width,
          height,
          metric: 'renderer temporal allocation descriptor bytes; not driver VRAM',
          peakBytes: peak,
          peakMiB: peak / 2 ** 20,
          samples,
        });
        json('resources.json', results);
      } finally {
        await carrier.dispose();
      }
    }
  },
);
