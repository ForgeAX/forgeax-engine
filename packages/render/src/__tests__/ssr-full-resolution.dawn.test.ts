import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import {
  runSsrGpuDispatch,
  SSR_GPU_PROBE_HEIGHT,
  SSR_GPU_PROBE_WIDTH,
  type SsrProbeShaderSources,
} from './ssr-gpu-dispatch';

it('traces and resolves both halves of the full-resolution reflection target', async () => {
  const compiler = await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  );
  const source = (name: string) =>
    readFileSync(resolve('packages/shader/src', `${name}.wgsl`), 'utf8');
  const imports = Object.fromEntries(
    ['common', 'standard-gbuffer', 'depth-pyramid-sample'].map((name) => {
      const text = source(name);
      return [text.match(/#define_import_path (\S+)/)?.[1] ?? '', text];
    }),
  );
  const shaders = {} as Record<keyof SsrProbeShaderSources, string>;
  for (const [key, name] of Object.entries({
    seed: 'depth-pyramid-seed',
    reduce: 'depth-pyramid-reduce',
    trace: 'ssr-trace',
    temporal: 'ssr-temporal',
    compose: 'ssr-compose',
  })) {
    const text = source(name);
    const compiled = await compiler.compileShader(text, {
      id: text.match(/#define_import_path (\S+)/)?.[1],
      imports,
    });
    if (!compiled.ok) throw compiled.error;
    shaders[key as keyof SsrProbeShaderSources] = compiled.value.wgsl;
  }
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (
      await recorder.backend.rhi.requestAdapter()
    )
      .unwrap()
      .requestDevice({ requiredFeatures: ['depth32float-stencil8'] })
  ).unwrap();
  try {
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const result = await runSsrGpuDispatch(
      device,
      shaders,
      1,
      { coordinateSource: true },
      recorder.backend.createShaderModuleImmediate,
    );
    (await recorder.frameBoundary()).unwrap();
    const artifact = (await pending).unwrap();
    const model = buildFrameModel(decodeTape(artifact.bytes).unwrap());
    const directory = process.env.FORGEAX_PARITY_EVIDENCE_DIR ?? 'artifacts/rendering-parity/ssr';
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, 'frame.rhitape'), artifact.bytes);
    const trace = result.tracePixels[0] ?? [];
    const countHits = (begin: number, end: number) => {
      let hits = 0;
      for (let y = begin; y < end; y++)
        for (let x = 0; x < SSR_GPU_PROBE_WIDTH; x++) {
          if ((trace[(y * SSR_GPU_PROBE_WIDTH + x) * 4 + 3] ?? 0) >= 0x3400) hits++;
        }
      return hits;
    };
    const topHits = countHits(0, SSR_GPU_PROBE_HEIGHT / 2);
    const bottomHits = countHits(SSR_GPU_PROBE_HEIGHT / 2, SSR_GPU_PROBE_HEIGHT);
    writeFileSync(
      resolve(directory, 'result.json'),
      JSON.stringify(
        {
          topHits,
          bottomHits,
          digest: artifact.digest,
          unseededResources: model.unseededResources,
          works: model.works.map((work) => ({
            workIndex: work.workIndex,
            pipeline: work.pipeline?.descriptor,
            bindings: work.bindings,
          })),
          resources: model.resources,
        },
        null,
        2,
      ),
    );
    // The mirror and wall are vertically symmetric. Half-size dispatch or
    // double-scaled receiver coordinates cannot satisfy this spatial gate.
    expect(trace).toHaveLength(SSR_GPU_PROBE_WIDTH * SSR_GPU_PROBE_HEIGHT * 4);
    expect(topHits).toBeGreaterThan(80);
    expect(bottomHits).toBeGreaterThan(80);
    expect(Math.abs(topHits - bottomHits)).toBeLessThanOrEqual(4);
  } finally {
    webgpu.disposeDevice(recorder.backend.unwrapDeviceForSurface(device).unwrap());
  }
}, 60_000);
