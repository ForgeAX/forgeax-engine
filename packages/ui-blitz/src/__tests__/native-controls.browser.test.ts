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
  await cdp().send('Emulation.setScrollbarsHidden', { hidden: false });
});
it('uses browser number decorations, focus modality and anchored validation in an independent scrolling form', async () => {
  const evidence = uiEvidenceDirectory(required(expect.getState().testPath), 'ui-native-controls');
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
    html,body{margin:0;background:#10243a;color:white;font:13px "Controls Fixture"}
    main{padding:24px}form{display:grid;grid-template-columns:1fr 120px;gap:16px;align-items:center}
    input,button,select{font:inherit;box-sizing:border-box}
    input{height:32px;width:120px;padding:6px;border:1px solid #789;border-radius:4px;background:#182d3e;color:white}
    button{height:32px}#before{grid-column:1/-1}#scroll{height:130px;overflow:auto;grid-column:1/-1;border:1px solid #789;padding:8px}
    #scroll label{display:flex;justify-content:space-between;align-items:center}#spacer{height:140px}
  </style><main><form><button type=button id=before>Settings</button>
    <label for=amount>Amount</label><input id=amount type=number value=0.65 min=0.1 max=2 step=0.05 required>
    <label for=readonly>Read only</label><input id=readonly type=number value=1 readonly>
    <label for=disabled>Disabled</label><input id=disabled type=number value=1 disabled>
    <button type=button id=action>Apply</button><select id=choice><option>One</option><option>Two</option></select>
    <section id=scroll><p>Independent scrolling form</p><div id=spacer></div><label for=bottom>Required amount<input id=bottom type=number required></label></section>
    <button>Submit</button></form></main>`;
  let ratio = 1;
  const width = 400,
    height = 440;
  await page.viewport(width, height);
  await cdp().send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // Match the portable scroller's zero gutter in headed and headless Chromium.
  // Scrolling and all control rectangles remain part of the differential below.
  await cdp().send('Emulation.setScrollbarsHidden', { hidden: true });
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
  browser.fonts.add(await new FontFace('Controls Fixture', font.slice().buffer).load());
  await browser.fonts.ready;
  const errors: unknown[] = [];
  const ui = await createBlitzUi({
    wasm,
    html,
    width,
    height,
    font,
    fontFamily: 'Controls Fixture',
    onError: (error) => errors.push(error),
  });
  cleanup.push(() => ui.dispose());
  const targets = [browser, ui.document].map((document) => ({
    document,
    amount: required(document.querySelector<HTMLInputElement>('#amount')),
    before: required(document.querySelector<HTMLButtonElement>('#before')),
    action: required(document.querySelector<HTMLButtonElement>('#action')),
    scroll: required(document.querySelector<HTMLElement>('#scroll')),
    bottom: required(document.querySelector<HTMLInputElement>('#bottom')),
    events: [] as string[],
  }));
  for (const target of targets)
    for (const type of ['input', 'change'])
      target.amount.addEventListener(type, () =>
        target.events.push(`${type}:${target.amount.value}`),
      );
  const capture = async (name: string) => {
    // Sample after the browser has retired disabled focus and settled its popup.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const states = targets.map(({ document, amount, bottom, scroll, events }, index) => ({
      active: document.activeElement?.id ?? '',
      value: amount.value,
      disabled: amount.disabled,
      readOnly: amount.readOnly,
      events: [...events],
      bottomValid: bottom.validity.valid,
      scroll: scroll.scrollTop,
      controls: ['#amount', '#readonly', '#disabled', '#action', '#bottom'].map((selector) => {
        const control = required(document.querySelector(selector));
        const style =
          index === 0
            ? required(browser.defaultView).getComputedStyle(control)
            : ui.getComputedStyle(control);
        const rect = control.getBoundingClientRect();
        return {
          selector,
          rect: [rect.x, rect.y, rect.width, rect.height],
          focusVisible: control.matches(':focus-visible'),
          outline: ['outline-style', 'outline-width', 'outline-color'].map((name) =>
            style.getPropertyValue(name),
          ),
        };
      }),
    }));
    await commands.writeFile(
      `${evidence}/${name}.json`,
      JSON.stringify(
        {
          browser: navigator.userAgent,
          width,
          height,
          ratio,
          browserViewport: {
            width: browser.defaultView?.innerWidth,
            height: browser.defaultView?.innerHeight,
            ratio: browser.defaultView?.devicePixelRatio,
          },
          layoutMetrics: await cdp().send('Page.getLayoutMetrics'),
          states,
        },
        null,
        2,
      ),
    );
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
    for (const [index, actual] of required(states[1]).controls.entries()) {
      const expected = required(required(states[0]).controls[index]);
      expect(actual.focusVisible).toBe(expected.focusVisible);
      if (actual.focusVisible) expect(actual.outline).toEqual(expected.outline);
      for (let axis = 0; axis < 4; axis++)
        expect(
          Math.abs(required(actual.rect[axis]) - required(expected.rect[axis])),
        ).toBeLessThanOrEqual(1);
    }
    expect(states[1]?.value).toBe(states[0]?.value);
    return rgba;
  };
  const pointer = async (elements: HTMLElement[], step = false, click = true) => {
    for (const [index, element] of elements.entries()) {
      const rect = element.getBoundingClientRect();
      const x = step ? rect.right - 14 : rect.x + rect.width / 2,
        y = rect.y + rect.height / 2 - (step ? 4 : 0);
      if (index === 0) {
        await cdp().send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        if (click) {
          await cdp().send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x,
            y,
            button: 'left',
            clickCount: 1,
          });
          await cdp().send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x,
            y,
            button: 'left',
            clickCount: 1,
          });
        }
      } else {
        ui.input.pointer({ phase: 'move', pointerId: 71, pointerType: 'mouse', x, y });
        if (click)
          for (const phase of ['down', 'up'] as const)
            ui.input.pointer({ phase, pointerId: 71, pointerType: 'mouse', x, y });
      }
    }
  };
  const key = async (key: string) => {
    await userEvent.keyboard(`{${key}}`);
    ui.input.key({ type: 'keydown', key });
    ui.input.key({ type: 'keyup', key });
  };
  await capture('01-idle');
  await pointer(
    targets.map(({ amount }) => amount),
    false,
    false,
  );
  const hovered = await capture('02-hover');
  const field = required(targets[1]).amount.getBoundingClientRect();
  let buttonPixels = 0;
  for (let y = Math.ceil(field.y + 10); y < field.bottom - 10; y++)
    for (let x = Math.ceil(field.right - 21); x < field.right - 7; x++) {
      const offset = (y * width + x) * 4;
      if (hovered[offset] === 239 && hovered[offset + 1] === 239 && hovered[offset + 2] === 239)
        buttonPixels++;
    }
  expect(buttonPixels, 'native number buttons occupy the browser content edge').toBeGreaterThan(20);
  for (const target of targets) target.before.focus();
  await key('Tab');
  await capture('03-keyboard-selection');
  await pointer(
    targets.map(({ amount }) => amount),
    true,
  );
  await key('ArrowDown');
  expect(targets.map(({ amount }) => amount.value)).toEqual(['0.65', '0.65']);
  expect(targets[1]?.events).toEqual(targets[0]?.events);
  expect(targets[1]?.events).toEqual(['input:0.7', 'change:0.7', 'input:0.65', 'change:0.65']);
  await capture('04-stepped');
  for (const target of targets) {
    target.amount.value = '0.42';
    target.amount.stepUp();
  }
  expect(targets.map(({ amount }) => amount.value)).toEqual(['0.45', '0.45']);
  for (const target of targets) target.amount.readOnly = true;
  await pointer(targets.map(({ action }) => action));
  await capture('05-pointer-readonly');
  for (const target of targets) {
    target.amount.readOnly = false;
    target.amount.disabled = true;
    target.amount.focus();
  }
  await capture('06-disabled');
  for (const target of targets) {
    target.amount.disabled = false;
    target.scroll.scrollTop = 1000;
    expect(target.bottom.reportValidity()).toBe(false);
  }
  await capture('07-scrolled-validation');
  await cdp().send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: false,
  });
  ratio = 2;
  ui.resize(width * ratio, height * ratio, ratio);
  for (const target of targets) {
    target.bottom.value = '2';
    expect(target.bottom.reportValidity()).toBe(true);
    target.amount.value = '';
    target.amount.reportValidity();
  }
  await capture('08-top-validation-dpr2');
  for (const target of targets) target.amount.disabled = true;
  await capture('09-disabled-clears-validation');
  expect(errors).toEqual([]);
});
