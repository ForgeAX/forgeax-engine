import { mkdirSync, writeFileSync } from 'node:fs';
import { attachRecorder, buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { LOD_SIZE, value, verifyLodTransition } from './lod-transition.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());

it.each([
  { renderPath: 'forward' as const, masked: false },
  { renderPath: 'deferred' as const, masked: true },
])('keeps complementary LOD pixels without requesting view clipping ($renderPath)', {
  timeout: 180_000,
}, async (options) => {
  let target: GPUTexture | undefined;
  const canvas = {
    width: LOD_SIZE,
    height: LOD_SIZE,
    getContext: () => ({
      configure(config: GPUCanvasConfiguration) {
        target?.destroy();
        target = config.device.createTexture({
          size: [LOD_SIZE, LOD_SIZE],
          format: config.format,
          usage: 0x11,
          viewFormats: [config.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
        });
      },
      unconfigure() {},
      getCurrentTexture: () => target,
    }),
  };
  const recorder = attachRecorder(webgpu).unwrap();
  const host = value(
    await constructRuntimeRendererHost(
      canvas,
      { rhi: recorder.backend.rhi },
      { shaderManifestUrl: manifestUrl },
    ),
  );
  const directory = `artifacts/lod-transition/rhi-debug/dawn/${options.renderPath}`;
  mkdirSync(directory, { recursive: true });
  try {
    await verifyLodTransition(host, {
      ...options,
      recorder,
      save: (name, bytes) => writeFileSync(`${directory}/${name}`, bytes),
      captured: async (encoded, _pixels, covered) => {
        if (!covered) return;
        const model = buildFrameModel(decodeTape(encoded.bytes).unwrap());
        const entry = options.renderPath === 'forward' ? 'fs_opaque' : 'fs_gbuffer';
        const draws = model.works.filter((work) =>
          work.pipeline.shaders.some(
            (shader) => shader.stage === 'fragment' && shader.entryPoint === entry,
          ),
        );
        expect(draws.length).toBeGreaterThanOrEqual(2);
        for (const work of draws) {
          expect(work.kind).toBe('drawIndexedIndirect');
          const source = work.pipeline.shaders.find(
            (shader) => shader.entryPoint === entry,
          )?.source;
          expect(source).toContain('applyLodCoverage');
          expect(source).not.toContain('applyViewClipping');
        }
        const shadows = model.works
          .flatMap((work) => work.pipeline.shaders)
          .filter((shader) => shader.stage === 'fragment' && shader.entryPoint === 'fs_shadow');
        // A retained shadow layer can have no raster work in this capture;
        // its light view also selects coverage independently of the main view.
        for (const shader of shadows) {
          expect(shader.source).not.toContain('applyViewClipping');
        }
      },
    });
  } finally {
    value(await host.renderer.dispose());
    (await recorder.dispose()).unwrap();
    target?.destroy();
  }
});
