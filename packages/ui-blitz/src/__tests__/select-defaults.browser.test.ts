import type {} from '@vitest/browser-playwright';
import { afterEach, expect, it } from 'vitest';
import { cdp, commands, page, userEvent } from 'vitest/browser';
import { createBlitzUi, type UiWasmHost } from '../index.js';
import { required, uiEvidenceDirectory } from './fixture.js';

const bytes = new Uint8Array(
  await (await fetch(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url))).arrayBuffer(),
);
const wasm: UiWasmHost = {
  readWasm: async () => bytes,
  instantiate: (imports) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
};
const cleanup: (() => void)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  await cdp().send('Emulation.clearDeviceMetricsOverride');
});

it('preserves select text through DPR changes and matches independent browser defaults and keyboard states', async () => {
  const evidence = uiEvidenceDirectory(required(expect.getState().testPath), 'ui-select-defaults');
  const font = new Uint8Array(
    await (
      await fetch(
        new URL(
          '../../../../third_party/blitz/packages/blitz-dom/tests/fonts/dejavu-sans-ascii.ttf',
          import.meta.url,
        ),
      )
    ).arrayBuffer(),
  );
  const html = `<!doctype html><style>
    html,body{margin:0;background:#10243a;color:white;font:13px "Select Fixture"}
    main{padding:20px;display:grid;grid-template-columns:150px 240px;gap:18px;align-items:center}
    select{font-family:"Select Fixture";justify-self:start}
    #normal,#disabled,#empty{font:inherit}#large{font:24px "Select Fixture"}
    #padded{font:13px "Select Fixture";padding:6px}
    #styled{font:16px "Select Fixture";color:#123456;background:#edf1f8;border:2px solid #678;padding:4px;border-radius:6px;width:160px;height:38px}
    button{grid-column:1/-1;height:28px}
  </style><main><label for=normal>Ordinary</label><select id=normal><option>One</option><option disabled>Unavailable</option><option>Three</option></select>
    <label for=large>Large font</label><select id=large><option>One</option><option>Three</option></select>
    <label for=padded>Padding</label><select id=padded><option>One</option><option>Three</option></select>
    <label for=empty>Empty</label><select id=empty></select>
    <label for=styled>Authored</label><select id=styled><option>One</option><option>Three</option></select>
    <label for=disabled>Disabled</label><select id=disabled disabled><option>One</option></select>
    <button id=after>After selects</button></main>`;
  const width = 460,
    height = 380;
  await page.viewport(width, height);
  await cdp().send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const iframe = document.createElement('iframe');
  iframe.style.cssText = `position:absolute;inset:0;width:${width}px;height:${height}px;border:0`;
  const loaded = new Promise<void>((resolve) => {
    iframe.onload = () => resolve();
  });
  iframe.srcdoc = html;
  document.body.append(iframe);
  cleanup.push(() => iframe.remove());
  await loaded;
  const browser = required(iframe.contentDocument);
  browser.fonts.add(await new FontFace('Select Fixture', font.slice().buffer).load());
  await browser.fonts.ready;
  const ui = await createBlitzUi({
    wasm,
    html,
    width,
    height,
    font,
    fontFamily: 'Select Fixture',
    onError: (cause) => {
      throw cause;
    },
  });
  cleanup.push(() => ui.dispose());
  const targets = [browser, ui.document].map((document) => ({
    document,
    field: required(document.querySelector<HTMLSelectElement>('#normal')),
    events: [] as string[],
  }));
  for (const target of targets)
    for (const type of ['input', 'change'])
      target.field.addEventListener(type, () =>
        target.events.push(`${type}:${target.field.value}`),
      );
  let ratio = 1;
  const states: unknown[] = [];
  const capture = async (name: string, geometry = true) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const pair = targets.map(({ document, field, events }) => ({
      active: document.activeElement?.id ?? '',
      value: field.value,
      events: [...events],
      selects: Array.from(document.querySelectorAll('select'), (select) => {
        const rect = select.getBoundingClientRect();
        return { id: select.id, rect: [rect.x, rect.y, rect.width, rect.height] };
      }),
    }));
    const rgba = required(ui.paint(performance.now()));
    const canvas = document.createElement('canvas');
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    required(canvas.getContext('2d')).putImageData(
      new ImageData(new Uint8ClampedArray(rgba), canvas.width, canvas.height),
      0,
      0,
    );
    await commands.writeFile(
      `${evidence}/${name}-native.png`,
      required(canvas.toDataURL().split(',')[1]),
      'base64',
    );
    await page
      .elementLocator(iframe)
      .screenshot({ path: `${evidence}/${name}-browser.png`, scale: 'device' });
    const rect = required(targets[1]).field.getBoundingClientRect();
    const points: [number, number][] = [];
    for (let y = Math.ceil((rect.top + 3) * ratio); y < (rect.bottom - 3) * ratio; y++)
      for (let x = Math.ceil((rect.left + 3) * ratio); x < (rect.left + 38) * ratio; x++) {
        const offset = (y * width * ratio + x) * 4;
        if (
          required(rgba[offset]) < 100 &&
          required(rgba[offset + 1]) < 100 &&
          required(rgba[offset + 2]) < 100
        )
          points.push([x / ratio, y / ratio]);
      }
    const ink = points.length
      ? [
          Math.max(...points.map(([x]) => x)) - Math.min(...points.map(([x]) => x)) + 1 / ratio,
          Math.max(...points.map(([, y]) => y)) - Math.min(...points.map(([, y]) => y)) + 1 / ratio,
        ]
      : [0, 0];
    states.push({ name, ratio, pair, ink });
    await commands.writeFile(`${evidence}/states.json`, JSON.stringify(states, null, 2));
    if (geometry)
      for (const [index, actual] of required(pair[1]).selects.entries()) {
        const expected = required(required(pair[0]).selects[index]);
        for (let axis = 0; axis < 4; axis++)
          expect
            .soft(
              Math.abs(required(actual.rect[axis]) - required(expected.rect[axis])),
              `${name} #${actual.id} rectangle axis ${axis}`,
            )
            .toBeLessThanOrEqual(1);
      }
    expect(required(pair[1]).value).toBe(required(pair[0]).value);
    expect(required(pair[1]).events).toEqual(required(pair[0]).events);
    return ink;
  };
  const initialInk = await capture('01-initial');
  for (const next of [2, 3, 1]) {
    ratio = next;
    await cdp().send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: ratio,
      mobile: false,
    });
    ui.resize(width * ratio, height * ratio, ratio);
    const ink = await capture(`02-resized-dpr${ratio}`);
    for (let axis = 0; axis < 2; axis++)
      expect
        .soft(
          Math.abs(required(ink[axis]) - required(initialInk[axis])),
          `DPR${ratio} text axis ${axis}`,
        )
        .toBeLessThanOrEqual(1);
  }
  const key = async (key: string) => {
    await userEvent.keyboard(key === ' ' ? ' ' : `{${key}}`);
    ui.input.key({ type: 'keydown', key });
    ui.input.key({ type: 'keyup', key });
  };
  for (const target of targets) target.field.focus();
  await key('ArrowDown');
  await capture('03-keyboard-skips-disabled');
  await key('Home');
  await key(' ');
  await key('ArrowDown');
  await capture('04-popup-highlight', false);
  await key('Escape');
  await capture('05-popup-escape-commit');
  await key(' ');
  await key('ArrowDown');
  await key('Enter');
  await capture('06-popup-committed');
  for (const target of targets) target.field.disabled = true;
  await capture('07-disabled-retires');
  expect(ui.input.focusedText()).toBeNull();
});
