import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { runSsrGpuDispatch, type SsrProbeShaderSources } from './ssr-gpu-dispatch';

it.each([
  1, 0.5,
] as const)('traces the complete receiver at %s density over 60 completed frames', async (resolutionScale) => {
  const compiler = await import(
    /* @vite-ignore */ new URL('../../../shader-compiler/dist/index.mjs', import.meta.url).href
  );
  const source = (name: string) =>
    readFileSync(resolve('packages/shader/src', `${name}.wgsl`), 'utf8');
  const imports = Object.fromEntries(
    ['common', 'standard-gbuffer', 'depth-pyramid-sample', 'scene-temporal'].map((name) => {
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
      60,
      {
        coordinateSource: true,
        quality: {
          resolutionScale,
          hizIterations: resolutionScale === 1 ? 64 : 32,
          linearIterations: resolutionScale === 1 ? 1024 : 512,
          refineSteps: resolutionScale === 1 ? 5 : 4,
        },
      },
      recorder.backend.createShaderModuleImmediate,
    );
    (await recorder.frameBoundary()).unwrap();
    const artifact = (await pending).unwrap();
    const model = buildFrameModel(decodeTape(artifact.bytes).unwrap());
    const directory = resolve(
      process.env.FORGEAX_PARITY_EVIDENCE_DIR ?? 'artifacts/rendering-parity/ssr',
      `trace-${resolutionScale}`,
    );
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, 'frame.rhitape'), artifact.bytes);
    expect(result.pixels).toHaveLength(60);
    const trace = result.tracePixels[59] ?? [];
    const { width, height } = result.traceExtent;
    const countHits = (begin: number, end: number) => {
      let hits = 0;
      for (let y = begin; y < end; y++)
        for (let x = 0; x < width; x++) {
          if ((trace[(y * width + x) * 4 + 3] ?? 0) >= 0x3400) hits++;
        }
      return hits;
    };
    const topHits = countHits(0, height / 2);
    const bottomHits = countHits(height / 2, height);
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
    expect(trace).toHaveLength(width * height * 4);
    expect(topHits).toBeGreaterThan(80 * resolutionScale * resolutionScale);
    expect(bottomHits).toBeGreaterThan(80 * resolutionScale * resolutionScale);
    // Full density keeps the established symmetric-receiver oracle. A half-density
    // lattice selects one of each two receivers; a phase difference can move at
    // most one trace row across this fixture's symmetric silhouette.
    expect(Math.abs(topHits - bottomHits)).toBeLessThanOrEqual(resolutionScale === 1 ? 4 : width);
  } finally {
    webgpu.disposeDevice(recorder.backend.unwrapDeviceForSurface(device).unwrap());
  }
}, 60_000);
