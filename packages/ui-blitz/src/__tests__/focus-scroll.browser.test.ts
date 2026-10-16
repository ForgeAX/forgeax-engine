import type {} from '@vitest/browser-playwright';
import { afterEach, expect, it } from 'vitest';
import { cdp, commands } from 'vitest/browser';
import { createBlitzUi } from '../index.js';
import { required, uiEvidenceDirectory } from './fixture.js';

afterEach(async () => {
  await cdp().send('Emulation.setScrollbarsHidden', { hidden: false });
});

it('centers offscreen focus while retaining already visible controls and explicit nearest alignment', async () => {
  // Match the portable scroller's zero gutter in headed and headless Chromium.
  await cdp().send('Emulation.setScrollbarsHidden', { hidden: true });
  const html =
    '<style>*{box-sizing:border-box}body{margin:0}#panel{width:200px;height:100px;overflow:auto}#area{width:700px;height:700px;padding:220px 0 0 300px}button{display:block;width:80px;height:20px;padding:0;border:0}</style><div id=panel><div id=area><button id=target>Focus</button></div></div>';
  const bytes = new Uint8Array(
    await (await fetch(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url))).arrayBuffer(),
  );
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'width:400px;height:300px;border:0';
  const loaded = new Promise<void>((resolve) => {
    iframe.onload = () => resolve();
  });
  iframe.srcdoc = html;
  document.body.append(iframe);
  await loaded;
  const ui = await createBlitzUi({
    wasm: {
      readWasm: async () => bytes,
      instantiate: (imports) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
    },
    html,
    width: 400,
    height: 300,
    onError: (error) => {
      throw error;
    },
  });
  const documents = [required(iframe.contentDocument), ui.document];
  const rows: unknown[] = [];
  try {
    for (const [name, x, y, height, prevent] of [
      ['offscreen', 0, 0, 20, false],
      ['visible', 250, 150, 20, false],
      ['partial', 190, 130, 20, false],
      ['prevent', 0, 0, 20, true],
      ['oversized', 0, 0, 150, false],
      ['covering', 240, 240, 150, false],
    ] as const) {
      const result = documents.map((document) => {
        const panel = required(document.querySelector<HTMLElement>('#panel')),
          target = required(document.querySelector<HTMLElement>('#target'));
        target.blur();
        target.style.height = `${height}px`;
        panel.scrollTo(x, y);
        target.focus({ preventScroll: prevent });
        return [panel.scrollLeft, panel.scrollTop];
      });
      rows.push({ name, result });
      expect.soft(result[1], name).toEqual(result[0]);
    }
    const nearest = documents.map((document) => {
      const panel = required(document.querySelector<HTMLElement>('#panel'));
      const target = required(document.querySelector<HTMLElement>('#target'));
      target.style.height = '20px';
      panel.scrollTo(0, 0);
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return [panel.scrollLeft, panel.scrollTop];
    });
    rows.push({ name: 'explicit-nearest', result: nearest });
    expect(nearest).toEqual([
      [180, 140],
      [180, 140],
    ]);
    await commands.writeFile(
      `${uiEvidenceDirectory(required(expect.getState().testPath), 'ui-focus-scroll')}/states.json`,
      JSON.stringify(rows, null, 2),
    );
  } finally {
    ui.dispose();
    iframe.remove();
  }
});
