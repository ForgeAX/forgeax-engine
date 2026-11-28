import { encodePng } from '@forgeax/engine-image/png';
import { ANTIALIAS_NONE, ANTIALIAS_TAA, ANTIALIAS_TSR, Camera } from '@forgeax/engine-render';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  summarizeFrame,
  tapeDigest,
} from '@forgeax/engine-rhi-debug';
import * as wgpu from '@forgeax/engine-rhi-wgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRuntimeRendererHost } from '../renderer-host';
import { renderValue } from './standard-gbuffer-replay.fixture';
import {
  linearQualityFrame,
  motionStop,
  qualityWorld,
  TSR_QUALITY_SIZE as size,
  TSR_STOP_CHECKPOINT,
  tsrMotionStopFrames,
  tsrSettleFrames,
} from './tsr-quality.fixture';

const ROOT = 'artifacts/ci-focus/temporal-aa';
async function save(name: string, data: Uint8Array | string) {
  if (typeof data === 'string') return commands.writeFile(`${ROOT}/${name}`, data);
  let binary = '';
  for (let start = 0; start < data.length; start += 8192)
    binary += String.fromCharCode(...data.subarray(start, start + 8192));
  await commands.writeFile(`${ROOT}/${name}`, btoa(binary), 'base64');
}
const quantile = (values: number[], q: number) =>
  [...values].sort((a, b) => a - b)[Math.ceil(q * values.length) - 1];

function frameCapture(name: string, index: number, steadyFrames: number, rest: number) {
  const stopped = index >= steadyFrames && rest === TSR_STOP_CHECKPOINT;
  return {
    name: stopped ? `${name}-stopped` : name,
    selected: index === steadyFrames - 1 || stopped,
  };
}

async function saveCapturedFrame(
  recorder: ReturnType<typeof attachRecorder> extends { unwrap(): infer R } ? R : never,
  pending: ReturnType<
    (ReturnType<typeof attachRecorder> extends { unwrap(): infer R } ? R : never)['captureFrame']
  >,
  captureName: string,
  canvas: HTMLCanvasElement,
) {
  (await recorder.frameBoundary()).unwrap();
  const artifact = (await pending).unwrap();
  const model = buildFrameModel(decodeTape(artifact.bytes).unwrap());
  expect(model.works.some((w) => w.kind === 'dispatchWorkgroups')).toBe(false);
  await save(`${captureName}.rhitape`, artifact.bytes);
  await save(
    `${captureName}-capture.json`,
    JSON.stringify(
      { digest: await tapeDigest(artifact.bytes), summary: summarizeFrame(model), model },
      null,
      2,
    ),
  );
  const shot = await page.elementLocator(canvas).screenshot({ base64: true });
  await commands.writeFile(
    `${ROOT}/${captureName}-canvas.png`,
    typeof shot === 'string' ? shot : shot.base64,
    'base64',
  );
}

async function saveMeanPreview(name: string, frames: number[][]) {
  const mean = Array.from(
    { length: size * size },
    (_, p) => frames.reduce((sum, f) => sum + (f[p] ?? 0), 0) / frames.length,
  );
  const png = new Uint8Array(size * size * 4);
  for (let p = 0; p < mean.length; p++) {
    const v = Math.round(Math.max(0, Math.min(1, mean[p] ?? 0)) * 255);
    png.set([v, v, v, 255], p * 4);
  }
  await save(`${name}-mean.png`, encodePng(size, size, png));
  await save(`${name}-frames.f32`, new Uint8Array(new Float32Array(frames.flat()).buffer));
  return mean;
}

async function route(name: string, aa: number, scale: number, extent = size) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = extent;
  document.body.append(canvas);
  const recorder = attachRecorder(wgpu).unwrap();
  const host = renderValue(
    await constructRuntimeRendererHost(
      canvas,
      {
        rhi: recorder.backend.rhi,
        rhiInstrumentation: {
          resolveSurfaceDevice: (device) =>
            ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
        },
      },
      { shaderManifestUrl: '/shaders/manifest.json' },
    ),
  );
  renderValue(await host.initialization);
  const { renderer } = host;
  const world = qualityWorld(aa, scale),
    lease = renderValue(renderer.attach(world));
  const camera = [...world.query({ with: [Camera] }).unwrap()][0]?.entity;
  if (!camera) throw new Error('missing camera');
  const frames: number[][] = [],
    completionMs: number[] = [];
  let stopped: number[] | undefined, settled: number[] | undefined;
  const settle = tsrSettleFrames(scale);
  try {
    expect(renderer.inspect().capabilities.backendKind).toBe('wgpu-webgl2');
    const count = aa === ANTIALIAS_NONE ? 1 : 96;
    const total = count + (aa === ANTIALIAS_TSR ? tsrMotionStopFrames(scale) : 0);
    for (let i = 0; i < total; i++) {
      const stop = motionStop(i, count);
      if (i >= count) world.set(camera, Transform, { pos: [stop.x, 0, 10] }).unwrap();
      propagateTransforms(world).unwrap();
      world.update(1 / 60).unwrap();
      const rest = i >= count ? stop.rest : -1;
      const observe =
        (i >= count - 16 && i < count) || rest === TSR_STOP_CHECKPOINT || rest === settle;
      const capture = frameCapture(name, i, count, rest);
      const pending = capture.selected ? recorder.captureFrame() : undefined;
      if (pending) (await recorder.frameBoundary()).unwrap();
      const start = performance.now();
      const receipt = await drawReadyFrame(
        renderer,
        { source: lease, sampleTimeSeconds: i / 60 },
        observe ? ['linear-ldr'] : undefined,
      );
      if (i >= 16 && i < count - 16) completionMs.push(performance.now() - start);
      if (pending) await saveCapturedFrame(recorder, pending, capture.name, canvas);
      if (observe) {
        const values = await linearQualityFrame(renderer, receipt, extent);
        if (i < count) frames.push(values);
        else {
          const isStop = rest === TSR_STOP_CHECKPOINT;
          if (isStop) stopped = values;
          else settled = values;
          await save(
            `${name}-${isStop ? 'stopped' : 'settled'}.f32`,
            new Uint8Array(new Float32Array(values).buffer),
          );
        }
      }
    }
    const mean = await saveMeanPreview(name, frames);
    const inspection = renderer.inspect();
    return {
      name,
      frames,
      mean,
      stopped,
      settled,
      inspection,
      completionMs,
      completion: {
        count: completionMs.length,
        p50: quantile(completionMs, 0.5),
        p95: quantile(completionMs, 0.95),
      },
    };
  } finally {
    lease.dispose();
    renderValue(await renderer.dispose());
    (await recorder.dispose()).unwrap();
    canvas.remove();
  }
}

// Each route is measured against the 8x raster integral alone, not against another temporal
// method: TSR follows UE 5.8.1 TSR, whose 16-sample history (TemporalSuperResolution.cpp:45)
// trades steady-state noise and motion-stop convergence for faster response than TAA/TAAU.
// Each ceiling is a local Chromium WebGL2 measurement plus 5%. The TSR motion stop is in place
// (see motionStop): stoppedMae is the TSR_STOP_CHECKPOINT rest frame and settledMae the
// tsrSettleFrames rest frame.
const BOUNDS = {
  0.5: {
    taa: { mae: 0.0509, energyError: 0.389, noise: 0.0039 },
    tsr: { mae: 0.0369, stoppedMae: 0.0634, settledMae: 0.044, energyError: 0.345, noise: 0.0135 },
  },
  1: {
    taa: { mae: 0.0202, energyError: 0.164, noise: 0.00406 },
    tsr: {
      mae: 0.0247,
      stoppedMae: 0.0235,
      settledMae: 0.0242,
      energyError: 0.248,
      noise: 0.00398,
    },
  },
} as const;
it.each([
  0.5, 1,
] as const)('qualifies TAA/TAAU and TSR at scale %s against the same 8x raster integral and motion-stop oracle', {
  timeout: 240_000,
}, async (scale) => {
  const saved = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
  try {
    const reference = await route(`reference-${scale}`, ANTIALIAS_NONE, 1, size * 8);
    const taa = await route(`taa-${scale}`, ANTIALIAS_TAA, scale);
    const tsr = await route(`tsr-${scale}`, ANTIALIAS_TSR, scale);
    const energy = reference.mean.reduce((s, v) => s + v, 0);
    const mae = (frame: readonly number[]) =>
      frame.reduce((s, v, p) => s + Math.abs(v - (reference.mean[p] ?? 0)), 0) / frame.length;
    const metrics = (r: typeof tsr) => ({
      mae: mae(r.mean),
      energyError: Math.abs(r.mean.reduce((s, v) => s + v, 0) - energy) / energy,
      noise: Math.sqrt(
        r.frames.reduce(
          (s, f) => s + f.reduce((t, v, p) => t + (v - (r.mean[p] ?? 0)) ** 2, 0),
          0,
        ) /
          (r.frames.length * r.mean.length),
      ),
      completion: r.completion,
    });
    if (!tsr.stopped || !tsr.settled) throw new Error('missing motion-stop frame');
    const a = metrics(taa),
      b = { ...metrics(tsr), stoppedMae: mae(tsr.stopped), settledMae: mae(tsr.settled) };
    await save(
      `quality-${scale}.json`,
      JSON.stringify(
        {
          scale,
          referenceEnergy: energy,
          taa: a,
          tsr: b,
          timingBoundary:
            '64 drawReadyFrame completion wall times after 16 warmup frames; recorder attached but capture and observations excluded; not GPU timestamps or game FPS',
          taaInspection: taa.inspection,
          tsrInspection: tsr.inspection,
          taaSamples: taa.completionMs,
          tsrSamples: tsr.completionMs,
        },
        null,
        2,
      ),
    );
    // Preparation-only receipts must not consume a jitter/history sample.
    expect(taa.inspection.temporal.frameIndex).toBe(95);
    expect(tsr.inspection.temporal.frameIndex).toBe(95 + tsrMotionStopFrames(scale));
    const bound = BOUNDS[scale];
    for (const key of ['mae', 'energyError', 'noise'] as const)
      expect(a[key], `taa ${key}`).toBeLessThanOrEqual(bound.taa[key] * 1.05);
    for (const key of ['mae', 'stoppedMae', 'settledMae', 'energyError', 'noise'] as const)
      expect(b[key], `tsr ${key}`).toBeLessThanOrEqual(bound.tsr[key] * 1.05);
  } finally {
    if (saved) Object.defineProperty(navigator, 'gpu', saved);
    else Reflect.deleteProperty(navigator, 'gpu');
  }
});

it('records matched 512px TAAU and TSR workloads for native RHI replay timing', {
  timeout: 240_000,
}, async () => {
  const saved = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
  try {
    const taa = await route('performance-taau', ANTIALIAS_TAA, 0.5, 512);
    const tsr = await route('performance-tsr', ANTIALIAS_TSR, 0.5, 512);
    await save(
      'performance-512.json',
      JSON.stringify(
        {
          output: [512, 512],
          inputScale: 0.5,
          objects: 12,
          boundary:
            'completion wall time with recorder attached; use the two captured steady frames for separate replay-device GPU timing',
          taa: { completion: taa.completion, samples: taa.completionMs },
          tsr: { completion: tsr.completion, samples: tsr.completionMs },
        },
        null,
        2,
      ),
    );
    expect(taa.completion.count).toBe(64);
    expect(tsr.completion.count).toBe(64);
    expect(tsr.inspection.temporal.mode).toBe('tsr');
    expect(tsr.inspection.temporal.historyValid).toBe(true);
  } finally {
    if (saved) Object.defineProperty(navigator, 'gpu', saved);
    else Reflect.deleteProperty(navigator, 'gpu');
  }
});
