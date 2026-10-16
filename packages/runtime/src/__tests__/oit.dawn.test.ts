import { mkdirSync, writeFileSync } from 'node:fs';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import { OIT_SIZE, verifyOit, verifyOitFog } from './oit.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());

function dawnCanvas() {
  let texture: GPUTexture | undefined;
  return {
    canvas: {
      width: OIT_SIZE,
      height: OIT_SIZE,
      getContext: () => ({
        configure: (options: GPUCanvasConfiguration) => {
          texture?.destroy();
          texture = options.device.createTexture({
            size: [OIT_SIZE, OIT_SIZE],
            format: options.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
            viewFormats: [options.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
          });
        },
        unconfigure: () => {},
        getCurrentTexture: () => texture,
      }),
    },
    destroy: () => texture?.destroy(),
  };
}

it.each([
  { renderPath: 'forward', msaa: false },
  { renderPath: 'forward', msaa: true },
  { renderPath: 'deferred', msaa: false },
] as const)('weighted blended OIT $renderPath msaa=$msaa: reference, order independence, sorted falsifier', {
  timeout: 180_000,
}, async (options) => {
  const surface = dawnCanvas();
  const constructed = await constructRuntimeRendererHost(surface.canvas, undefined, {
    shaderManifestUrl: manifestUrl,
  });
  if (!constructed.ok) throw new Error(JSON.stringify(constructed.error));
  const host = constructed.value;
  const directory = `artifacts/oit/${options.renderPath}-${options.msaa ? 'msaa4' : 'msaa1'}`;
  mkdirSync(directory, { recursive: true });
  try {
    const evidence = await verifyOit(host.renderer, options);
    writeFileSync(`${directory}/probes.json`, JSON.stringify(evidence, null, 2));
    expect(evidence.completedFrames).toBeGreaterThan(0);
  } finally {
    host.renderer.dispose();
    surface.destroy();
  }
});

it.each([
  { renderPath: 'forward', msaa: false },
  { renderPath: 'deferred', msaa: true },
] as const)('weighted blended OIT $renderPath msaa=$msaa: accumulate draws fog at their own depth', {
  timeout: 180_000,
}, async (options) => {
  const surface = dawnCanvas();
  const constructed = await constructRuntimeRendererHost(surface.canvas, undefined, {
    shaderManifestUrl: manifestUrl,
  });
  if (!constructed.ok) throw new Error(JSON.stringify(constructed.error));
  const host = constructed.value;
  const directory = `artifacts/oit/fog-${options.renderPath}-${options.msaa ? 'msaa4' : 'msaa1'}`;
  mkdirSync(directory, { recursive: true });
  try {
    const evidence = await verifyOitFog(host.renderer, options);
    writeFileSync(`${directory}/probes.json`, JSON.stringify(evidence, null, 2));
  } finally {
    host.renderer.dispose();
    surface.destroy();
  }
});
