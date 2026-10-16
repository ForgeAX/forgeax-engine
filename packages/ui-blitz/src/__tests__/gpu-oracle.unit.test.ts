/// <reference types="node" />
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createBlitzUi, type UiWasmHost } from '../index.js';
import { required } from './fixture.js';
import { compareUiRaster, pixelAt, uiRasterCases, uiRasterImage } from './gpu-parity-fixture.js';

const bytes = await readFile(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url));
const font = await readFile(
  new URL(
    '../../../../third_party/blitz/packages/blitz-dom/tests/fonts/dejavu-sans-ascii.ttf',
    import.meta.url,
  ),
);
const wasm: UiWasmHost = {
  readWasm: async () => bytes,
  instantiate: (imports) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
};

it.each(uiRasterCases)('qualifies the reference path for $name', async (scene) => {
  const ui = await createBlitzUi({
    wasm,
    font,
    html: scene.html,
    width: scene.width,
    height: scene.height,
    pixelRatio: scene.pixelRatio ?? 1,
    resources: {
      baseUrl: 'https://ui-raster.test/',
      read: async (url) => {
        if (url !== 'https://ui-raster.test/red.png')
          throw new Error(`Unexpected oracle resource: ${url}`);
        return uiRasterImage;
      },
    },
    onError: (cause) => {
      throw cause;
    },
  });
  try {
    if (scene.reference) {
      // This admitted CSS filter is GPU-owned. Keep the former CPU panic as a
      // structured rejection/recovery gate, never as its visual reference.
      let failure: unknown;
      try {
        ui.paint(0);
      } catch (cause) {
        failure = cause;
      }
      expect(failure).toMatchObject({
        code: 'ui-dom-operation-failed',
        operation: 'paint',
        cause: expect.stringContaining('ui-cpu-unsupported-filter'),
      });
      required(ui.document.querySelector('main')).style.filter = 'none';
      expect(pixelAt(required(ui.paint(1)), scene.width, 48, 48)).toEqual([200, 100, 40, 255]);
      return;
    }
    let previous: Uint8Array | undefined;
    for (const [index, state] of scene.states.entries()) {
      state.apply?.(ui);
      const pixels = required(ui.paint(state.time));
      expect(pixels).toHaveLength(scene.width * scene.height * 4);
      if (state.inspect) expect(state.inspect(ui)).toEqual(state.expected);
      // FALSIFY: clearing even a small admitted feature must fail the same
      // all-channel metric used by the future real GPU readback comparison.
      expect(compareUiRaster(pixels, new Uint8Array(pixels.length)).maxError).toBeGreaterThan(0.05);
      expect(compareUiRaster(pixels, pixels).maxError).toBe(0);
      if (previous) expect(compareUiRaster(previous, pixels).maxError).toBeGreaterThan(0.05);
      let premultiplicationViolation = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const alpha = required(pixels[offset + 3]);
        for (let channel = 0; channel < 3; channel++)
          premultiplicationViolation = Math.max(
            premultiplicationViolation,
            required(pixels[offset + channel]) - alpha,
          );
      }
      expect(premultiplicationViolation).toBe(0);
      if (index === 0)
        for (const probe of scene.probes ?? [])
          expect(pixelAt(pixels, scene.width, probe.x, probe.y)).toEqual(probe.rgba);
      if (scene.name === 'single-blur-filter') {
        const fringe = pixelAt(pixels, scene.width, 27, 52);
        expect(fringe[0]).toBeGreaterThan(0);
        expect(fringe[3]).toBeLessThan(128);
      }
      if (scene.name === 'single-colored-drop-shadow') {
        const shadow = pixelAt(pixels, scene.width, 74, 48);
        expect(shadow[1]).toBeGreaterThan(180);
        expect(shadow[0]).toBe(0);
      }
      if (scene.name === 'gradient-alpha-mask-and-image') {
        const left = pixelAt(pixels, scene.width, 24, 48);
        const right = pixelAt(pixels, scene.width, 136, 48);
        expect(left[3]).toBeGreaterThan(right[3] + 180);
        expect(left[0]).toBeGreaterThan(left[2]);
        expect(right[2]).toBeGreaterThan(right[0]);
      }
      if (scene.name === 'prepared-glyphs-bold-and-text-shadow') {
        const coverage = (top: number) => {
          let sum = 0;
          for (let y = top; y < top + 30; y++)
            for (let x = 8; x < 72; x++) sum += pixelAt(pixels, scene.width, x, y)[3];
          return sum;
        };
        expect(coverage(8)).toBeGreaterThan(255 * 20);
        expect(coverage(40)).toBeGreaterThan(coverage(8) * 1.1);
        let red = 0;
        for (let y = 8; y < 38; y++)
          for (let x = 114; x < 138; x++) if (pixelAt(pixels, scene.width, x, y)[0] > 0) red++;
        expect(red).toBeGreaterThan(20);
      }
      previous = pixels;
    }
  } finally {
    ui.dispose();
  }
});
