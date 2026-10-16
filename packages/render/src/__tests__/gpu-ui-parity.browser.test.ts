import { expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createShaderModule, requestAdapter } from '../../../rhi-webgpu/src/index.js';
import { required } from '../../../ui-blitz/src/__tests__/fixture.js';
import {
  compareUiRaster,
  uiRasterCases,
} from '../../../ui-blitz/src/__tests__/gpu-parity-fixture.js';
import type { UiWasmHost } from '../../../ui-blitz/src/index.js';
import { verifyGpuUiParity } from './gpu-ui-parity.fixture.js';

it('qualifies the independent ColorMatrix oracle against actual Chromium CSS pixels', async () => {
  const scene = required(uiRasterCases.find((item) => item.reference));
  const previousViewport = { width: innerWidth, height: innerHeight };
  // Keep Vitest's outer preview at scale 1; the scene itself remains exactly
  // 128x112 pixels. Otherwise the runner can resample the screenshot to 80%.
  await page.viewport(640, 480);
  const iframe = document.createElement('iframe');
  iframe.style.cssText = `position:absolute;left:0;top:0;width:${scene.width}px;height:${scene.height}px;border:0;background:white;z-index:1000`;
  const loaded = new Promise<void>((resolve) => {
    iframe.onload = () => resolve();
  });
  iframe.srcdoc = scene.html;
  document.body.append(iframe);
  try {
    await loaded;
    const screenshot = await page
      .elementLocator(iframe)
      .screenshot({ base64: true, path: 'gpu-ui-color-matrix-native.png' });
    const base64 = typeof screenshot === 'string' ? screenshot : screenshot.base64;
    const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    try {
      expect([bitmap.width, bitmap.height]).toEqual([scene.width, scene.height]);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = required(canvas.getContext('2d'));
      context.drawImage(bitmap, 0, 0);
      const actual = new Uint8Array(
        context.getImageData(0, 0, bitmap.width, bitmap.height).data.buffer,
      );
      const expected = required(scene.reference)();
      // Browser screenshots composite the transparent iframe over its white
      // presentation background. The independent GPU oracle remains transparent.
      for (let offset = 0; offset < expected.length; offset += 4) {
        const alpha = required(expected[offset + 3]);
        for (let channel = 0; channel < 3; channel++)
          expected[offset + channel] = required(expected[offset + channel]) + 255 - alpha;
        expected[offset + 3] = 255;
      }
      expect(compareUiRaster(expected, actual).maxError).toBeLessThanOrEqual(0.05);
    } finally {
      bitmap.close();
    }
  } finally {
    iframe.remove();
    await page.viewport(previousViewport.width, previousViewport.height);
  }
});

it('matches real Blitz GPU raster with all CPU and independent filter pixel oracles on WebGPU', async () => {
  const load = async (url: URL) => new Uint8Array(await (await fetch(url)).arrayBuffer());
  const [bytes, font] = await Promise.all([
    load(new URL('../../../ui-blitz/pkg/ui_blitz_bg.wasm', import.meta.url)),
    load(
      new URL(
        '../../../../third_party/blitz/packages/blitz-dom/tests/fonts/dejavu-sans-ascii.ttf',
        import.meta.url,
      ),
    ),
  ]);
  const wasm: UiWasmHost = {
    readWasm: async () => bytes,
    instantiate: (imports) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
  };
  const device = (await (await requestAdapter()).unwrap().requestDevice()).unwrap();
  await verifyGpuUiParity({
    device,
    createReplacementDevice: async () =>
      (await (await requestAdapter()).unwrap().requestDevice()).unwrap(),
    wasm,
    font,
    createShaderModule: async (owner, code) => (await createShaderModule(owner, { code })).unwrap(),
  });
}, 60_000);
