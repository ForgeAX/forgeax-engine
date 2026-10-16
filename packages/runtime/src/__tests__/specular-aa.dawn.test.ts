import { mkdirSync, writeFileSync } from 'node:fs';
import type { Renderer, RendererOptions } from '@forgeax/engine-render';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { luminancePng, offscreenCanvas } from './hdr-evidence.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import {
  BACKDROP_ROUGHNESS,
  compareToReference,
  displayedFrame,
  LOW,
  maxDifference,
  renderJitteredFrames,
  SPHERE_ROUGHNESS,
  SUPERSAMPLE,
  specularAaRegions,
  unwrap,
  verifySpecularAaGBuffer,
  withoutSpecularAaManifest,
} from './specular-aa.fixture';

const manifest = await buildEngineShaderManifest();
const withAaUrl = shaderManifestUrl(manifest);
const stripped = withoutSpecularAaManifest(manifest);
const withoutAaUrl = shaderManifestUrl(stripped.manifest);
const directory = 'artifacts/specular-aa/dawn';

async function withRenderer<T>(
  size: number,
  manifestUrl: string,
  options: Omit<RendererOptions, 'rhi'>,
  body: (renderer: Renderer) => Promise<T>,
) {
  const target = offscreenCanvas(size);
  const host = unwrap(
    await constructRuntimeRendererHost(
      target.canvas,
      { rhi: webgpu.rhi, ...options },
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

it('strips specular AA from every composed Standard program for the baseline', () => {
  expect(stripped.patched).toBeGreaterThan(0);
  const sources = [
    ...stripped.manifest.entries.map((entry) => entry.wgsl),
    ...stripped.manifest.materialShaders.flatMap((material) => [
      material.composedWgsl,
      ...material.variants.map((variant) => variant.composedWgsl),
    ]),
  ];
  const definitions = sources.flatMap(
    (source) => source.match(/fn specularAntiAliasedRoughness\w*\([^{]*\{/g) ?? [],
  );
  const identities = sources.flatMap(
    (source) => source.match(/fn specularAntiAliasedRoughness\w*\((\w+)[^{]*\{ return \1;/g) ?? [],
  );
  expect(definitions.length).toBeGreaterThan(0);
  expect(identities.length).toBe(definitions.length);
});

it('moves sub-pixel highlights toward an 8x supersampled truth without touching flat surfaces', {
  timeout: 600_000,
}, async () => {
  mkdirSync(directory, { recursive: true });
  const render = (size: number, url: string) =>
    withRenderer(size, url, {}, (renderer) => renderJitteredFrames(renderer, size));
  const on = await render(LOW, withAaUrl);
  const off = await render(LOW, withoutAaUrl);
  const truth = await render(LOW * SUPERSAMPLE, withoutAaUrl);
  const regions = specularAaRegions();
  const metrics = Object.fromEntries(
    (['curved', 'subPixel'] as const).map((name) => {
      const { flickerMap: _on, ...withAa } = compareToReference(on, truth, regions[name]);
      const { flickerMap: _off, ...withoutAa } = compareToReference(off, truth, regions[name]);
      return [name, { on: withAa, off: withoutAa }];
    }),
  ) as Record<
    'curved' | 'subPixel',
    Record<'on' | 'off', Omit<ReturnType<typeof compareToReference>, 'flickerMap'>>
  >;
  const flatDifference = maxDifference(on, off, regions.flat);
  for (const [name, frames] of [
    ['on', on],
    ['off', off],
    ['truth', truth],
  ] as const)
    writeFileSync(
      `${directory}/${name}.png`,
      luminancePng(displayedFrame(frames[0] ?? new Float32Array()), LOW, 4),
    );
  writeFileSync(
    `${directory}/flicker-on.png`,
    luminancePng(compareToReference(on, truth, regions.curved).flickerMap, LOW, 8),
  );
  writeFileSync(
    `${directory}/flicker-off.png`,
    luminancePng(compareToReference(off, truth, regions.curved).flickerMap, LOW, 8),
  );
  writeFileSync(
    `${directory}/effect.json`,
    JSON.stringify({ ...metrics, flatDifference }, null, 2),
  );

  // Resolved curvature: closer to the truth on every measure, and the linear
  // highlight energy that point sampling loses is recovered.
  expect(metrics.curved.on.rmse).toBeLessThan(metrics.curved.off.rmse * 0.9);
  expect(metrics.curved.on.peakFlicker).toBeLessThan(metrics.curved.off.peakFlicker * 0.8);
  expect(Math.abs(1 - metrics.curved.on.energy)).toBeLessThan(
    Math.abs(1 - metrics.curved.off.energy) * 0.5,
  );
  // Sub-pixel curvature: less highlight popping with bounded extra blur.
  expect(metrics.subPixel.on.peakFlicker).toBeLessThan(metrics.subPixel.off.peakFlicker * 0.9);
  expect(metrics.subPixel.on.rmse).toBeLessThan(metrics.subPixel.off.rmse * 1.1);
  // Zero curvature leaves the shading bit-identical.
  expect(flatDifference).toBe(0);
});

it('replays the packed G-buffer roughness with and without specular AA on fresh devices', {
  timeout: 180_000,
}, async () => {
  mkdirSync(directory, { recursive: true });
  const recorder = attachRecorder(webgpu).unwrap();
  const target = offscreenCanvas(LOW);
  const host = unwrap(
    await constructRuntimeRendererHost(
      target.canvas,
      { rhi: recorder.backend.rhi },
      { shaderManifestUrl: withAaUrl },
    ),
  );
  try {
    const evidence = await verifySpecularAaGBuffer(host.renderer, recorder, (name, bytes) =>
      writeFileSync(`${directory}/${name}`, bytes),
    );
    const histogram = (values: number[]) =>
      Object.fromEntries(
        [...new Set(values)]
          .sort((a, b) => a - b)
          .map((v) => [v, values.filter((x) => x === v).length]),
      );
    writeFileSync(
      `${directory}/gbuffer.json`,
      JSON.stringify(
        {
          digest: evidence.digest,
          geometryWorks: evidence.geometryWorks,
          unseededResources: evidence.unseededResources,
          sphere: histogram(evidence.sphere),
          sphereOff: histogram(evidence.sphereOff),
          backdrop: histogram(evidence.backdrop),
          backdropOff: histogram(evidence.backdropOff),
        },
        null,
        2,
      ),
    );
    // Mirrors encodeStandardNormalRoughness: f32 scale, then WGSL round (half to even).
    const byte = (roughness: number) => {
      const scaled = Math.fround(Math.fround(roughness) * 255);
      const floor = Math.floor(scaled);
      return scaled - floor === 0.5 ? floor + (floor % 2) : Math.round(scaled);
    };
    expect(evidence.sourcesContainSpecularAa.every(Boolean)).toBe(true);
    expect(evidence.sphere.length).toBeGreaterThan(1000);
    // Without specular AA the replayed G-buffer holds exactly the authored roughness.
    expect(new Set(evidence.sphereOff)).toEqual(new Set(SPHERE_ROUGHNESS.map(byte)));
    expect(new Set(evidence.backdropOff)).toEqual(new Set([byte(BACKDROP_ROUGHNESS)]));
    // With it, curved metal only ever widens its lobe; the flat backdrop is unchanged.
    expect(
      evidence.sphere.every((value, index) => value >= (evidence.sphereOff[index] ?? 256)),
    ).toBe(true);
    expect(
      evidence.sphere.filter((value, index) => value > (evidence.sphereOff[index] ?? 0)).length,
    ).toBeGreaterThan(evidence.sphere.length / 2);
    expect(evidence.backdrop).toEqual(evidence.backdropOff);
  } finally {
    unwrap(await host.renderer.dispose());
    target.destroy();
    (await recorder.dispose()).unwrap();
  }
});
