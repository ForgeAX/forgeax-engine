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

it('reveals the same retained invalid field through a scaled scrolling form', async () => {
  const evidence = uiEvidenceDirectory(
    required(expect.getState().testPath),
    'ui-transformed-form-scroll',
  );
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
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#10243a;color:#eef2fa;font:14px/20px "Scroll Fixture"}
    #toolbar{height:48px;padding:10px 24px;background:#1d3852;display:flex;justify-content:space-between;align-items:center}
    button,input{font:inherit;height:32px}button{background:#f7c62d;color:#10243a;border:0;border-radius:4px;padding:4px 12px}
    #panel{position:absolute;left:24px;top:72px;width:320px;height:220px;overflow:auto;border:8px solid #8097af;padding:12px;transform-origin:top left;background:#274460}
    #before{height:220px;padding:12px;background:#1d3852}#after{height:180px}
    label{display:flex;gap:12px;justify-content:space-between;align-items:center;margin:16px 0}
    input{width:120px;min-width:0;padding:4px;border:1px solid #8097af;border-radius:4px}
  </style><header id=toolbar><strong>Scaled form</strong><button id=open>Focus amount</button></header>
  <form id=panel><div id=before>Scroll to the required field</div><label for=amount>Amount<input id=amount type=number min=1 max=9 required></label><div id=after></div><button>Submit</button></form>`;
  const width = 640,
    height = 480;
  let ratio = 1;
  await page.viewport(width, height);
  // Match the portable scroller's zero gutter without changing authored CSS.
  // Keep the exact nested scroll/client extents and transformed hit geometry.
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
  browser.fonts.add(await new FontFace('Scroll Fixture', font.slice().buffer).load());
  await browser.fonts.ready;
  const errors: unknown[] = [];
  const ui = await createBlitzUi({
    wasm,
    html,
    width,
    height,
    font,
    fontFamily: 'Scroll Fixture',
    onError: (cause) => errors.push(cause),
  });
  cleanup.push(() => ui.dispose());
  const targets = [browser, ui.document].map((document) => ({
    document,
    panel: required(document.querySelector<HTMLElement>('#panel')),
    amount: required(document.querySelector<HTMLInputElement>('#amount')),
  }));
  for (const { document, amount } of targets) {
    required(document.querySelector('#open')).addEventListener('click', () => {
      amount.focus({ preventScroll: true });
      amount.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }
  const focusAmount = async () => {
    await userEvent.click(required(browser.querySelector('#open')));
    const button = required(ui.document.querySelector('#open'));
    const rect = button.getBoundingClientRect();
    const x = rect.x + rect.width / 2,
      y = rect.y + rect.height / 2;
    expect(ui.elementFromPoint(x, y)).toBe(button);
    for (const phase of ['down', 'up'] as const)
      ui.input.pointer({ phase, pointerId: 41, pointerType: 'mouse', x, y });
  };
  const states: unknown[] = [];
  let lastPixels: Uint8Array | null = null;
  const capture = async (name: string) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const snapshots = targets.map(({ document, panel, amount }) => {
      const rect = (element: Element) => {
        const r = element.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      return {
        active: document.activeElement?.id,
        scroll: panel.scrollTop,
        scrollHeight: panel.scrollHeight,
        clientHeight: panel.clientHeight,
        clientWidth: panel.clientWidth,
        panel: rect(panel),
        amount: rect(amount),
        value: amount.value,
        valid: amount.validity.valid,
        outer: document.querySelector('#outer')
          ? (() => {
              const outer = required(document.querySelector<HTMLElement>('#outer'));
              return {
                rect: rect(outer),
                x: outer.scrollLeft,
                y: outer.scrollTop,
                scrollWidth: outer.scrollWidth,
                clientWidth: outer.clientWidth,
              };
            })()
          : null,
        sameField: document.querySelector('#amount') === amount,
      };
    });
    states.push({ name, ratio, snapshots });
    await commands.writeFile(`${evidence}/states.json`, JSON.stringify(states, null, 2));
    lastPixels = ui.paint(performance.now()) ?? lastPixels;
    const canvas = document.createElement('canvas');
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    required(canvas.getContext('2d')).putImageData(
      new ImageData(new Uint8ClampedArray(required(lastPixels)), width * ratio, height * ratio),
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
      .screenshot({ path: `${evidence}/${name}-browser.png`, scale: 'css' });
    const expected = required(snapshots[0]),
      actual = required(snapshots[1]);
    expect.soft(actual.active, `${name}: focus owner`).toBe(expected.active);
    expect.soft(actual.valid, `${name}: validity`).toBe(expected.valid);
    expect.soft(actual.scroll, `${name}: scroll CSS pixels`).toBeCloseTo(expected.scroll, 0);
    expect.soft(actual.scrollHeight, `${name}: scrollHeight`).toBe(expected.scrollHeight);
    expect.soft(actual.clientWidth, `${name}: clientWidth`).toBe(expected.clientWidth);
    expect.soft(actual.sameField && expected.sameField, `${name}: retained field`).toBe(true);
    if (actual.outer && expected.outer) {
      expect
        .soft(actual.outer.scrollWidth, `${name}: outer scrollWidth`)
        .toBe(expected.outer.scrollWidth);
      expect
        .soft(actual.outer.clientWidth, `${name}: outer clientWidth`)
        .toBe(expected.outer.clientWidth);
      expect
        .soft(Math.abs(actual.outer.x - expected.outer.x), `${name}: outer scroll x`)
        .toBeLessThanOrEqual(1);
      expect
        .soft(Math.abs(actual.outer.y - expected.outer.y), `${name}: outer scroll y`)
        .toBeLessThanOrEqual(1);
    }
    for (const id of ['panel', 'amount'] as const)
      for (const axis of ['x', 'y', 'width', 'height'] as const)
        expect
          .soft(Math.abs(actual[id][axis] - expected[id][axis]), `${name}:${id}:${axis}`)
          .toBeLessThanOrEqual(1);
  };
  for (const scale of [1, 1.25, 0.75]) {
    for (const { panel, amount } of targets) {
      amount.blur();
      panel.style.transform = `scale(${scale})`;
      panel.scrollTop = 0;
    }
    await capture(`scale-${scale}-before`);
    await focusAmount();
    await capture(`scale-${scale}-revealed`);
  }
  for (const { panel } of targets) expect((panel as HTMLFormElement).reportValidity()).toBe(false);
  await capture('scaled-validation');
  for (const { panel, amount } of targets) {
    amount.value = '3';
    expect((panel as HTMLFormElement).reportValidity()).toBe(true);
  }
  ratio = 3;
  await cdp().send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: ratio,
    mobile: false,
  });
  ui.resize(width * ratio, height * ratio, ratio);
  for (const { document, panel, amount } of targets) {
    amount.blur();
    const outer = document.createElement('section');
    outer.id = 'outer';
    outer.style.cssText =
      'position:absolute;left:24px;top:72px;width:360px;height:220px;overflow:auto;padding:12px;border:6px solid #c6d3e2;background:#1d3852;transform:scale(.9);transform-origin:top left';
    document.body.append(outer);
    outer.append(panel);
    panel.style.position = 'relative';
    panel.style.left = '0';
    panel.style.top = '0';
    panel.style.marginTop = '120px';
    panel.style.marginBottom = '200px';
    panel.style.transform = 'scale(1.25)';
    panel.scrollTop = 0;
  }
  await capture('nested-dpr3-before');
  for (const { amount } of targets) amount.scrollIntoView({ block: 'center', inline: 'nearest' });
  await capture('nested-dpr3-centered');
  for (const { amount } of targets) amount.scrollIntoView({ block: 'start', inline: 'nearest' });
  await capture('nested-dpr3-start');
  for (const { amount } of targets) amount.scrollIntoView({ block: 'end', inline: 'nearest' });
  await capture('nested-dpr3-end');
  // The native bridge must release its borrow before script observes either
  // changed scroller, and repeated alignment must not manufacture an event.
  const events: string[] = [];
  const native = required(targets[1]);
  const outer = required(ui.document.querySelector<HTMLElement>('#outer'));
  const observeScroll = (event: Event) => {
    const element = event.currentTarget as HTMLElement;
    events.push(element.id);
    expect(native.amount.getBoundingClientRect().height).toBeGreaterThan(0);
    expect(native.panel.scrollTop).toBe(162);
  };
  for (const element of [native.panel, outer]) element.addEventListener('scroll', observeScroll);
  native.amount.scrollIntoView({ block: 'center', inline: 'nearest' });
  expect(events).toEqual(['panel', 'outer']);
  native.amount.scrollIntoView({ block: 'center', inline: 'nearest' });
  expect(events).toEqual(['panel', 'outer']);
  for (const element of [native.panel, outer]) element.removeEventListener('scroll', observeScroll);
  native.panel.addEventListener('scroll', () => ui.dispose());
  native.amount.scrollIntoView({ block: 'end', inline: 'nearest' });
  expect(errors).toEqual([]);
});
