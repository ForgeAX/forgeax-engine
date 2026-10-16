import { expect, it } from 'vitest';
import { createShaderModule, ensureReady, requestAdapter } from '../../../rhi-wgpu/src/index';
import type { UiWasmHost } from '../../../ui-blitz/src/index';
import { verifyGpuUiParity } from './gpu-ui-parity.fixture';

it('matches real Blitz GPU raster with the shared pixel oracles on WebGL2', async () => {
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
  const canvases: HTMLCanvasElement[] = [];
  const createDevice = async () => {
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    canvases.push(canvas);
    const device = (
      await (await requestAdapter(undefined, canvas)).unwrap().requestDevice()
    ).unwrap();
    expect(device.caps.backendKind).toBe('wgpu-webgl2');
    return device;
  };
  try {
    await ensureReady();
    const device = await createDevice();
    const results = await verifyGpuUiParity({
      device,
      createReplacementDevice: createDevice,
      wasm,
      font,
      createShaderModule: async (owner, code) =>
        (await createShaderModule(owner, { code })).unwrap(),
    });
    // biome-ignore lint/suspicious/noConsole: retain per-scene pixel evidence in the real backend log.
    console.info(JSON.stringify({ backend: device.caps.backendKind, results }));
    await device.queue.onSubmittedWorkDone();
  } finally {
    for (const canvas of canvases) {
      canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
      canvas.remove();
    }
  }
}, 60_000);
