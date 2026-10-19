import { mkdirSync, writeFileSync } from 'node:fs';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';
import { RESPONSE_SIZE, renderResponse, responseSamples } from './skylight-response.fixture';
import { unwrap } from './specular-aa.fixture';

const manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());

for (const renderPath of ['forward', 'deferred'] as const) {
  it(`solid Skylight matches uniform panorama BRDF response in ${renderPath}`, {
    timeout: 300_000,
  }, async () => {
    const target = offscreenCanvas(RESPONSE_SIZE);
    const host = unwrap(
      await constructRuntimeRendererHost(
        target.canvas,
        { rhi },
        { shaderManifestUrl: manifestUrl },
      ),
    );
    try {
      const solid = responseSamples(await renderResponse(host.renderer, 'solid', renderPath));
      const panorama = responseSamples(await renderResponse(host.renderer, 'panorama', renderPath));
      const dark = responseSamples(await renderResponse(host.renderer, 'none', renderPath));
      const directory = 'artifacts/skylight-response/dawn';
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        `${directory}/${renderPath}.json`,
        JSON.stringify({ solid, panorama, dark }, null, 2),
      );
      for (const [i, sample] of solid.entries())
        for (let c = 0; c < 3; c++) {
          expect(
            Math.abs((sample.rgb[c] ?? NaN) - (panorama[i]?.rgb[c] ?? NaN)),
            `${sample.name} r=${sample.roughness} ${sample.region} channel=${c}`,
          ).toBeLessThan(0.025);
          expect(dark[i]?.rgb[c], 'absent Skylight stays black').toBeLessThan(0.001);
        }
      const copper = solid.filter((s) => s.name === 'copper' && s.region === 'core');
      expect(
        (copper[0]?.rgb[0] ?? 0) - (copper[2]?.rgb[0] ?? 0),
        'rough colored metal loses energy; constant [1,0] falsifier',
      ).toBeGreaterThan(0.12);
      const dielectric = solid.filter((s) => s.name === 'dielectric' && s.roughness === 0.1);
      expect(
        (dielectric[1]?.rgb[0] ?? 0) - (dielectric[0]?.rgb[0] ?? 0),
        'smooth dielectric grazing reflection',
      ).toBeGreaterThan(0.015);
    } finally {
      unwrap(await host.renderer.dispose());
      target.destroy();
    }
  });
}
