import { expect, it } from 'vitest';
import { cdp, commands, page, userEvent } from 'vitest/browser';
import { createBlitzUi } from '../index.js';
import { required, uiEvidenceDirectory } from './fixture.js';
import { profileSettingsHtml as html } from './profile-settings-fixture.js';

const bytes = new Uint8Array(
  await (await fetch(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url))).arrayBuffer(),
);
const wasm = {
  readWasm: async () => bytes,
  instantiate: (imports: object) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
};
it('resets the native form-owned controls, cancellation and dirty defaults through ordinary reset controls', async () => {
  const width = 440,
    height = 480;
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
  await page.viewport(width * 2 + 12, height + 28);
  const stage = document.createElement('section');
  stage.style.cssText = `position:absolute;inset:0;width:${width * 2 + 12}px;height:${height + 28}px;background:#10243a;color:white`;
  const legend = document.createElement('div');
  legend.textContent = 'Chromium (left) / Blitz CPU reference (right): after Restore defaults';
  legend.style.cssText = 'height:28px;font:14px/28px sans-serif';
  const iframe = document.createElement('iframe');
  iframe.style.cssText = `position:absolute;left:0;top:28px;width:${width}px;height:${height}px;border:0`;
  const loaded = new Promise<void>((resolve) => {
    iframe.onload = () => resolve();
  });
  iframe.srcdoc = html;
  stage.append(legend, iframe);
  document.body.append(stage);
  const errors: unknown[] = [];
  const ui = await createBlitzUi({
    wasm,
    html,
    width,
    height,
    font,
    fontFamily: 'Reset Form',
    onError: (error) => errors.push(error),
  });
  try {
    await loaded;
    const browser = required(iframe.contentDocument);
    browser.fonts.add(await new FontFace('Reset Form', font.slice().buffer).load());
    await browser.fonts.ready;
    const documents = [browser, ui.document];
    const ids = [
      'name',
      'count',
      'volume',
      'quality',
      'notes',
      'locked',
      'check',
      'radio-a',
      'radio-b',
      'foreign',
      'associated',
      'unrelated',
    ];
    const field = (document: Document, id: string) =>
      required(document.getElementById(id)) as HTMLInputElement;
    const snapshot = (document: Document) =>
      Object.fromEntries(
        ids.map((id) => [
          id,
          ['check', 'radio-a', 'radio-b'].includes(id)
            ? field(document, id).checked
            : field(document, id).value,
        ]),
      );
    const seed = (document: Document) => {
      for (const id of ['name', 'notes', 'locked', 'foreign', 'associated', 'unrelated'])
        field(document, id).value = 'Edited';
      field(document, 'count').value = '8';
      field(document, 'volume').value = '80';
      field(document, 'quality').value = 'high';
      field(document, 'check').checked = false;
      field(document, 'radio-b').checked = true;
    };
    const events = documents.map((document) => {
      const trace: string[] = [];
      for (const type of ['reset', 'input', 'change'])
        document.addEventListener(type, (event) =>
          trace.push(`${type}:${(event.target as HTMLElement).id}`),
        );
      return trace;
    });
    const click = async (id: string) => {
      const browserBox = field(browser, id).getBoundingClientRect();
      const frameBox = iframe.getBoundingClientRect();
      const x = frameBox.x + browserBox.x + browserBox.width / 2;
      const y = frameBox.y + browserBox.y + browserBox.height / 2;
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
      const box = field(ui.document, id).getBoundingClientRect();
      for (const phase of ['down', 'up'] as const)
        ui.input.pointer({
          phase,
          pointerId: 1,
          pointerType: 'mouse',
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
        });
    };
    documents.forEach(seed);
    await click('restore');
    const afterReset = documents.map(snapshot);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.style.cssText = `position:absolute;left:${width + 12}px;top:28px`;
    const pixels = required(ui.paint(0));
    required(canvas.getContext('2d')).putImageData(
      new ImageData(new Uint8ClampedArray(pixels), width, height),
      0,
      0,
    );
    stage.append(canvas);
    const evidence = uiEvidenceDirectory(required(expect.getState().testPath), 'ui-form-reset');
    await commands.writeFile(
      `${evidence}/result.json`,
      JSON.stringify({ afterReset, events, errors }, null, 2),
    );
    await page.elementLocator(stage).screenshot({ path: `${evidence}/after-reset.png` });
    expect(afterReset[1]).toEqual(afterReset[0]);
    expect(afterReset[0]).toMatchObject({
      name: 'Player',
      count: '4',
      volume: '25',
      quality: 'low',
      notes: 'Default notes',
      locked: 'A-1',
      check: true,
      'radio-a': true,
      'radio-b': false,
      foreign: 'Edited',
      associated: 'Outside',
      unrelated: 'Edited',
    });
    expect(events).toEqual([['reset:profile'], ['reset:profile']]);
    const forms = documents.map((document) =>
      required(document.querySelector<HTMLFormElement>('#profile')),
    );
    documents.forEach(seed);
    documents.forEach((document) => {
      field(document, 'restore').addEventListener('click', (event) => event.preventDefault(), {
        once: true,
      });
    });
    await click('restore');
    expect(documents.map(snapshot)).toEqual([snapshot(browser), snapshot(browser)]);
    expect(events).toEqual([['reset:profile'], ['reset:profile']]);
    forms.forEach((form) => {
      form.addEventListener('reset', (event) => event.preventDefault(), { once: true });
    });
    await click('input-reset');
    expect(documents.map(snapshot)).toEqual([snapshot(browser), snapshot(browser)]);
    expect(events).toEqual([
      ['reset:profile', 'reset:profile'],
      ['reset:profile', 'reset:profile'],
    ]);
    for (const [index, form] of forms.entries()) {
      form.addEventListener(
        'reset',
        () => {
          form.reset();
          field(required(documents[index]), 'name').defaultValue = 'Latest default';
        },
        { once: true },
      );
      form.reset();
    }
    expect(documents.map(snapshot)).toEqual([snapshot(browser), snapshot(browser)]);
    expect(field(ui.document, 'name').value).toBe('Latest default');
    for (const document of documents) {
      field(document, 'name').defaultValue = 'After reset';
      field(document, 'volume').defaultValue = '35';
      field(document, 'check').defaultChecked = false;
      required(document.querySelector<HTMLOptionElement>('option[value=high]')).defaultSelected =
        true;
    }
    expect(documents.map(snapshot)).toEqual([snapshot(browser), snapshot(browser)]);
    expect(snapshot(ui.document)).toMatchObject({
      name: 'After reset',
      volume: '35',
      check: false,
      quality: 'high',
    });
    field(browser, 'input-reset').focus();
    await userEvent.keyboard('{Enter}');
    field(ui.document, 'input-reset').focus();
    ui.input.key({ type: 'keydown', key: 'Enter' });
    ui.input.key({ type: 'keyup', key: 'Enter' });
    expect(documents.map(snapshot)).toEqual([snapshot(browser), snapshot(browser)]);
    expect(events[1]).toEqual(events[0]);
    expect(events[0]).toEqual(Array(4).fill('reset:profile'));
    // A reset while an editor retains focus silently establishes its new value.
    // Later focus retirement must not mistake that default action for user input.
    for (const [index, form] of forms.entries()) {
      const input = field(required(documents[index]), 'name');
      input.value = 'Edited before focus';
      input.focus();
      form.reset();
      input.blur();
    }
    expect(events[1]).toEqual(events[0]);
    expect(events[0]).toEqual(Array(5).fill('reset:profile'));
    await commands.writeFile(
      `${evidence}/final-events.json`,
      JSON.stringify({ values: documents.map(snapshot), events, errors }, null, 2),
    );
    expect(errors).toEqual([]);
  } finally {
    ui.dispose();
    stage.remove();
  }
}, 30_000);
