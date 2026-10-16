import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { World } from '@forgeax/engine-ecs';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { beforeAll, expect, it } from 'vitest';
import { createBlitzUi, type UiWasmHost } from '../../../ui-blitz/src/index.js';
import { constructRuntimeRendererHost } from '../renderer-host';
import { readUiFrame, verifyCpuUiComposition, verifyCpuUiFailure } from './cpu-ui.fixture';
import { encodeRgbaPng, offscreenCanvas } from './hdr-evidence.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const uiWasmBytes = readFile(new URL('../../../ui-blitz/pkg/ui_blitz_bg.wasm', import.meta.url));
const uiWasm: UiWasmHost = {
  readWasm: () => uiWasmBytes,
  instantiate: async (imports) =>
    WebAssembly.instantiate(await uiWasmBytes, imports as WebAssembly.Imports),
};

let manifestUrl = '';
beforeAll(async () => {
  manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());
}, 300_000);
const directory = 'artifacts/cpu-ui/dawn';
const save = (name: string, pixels: Uint8Array) => {
  mkdirSync(directory, { recursive: true });
  writeFileSync(`${directory}/${name}.png`, encodeRgbaPng(pixels, 64));
};

it('presents UI before game preparation and composes transparent UI after the 3D output transform in one submission', {
  timeout: 120_000,
}, async () => {
  const surface = offscreenCanvas(64);
  try {
    await verifyCpuUiComposition(surface.canvas, manifestUrl, save);
  } finally {
    surface.destroy();
  }
});

it('keeps the same graphics/UI host usable after scene initialization fails', {
  timeout: 60_000,
}, async () => {
  const surface = offscreenCanvas(64);
  try {
    await verifyCpuUiFailure(surface.canvas, save);
  } finally {
    surface.destroy();
  }
});

it('composes real Blitz WASM at the WeChat DPR3 physical extent while retaining CSS-pixel layout', {
  timeout: 60_000,
}, async () => {
  const width = 2532;
  const height = 1170;
  const pixelRatio = 3;
  const ui = await createBlitzUi({
    wasm: uiWasm,
    html: '<style>body{margin:0}main{width:100px;height:40px;background:red}</style><main></main>',
    width: width / pixelRatio,
    height: height / pixelRatio,
    pixelRatio,
    onError: (cause) => {
      throw cause;
    },
  });
  const surface = offscreenCanvas(width, height);
  let rejectManifest!: (cause: unknown) => void;
  const deferred = new Promise<string>((_resolve, reject) => {
    rejectManifest = reject;
  });
  let byteLength: number | undefined;
  const host = await constructRuntimeRendererHost(
    surface.canvas,
    {
      ui: {
        kind: 'rgba',
        paint(time, outputWidth, outputHeight) {
          expect([outputWidth, outputHeight]).toEqual([width, height]);
          const pixels = ui.paint(time);
          byteLength = pixels?.byteLength;
          return pixels;
        },
      },
    },
    { shaderManifestUrl: '/dpr3-deferred.json', readShaderManifest: () => deferred },
  );
  if (!host.ok) throw host.error;
  const renderer = host.value.renderer;
  const world = new World();
  try {
    // Reproduce the actual Host mistake: logical display dimensions cannot
    // supply a DPR3 physical surface. The Renderer must preserve this rejection.
    await expect(readUiFrame(renderer, world, width, height)).rejects.toThrow(
      'UI paint must return tightly packed premultiplied sRGB RGBA8',
    );
    expect(byteLength).toBe((width / pixelRatio) * (height / pixelRatio) * 4);
    ui.resize(width, height, pixelRatio);
    expect(ui.document.querySelector('main')?.getBoundingClientRect()).toMatchObject({
      width: 100,
      height: 40,
    });
    const frame = await readUiFrame(renderer, world, width, height);
    expect(byteLength).toBe(width * height * 4);
    expect(frame.receipt.presentation).toBe('pending');
    const pixel = (x: number, y: number) => [
      ...frame.rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 3),
    ];
    expect(pixel(298, 118)).toEqual([255, 0, 0]);
    expect(pixel(301, 121)).toEqual([0, 0, 0]);
    expect(pixel(width - 1, height - 1)).toEqual([0, 0, 0]);
  } finally {
    rejectManifest(new Error('DPR3 UI regression complete'));
    await host.value.initialization;
    const disposed = await renderer.dispose();
    ui.dispose();
    surface.destroy();
    expect(disposed).toMatchObject({ ok: true });
  }
});
