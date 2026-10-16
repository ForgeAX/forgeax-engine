import { mkdirSync, writeFileSync } from 'node:fs';
import type { Renderer, RendererOptions } from '@forgeax/engine-render';
import type { RhiInstance } from '@forgeax/engine-rhi';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { luminancePng, offscreenCanvas } from './hdr-evidence.fixture';
import {
  COMPENSATED,
  FURNACE_SIZE,
  furnaceMetrics,
  type RenderPath,
  renderFurnace,
  replayFurnace,
  singleScatterManifest,
} from './ibl-furnace.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { unwrap } from './specular-aa.fixture';

// A uniform white panorama is indistinguishable from the white fallback cube,
// so readiness comes from the renderer's IBL binding receipt.
process.env.FORGEAX_MATERIAL_DIAGNOSTICS = '1';
const manifest = await buildEngineShaderManifest();
const compensatedUrl = shaderManifestUrl(manifest);
const single = singleScatterManifest(manifest);
const singleScatterUrl = shaderManifestUrl(single.manifest);
const directory = 'artifacts/ibl-furnace/dawn';
const PATHS: readonly RenderPath[] = ['forward', 'deferred'];

async function withRenderer<T>(
  manifestUrl: string,
  options: Omit<RendererOptions, 'rhi'>,
  body: (renderer: Renderer) => Promise<T>,
  rhi: RhiInstance = webgpu.rhi,
) {
  const target = offscreenCanvas(FURNACE_SIZE);
  const host = unwrap(
    await constructRuntimeRendererHost(
      target.canvas,
      { rhi, ...options },
      { shaderManifestUrl: manifestUrl },
    ),
  );
  try {
    return await body(host.renderer);
  } finally {
    unwrap(await host.renderer.dispose());
    target.destroy();
  }
}

type Metrics = ReturnType<typeof furnaceMetrics>;

/** Compensated metal matches the sky at every roughness; single scatter visibly darkens. */
function expectFurnace(label: string, withMs: Metrics, withoutMs: Metrics) {
  expect(Math.abs(withMs.background.mean - 1), `${label} background`).toBeLessThan(0.01);
  withMs.spheres.forEach((sphere, i) => {
    const single = withoutMs.spheres[i];
    const at = `${label} roughness=${sphere.roughness}`;
    expect(Math.abs(sphere.albedo - 1), `compensated ${at}`).toBeLessThan(0.02);
    expect(sphere.min, `compensated min ${at}`).toBeGreaterThan(0.97);
    expect(sphere.albedo, `gain ${at}`).toBeGreaterThanOrEqual((single?.albedo ?? 1) - 1e-3);
  });
  const smooth = withoutMs.spheres[0]?.albedo ?? 0;
  const rough = withoutMs.spheres.at(-1)?.albedo ?? 1;
  // Falsifier: without the multiple-scattering term the roughest sphere loses a large share.
  expect(rough, `${label} single-scatter roughness=1`).toBeLessThan(0.6);
  expect(smooth - rough, `${label} single-scatter loss`).toBeGreaterThan(0.3);
}

it('reduces every composed specular IBL program to single scattering for the falsifier', () => {
  expect(single.patched).toBeGreaterThan(0);
  const sources = [
    ...single.manifest.entries.map((entry) => entry.wgsl),
    ...single.manifest.materialShaders.flatMap((material) => [
      material.composedWgsl,
      ...material.variants.map((variant) => variant.composedWgsl),
    ]),
  ];
  expect(sources.every((source) => !new RegExp(COMPENSATED.source).test(source))).toBe(true);
});

it('white-furnace: rough white metal vanishes into a uniform environment on both paths', {
  timeout: 600_000,
}, async () => {
  mkdirSync(directory, { recursive: true });
  const report: Record<string, unknown> = {};
  for (const renderPath of PATHS) {
    const on = await withRenderer(compensatedUrl, {}, (r) => renderFurnace(r, renderPath));
    const off = await withRenderer(singleScatterUrl, {}, (r) => renderFurnace(r, renderPath));
    writeFileSync(`${directory}/${renderPath}-compensated.png`, luminancePng(on, FURNACE_SIZE, 1));
    writeFileSync(
      `${directory}/${renderPath}-single-scatter.png`,
      luminancePng(off, FURNACE_SIZE, 1),
    );
    const withMs = furnaceMetrics(on);
    const withoutMs = furnaceMetrics(off);
    report[renderPath] = { compensated: withMs, singleScatter: withoutMs };
    expectFurnace(renderPath, withMs, withoutMs);
  }
  writeFileSync(`${directory}/effect.json`, JSON.stringify(report, null, 2));
});

it('rhi-debug replay: the captured shading draw conserves energy; the same tape at single scatter does not', {
  timeout: 300_000,
}, async () => {
  mkdirSync(directory, { recursive: true });
  const recorder = attachRecorder(webgpu).unwrap();
  try {
    const evidence = await withRenderer(
      compensatedUrl,
      {},
      (renderer) =>
        replayFurnace(renderer, recorder, (name, bytes) =>
          writeFileSync(`${directory}/${name}`, bytes),
        ),
      recorder.backend.rhi,
    );
    writeFileSync(
      `${directory}/replay-compensated.png`,
      luminancePng(evidence.compensated, FURNACE_SIZE, 1),
    );
    writeFileSync(
      `${directory}/replay-single-scatter.png`,
      luminancePng(evidence.single, FURNACE_SIZE, 1),
    );
    const compensated = furnaceMetrics(evidence.compensated);
    const single = furnaceMetrics(evidence.single);
    const summary = {
      digest: evidence.digest,
      works: evidence.works,
      shadingWorks: evidence.shadingWorks,
      workIndex: evidence.workIndex,
      width: evidence.width,
      unseededResources: evidence.unseededResources,
      compensated,
      single,
    };
    writeFileSync(`${directory}/replay.json`, JSON.stringify(summary, null, 2));
    expect(evidence.shadingWorks).toBeGreaterThan(0);
    expect(evidence.width).toBe(FURNACE_SIZE);
    expectFurnace('replay', compensated, single);
  } finally {
    (await recorder.dispose()).unwrap();
  }
});
