import { mkdir, writeFile } from 'node:fs/promises';
import { ANTIALIAS_NONE, ANTIALIAS_TSR, Camera } from '@forgeax/engine-render';
import type { RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { buildEngineShaderTemplateManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { temporalJitterSampleCount } from '../../../render/src/temporal/view';
import { constructRuntimeRendererHost } from '../renderer-host';
import { encodeRgbaPng, offscreenCanvas } from './hdr-evidence.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import {
  linearQualityFrame,
  motionStop,
  qualityWorld,
  TSR_QUALITY_SIZE,
  TSR_STOP_CHECKPOINT,
  tsrMotionStopFrames,
  tsrSettleFrames,
} from './tsr-quality.fixture';

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.value;
}
const output = process.env.FORGEAX_TSR_EVIDENCE;
const size = TSR_QUALITY_SIZE,
  zoom = 8;
function preview(values: number[]) {
  const bytes = new Uint8Array(size * size * 4);
  for (let i = 0; i < values.length; i++) {
    const v = Math.round(Math.max(0, Math.min(1, values[i] ?? 0)) * 255);
    bytes.set([v, v, v, 255], i * 4);
  }
  return encodeRgbaPng(bytes, size, 2);
}
interface QualityRoute {
  name: string;
  frames: number[][];
  mean: number[];
  stopped?: number[] | undefined;
  settled?: number[] | undefined;
  curve: number[][];
  input: { width: number; height: number };
}

async function beginQualityCapture(recorder: RecorderAttachment | undefined, selected: boolean) {
  if (!recorder || !selected) return undefined;
  const pending = recorder.captureFrame();
  (await recorder.frameBoundary()).unwrap();
  return { recorder, pending };
}
async function endQualityCapture(
  capture: Awaited<ReturnType<typeof beginQualityCapture>>,
  evidence: string | undefined,
  phase0: boolean,
) {
  if (!capture) return;
  (await capture.recorder.frameBoundary()).unwrap();
  const artifact = (await capture.pending).unwrap();
  if (!evidence) return;
  await mkdir(evidence, { recursive: true });
  await writeFile(
    `${evidence}/${phase0 ? 'quality-tsr-phase0' : 'quality-tsr'}.rhitape`,
    artifact.bytes,
  );
  await writeFile(
    `${evidence}/quality-tsr-model.json`,
    JSON.stringify(buildFrameModel(decodeTape(artifact.bytes).unwrap()), null, 2),
  );
}

function shouldObserveQualityFrame(
  index: number,
  count: number,
  rest: number,
  settle: number,
  evidence: string | undefined,
): boolean {
  return (
    (index >= count - 16 && index < count) ||
    rest === TSR_STOP_CHECKPOINT ||
    rest === settle ||
    (evidence !== undefined && rest >= 0)
  );
}

function qualityHostOptions(recorder: RecorderAttachment | undefined) {
  return recorder
    ? {
        rhi: recorder.backend.rhi,
        rhiInstrumentation: {
          resolveSurfaceDevice: (
            device: Parameters<typeof recorder.backend.unwrapDeviceForSurface>[0],
          ) => ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
        },
      }
    : {};
}

function meanQualityFrame(frames: number[][]): number[] {
  return Array.from(
    { length: size * size },
    (_, p) => frames.reduce((sum, f) => sum + (f[p] ?? 0), 0) / frames.length,
  );
}

async function qualityRoute(
  manifest: string,
  name: string,
  mode: number,
  scale: number,
  extent: number,
  count: number,
  evidence: string | undefined,
): Promise<QualityRoute> {
  const recorder = name === 'tsr' ? attachRecorder(webgpu).unwrap() : undefined;
  const surface = offscreenCanvas(extent),
    world = qualityWorld(mode, scale);
  const host = value(
    await constructRuntimeRendererHost(surface.canvas, qualityHostOptions(recorder), {
      shaderManifestUrl: manifest,
    }),
  );
  value(await host.initialization);
  const renderer = host.renderer,
    lease = value(renderer.attach(world)),
    frames: number[][] = [];
  let stopped: number[] | undefined, settled: number[] | undefined;
  const curve: number[][] = [];
  const settle = tsrSettleFrames(scale);
  const camera = [...world.query({ with: [Camera] }).unwrap()][0]?.entity;
  if (camera === undefined) throw new Error('missing quality camera');
  try {
    const total = count + (name === 'tsr' ? tsrMotionStopFrames(scale) : 0);
    for (let i = 0; i < total; i++) {
      const stop = motionStop(i, count);
      if (i >= count) world.set(camera, Transform, { pos: [stop.x, 0, 10] }).unwrap();
      propagateTransforms(world);
      world.update(1 / 60).unwrap();
      const rest = i >= count ? stop.rest : -1;
      const observe = shouldObserveQualityFrame(i, count, rest, settle, evidence);
      const capture = await beginQualityCapture(recorder, i === count - 1 || i === count - 16);
      const receipt = await drawReadyFrame(
        renderer,
        { source: lease, sampleTimeSeconds: i / 60 },
        observe ? ['linear-ldr'] : undefined,
      );
      await endQualityCapture(capture, evidence, i === count - 16);
      if (!observe) continue;
      const frame = await linearQualityFrame(renderer, receipt, extent);
      if (i < count) frames.push(frame);
      else curve[rest] = frame;
      if (rest === TSR_STOP_CHECKPOINT) stopped = frame;
      if (rest === settle) settled = frame;
    }
    const internal = renderer.inspect().dynamicResolution?.extent;
    return {
      name,
      frames,
      stopped,
      settled,
      curve,
      input: {
        width: internal?.internalWidth ?? extent,
        height: internal?.internalHeight ?? extent,
      },
      mean: meanQualityFrame(frames),
    };
  } finally {
    lease.dispose();
    value(await renderer.dispose());
    surface.destroy();
    if (recorder) (await recorder.dispose()).unwrap();
  }
}

// The scale-independent 8x raster integral is measured once; every scale
// still owns a fresh TSR history and all original temporal frames.
let qualityManifest: Promise<string> | undefined;
let rasterReference: Promise<QualityRoute> | undefined;

// The oracle is the independent 8x raster integral alone, not another temporal method: TSR
// follows UE 5.8.1 TSR, whose 16-sample history (TemporalSuperResolution.cpp:45) trades
// steady-state noise and motion-stop convergence for faster response than TAAU's ~100-sample
// history. Each ceiling is the UE-faithful baseline of bb20439f38 plus 5%, so any regression
// against the reference fails; an improvement lowers the baseline. Baselines are local D3D12
// measurements. The motion stop is in place, so history survives it: stoppedMae is the
// TSR_STOP_CHECKPOINT rest frame and settledMae the tsrSettleFrames rest frame (local D3D12).
// The lower scale exercises reconstruction; native scale isolates temporal quality.
const BOUNDS = {
  0.5: { mae: 0.0365, stoppedMae: 0.0646, settledMae: 0.0454, energyError: 0.34, noise: 0.0133 },
  1: { mae: 0.0248, stoppedMae: 0.0235, settledMae: 0.0237, energyError: 0.249, noise: 0.00405 },
} as const;
it.each([
  0.5, 1,
] as const)('compares static thin lines at scale %s with an independent 8x raster integral', {
  timeout: 240_000,
}, async (scale) => {
  const evidence = output ? `${output}/scale-${scale.toFixed(3)}` : undefined;
  qualityManifest ??= buildEngineShaderTemplateManifest().then(shaderManifestUrl);
  const manifest = await qualityManifest;
  rasterReference ??= qualityRoute(
    manifest,
    'reference',
    ANTIALIAS_NONE,
    1,
    size * zoom,
    1,
    undefined,
  );
  const reference = await rasterReference;
  const results: QualityRoute[] = [reference];
  // The averaged window must hold whole jitter cycles: TSR rounds its sample count up to a
  // prime, so a fixed 96 frames would cut the last cycle short.
  const cycle = temporalJitterSampleCount('tsr', scale);
  const tsr = await qualityRoute(
    manifest,
    'tsr',
    ANTIALIAS_TSR,
    scale,
    size,
    Math.ceil(96 / cycle) * cycle,
    evidence,
  );
  results.push(tsr);
  const mae = (frame: readonly number[]) =>
    frame.reduce((s, v, p) => s + Math.abs(v - (reference.mean[p] ?? 0)), 0) / frame.length;
  const energy = reference.mean.reduce((s, v) => s + v, 0);
  const sum = (frame: readonly number[]) => frame.reduce((s, v) => s + v, 0);
  if (!tsr.stopped || !tsr.settled) throw new Error('missing motion-stop evidence');
  const b = {
    mae: mae(tsr.mean),
    stoppedMae: mae(tsr.stopped),
    settledMae: mae(tsr.settled),
    energyError: Math.abs(sum(tsr.mean) - energy) / energy,
    noise: Math.sqrt(
      tsr.frames.reduce(
        (s, f) => s + f.reduce((t, v, p) => t + (v - (tsr.mean[p] ?? 0)) ** 2, 0),
        0,
      ) /
        (tsr.frames.length * tsr.mean.length),
    ),
  };
  if (evidence) {
    for (const result of results)
      await writeFile(`${evidence}/quality-${result.name}.png`, preview(result.mean));
    for (const result of results)
      await writeFile(
        `${evidence}/quality-${result.name}-frames.f32`,
        new Uint8Array(new Float32Array(result.frames.flat()).buffer),
      );
    await writeFile(`${evidence}/quality-tsr-stopped.png`, preview(tsr.stopped));
    await writeFile(`${evidence}/quality-tsr-settled.png`, preview(tsr.settled));
    await writeFile(
      `${evidence}/quality.json`,
      JSON.stringify(
        {
          configuredScale: scale,
          input: tsr.input,
          referenceEnergy: energy,
          tsr: b,
          stopFrames: TSR_STOP_CHECKPOINT,
          settleFrames: tsrSettleFrames(scale),
          // Rest frame r: MAE and energy ratio against the reference after r frames at rest.
          stopCurve: tsr.curve.map((frame, rest) => ({
            rest,
            mae: mae(frame),
            energyRatio: sum(frame) / energy,
          })),
        },
        null,
        2,
      ),
    );
  }
  const bound = BOUNDS[scale];
  for (const key of ['mae', 'stoppedMae', 'settledMae', 'energyError', 'noise'] as const)
    expect(b[key], key).toBeLessThanOrEqual(bound[key] * 1.05);
});
