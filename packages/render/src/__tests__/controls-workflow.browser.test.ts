import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { createShaderModule, requestAdapter } from '../../../rhi-webgpu/src/index.js';
import * as webgl from '../../../rhi-wgpu/src/index.js';
import { controlsWorkflowRasterCase } from '../../../ui-blitz/src/__tests__/controls-workflow-gpu-fixture.js';
import { required } from '../../../ui-blitz/src/__tests__/fixture.js';
import type { UiWasmHost } from '../../../ui-blitz/src/index.js';
import { verifyGpuUiParity } from './gpu-ui-parity.fixture.js';

const load = async (url: URL) => new Uint8Array(await (await fetch(url)).arrayBuffer());
const [bytes, font] = await Promise.all([
  load(new URL('../../../ui-blitz/pkg/ui_blitz_bg.wasm', import.meta.url)),
  load(
    new URL(
      '../../../devkit/node_modules/@fontsource-variable/noto-sans-sc/files/noto-sans-sc-latin-wght-normal.woff2',
      import.meta.url,
    ),
  ),
]);
const wasm: UiWasmHost = {
  readWasm: async () => bytes,
  instantiate: (imports) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
};

for (const backend of ['webgpu', 'webgl2'] as const)
  it(`renders the composite inventory and settings workflow on ${backend}`, async () => {
    const canvases: HTMLCanvasElement[] = [];
    const createDevice = async () => {
      if (backend === 'webgpu')
        return (await (await requestAdapter()).unwrap().requestDevice()).unwrap();
      const canvas = document.createElement('canvas');
      document.body.append(canvas);
      canvases.push(canvas);
      return (
        await (await webgl.requestAdapter(undefined, canvas)).unwrap().requestDevice()
      ).unwrap();
    };
    if (backend === 'webgl2') await webgl.ensureReady();
    const testPath = required(expect.getState().testPath).replaceAll('\\', '/');
    const packageStart = testPath.lastIndexOf('/packages/render/');
    expect(packageStart).toBeGreaterThanOrEqual(0);
    const directory = `${testPath.slice(0, packageStart)}/artifacts/ui-controls-workflow/${backend}`;
    try {
      const result = await verifyGpuUiParity({
        device: await createDevice(),
        createReplacementDevice: createDevice,
        wasm,
        font,
        fontFamily: 'Inventory Fixture',
        cases: [controlsWorkflowRasterCase],
        createShaderModule: async (device, code) =>
          (
            await (backend === 'webgpu' ? createShaderModule : webgl.createShaderModule)(device, {
              code,
            })
          ).unwrap(),
        save: async (name, width, expected, actual) => {
          for (const [kind, rgba] of [
            ['cpu', expected],
            ['gpu', actual],
          ] as const) {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = rgba.length / width / 4;
            required(canvas.getContext('2d')).putImageData(
              new ImageData(new Uint8ClampedArray(rgba), width, canvas.height),
              0,
              0,
            );
            await commands.writeFile(
              `${directory}/${name}.${kind}.png`,
              required(canvas.toDataURL().split(',')[1]),
              'base64',
            );
            let binary = '';
            for (let i = 0; i < rgba.length; i += 8192)
              binary += String.fromCharCode(...rgba.subarray(i, i + 8192));
            await commands.writeFile(`${directory}/${name}.${kind}.rgba`, btoa(binary), 'base64');
          }
        },
      });
      await commands.writeFile(`${directory}/result.json`, JSON.stringify(result, null, 2));
    } finally {
      for (const canvas of canvases) {
        canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
        canvas.remove();
      }
    }
  }, 60_000);
