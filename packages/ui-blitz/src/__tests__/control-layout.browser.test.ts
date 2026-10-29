import { expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { createBlitzUi } from '../index.js';
import { required, uiEvidenceDirectory } from './fixture.js';

const bytes = new Uint8Array(
  await (await fetch(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url))).arrayBuffer(),
);
const wasm = {
  readWasm: async () => bytes,
  instantiate: (imports: object) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
};

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

it.each([
  {
    name: 'intrinsic',
    width: 720,
    height: 660,
    html: `<!doctype html><style>
    html,body{margin:0;background:#10243a;color:white;font:16px/24px "Control Layout"}
    main{padding:20px}p{margin:0 0 10px}input,textarea,button,select{font:inherit;border:1px solid #999;padding:2px}
    .grid{display:grid;width:500px;grid-template-columns:1fr 1fr;gap:20px;margin-top:16px}
    label{display:flex;flex-direction:column;gap:4px}.grid textarea,.grid input{box-sizing:border-box;width:100%;min-width:0}
  </style><main>
    <p>Default <textarea id=default></textarea></p>
    <p>Five columns <textarea id=five cols=5 rows=1></textarea></p>
    <p>Forty columns <textarea id=forty cols=40 rows=3></textarea></p>
    <p>Invalid defaults <textarea id=invalid cols=0 rows=0></textarea></p>
    <p>Text <input id=text></p>
    <p>Five characters <input id=small size=5></p>
    <p>Number <input id=number type=number size=5></p>
    <div class=grid><label id=left>Notes<textarea id=notes></textarea></label><label id=right>Reference<input id=reference></label></div>
  </main>`,
  },
  {
    name: 'inline-baselines',
    width: 540,
    height: 500,
    html: `<!doctype html><style>
    html,body{margin:0;background:#10243a;color:white;font:14px "Control Layout"}
    main{padding:24px}p{margin:16px 0}input,textarea,select,button{font-family:"Control Layout"}
  </style><main id=panel><h2>Control baselines</h2>
    <p id=range-row>Music volume <input id=range type=range value=70></p>
    <p id=checkbox-row><input id=checkbox type=checkbox> Mute music bus</p>
    <p id=select-row>Anti-aliasing <select id=select><option>None</option><option>MSAA</option><option>FXAA</option></select></p>
    <p id=radio-row><input id=radio type=radio> High contrast</p>
    <p id=input-row>Reference <input id=input value=A-1></p>
    <button id=done>Done</button></main>`,
  },
])('matches font-derived control layout and grid tracks: $name', async ({
  name,
  width,
  height,
  html,
}) => {
  await page.viewport(width, height);
  const iframe = document.createElement('iframe');
  iframe.style.cssText = `position:absolute;inset:0;width:${width}px;height:${height}px;border:0`;
  const loaded = new Promise<void>((resolve) => {
    iframe.onload = () => resolve();
  });
  iframe.srcdoc = html;
  document.body.append(iframe);
  await loaded;
  const browser = required(iframe.contentDocument);
  browser.fonts.add(
    await new FontFace('Control Layout', font.slice().buffer, { weight: '100 900' }).load(),
  );
  await browser.fonts.load('16px "Control Layout"');
  await browser.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const errors: unknown[] = [];
  const ui = await createBlitzUi({
    wasm,
    html,
    width,
    height,
    font,
    fontFamily: 'Control Layout',
    onError: (error) => errors.push(error),
  });
  const evidence = uiEvidenceDirectory(required(expect.getState().testPath), 'ui-control-layout');
  try {
    const states = [browser, ui.document].map((document) =>
      Array.from(document.querySelectorAll('[id]'), (element) => {
        const rect = element.getBoundingClientRect();
        return { id: element.id, rect: [rect.x, rect.y, rect.width, rect.height] };
      }),
    );
    await commands.writeFile(`${evidence}/${name}.json`, JSON.stringify(states, null, 2));
    await page.elementLocator(iframe).screenshot({ path: `${evidence}/${name}.browser.png` });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const pixels = required(ui.paint(performance.now()));
    required(canvas.getContext('2d')).putImageData(
      new ImageData(new Uint8ClampedArray(pixels), width, height),
      0,
      0,
    );
    const checkbox = ui.document.querySelector<HTMLInputElement>('#checkbox');
    if (checkbox) {
      expect(checkbox.checked).toBe(false);
      expect(checkbox.matches(':focus-visible')).toBe(false);
      const rect = checkbox.getBoundingClientRect();
      let accentPixels = 0;
      for (let y = Math.floor(rect.top - 1); y <= Math.ceil(rect.bottom + 1); y++)
        for (let x = Math.floor(rect.left - 1); x <= Math.ceil(rect.right + 1); x++) {
          const offset = (y * width + x) * 4;
          if (
            required(pixels[offset]) < 50 &&
            required(pixels[offset + 1]) < 180 &&
            required(pixels[offset + 2]) > 200
          )
            accentPixels++;
        }
      expect(accentPixels, 'unchecked controls use a neutral border').toBe(0);
    }
    await commands.writeFile(
      `${evidence}/${name}.native.png`,
      required(canvas.toDataURL().split(',')[1]),
      'base64',
    );
    for (const [index, actual] of required(states[1]).entries()) {
      const expected = required(required(states[0])[index]);
      for (const axis of [0, 1, 2, 3])
        expect
          .soft(
            Math.abs(required(actual.rect[axis]) - required(expected.rect[axis])),
            `${actual.id} size axis ${axis}`,
          )
          .toBeLessThanOrEqual(1);
    }
    if (name === 'intrinsic') {
      const weights = [];
      for (const weight of ['100', '400', '700']) {
        const fields = [browser, ui.document].map((document) => {
          const field = required(document.querySelector<HTMLTextAreaElement>('#forty'));
          field.style.fontWeight = weight;
          return field;
        });
        await browser.fonts.load(`${weight} 16px "Control Layout"`);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const widths = fields.map((field) => field.getBoundingClientRect().width);
        weights.push({ weight, widths });
        await commands.writeFile(`${evidence}/weights.json`, JSON.stringify(weights, null, 2));
        expect(
          Math.abs(required(widths[1]) - required(widths[0])),
          `variable font weight ${weight}`,
        ).toBeLessThanOrEqual(1);
        const chWidths = fields.map((field) => {
          field.style.width = '20ch';
          const width = field.getBoundingClientRect().width;
          field.style.removeProperty('width');
          return width;
        });
        expect(
          Math.abs(required(chWidths[1]) - required(chWidths[0])),
          `CSS ch remains zero advance at weight ${weight}`,
        ).toBeLessThanOrEqual(1);
      }
    }
    expect(errors).toEqual([]);
  } finally {
    ui.dispose();
    iframe.remove();
  }
});

it('exposes single-line editor widths without changing other control padding boxes', async () => {
  const types = ['text', 'number', 'password', 'email', 'url', 'tel', 'search', 'range'];
  const html = `<!doctype html><style>
    input,textarea{width:76px;height:30px;padding:5px;border:1px solid;font:13px "Control Layout"}
    input[type=range],textarea{width:240px;height:60px}
  </style>${types.map((type) => `<input id=${type} type=${type} value=2.4>`).join('')}<textarea id=textarea>2.4</textarea>`;
  const iframe = document.createElement('iframe');
  const loaded = new Promise<void>((resolve) => {
    iframe.onload = () => resolve();
  });
  iframe.srcdoc = html;
  document.body.append(iframe);
  await loaded;
  const browser = required(iframe.contentDocument);
  browser.fonts.add(await new FontFace('Control Layout', font.slice().buffer).load());
  const errors: unknown[] = [];
  const ui = await createBlitzUi({
    wasm,
    html,
    width: 600,
    height: 320,
    font,
    fontFamily: 'Control Layout',
    onError: (error) => errors.push(error),
  });
  try {
    for (const boxSizing of ['content-box', 'border-box']) {
      for (const padding of [0, 5, 10]) {
        const states = [browser, ui.document].map((document) =>
          Array.from(document.querySelectorAll<HTMLElement>('input,textarea'), (element) => {
            element.style.boxSizing = boxSizing;
            element.style.padding = `${padding}px`;
            return {
              id: element.id,
              clientWidth: element.clientWidth,
              scrollWidth: element.scrollWidth,
              clientHeight: element.clientHeight,
              scrollHeight: element.scrollHeight,
            };
          }),
        );
        expect(states[1], `${boxSizing}, padding ${padding}`).toEqual(states[0]);
      }
    }
    const overflowing = [browser, ui.document].map((document) => {
      const input = required(document.querySelector<HTMLInputElement>('#text'));
      input.value = 'MMMMMMMMMMMMMMMMMMMM';
      return { clientWidth: input.clientWidth, scrollWidth: input.scrollWidth };
    });
    expect(overflowing[1]).toEqual(overflowing[0]);
    expect(required(overflowing[0]).scrollWidth).toBeGreaterThan(
      required(overflowing[0]).clientWidth,
    );
    expect(errors).toEqual([]);
  } finally {
    ui.dispose();
    iframe.remove();
  }
});
