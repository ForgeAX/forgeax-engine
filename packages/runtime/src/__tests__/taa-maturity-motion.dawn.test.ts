import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { downsample, error, json, quantile, save, scene } from './taa-maturity.fixture';

const WIDTH = 256,
  HEIGHT = 192;
type Carrier = Awaited<ReturnType<typeof scene>>;
const pose = (carrier: Carrier, x: number, angle = 0) =>
  carrier.world
    .set(carrier.camera, Transform, {
      pos: [x, 0, 4],
      quat: [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)],
    })
    .unwrap();
const support = new WeakMap<Uint8Array, Uint8Array>();
const local = (image: Uint8Array, reference: Uint8Array) => {
  let halo = support.get(reference);
  if (!halo) {
    halo = Uint8Array.from({ length: WIDTH * HEIGHT }, (_, p) => {
      const x = p % WIDTH,
        y = Math.floor(p / WIDTH);
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const i =
            (Math.max(0, Math.min(HEIGHT - 1, y + dy)) * WIDTH +
              Math.max(0, Math.min(WIDTH - 1, x + dx))) *
            4;
          if (Math.max(reference[i] ?? 0, reference[i + 1] ?? 0, reference[i + 2] ?? 0) > 50)
            return 1;
        }
      return 0;
    });
    support.set(reference, halo);
  }
  const values = [],
    haloValues = [];
  for (let p = 0; p < WIDTH * HEIGHT; p++) {
    const core =
      Math.max(reference[p * 4] ?? 0, reference[p * 4 + 1] ?? 0, reference[p * 4 + 2] ?? 0) > 50;
    if (core || halo[p])
      for (let c = 0; c < 3; c++) {
        const delta = Math.abs((image[p * 4 + c] ?? 0) - (reference[p * 4 + c] ?? 0)) / 255;
        if (core) values.push(delta);
        if (halo[p]) haloValues.push(delta);
      }
  }
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  return {
    mean: mean(values),
    p95: quantile(values, 0.95),
    haloMean: mean(haloValues),
    haloP95: quantile(haloValues, 0.95),
  };
};

it.skipIf(process.env.TAA_MATURITY !== 'motion')(
  'compares camera movement, rotation, object occlusion and stop against independent spatial integration',
  { timeout: 240_000, retry: 0 },
  async () => {
    // The local admission budget is declared before measuring. A moving
    // low-resolution lattice may spend at most 0.02 additional display error
    // over native aliased current, and must recover to that control in 8 frames.
    const reports = [];
    for (const scale of [1, 0.5, 0.67, 0.75]) {
      const recorder = attachRecorder(webgpu).unwrap();
      const current = await scene(WIDTH, HEIGHT, { rhi: recorder.backend.rhi });
      const reference = await scene(WIDTH * 4, HEIGHT * 4);
      const alias = await scene(WIDTH, HEIGHT);
      try {
        current.mode(scale === 1 ? undefined : scale);
        for (let f = 0; f < 180; f++) await current.draw();
        const samples = [];
        for (const scenario of ['translate', 'rotate', 'occlude'] as const) {
          for (let f = 1; f <= 60; f++) {
            const x = scenario === 'translate' ? (f * 0.6 * 4) / WIDTH : 0;
            const angle = scenario === 'rotate' ? f * 0.001 : 0;
            for (const carrier of [current, reference, alias]) {
              pose(carrier, x, angle);
              if (scenario === 'occlude') {
                const entity = carrier.moving[17];
                if (entity === undefined) throw new Error('missing occluder');
                carrier.world
                  .set(entity, Transform, {
                    pos: [-1.2 + f * 0.04, 0, 0.3],
                    quat: [0, 0, 0, 1],
                    scale: [0.6, 0.6, 1],
                  })
                  .unwrap();
              }
            }
            const image = await current.pixels();
            if ([8, 32, 60].includes(f)) {
              const truth = downsample(await reference.hdr(), WIDTH, HEIGHT);
              const control = await alias.pixels();
              const measured = local(image, truth),
                aliased = local(control, truth);
              samples.push({ scenario, frame: f, measured, aliased, full: error(image, truth) });
              save(`motion-${scale}-${scenario}-${f}.rgba`, image);
              save(`motion-${scale}-${scenario}-${f}-reference.rgba`, truth);
              expect
                .soft(measured.mean, `${scenario} local error at scale ${scale}`)
                .toBeLessThanOrEqual(aliased.mean + 0.02);
            }
          }
          const truth = downsample(await reference.hdr(), WIDTH, HEIGHT);
          const aliased = local(await alias.pixels(), truth);
          const recovery = [];
          for (let f = 1; f <= 16; f++) {
            const capture =
              scale === 0.5 && scenario === 'translate' && [1, 8].includes(f)
                ? recorder.captureFrame()
                : undefined;
            if (capture) (await recorder.frameBoundary()).unwrap();
            const image = await current.pixels();
            if (capture) {
              (await recorder.frameBoundary()).unwrap();
              save(`motion-stop-${f}.rhitape`, (await capture).unwrap().bytes);
            }
            recovery.push({ frame: f, local: local(image, truth), full: error(image, truth) });
            if ([1, 8, 16].includes(f)) save(`stop-${scale}-${scenario}-${f}.rgba`, image);
          }
          expect
            .soft(recovery[0]?.local.mean, `${scenario} first-stop scale ${scale}`)
            .toBeLessThanOrEqual(aliased.mean + 0.02);
          expect
            .soft(recovery[7]?.local.mean, `${scenario} stop8 scale ${scale}`)
            .toBeLessThanOrEqual(aliased.mean);
          samples.push({ scenario, recovery, aliased });
          json('motion-partial.json', { scale, samples });
        }
        reports.push({ scale, samples });
        json('motion.json', {
          width: WIDTH,
          height: HEIGHT,
          reference: '4x4 linear HDR spatial integration, independent of temporal history',
          thresholds: { movingExtraLocalMean: 0.02, stopFrames: 8 },
          reports,
        });
      } finally {
        await current.dispose();
        await reference.dispose();
        await alias.dispose();
      }
    }
  },
);
