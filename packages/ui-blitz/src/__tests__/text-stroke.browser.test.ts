import { expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { createBlitzUi } from '../index.js';
import { required, uiEvidenceDirectory } from './fixture.js';

it('paints inherited glyph outlines with live paint-order changes against real browser text', async () => {
  const width = 240,
    height = 88;
  const load = async (url: URL) => new Uint8Array(await (await fetch(url)).arrayBuffer());
  const [bytes, font] = await Promise.all([
    load(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url)),
    load(
      new URL(
        '../../../../third_party/blitz/packages/blitz-dom/tests/fonts/dejavu-sans-ascii.ttf',
        import.meta.url,
      ),
    ),
  ]);
  const html =
    '<!doctype html><style>html,body{margin:0;background:white}#host{color:lime;font:48px/64px "Stroke Fixture";-webkit-text-stroke:6px red;paint-order:stroke fill}span{position:absolute;left:12px;top:4px}</style><div id=host><span id=text>IRON</span></div>';
  const frame = document.createElement('iframe');
  frame.style.cssText = `width:${width}px;height:${height}px;border:0`;
  const loaded = new Promise<void>((resolve) => {
    frame.onload = () => resolve();
  });
  frame.srcdoc = html;
  document.body.append(frame);
  await loaded;
  const browser = required(frame.contentDocument);
  browser.fonts.add(await new FontFace('Stroke Fixture', font.slice().buffer).load());
  await browser.fonts.load('48px "Stroke Fixture"');
  const errors: unknown[] = [];
  const ui = await createBlitzUi({
    width,
    height,
    html,
    font,
    fontFamily: 'Stroke Fixture',
    wasm: {
      readWasm: async () => bytes,
      instantiate: (imports) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
    },
    onError: (error) => errors.push(error),
  });
  const evidence = uiEvidenceDirectory(required(expect.getState().testPath), 'ui-text-stroke');
  const rows: unknown[] = [];
  const count = (pixels: Uint8Array, color: readonly number[]) => {
    let result = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (color.every((value, channel) => pixels[i + channel] === value)) result++;
    return result;
  };
  let backRed = 0,
    backGreen = 0;
  try {
    for (const [name, style] of [
      ['back', 'paint-order:stroke fill'],
      ['front', 'paint-order:normal'],
      ['zero', '-webkit-text-stroke-width:0'],
    ] as const) {
      for (const document of [browser, ui.document])
        required(document.querySelector('#text')).setAttribute('style', style);
      const pixels = required(ui.paint(performance.now()));
      const red = count(pixels, [255, 0, 0]),
        green = count(pixels, [0, 255, 0]);
      if (name === 'back') {
        expect(red).toBeGreaterThan(100);
        expect(green).toBeGreaterThan(100);
        backRed = red;
        backGreen = green;
      }
      if (name === 'front') {
        expect(red).toBeGreaterThan(backRed);
        expect(green).toBeLessThan(backGreen);
      }
      if (name === 'zero') expect(red).toBe(0);
      for (const property of [
        '-webkit-text-stroke-width',
        '-webkit-text-stroke-color',
        'paint-order',
      ]) {
        expect(
          ui
            .getComputedStyle(required(ui.document.querySelector('#text')))
            .getPropertyValue(property),
        ).toBe(
          required(browser.defaultView)
            .getComputedStyle(required(browser.querySelector('#text')))
            .getPropertyValue(property),
        );
      }
      rows.push({ name, red, green });
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      required(canvas.getContext('2d')).putImageData(
        new ImageData(new Uint8ClampedArray(pixels), width, height),
        0,
        0,
      );
      document.body.append(canvas);
      await page.elementLocator(frame).screenshot({ path: `${evidence}/${name}.browser.png` });
      await page.elementLocator(canvas).screenshot({ path: `${evidence}/${name}.native.png` });
      canvas.remove();
    }
    expect(errors).toEqual([]);
    await commands.writeFile(
      `${evidence}/result.json`,
      JSON.stringify({ rows, errors, userAgent: navigator.userAgent }, null, 2),
    );
  } finally {
    ui.dispose();
    frame.remove();
  }
});
