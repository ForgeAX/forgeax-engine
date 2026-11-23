import { mkdirSync, writeFileSync } from 'node:fs';
import type { Renderer } from '@forgeax/engine-render';
import type { RhiInstance } from '@forgeax/engine-rhi';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderTemplateManifest } from '@forgeax/engine-vite-plugin-shader';
import { afterAll, expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { luminancePng, offscreenCanvas } from './hdr-evidence.fixture';
import {
  FURNACE_SIZE,
  furnaceMetrics,
  type RenderPath,
  renderFurnace,
  replayFurnace,
  SWEEP_WIDTH,
  singleScatterPublication,
} from './ibl-furnace.fixture';
import { observeNativeDeviceRequests } from './native-device-work.fixture';
import { shaderManifestUrl, shaderPublicationUrl } from './shader-manifest-url.fixture';
import { unwrap } from './specular-aa.fixture';

// A uniform white panorama is indistinguishable from the white fallback cube,
// so readiness comes from the renderer's IBL binding receipt.
const manifest = await buildEngineShaderTemplateManifest();
const compensatedUrl = shaderManifestUrl(manifest);
const single = singleScatterPublication(manifest);
const singleScatterUrl = shaderPublicationUrl(single.publication);
const directory = 'artifacts/ibl-furnace/dawn';
const PATHS: readonly RenderPath[] = ['forward', 'deferred'];

const nativeDevices = observeNativeDeviceRequests();
// Positive and single-scatter programs retain separate live hosts. The recorded
// shader falsifier still opens its own host and both independent replay devices.
const liveHosts = new Map<string, ReturnType<typeof createFurnaceHost>>();
async function createFurnaceHost(manifestUrl: string, rhi: RhiInstance) {
  const target = offscreenCanvas(FURNACE_SIZE);
  const host = unwrap(
    await constructRuntimeRendererHost(target.canvas, { rhi }, { shaderManifestUrl: manifestUrl }),
  );
  return { target, host };
}
afterAll(async () => {
  try {
    for (const pending of liveHosts.values()) {
      const { target, host } = await pending;
      unwrap(await host.renderer.dispose());
      target.destroy();
    }
    nativeDevices.assertMaximum(5);
  } finally {
    liveHosts.clear();
    nativeDevices.restore();
  }
});
async function withRenderer<T>(
  manifestUrl: string,
  body: (renderer: Renderer, canvas: ReturnType<typeof offscreenCanvas>['canvas']) => Promise<T>,
  rhi: RhiInstance = webgpu.rhi,
) {
  if (rhi === webgpu.rhi) {
    let pending = liveHosts.get(manifestUrl);
    if (pending === undefined) {
      pending = createFurnaceHost(manifestUrl, rhi);
      liveHosts.set(manifestUrl, pending);
    }
    const { host, target } = await pending;
    return body(host.renderer, target.canvas);
  }
  const { target, host } = await createFurnaceHost(manifestUrl, rhi);
  try {
    return await body(host.renderer, target.canvas);
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

it('publishes a single-scattering template source for the falsifier', () => {
  expect(single.patched).toBeGreaterThan(0);
});

it('white-furnace: rough white metal vanishes into a uniform environment on both paths', {
  timeout: 600_000,
}, async () => {
  mkdirSync(directory, { recursive: true });
  const report: Record<string, unknown> = {};
  for (const renderPath of PATHS) {
    const on = await withRenderer(compensatedUrl, (r) => renderFurnace(r, renderPath));
    const off = await withRenderer(singleScatterUrl, (r) => renderFurnace(r, renderPath));
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

it('white-furnace: a fully rough white dielectric matches its skybox', {
  timeout: 300_000,
}, async () => {
  mkdirSync(directory, { recursive: true });
  const report: Partial<Record<RenderPath, { white: Metrics; gray: Metrics }>> = {};
  for (const renderPath of PATHS) {
    const image = await withRenderer(compensatedUrl, (renderer) =>
      renderFurnace(renderer, renderPath, 'dielectric'),
    );
    const control = await withRenderer(compensatedUrl, (renderer) =>
      renderFurnace(renderer, renderPath, 'dielectric-gray'),
    );
    writeFileSync(
      `${directory}/${renderPath}-dielectric.png`,
      luminancePng(image, FURNACE_SIZE, 1),
    );
    writeFileSync(
      `${directory}/${renderPath}-dielectric-gray.png`,
      luminancePng(control, FURNACE_SIZE, 1),
    );
    const white = furnaceMetrics(image, 'dielectric');
    const gray = furnaceMetrics(control, 'dielectric');
    report[renderPath] = { white, gray };
    writeFileSync(`${directory}/dielectric.json`, JSON.stringify(report, null, 2));
    const sphere = white.spheres[0];
    const graySphere = gray.spheres[0];
    if (sphere === undefined || graySphere === undefined) throw new Error('Missing sphere pixels');
    expect(Math.abs(white.background.mean - 1), `${renderPath} background`).toBeLessThan(0.01);
    expect(Math.abs(sphere.albedo - 1), `${renderPath} mean relative to sky`).toBeLessThan(0.01);
    expect(
      sphere.min / white.background.mean,
      `${renderPath} dimmest sphere pixel`,
    ).toBeGreaterThan(0.98);
    expect(sphere.max / white.background.mean, `${renderPath} brightest sphere pixel`).toBeLessThan(
      1.02,
    );
    expect(graySphere.albedo, `${renderPath} gray sphere is drawn`).toBeGreaterThan(0.45);
    expect(graySphere.albedo, `${renderPath} gray sphere stays visible`).toBeLessThan(0.6);
  }
});

it.each([
  {},
  { gbufferFormat: 'default' as const },
])('Deferred selects local diffuse only with an authored LightProbe (%o)', {
  timeout: 300_000,
}, async (options) => {
  await withRenderer(compensatedUrl, async (renderer) => {
    const sample = async (blackProbe?: true) => {
      const pixels = await renderFurnace(renderer, 'deferred', 'dielectric', {
        ...options,
        ...(blackProbe === undefined ? {} : { blackProbe }),
      });
      const metrics = furnaceMetrics(pixels, 'dielectric');
      expect(Math.abs(metrics.background.mean - 1)).toBeLessThan(0.01);
      return metrics.spheres[0]?.albedo ?? -1;
    };
    expect(await sample()).toBeGreaterThan(0.98);
    expect(await sample(true)).toBeLessThan(0.08);
    expect(await sample()).toBeGreaterThan(0.98);
  });
});

it('white-furnace: two rows sweep metallic and dielectric roughness from zero to one', {
  timeout: 300_000,
}, async () => {
  mkdirSync(directory, { recursive: true });
  const results = [];
  for (const renderPath of PATHS) {
    const { white, gray } = await withRenderer(compensatedUrl, async (renderer, canvas) => {
      const width = canvas.width;
      canvas.width = SWEEP_WIDTH;
      try {
        return {
          white: await renderFurnace(renderer, renderPath, 'sweep'),
          gray: await renderFurnace(renderer, renderPath, 'sweep-gray'),
        };
      } finally {
        canvas.width = width;
      }
    });
    writeFileSync(
      `${directory}/${renderPath}-roughness-sweep.png`,
      luminancePng(white, SWEEP_WIDTH, 1, FURNACE_SIZE),
    );
    writeFileSync(
      `${directory}/${renderPath}-roughness-sweep-gray.png`,
      luminancePng(gray, SWEEP_WIDTH, 1, FURNACE_SIZE),
    );
    results.push({
      renderPath,
      white: furnaceMetrics(white, 'sweep'),
      gray: furnaceMetrics(gray, 'sweep'),
    });
  }
  writeFileSync(`${directory}/roughness-sweep.json`, JSON.stringify(results, null, 2));
  for (const { renderPath, white, gray } of results) {
    expect(white.spheres).toHaveLength(22);
    expect(Math.abs(white.background.mean - 1), `${renderPath} background`).toBeLessThan(0.01);
    for (const [index, sphere] of white.spheres.entries()) {
      const label = `${renderPath} metallic=${sphere.metallic} roughness=${sphere.roughness}`;
      expect(sphere.pixels, label).toBeGreaterThan(1000);
      expect(Math.abs(sphere.albedo - 1), `${label} mean`).toBeLessThan(0.02);
      expect(sphere.min / white.background.mean, `${label} minimum`).toBeGreaterThan(0.97);
      expect(sphere.max / white.background.mean, `${label} maximum`).toBeLessThan(1.03);
      expect(gray.spheres[index]?.albedo, `${label} gray control`).toBeLessThan(0.75);
      expect(gray.spheres[index]?.albedo, `${label} gray control`).toBeGreaterThan(0.25);
    }
  }
});

it('rhi-debug replay: the captured shading draw conserves energy; the same tape at single scatter does not', {
  timeout: 300_000,
}, async () => {
  mkdirSync(directory, { recursive: true });
  const recorder = attachRecorder(webgpu).unwrap();
  try {
    const evidence = await withRenderer(
      compensatedUrl,
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
