import type {} from '@vitest/browser-playwright';
import { afterEach, expect, it } from 'vitest';
import { cdp, commands } from 'vitest/browser';
import { createBlitzUi } from '../index.js';
import { required, uiEvidenceDirectory } from './fixture.js';

afterEach(async () => {
  await cdp().send('Emulation.setScrollbarsHidden', { hidden: false });
});

it('uses the input content clip for client geometry and the same editor for script scrolling and paint', async () => {
  // Match the portable zero-gutter scrollport; classic scrollbar UI is separate.
  await cdp().send('Emulation.setScrollbarsHidden', { hidden: true });
  const bytes = new Uint8Array(
    await (await fetch(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url))).arrayBuffer(),
  );
  const font = new Uint8Array(
    await (
      await fetch(
        new URL(
          '../../../devkit/node_modules/@fontsource-variable/noto-sans-sc/files/noto-sans-sc-latin-wght-normal.woff2',
          import.meta.url,
        ),
      )
    ).arrayBuffer(),
  );
  const html = `<!doctype html><style>
    body{margin:0}input,textarea,#box{display:block;box-sizing:content-box;width:76px;height:20px;
    padding:5px;border:1px solid black;font:16px "Client Clip";margin:4px;color:black;background:white}
    #box{overflow:auto}
    </style><input id=text value=short><input id=number type=number value=2.4><textarea id=area></textarea><div id=box></div>`;
  const iframe = document.createElement('iframe');
  const loaded = new Promise<void>((resolve) => {
    iframe.onload = () => resolve();
  });
  iframe.srcdoc = html;
  document.body.append(iframe);
  await loaded;
  const browser = required(iframe.contentDocument);
  browser.fonts.add(await new FontFace('Client Clip', font.slice().buffer).load());
  await browser.fonts.load('16px "Client Clip"');
  const errors: unknown[] = [];
  const ui = await createBlitzUi({
    wasm: {
      readWasm: async () => bytes,
      instantiate: (imports) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
    },
    html,
    width: 240,
    height: 200,
    font,
    fontFamily: 'Client Clip',
    onError: (error) => errors.push(error),
  });
  const rows: unknown[] = [];
  try {
    const geometry = (document: Document) =>
      ['text', 'number', 'area', 'box'].map((id) => {
        const element = required(document.getElementById(id));
        return {
          id,
          width: element.getBoundingClientRect().width,
          client: [
            element.clientWidth,
            element.clientHeight,
            element.clientLeft,
            element.clientTop,
          ],
          scroll: [element.scrollWidth, element.scrollHeight],
        };
      });
    const expected = geometry(browser);
    const actual = geometry(ui.document);
    rows.push({ stage: 'short', browser: expected, native: actual });
    expect.soft(expected[0]?.client).toEqual([76, 30, 6, 1]);
    expect.soft(actual).toEqual(expected);
    const text = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (const document of [browser, ui.document])
      required(document.querySelector<HTMLInputElement>('#text')).value = text;
    const start = required(ui.paint(0)).slice();
    const scroll = (document: Document) => {
      const input = required(document.querySelector<HTMLInputElement>('#text'));
      input.scrollLeft = 10000;
      return {
        left: input.scrollLeft,
        width: input.scrollWidth,
        client: input.clientWidth,
        rect: input.getBoundingClientRect().width,
      };
    };
    const end = [browser, ui.document].map(scroll);
    rows.push({ stage: 'long-end', browser: end[0], native: end[1] });
    for (const value of end) {
      expect.soft(value.left).toBeGreaterThan(80);
      expect.soft(value.left).toBeCloseTo(value.width - value.client, 0);
      expect.soft(value.rect).toBe(88);
    }
    expect.soft(required(end[1]).left).toBeCloseTo(required(end[0]).left, 0);
    const moved = required(ui.paint(0)).slice();
    expect.soft(moved).not.toEqual(start);
    const shrunk = [browser, ui.document].map((document) => {
      const input = required(document.querySelector<HTMLInputElement>('#text'));
      input.value = 'short';
      return [input.scrollLeft, input.scrollWidth, input.clientWidth];
    });
    rows.push({ stage: 'shrink', values: shrunk });
    expect.soft(shrunk).toEqual([
      [0, 76, 76],
      [0, 76, 76],
    ]);
    expect.soft(errors).toEqual([]);
  } finally {
    await commands.writeFile(
      `${uiEvidenceDirectory(required(expect.getState().testPath), 'ui-input-client-scroll')}/states.json`,
      JSON.stringify({ rows, errors }, null, 2),
    );
    ui.dispose();
    iframe.remove();
  }
});
