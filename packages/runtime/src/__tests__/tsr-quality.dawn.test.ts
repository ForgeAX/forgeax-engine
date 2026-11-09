import { mkdir, writeFile } from 'node:fs/promises';
import { ANTIALIAS_NONE, ANTIALIAS_TAA, ANTIALIAS_TSR, Camera } from '@forgeax/engine-render';
import type { RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { constructRuntimeRendererHost } from '../renderer-host';
import { encodeRgbaPng, offscreenCanvas } from './hdr-evidence.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { linearQualityFrame, qualityWorld, TSR_QUALITY_SIZE } from './tsr-quality.fixture';

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
    await constructRuntimeRendererHost(
      surface.canvas,
      recorder
        ? {
            rhi: recorder.backend.rhi,
            rhiInstrumentation: {
              resolveSurfaceDevice: (device) =>
                ok(recorder.backend.unwrapDeviceForSurface(device).unwrap()),
            },
          }
        : {},
      { shaderManifestUrl: manifest },
    ),
  );
  value(await host.initialization);
  const renderer = host.renderer,
    lease = value(renderer.attach(world)),
    frames: number[][] = [];
  let stopped: number[] | undefined;
  const camera = [...world.query({ with: [Camera] }).unwrap()][0]?.entity;
  if (camera === undefined) throw new Error('missing quality camera');
  try {
    for (let i = 0; i < count + (name === 'tsr' ? 24 : 0); i++) {
      if (i >= count)
        world
          .set(camera, Transform, { pos: [i < count + 16 ? (i - count + 1) * 0.03 : 0, 0, 10] })
          .unwrap();
      propagateTransforms(world);
      world.update(1 / 60).unwrap();
      const observe = (i >= count - 16 && i < count) || i === count + 23;
      const capture = await beginQualityCapture(recorder, i === count - 1 || i === count - 16);
      const receipt = await drawReadyFrame(
        renderer,
        { leases: [lease], camera: { lease }, environment: { lease }, sampleTimeSeconds: i / 60 },
        observe ? ['linear-ldr'] : undefined,
      );
      await endQualityCapture(capture, evidence, i === count - 16);
      if (!observe) continue;
      const frame = await linearQualityFrame(renderer, receipt, extent);
      if (i < count) frames.push(frame);
      else stopped = frame;
    }
    const internal = renderer.inspect().dynamicResolution?.extent;
    return {
      name,
      frames,
      stopped,
      input: {
        width: internal?.internalWidth ?? extent,
        height: internal?.internalHeight ?? extent,
      },
      mean: Array.from(
        { length: size * size },
        (_, p) => frames.reduce((sum, f) => sum + (f[p] ?? 0), 0) / frames.length,
      ),
    };
  } finally {
    lease.dispose();
    value(await renderer.dispose());
    surface.destroy();
    if (recorder) (await recorder.dispose()).unwrap();
  }
}

it.each([
  0.5,
  2 / 3,
  0.75,
  1,
])('compares static thin lines at scale %s with TAAU and an independent 8x raster integral', {
  timeout: 240_000,
}, async (scale) => {
  const evidence = output ? `${output}/scale-${scale.toFixed(3)}` : undefined;
  const manifest = shaderManifestUrl(await buildEngineShaderManifest());
  const results: QualityRoute[] = [];
  for (const [name, mode, inputScale, extent, count] of [
    ['reference', ANTIALIAS_NONE, 1, size * zoom, 1],
    ['taau', ANTIALIAS_TAA, scale, size, 96],
    ['tsr', ANTIALIAS_TSR, scale, size, 96],
  ] as const)
    results.push(await qualityRoute(manifest, name, mode, inputScale, extent, count, evidence));
  const reference = results[0],
    taau = results[1],
    tsr = results[2];
  if (!reference || !taau || !tsr) throw new Error('missing quality route');
  const metrics = (r: typeof tsr) => ({
    mae: r.mean.reduce((s, v, p) => s + Math.abs(v - (reference.mean[p] ?? 0)), 0) / r.mean.length,
    energy: r.mean.reduce((s, v) => s + v, 0),
    noise: Math.sqrt(
      r.frames.reduce((s, f) => s + f.reduce((t, v, p) => t + (v - (r.mean[p] ?? 0)) ** 2, 0), 0) /
        (r.frames.length * r.mean.length),
    ),
  });
  if (!tsr.stopped) throw new Error('missing eight-frame motion-stop evidence');
  const stoppedMae =
    tsr.stopped.reduce((sum, v, p) => sum + Math.abs(v - (reference.mean[p] ?? 0)), 0) /
    tsr.stopped.length;
  const a = metrics(taau),
    b = metrics(tsr),
    energy = reference.mean.reduce((s, v) => s + v, 0);
  if (evidence) {
    for (const result of results)
      await writeFile(`${evidence}/quality-${result.name}.png`, preview(result.mean));
    for (const result of results)
      await writeFile(
        `${evidence}/quality-${result.name}-frames.f32`,
        new Uint8Array(new Float32Array(result.frames.flat()).buffer),
      );
    await writeFile(`${evidence}/quality-tsr-stopped.png`, preview(tsr.stopped));
    await writeFile(
      `${evidence}/quality.json`,
      JSON.stringify(
        {
          configuredScale: scale,
          input: tsr.input,
          referenceEnergy: energy,
          taau: a,
          tsr: b,
          stoppedMae,
          stopFrames: 8,
          stopMilliseconds: (1000 * 8) / 60,
        },
        null,
        2,
      ),
    );
  }
  expect(stoppedMae).toBeLessThanOrEqual(b.mae * 1.1);
  expect(b.mae).toBeLessThanOrEqual(a.mae * 1.05);
  expect(Math.abs(b.energy - energy)).toBeLessThanOrEqual(Math.abs(a.energy - energy) * 1.05);
  expect(b.noise).toBeLessThanOrEqual(a.noise * 0.75);
});
