import { mkdirSync, writeFileSync } from 'node:fs';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { deviceOptionsForAdapter } from '../../../render/src/assembly/device-feature-admission';
import { constructRuntimeRendererHost } from '../renderer-host';
import { OIT_SIZE, verifyOit } from './oit.fixture';
import { inspectOitTape } from './oit-capture.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());

it.each([
  { msaa: true },
  { msaa: false },
])('OIT frame msaa=$msaa replays on a fresh device with accumulation and composite evidence', {
  timeout: 240_000,
}, async ({ msaa }) => {
  let texture: GPUTexture | undefined;
  const canvas = {
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
  };
  const recorder = attachRecorder(webgpu).unwrap();
  const constructed = await constructRuntimeRendererHost(
    canvas,
    { rhi: recorder.backend.rhi },
    { shaderManifestUrl: manifestUrl },
  );
  if (!constructed.ok) throw new Error(JSON.stringify(constructed.error));
  const host = constructed.value;
  const directory = `artifacts/oit/rhi-debug-${msaa ? 'msaa4' : 'msaa1'}`;
  mkdirSync(directory, { recursive: true });
  let inspected = false;
  try {
    await verifyOit(host.renderer, {
      renderPath: 'forward',
      msaa,
      capture: {
        recorder,
        async onTape(encoded, live) {
          writeFileSync(`${directory}/frame.rhitape`, encoded.bytes);
          const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
          const device = (await adapter.requestDevice(deviceOptionsForAdapter(adapter))).unwrap();
          const evidence = await inspectOitTape({
            encoded,
            live,
            msaa,
            backend: { device, createShaderModule: webgpu.createShaderModule },
          });
          for (const [name, bytes] of Object.entries(evidence.raw))
            writeFileSync(`${directory}/${name}.bin`, bytes);
          const { raw: _raw, ...report } = evidence;
          writeFileSync(`${directory}/inspection.json`, JSON.stringify(report, null, 2));
          inspected = true;
        },
      },
    });
    expect(inspected).toBe(true);
  } finally {
    host.renderer.dispose();
    (await recorder.dispose()).unwrap();
    texture?.destroy();
  }
});
