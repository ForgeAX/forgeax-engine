import { afterEach, expect, it } from 'vitest';
import { cdp, commands, page, userEvent } from 'vitest/browser';
import { createBlitzUi } from '../index.js';
import { controlsWorkflowHtml, mountControlsWorkflow } from './controls-workflow-fixture.js';
import { required, selectAllKeys, uiEvidenceDirectory } from './fixture.js';

afterEach(async () => {
  await cdp().send('Emulation.setScrollbarsHidden', { hidden: false });
});

it('keeps dynamic inventory usable after repeated settings modal requests', async () => {
  const width = 640,
    height = 480;
  const load = async (url: URL) => new Uint8Array(await (await fetch(url)).arrayBuffer());
  const [bytes, font] = await Promise.all([
    load(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url)),
    load(
      new URL(
        '../../../devkit/node_modules/@fontsource-variable/noto-sans-sc/files/noto-sans-sc-latin-wght-normal.woff2',
        import.meta.url,
      ),
    ),
  ]);
  await page.viewport(width, height);
  // Match the portable scroller's zero gutter in headed and headless Chromium.
  await cdp().send('Emulation.setScrollbarsHidden', { hidden: true });
  const iframe = document.createElement('iframe');
  iframe.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px;border:0`;
  const loaded = new Promise<void>((resolve) => {
    iframe.onload = () => resolve();
  });
  iframe.srcdoc = controlsWorkflowHtml;
  document.body.append(iframe);
  await loaded;
  const browser = required(iframe.contentDocument);
  browser.fonts.add(await new FontFace('Inventory Fixture', new Uint8Array(font).buffer).load());
  browser.fonts.add(
    await new FontFace('Noto Sans SC Variable', new Uint8Array(font).buffer).load(),
  );
  await browser.fonts.ready;
  const errors: unknown[] = [];
  const ui = await createBlitzUi({
    wasm: {
      readWasm: async () => bytes,
      instantiate: (imports) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
    },
    html: controlsWorkflowHtml,
    width,
    height,
    font,
    fontFamily: 'Inventory Fixture',
    onError: (error) => errors.push(error),
  });
  const browserFlow = mountControlsWorkflow(browser),
    nativeFlow = mountControlsWorkflow(ui.document);
  const targets = [browserFlow, nativeFlow];
  const evidence = uiEvidenceDirectory(
    required(expect.getState().testPath),
    'ui-controls-workflow',
  );
  const states: unknown[] = [];
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const key = async (key: string) => {
    await userEvent.keyboard(`{${key}}`);
    ui.input.key({ type: 'keydown', key });
    ui.input.key({ type: 'keyup', key });
  };
  const active = (document: Document) => {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    return (
      element?.getAttribute('data-ui-setting') ?? element?.getAttribute('role') ?? element?.id ?? ''
    );
  };
  const capture = async (name: string, validation = false) => {
    // Chromium's native validation animation is unaffected by screenshot CSS animation settings.
    await new Promise((resolve) => setTimeout(resolve, validation ? 600 : 150));
    const snapshots = targets.map((flow) => ({
      active: active(flow.document),
      ids: Array.from(flow.items.children, (row) => row.id),
      values: flow.quantities.map((field) => field.value),
      valid: flow.quantities.map((field) => field.validity.valid),
      scroll: flow.form.scrollTop,
      scrollHeight: flow.form.scrollHeight,
      clientWidth: flow.form.clientWidth,
      clientHeight: flow.form.clientHeight,
      apply: (() => {
        const r = flow.apply.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height];
      })(),
      form: (() => {
        const r = flow.form.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height];
      })(),
      inert: flow.inventoryUi.host.inert,
      modal: !required(flow.shadow.querySelector<HTMLElement>('[role="dialog"]')).hidden,
      submitted: flow.submitted.map((values) => [...values]),
      settings: { ...flow.state },
      quantities: flow.quantities.map((field) => {
        const r = field.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height];
      }),
    }));
    states.push({ name, snapshots, errors });
    if (name === '06-settings-modal') {
      const properties = [
        'font-family',
        'font-size',
        'line-height',
        'display',
        'vertical-align',
        'box-sizing',
        'margin-top',
        'margin-bottom',
        'padding-top',
        'padding-bottom',
        'border-top-width',
        'border-bottom-width',
      ];
      const geometry = targets.map((flow, index) =>
        Array.from(
          flow.shadow.querySelectorAll('.panel,h2,label,input,select,button'),
          (element) => {
            const rect = element.getBoundingClientRect();
            const style =
              index === 0
                ? required(browser.defaultView).getComputedStyle(element)
                : ui.getComputedStyle(element);
            return {
              tag: element.tagName,
              setting: element.getAttribute('data-ui-setting'),
              rect: [rect.x, rect.y, rect.width, rect.height],
              styles: Object.fromEntries(
                properties.map((property) => [property, style.getPropertyValue(property)]),
              ),
            };
          },
        ),
      );
      await commands.writeFile(`${evidence}/geometry.json`, JSON.stringify(geometry, null, 2));
      await cdp().send('DOM.enable');
      await cdp().send('CSS.enable');
      const { nodes } = await cdp().send('DOM.getFlattenedDocument', { depth: -1, pierce: true });
      const fonts = [];
      for (const node of nodes.filter((node) => node.attributes?.includes('settings-title'))) {
        fonts.push({
          nodeName: node.nodeName,
          fonts: await cdp().send('CSS.getPlatformFontsForNode', { nodeId: node.nodeId }),
        });
      }
      await commands.writeFile(`${evidence}/platform-fonts.json`, JSON.stringify(fonts, null, 2));
    }
    await commands.writeFile(`${evidence}/states.json`, JSON.stringify(states, null, 2));
    await page.elementLocator(iframe).screenshot({ path: `${evidence}/${name}.browser.png` });
    const pixels = ui.paint(performance.now());
    if (pixels) {
      required(canvas.getContext('2d')).putImageData(
        new ImageData(new Uint8ClampedArray(pixels), width, height),
        0,
        0,
      );
    }
    // A no-op request retains the previous frame, just as it does in a Host.
    await commands.writeFile(
      `${evidence}/${name}.native.png`,
      required(canvas.toDataURL().split(',')[1]),
      'base64',
    );
    expect.soft(snapshots[1]).toEqual(snapshots[0]);
  };
  try {
    await capture('01-initial');
    for (const flow of targets) flow.add.focus();
    await key('Enter');
    await key('Tab');
    await capture('02-inserted-number');
    for (const flow of targets) expect(flow.form.reportValidity()).toBe(false);
    await capture('03-required-validation', true);
    await userEvent.keyboard('12');
    ui.input.text('12');
    for (const flow of targets) expect(required(flow.quantities[1]).reportValidity()).toBe(false);
    await capture('04-range-validation', true);
    for (const flow of targets) flow.form.scrollTop = 60;
    await capture('05-scroll-with-feedback', true);
    await key('F2');
    await capture('06-settings-modal');
    await key('Tab');
    await key('Home');
    await key('Tab');
    await key('Tab');
    await key('Home');
    await capture('07-settings-controls');
    await key('F2');
    await capture('08-repeated-modal-open');
    for (const flow of targets) expect.soft(active(flow.document)).toBe('antialias');
    for (const flow of targets) flow.row.remove();
    await key('Escape');
    await capture('09-origin-removed-modal-close');
    for (const flow of targets) {
      expect.soft(flow.inventoryUi.host.inert).toBe(false);
      expect.soft(flow.opener.inert).toBe(false);
      expect.soft(active(flow.document)).toBe('settings-open');
    }
    for (const flow of targets) flow.add.focus();
    await key('Enter');
    await key('Tab');
    await userEvent.keyboard(`${selectAllKeys()}4`);
    ui.input.text('4');
    for (const flow of targets) {
      expect(flow.form.reportValidity()).toBe(true);
      flow.apply.focus();
    }
    await key('Enter');
    await capture('10-retained-row-submitted');
    expect(nativeFlow.submitted).toEqual([[3, 4, 1]]);
    for (const flow of targets) {
      flow.settings.close();
      expect.soft(active(flow.document)).toBe('apply');
    }
    expect(errors).toEqual([]);
  } finally {
    for (const flow of targets) {
      flow.settings.dispose();
      flow.inventoryUi.dispose();
    }
    ui.dispose();
    iframe.remove();
  }
});
