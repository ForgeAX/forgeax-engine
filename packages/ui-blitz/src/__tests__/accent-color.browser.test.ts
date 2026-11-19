import { expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { createBlitzUi } from '../index.js';
import { required, uiEvidenceDirectory } from './fixture.js';

it('matches authored accent inheritance and live native painting against browser controls', async () => {
  const width = 320,
    height = 120;
  const html =
    '<!doctype html><style>html,body{margin:0;background:white}#host{accent-color:#d2a347}input{width:24px;height:24px;margin:8px}input[type=range]{width:160px;height:16px}</style><div id=host><input id=check type=checkbox checked><input id=radio type=radio checked><input id=range type=range value=50></div>';
  const iframe = document.createElement('iframe');
  iframe.style.cssText = `width:${width}px;height:${height}px;border:0`;
  const loaded = new Promise<void>((resolve) => {
    iframe.onload = () => resolve();
  });
  iframe.srcdoc = html;
  document.body.append(iframe);
  await loaded;
  const browser = required(iframe.contentDocument);
  const bytes = new Uint8Array(
    await (await fetch(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url))).arrayBuffer(),
  );
  const errors: unknown[] = [];
  const ui = await createBlitzUi({
    width,
    height,
    html,
    wasm: {
      readWasm: async () => bytes,
      instantiate: (imports) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
    },
    onError: (error) => errors.push(error),
  });
  const evidence = uiEvidenceDirectory(required(expect.getState().testPath), 'ui-control-accent');
  const rows: unknown[] = [];
  try {
    for (const [name, style, color] of [
      ['gold', 'accent-color:#d2a347', [210, 163, 71]],
      ['red', 'accent-color:rgb(255,0,0)', [255, 0, 0]],
    ] as const) {
      for (const document of [browser, ui.document])
        required(document.querySelector('#host')).setAttribute('style', style);
      const pixels = required(ui.paint(performance.now()));
      let count = 0;
      for (let offset = 0; offset < pixels.length; offset += 4)
        if (color.every((channel, index) => pixels[offset + index] === channel)) count++;
      expect(count).toBeGreaterThan(30);
      for (const selector of ['#check', '#radio', '#range']) {
        const rect = required(ui.document.querySelector(selector)).getBoundingClientRect();
        let dark = 0;
        for (let y = Math.ceil(rect.y); y < Math.floor(rect.bottom); y++) {
          for (let x = Math.ceil(rect.x); x < Math.floor(rect.right); x++) {
            const offset = (y * width + x) * 4;
            if ([0, 1, 2].every((channel) => pixels[offset + channel] === 59)) dark++;
          }
        }
        if (name === 'gold') expect(dark, `${selector} dark contrast`).toBeGreaterThan(5);
        else expect(dark, `${selector} light contrast`).toBe(0);
      }

      const computed = ['#check', '#radio', '#range'].map((selector) => {
        const real = required(browser.querySelector(selector)),
          native = required(ui.document.querySelector(selector));
        const expected = required(browser.defaultView)
          .getComputedStyle(real)
          .getPropertyValue('accent-color');
        const actual = ui.getComputedStyle(native).getPropertyValue('accent-color');
        expect(actual).toBe(expected);
        return { selector, browser: expected, native: actual };
      });
      rows.push({ name, computed, accentPixels: count, userAgent: navigator.userAgent });
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      required(canvas.getContext('2d')).putImageData(
        new ImageData(new Uint8ClampedArray(pixels), width, height),
        0,
        0,
      );
      document.body.append(canvas);
      await page.elementLocator(iframe).screenshot({ path: `${evidence}/${name}.browser.png` });
      await page.elementLocator(canvas).screenshot({ path: `${evidence}/${name}.native.png` });
      canvas.remove();
    }
    const checkbox = required(ui.document.querySelector<HTMLInputElement>('#check'));
    let changes = 0;
    checkbox.addEventListener('change', () => changes++);
    const rect = checkbox.getBoundingClientRect();
    ui.input.pointer({
      phase: 'down',
      pointerId: 1,
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
    });
    ui.input.pointer({
      phase: 'up',
      pointerId: 1,
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
    });
    expect(checkbox.checked).toBe(false);
    expect(changes).toBe(1);
    expect(errors).toEqual([]);
    await commands.writeFile(
      `${evidence}/result.json`,
      JSON.stringify({ nativeCpuPaint: true, rows, changes, errors }, null, 2),
    );
  } finally {
    ui.dispose();
    iframe.remove();
  }
});
