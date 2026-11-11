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
import { linearQualityFrame, qualityWorld, TSR_QUALITY_SIZE as size } from './tsr-quality.fixture';

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

function frameCapture(name: string, index: number, steadyFrames: number) {
  const stopped = index === steadyFrames + 23;
  return {
    name: stopped ? `${name}-stopped` : name,
    selected: index === steadyFrames - 1 || stopped,
  };
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
  let stopped: number[] | undefined;
  try {
    expect(renderer.inspect().capabilities.backendKind).toBe('wgpu-webgl2');
    const count = aa === ANTIALIAS_NONE ? 1 : 96;
    for (let i = 0; i < count + (aa === ANTIALIAS_TSR ? 24 : 0); i++) {
      if (i >= count)
        world
          .set(camera, Transform, { pos: [i < count + 16 ? (i - count + 1) * 0.03 : 0, 0, 10] })
          .unwrap();
      propagateTransforms(world).unwrap();
      world.update(1 / 60).unwrap();
      const observe = (i >= count - 16 && i < count) || i === count + 23;
      const capture = frameCapture(name, i, count);
      const pending = capture.selected ? recorder.captureFrame() : undefined;
      if (pending) (await recorder.frameBoundary()).unwrap();
      const start = performance.now();
      const receipt = await drawReadyFrame(
        renderer,
        { leases: [lease], camera: { lease }, environment: { lease }, sampleTimeSeconds: i / 60 },
        observe ? ['linear-ldr'] : undefined,
      );
      if (i >= 16 && i < count - 16) completionMs.push(performance.now() - start);
      if (pending) {
        (await recorder.frameBoundary()).unwrap();
        const artifact = (await pending).unwrap();
        const model = buildFrameModel(decodeTape(artifact.bytes).unwrap());
        expect(model.works.some((w) => w.kind === 'dispatchWorkgroups')).toBe(false);
        await save(`${capture.name}.rhitape`, artifact.bytes);
        await save(
          `${capture.name}-capture.json`,
          JSON.stringify(
            { digest: await tapeDigest(artifact.bytes), summary: summarizeFrame(model), model },
            null,
            2,
          ),
        );
        const shot = await page.elementLocator(canvas).screenshot({ base64: true });
        await commands.writeFile(
          `${ROOT}/${capture.name}-canvas.png`,
          typeof shot === 'string' ? shot : shot.base64,
          'base64',
        );
      }
      if (observe) {
        const values = await linearQualityFrame(renderer, receipt, extent);
        if (i < count) frames.push(values);
        else {
          stopped = values;
          await save(`${name}-stopped.f32`, new Uint8Array(new Float32Array(values).buffer));
        }
      }
    }
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
    const inspection = renderer.inspect();
    await save(`${name}-frames.f32`, new Uint8Array(new Float32Array(frames.flat()).buffer));
    return {
      name,
      frames,
      mean,
      stopped,
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

it.each([
  0.5, 1,
])('qualifies TAA/TAAU and TSR at scale %s against the same 8x raster integral and motion-stop oracle', {
  timeout: 240_000,
}, async (scale) => {
  const saved = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
  try {
    const reference = await route(`reference-${scale}`, ANTIALIAS_NONE, 1, size * 8);
    const taa = await route(`taa-${scale}`, ANTIALIAS_TAA, scale);
    const tsr = await route(`tsr-${scale}`, ANTIALIAS_TSR, scale);
    const metrics = (r: typeof tsr) => ({
      mae:
        r.mean.reduce((s, v, p) => s + Math.abs(v - (reference.mean[p] ?? 0)), 0) / r.mean.length,
      energy: r.mean.reduce((s, v) => s + v, 0),
      noise: Math.sqrt(
        r.frames.reduce(
          (s, f) => s + f.reduce((t, v, p) => t + (v - (r.mean[p] ?? 0)) ** 2, 0),
          0,
        ) /
          (r.frames.length * r.mean.length),
      ),
      completion: r.completion,
    });
    const a = metrics(taa),
      b = metrics(tsr),
      energy = reference.mean.reduce((s, v) => s + v, 0);
    if (!tsr.stopped) throw new Error('missing motion-stop frame');
    const stoppedMae =
      tsr.stopped.reduce((s, v, p) => s + Math.abs(v - (reference.mean[p] ?? 0)), 0) /
      tsr.stopped.length;
    await save(
      `quality-${scale}.json`,
      JSON.stringify(
        {
          scale,
          referenceEnergy: energy,
          taa: a,
          tsr: b,
          stoppedMae,
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
    expect(tsr.inspection.temporal.frameIndex).toBe(119);
    expect(stoppedMae).toBeLessThanOrEqual(b.mae * 1.1);
    expect(b.mae).toBeLessThanOrEqual(a.mae * 1.05);
    expect(Math.abs(b.energy - energy)).toBeLessThanOrEqual(Math.abs(a.energy - energy) * 1.05);
    expect(b.noise).toBeLessThanOrEqual(a.noise * 0.75);
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
