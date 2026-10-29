import { mountUi, type UiAsset, type UiInstance } from '@forgeax/engine-ui';
import type {} from '@vitest/browser-playwright';
import { afterEach, expect, it } from 'vitest';
import { cdp, commands, page, userEvent } from 'vitest/browser';
import { createBlitzUi, type UiWasmHost } from '../index.js';
import { checkableHtml, checkableTrace } from './checkable-fixture.js';
import { required, selectAllKeys, uiEvidenceDirectory } from './fixture.js';
import { inputSubmitRasterCase } from './input-submit-fixture.js';

const bytes = new Uint8Array(
  await (await fetch(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url))).arrayBuffer(),
);
const host: UiWasmHost = {
  readWasm: async () => bytes,
  instantiate: (imports) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
};
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});
async function pair(html: string, width = 200, height = 200, font?: Uint8Array) {
  const iframe = document.createElement('iframe');
  iframe.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px;border:0`;
  const loaded = new Promise<void>((resolve) => {
    iframe.onload = () => resolve();
  });
  iframe.srcdoc = html;
  document.body.append(iframe);
  cleanup.push(() => iframe.remove());
  await loaded;
  const native = required(iframe.contentDocument);
  if (font) native.fonts.add(await new FontFace('UI Fixture', font.slice().buffer).load());
  const errors: unknown[] = [];
  const ui = await createBlitzUi({
    wasm: host,
    html,
    width,
    height,
    ...(font ? { font, fontFamily: 'UI Fixture' } : {}),
    onError: (cause) => errors.push(cause),
  });
  cleanup.push(() => ui.dispose());
  return { native, ui, errors, iframe };
}
it('submits mixed forms from readonly controls with the same Enter semantics', async () => {
  const width = 540,
    height = 510;
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
  const { native, ui, errors } = await pair(
    `<!doctype html><style>
      *{box-sizing:border-box}html,body{margin:0;background:#10243a;color:#eef2fa;font:16px/24px "UI Fixture"}
      main{padding:20px}h2{margin:0 0 16px}form{display:grid;grid-template-columns:1fr 1fr;gap:12px 20px}
      label{display:flex;flex-direction:column;gap:4px}input,textarea,select,button{font:inherit;min-width:0}
      input:not([type=checkbox]):not([type=radio]),select{width:100%;height:32px}textarea{width:100%;height:60px}
      .check{flex-direction:row;align-items:center}button{grid-column:1 / 3;height:38px;background:#f7c62d;color:#10243a;border:0;border-radius:4px}
      #status{margin-top:12px}
    </style><main><h2>Order settings</h2><form>
      <label>Order name (read only)<input id="text" value="Order A" readonly></label>
      <label>Quantity (read only)<input id="number" type="number" value="3" readonly></label>
      <label class="check"><input id="checkbox" type="checkbox">Gift wrapping</label>
      <label class="check"><input id="radio" type="radio" name="shipping">Express delivery</label>
      <label>Coverage<input id="range" type="range" value="50"></label>
      <label>Service<select id="select"><option>Standard</option><option>Priority</option></select></label>
      <label>Notes (read only)<textarea id="textarea" readonly>Leave at reception.</textarea></label>
      <label>Reference<input id="reference" value="A-1" required></label>
      <button id="save">Save order</button>
    </form><p id="status">Not saved</p></main>`,
    width,
    height,
    font,
  );
  await page.viewport(width, height);
  const evidence = uiEvidenceDirectory(
    required(expect.getState().testPath),
    'ui-control-semantics',
  );
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const forms = [native, ui.document].map((document) => {
    const submitted: string[] = [];
    required(document.querySelector('form')).addEventListener('submit', (event) => {
      event.preventDefault();
      submitted.push(document.activeElement?.id ?? '');
      required(document.querySelector('#status')).textContent = `Saved ${submitted.length} times`;
    });
    return { document, submitted };
  });
  const capture = async (name: string, validation = false) => {
    // Chromium's native validation animation is unaffected by screenshot CSS animation settings.
    if (validation) {
      // Materialize the popup before its compositor animation interval in headless Chromium.
      await cdp().send('Page.captureScreenshot', { format: 'png' });
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    await page
      .elementLocator(required(native.defaultView?.frameElement))
      .screenshot({ path: `${evidence}/${name}.browser.png` });
    const pixels = ui.paint(performance.now());
    if (pixels)
      required(canvas.getContext('2d')).putImageData(
        new ImageData(new Uint8ClampedArray(pixels), width, height),
        0,
        0,
      );
    await commands.writeFile(
      `${evidence}/${name}.native.png`,
      required(canvas.toDataURL().split(',')[1]),
      'base64',
    );
  };
  const key = async () => {
    await userEvent.keyboard('{Enter}');
    ui.input.key({ type: 'keydown', key: 'Enter' });
    ui.input.key({ type: 'keyup', key: 'Enter' });
  };
  let editRequests = 0;
  const unsubscribe = ui.input.subscribeTextEdit(() => editRequests++);
  cleanup.push(unsubscribe);
  const pointerFocus = [];
  for (const id of ['text', 'number']) {
    const browserField = required(native.getElementById(id));
    const browserRect = browserField.getBoundingClientRect();
    await cdp().send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [
        { x: browserRect.x + browserRect.width / 2, y: browserRect.y + browserRect.height / 2 },
      ],
    });
    await cdp().send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const field = required(ui.document.getElementById(id));
    const rect = field.getBoundingClientRect();
    for (const phase of ['down', 'up'] as const)
      ui.input.pointer({
        phase,
        pointerId: 1,
        pointerType: 'touch',
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
      });
    expect(ui.input.focusedText()).toBeNull();
    ui.input.text('rejected');
    pointerFocus.push({
      id,
      states: forms.map(({ document }) => ({
        active: document.activeElement?.id,
        visible: required(document.getElementById(id)).matches(':focus-visible'),
      })),
    });
  }
  await commands.writeFile(`${evidence}/pointer-focus.json`, JSON.stringify(pointerFocus, null, 2));
  for (const state of pointerFocus) expect.soft(state.states[1]).toEqual(state.states[0]);
  expect(editRequests).toBe(0);
  expect(required(ui.document.querySelector<HTMLInputElement>('#number')).value).toBe('3');
  await capture('01-readonly-touch');
  const geometry = forms.map(({ document }) =>
    Array.from(document.querySelectorAll('form,label,input,textarea,select,button'), (element) => {
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName,
        id: element.id,
        rect: [rect.x, rect.y, rect.width, rect.height],
      };
    }),
  );
  await commands.writeFile(`${evidence}/geometry.json`, JSON.stringify(geometry, null, 2));
  for (const [index, actual] of required(geometry[1]).entries()) {
    const expected = required(required(geometry[0])[index]);
    for (const axis of [0, 1, 2, 3])
      expect
        .soft(
          Math.abs(required(actual.rect[axis]) - required(expected.rect[axis])),
          `${actual.tag}#${actual.id} rectangle axis ${axis}`,
        )
        .toBeLessThanOrEqual(1);
  }
  const states = [];
  for (const id of ['text', 'number', 'textarea', 'checkbox', 'radio', 'range', 'select', 'save']) {
    for (const { document } of forms) required(document.getElementById(id)).focus();
    await key();
    states.push({ id, submitted: forms.map(({ submitted }) => [...submitted]) });
  }
  await capture('02-control-submissions');
  expect.soft(forms[1]?.submitted).toEqual(forms[0]?.submitted);
  expect
    .soft(forms[0]?.submitted)
    .toEqual(['text', 'number', 'checkbox', 'radio', 'range', 'save']);
  for (const eventType of ['keydown', 'click']) {
    for (const { document } of forms) {
      required(document.getElementById('number')).focus();
      required(
        document.getElementById(eventType === 'keydown' ? 'number' : 'save'),
      ).addEventListener(eventType, (event) => event.preventDefault(), { once: true });
    }
    await key();
    expect(forms.map(({ submitted }) => submitted.length)).toEqual([6, 6]);
  }
  for (const { document } of forms) {
    required(document.getElementById('number')).focus();
    required(document.querySelector<HTMLInputElement>('#reference')).value = '';
  }
  await key();
  await capture('03-required-feedback', true);
  expect(forms.map(({ document }) => document.activeElement?.id)).toEqual([
    'reference',
    'reference',
  ]);
  await userEvent.keyboard('A-2');
  ui.input.text('A-2');
  await key();
  await capture('04-recovered-submit', true);
  expect.soft(forms[1]?.submitted).toEqual(forms[0]?.submitted);
  expect(errors).toEqual([]);
  expect(editRequests).toBe(0);
  await commands.writeFile(`${evidence}/enter-probe.json`, JSON.stringify(states, null, 2));
});
it.each([
  ['single text and nonblocking range', '<input readonly value=Order><input type=range>', 1],
  ['range without a submitter', '<input type=range>', 0],
  ['checkbox without a submitter', '<input type=checkbox>', 0],
  ['radio without a submitter', '<input type=radio>', 0],
  ['two readonly blocking fields', '<input readonly><input type=number readonly>', 0],
  [
    'disabled default submitter',
    '<input readonly><button disabled>First</button><button>Second</button>',
    0,
  ],
] as const)('keeps implicit submission rules for %s', async (_name, fields, expected) => {
  const { native, ui, errors } = await pair(`<form>${fields}</form>`);
  const submitted = [0, 0];
  for (const [index, document] of [native, ui.document].entries()) {
    required(document.querySelector('form')).addEventListener('submit', (event) => {
      event.preventDefault();
      submitted[index] = required(submitted[index]) + 1;
    });
    required(document.querySelector<HTMLInputElement>('input')).focus();
  }
  await userEvent.keyboard('{Enter}');
  ui.input.key({ type: 'keydown', key: 'Enter' });
  ui.input.key({ type: 'keyup', key: 'Enter' });
  expect(submitted).toEqual([expected, expected]);
  expect(errors).toEqual([]);
});
it('enters keyboard focus from an unfocused document and honors canceled Tab defaults', async () => {
  const { native, ui, errors } = await pair(
    '<!doctype html><body tabindex="-1"><button id="first">Open controls</button><input id="radius" type="number" value="0.75">',
  );
  for (const document of [native, ui.document]) {
    document.body.addEventListener('keydown', (event) => event.preventDefault(), { once: true });
  }
  native.body.focus();
  const tab = async () => {
    await userEvent.keyboard('{Tab}');
    ui.input.key({ type: 'keydown', key: 'Tab' });
    ui.input.key({ type: 'keyup', key: 'Tab' });
  };
  await tab();
  expect(native.activeElement).toBe(native.body);
  expect(ui.document.activeElement).toBe(ui.document.body);
  await tab();
  expect(native.activeElement?.id).toBe('first');
  expect(ui.document.activeElement?.id).toBe(native.activeElement?.id);
  await tab();
  expect(native.activeElement?.id).toBe('radius');
  expect(ui.document.activeElement?.id).toBe(native.activeElement?.id);
  expect(errors).toEqual([]);
});
it('keeps the current edit when a scripted focus target is not eligible', async () => {
  const { native, ui, errors } = await pair(
    '<input id="current" value="old"><input id="disabled" disabled><input id="hidden" style="display:none"><div id="plain">Text</div>',
  );
  const traces = [native, ui.document].map((document) => {
    const current = required(document.querySelector<HTMLInputElement>('#current'));
    current.focus();
    const events: string[] = [];
    for (const type of ['change', 'blur', 'focusout'])
      current.addEventListener(type, () => events.push(type));
    return { document, current, events };
  });
  await userEvent.keyboard(`${selectAllKeys()}edited`);
  ui.input.text('edited');
  const results = traces.map(({ document, current, events }) => {
    const states: unknown[] = [];
    for (const selector of ['#disabled', '#hidden', '#plain']) {
      required(document.querySelector<HTMLElement>(selector)).focus();
      states.push({
        active: document.activeElement?.id,
        value: current.value,
        events: [...events],
      });
    }
    return states;
  });
  expect(results[1]).toEqual(results[0]);
  expect(ui.input.focusedText()?.value).toBe('edited');
  expect(errors).toEqual([]);
});
it.each([
  ['change', 'none'],
  ['change', 'focus-third'],
  ['change', 'remove-next'],
  ['change', 'disable-next'],
  ['change', 'hide-next'],
  ['change', 'inert-next'],
  ['change', 'remove-current'],
  ['blur', 'focus-third'],
])('commits before blur and respects its %s callback: %s', async (trigger, mutation) => {
  const { native, ui, errors } = await pair(
    '<input id="current" value="old"><input id="next"><button id="third">Third</button>',
  );
  const traces = [native, ui.document].map((document) => {
    const current = required(document.querySelector<HTMLInputElement>('#current'));
    const next = required(document.querySelector<HTMLInputElement>('#next'));
    const third = required(document.querySelector<HTMLButtonElement>('#third'));
    current.focus();
    const events: unknown[] = [];
    for (const node of [current, next, third]) {
      for (const type of ['change', 'blur', 'focusout', 'focus', 'focusin']) {
        node.addEventListener(type, (event) => {
          events.push({
            type,
            target: node.id,
            active: document.activeElement?.id ?? '',
            related: (event as FocusEvent).relatedTarget
              ? ((event as FocusEvent).relatedTarget as Element).id
              : null,
          });
          if (node !== current || type !== trigger) return;
          if (mutation === 'focus-third') third.focus();
          else if (mutation === 'remove-next') next.remove();
          else if (mutation === 'disable-next') next.disabled = true;
          else if (mutation === 'hide-next') next.style.display = 'none';
          else if (mutation === 'inert-next') next.inert = true;
          else if (mutation === 'remove-current') current.remove();
        });
      }
    }
    return () => ({ events, active: document.activeElement?.id ?? '' });
  });
  await userEvent.keyboard(selectAllKeys());
  await cdp().send('Input.insertText', { text: 'edited' });
  ui.input.text('edited');
  await userEvent.keyboard('{Tab}');
  ui.input.key({ type: 'keydown', key: 'Tab' });
  ui.input.key({ type: 'keyup', key: 'Tab' });
  expect(required(traces[1])()).toEqual(required(traces[0])());
  expect(errors).toEqual([]);
});
it('matches constraint messages and canceled interactive validation without author UI', async () => {
  const { native, ui, errors } = await pair(
    '<style>body{background:#123}</style><form><input id="radius" type="number" min="0.1" max="2" step="0.1" required><button>Generate</button></form>',
    320,
    160,
  );
  const fields = [native, ui.document].map((document) =>
    required(document.querySelector<HTMLInputElement>('input')),
  );
  for (const value of ['', '0', '3', '0.42', '0.8']) {
    for (const field of fields) field.value = value;
    expect(fields.map((field) => Boolean(field.validationMessage))).toEqual([
      value !== '0.8',
      value !== '0.8',
    ]);
  }
  for (const field of fields) {
    field.value = '0.42';
    field.focus();
    field.addEventListener('invalid', (event) => event.preventDefault(), { once: true });
  }
  const before = required(ui.paint(0));
  expect(fields.map((field) => field.reportValidity())).toEqual([false, false]);
  expect(ui.paint(0)).toBeNull();
  expect(fields.map((field) => field.reportValidity())).toEqual([false, false]);
  expect(required(ui.paint(0))).not.toEqual(before);
  const input = required(fields[1]);
  ui.input.text('0.8');
  expect(input.validationMessage).toBe('');
  expect(input.reportValidity()).toBe(true);
  input.value = '0.42';
  input.disabled = true;
  expect(input.validationMessage).toBe('');
  expect(input.reportValidity()).toBe(true);
  expect(errors).toEqual([]);
});
it('matches Chromium cancellation and restart of animations below display:none', async () => {
  const { native, ui, errors } = await pair(
    '<style>body{margin:0}section{position:absolute;inset:0}#spinner{position:absolute;left:30px;top:30px;width:30px;height:10px;background:red;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style><canvas></canvas><section><div id="spinner"></div></section>',
    100,
    100,
  );
  const nativeLoading = required(native.querySelector('section'));
  const nativeSpinner = required(native.querySelector('#spinner'));
  const loading = required(ui.document.querySelector('section'));
  const spinner = required(ui.document.querySelector('#spinner'));
  const nativeStyle = () => required(native.defaultView).getComputedStyle(nativeSpinner).transform;
  const matrix = (value: string) => Array.from(new DOMMatrixReadOnly(value).toFloat64Array());
  const compare = () => {
    const expected = matrix(nativeStyle());
    const actual = matrix(ui.getComputedStyle(spinner).getPropertyValue('transform'));
    for (const [index, value] of expected.entries()) expect(actual[index]).toBeCloseTo(value, 5);
  };
  const original = required(nativeSpinner.getAnimations()[0]);
  original.pause();
  original.currentTime = 0;
  required(ui.paint(0));
  original.currentTime = 250;
  required(ui.paint(250));
  compare();
  nativeLoading.style.display = loading.style.display = 'none';
  nativeStyle();
  required(ui.paint(300));
  expect(nativeSpinner.getAnimations()).toHaveLength(0);
  expect(ui.paint(1400) === null).toBe(true);
  nativeLoading.style.display = loading.style.display = 'block';
  const restarted = required(nativeSpinner.getAnimations()[0]);
  expect(restarted).not.toBe(original);
  expect(restarted.currentTime).toBe(0);
  restarted.pause();
  required(ui.paint(1500));
  compare();
  restarted.currentTime = 250;
  required(ui.paint(1750));
  compare();
  expect(ui.document.querySelector('#spinner')).toBe(spinner);
  expect(errors).toEqual([]);
});
it('matches checked properties, preactivation, canceled clicks and radio group scope', async () => {
  const { native, ui, errors } = await pair(checkableHtml);
  expect(checkableTrace(ui.document)).toEqual(checkableTrace(native));
  expect(errors).toEqual([]);
});
it('matches real checkbox and radio pointer, label and keyboard activation', async () => {
  const html =
    '<label for="toggle" style="display:inline-block;width:60px;height:24px">Toggle</label><input id="toggle" type="checkbox"><input id="left" type="radio" name="choice" checked><input id="right" type="radio" name="choice">';
  const native = document.createElement('section');
  native.style.cssText = 'position:absolute;left:0;top:0;background:white;z-index:100';
  native.innerHTML = html;
  document.body.append(native);
  cleanup.push(() => native.remove());
  const ui = await createBlitzUi({
    wasm: host,
    html,
    width: 200,
    height: 200,
    onError: (cause) => {
      throw cause;
    },
  });
  cleanup.push(() => ui.dispose());
  async function run(
    root: ParentNode,
    tap: (node: Element) => Promise<void>,
    key: (value: string) => Promise<void>,
  ) {
    const check = required(root.querySelector<HTMLInputElement>('#toggle'));
    const left = required(root.querySelector<HTMLInputElement>('#left'));
    const right = required(root.querySelector<HTMLInputElement>('#right'));
    const trace: unknown[] = [];
    for (const field of [check, left, right])
      for (const kind of ['click', 'input', 'change'])
        field.addEventListener(kind, () => trace.push([field.id, kind, field.checked]));
    await tap(check);
    await key(' ');
    await tap(required(root.querySelector('label')));
    check.addEventListener('click', (event) => event.preventDefault(), { once: true });
    await tap(check);
    await tap(right);
    await key('ArrowLeft');
    await tap(left);
    return { trace, state: [check.checked, left.checked, right.checked] };
  }
  const expected = await run(
    native,
    (node) => userEvent.click(node),
    (key) => userEvent.keyboard(key === ' ' ? ' ' : `{${key}}`),
  );
  const actual = await run(
    ui.document,
    async (node) => {
      const rect = node.getBoundingClientRect();
      for (const phase of ['down', 'up'] as const)
        ui.input.pointer({
          phase,
          pointerId: 1,
          pointerType: 'touch',
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
        });
    },
    async (key) => {
      ui.input.key({ type: 'keydown', key });
      ui.input.key({ type: 'keyup', key });
    },
  );
  expect(actual).toEqual(expected);
});
function numberForm(document: Document) {
  const form = required(document.querySelector('form'));
  const button = required(form.querySelector<HTMLElement>('button,input[type=submit]'));
  const field = document.createElement('input');
  field.type = 'number';
  field.name = 'radius';
  field.min = '0.1';
  field.max = '2';
  field.step = '0.05';
  field.required = true;
  const label = document.createElement('label');
  label.append(field);
  form.insertBefore(label, button);
  const submitted: number[] = [];
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitted.push(field.valueAsNumber);
  });
  const values = ['', 'garbage', '0.05', '2.05', '0.12', '0.35', '1e0', '+1', '1.', '1e999', '.15'];
  return values.map((value) => {
    field.value = value;
    const validity = field.validity;
    const result = {
      value: field.value,
      number: field.valueAsNumber,
      valid: validity.valid,
      required: validity.valueMissing,
      under: validity.rangeUnderflow,
      over: validity.rangeOverflow,
      step: validity.stepMismatch,
      checked: form.checkValidity(),
    };
    button.click();
    return { ...result, submitted: [...submitted] };
  });
}
it('runs identical dynamic number form operations against the browser', async () => {
  const { native, ui, errors } = await pair(
    '<!doctype html><form><button>Generate</button></form>',
  );
  expect(numberForm(ui.document)).toEqual(numberForm(native));
  expect(errors).toEqual([]);
});
it('submits the same dynamic number form through an input submit control', async () => {
  const { native, ui, errors } = await pair(
    '<!doctype html><form><input type=submit value=Generate></form>',
  );
  expect(numberForm(ui.document)).toEqual(numberForm(native));
  expect(errors).toEqual([]);
});
it('updates input-button labels and preserves keyboard submission and cancellation', async () => {
  await page.viewport(360, 210);
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
  const { native, ui, errors, iframe } = await pair(inputSubmitRasterCase.html, 360, 210, font);
  const forms = [native, ui.document].map((document) => {
    const form = required(document.querySelector('form'));
    const submit = required(document.querySelector<HTMLInputElement>('#submit'));
    const action = required(document.querySelector<HTMLInputElement>('#action'));
    const radius = required(document.querySelector<HTMLInputElement>('#radius'));
    const trace: string[] = [];
    form.addEventListener('click', (event) =>
      trace.push(`click:${(event.target as HTMLElement).id}`),
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      trace.push(`submit:${event.submitter?.id}`);
    });
    return { form, submit, action, radius, trace };
  });
  const evidence = uiEvidenceDirectory(required(expect.getState().testPath), 'ui-input-submit');
  const capture = async (name: string) => {
    const pixels = required(ui.paint(performance.now()));
    const canvas = document.createElement('canvas');
    canvas.width = 360;
    canvas.height = 210;
    required(canvas.getContext('2d')).putImageData(
      new ImageData(new Uint8ClampedArray(pixels), 360, 210),
      0,
      0,
    );
    await commands.writeFile(
      `${evidence}/${name}.native.png`,
      required(canvas.toDataURL().split(',')[1]),
      'base64',
    );
    await page.elementLocator(iframe).screenshot({ path: `${evidence}/${name}.browser.png` });
    return pixels;
  };
  const initial = await capture('01-static-label');
  for (const current of forms) {
    expect(current.submit.value).toBe('Generate');
    current.submit.value = 'Apply';
    expect(current.submit.getAttribute('value')).toBe('Apply');
    expect(current.submit.defaultValue).toBe('Apply');
  }
  const property = required(ui.paint(performance.now()));
  for (const current of forms) {
    current.submit.setAttribute('value', 'Retry');
    expect(current.submit.value).toBe('Retry');
  }
  const updated = await capture('02-updated-label');
  const rect = required(forms[1]).submit.getBoundingClientRect();
  const changes = (a: Uint8Array, b: Uint8Array) => {
    let changed = 0;
    for (let y = Math.ceil(rect.top + 4); y < rect.bottom - 4; y++)
      for (let x = Math.ceil(rect.left + 6); x < rect.right - 6; x++) {
        const offset = (y * 360 + x) * 4;
        if (a[offset] !== b[offset]) changed++;
      }
    return changed;
  };
  expect(changes(initial, property)).toBeGreaterThan(20);
  expect(changes(property, updated)).toBeGreaterThan(20);
  let editRequests = 0;
  cleanup.push(ui.input.subscribeTextEdit(() => editRequests++));
  const key = async (value: string) => {
    await userEvent.keyboard(value === ' ' ? ' ' : `{${value}}`);
    ui.input.key({ type: 'keydown', key: value });
    ui.input.key({ type: 'keyup', key: value });
  };
  for (const id of ['submit', 'action'] as const) {
    for (const current of forms) current[id].focus();
    expect(ui.input.focusedText()).toBeNull();
    await key('Enter');
    await key(' ');
  }
  for (const current of forms) {
    current.submit.focus();
    current.submit.addEventListener('keydown', (event) => event.preventDefault(), { once: true });
  }
  await key('Enter');
  for (const current of forms)
    current.submit.addEventListener('click', (event) => event.preventDefault(), { once: true });
  await key('Enter');
  for (const current of forms) current.radius.focus();
  await key('Enter');
  for (const [index, current] of forms.entries()) {
    const buttonRect = current.submit.getBoundingClientRect();
    const x = buttonRect.x + buttonRect.width / 2;
    const y = buttonRect.y + buttonRect.height / 2;
    if (index === 0) {
      for (const type of ['mousePressed', 'mouseReleased'] as const)
        await cdp().send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    } else {
      for (const phase of ['down', 'up'] as const)
        ui.input.pointer({ phase, pointerId: 29, pointerType: 'mouse', x, y });
    }
  }
  for (const current of forms) {
    current.submit.disabled = true;
    current.submit.click();
  }
  await key('Enter');
  const expected = [
    'click:submit',
    'submit:submit',
    'click:submit',
    'submit:submit',
    'click:action',
    'click:action',
    'click:submit',
    'click:submit',
    'submit:submit',
    'click:submit',
    'submit:submit',
  ];
  expect(forms.map((current) => current.trace)).toEqual([expected, expected]);
  expect(editRequests).toBe(0);
  expect(errors).toEqual([]);
  await commands.writeFile(
    `${evidence}/result.json`,
    JSON.stringify(
      {
        traces: forms.map((current) => current.trace),
        labelChangedPixels: [changes(initial, property), changes(property, updated)],
        editRequests,
        errors,
      },
      null,
      2,
    ),
  );
});
it('matches explicit button dimensions including UA padding and borders', async () => {
  const { native, ui } = await pair(
    '<!doctype html><button style="width:80px;height:30px">Save</button>',
  );
  const expected = required(native.querySelector('button')).getBoundingClientRect();
  const actual = required(ui.document.querySelector('button')).getBoundingClientRect();
  expect([actual.width, actual.height]).toEqual([expected.width, expected.height]);
});
it('inherits host styles and resolves control hits through an ordinary mounted ShadowRoot', async () => {
  const { native, ui } = await pair('<!doctype html><style>body{margin:0}</style>');
  const asset = {
    guid: 'shadow-input',
    html: '<span>Title</span><button>Go</button>',
    css: ':host{display:block;color:white;background:#102334;font:20px sans-serif}button{pointer-events:auto;width:80px;height:30px}',
  };
  const roots = [native, ui.document].map((document) => {
    const result = mountUi(asset, { root: document.body, layer: 1 });
    if (!result.ok) throw result.error;
    cleanup.push(() => result.value.dispose());
    return required(result.value.host.shadowRoot);
  });
  for (const color of ['white', 'rgb(20, 210, 80)']) {
    roots.forEach((root) => {
      (root.host as HTMLElement).style.color = color;
    });
    const expected = required(native.defaultView).getComputedStyle(
      required(required(roots[0]).querySelector('span')),
    ).color;
    expect(
      ui
        .getComputedStyle(required(required(roots[1]).querySelector('span')))
        .getPropertyValue('color'),
    ).toBe(expected);
  }
  for (const edge of [0.1, 0.5, 0.9]) {
    const results = roots.map((root, index) => {
      const button = required(root.querySelector('button'));
      const rect = button.getBoundingClientRect();
      const x = rect.x + rect.width * edge,
        y = rect.y + rect.height * 0.5;
      return (index === 0 ? root.elementFromPoint(x, y) : ui.elementFromPoint(x, y)) === button;
    });
    expect(results).toEqual([true, true]);
  }
});
it('matches Grid resize and class/style changes without replacing node identities', async () => {
  const { native, ui } = await pair(
    '<!doctype html><style>body{margin:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;height:200px}section{background:red}aside{background:blue}body.wide{grid-template-columns:3fr 1fr}</style><section></section><aside></aside>',
  );
  const rect = (node: Element) => {
    const { x, y, width, height } = node.getBoundingClientRect();
    return [x, y, width, height];
  };
  const aside = required(ui.document.querySelector('aside'));
  for (const wide of [false, true, false]) {
    native.body.classList.toggle('wide', wide);
    ui.document.body.classList.toggle('wide', wide);
    const expected = rect(required(native.querySelector('aside')));
    const actual = rect(aside);
    actual.forEach((value, i) => {
      expect(Math.abs(value - required(expected[i]))).toBeLessThanOrEqual(1 / 64);
    });
    expect(ui.document.querySelector('aside')).toBe(aside);
  }
});
it('matches Grid spans and dynamic form children through synchronous hit and submit defaults', async () => {
  const evidence = uiEvidenceDirectory(required(expect.getState().testPath), 'ui-grid-form');
  const fontUrl = new URL(
    '../../../devkit/node_modules/@fontsource-variable/noto-sans-sc/files/noto-sans-sc-latin-wght-normal.woff2',
    import.meta.url,
  );
  const font = new Uint8Array(await (await fetch(fontUrl)).arrayBuffer());
  const width = 360,
    height = 240;
  // Same two-column Grid / nested label Flex semantics as ordinary authored forms.
  // Explicit line/control sizes keep this a layout test, independent of UA normal line-height.
  const { native, ui, errors, iframe } = await pair(
    `<!doctype html><style>
      html,body{margin:0;width:100%;height:100%;background:#10243a;color:white;font:14px/20px "UI Fixture"}
      body{box-sizing:border-box;padding:12px}
      form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:44px;gap:8px}
      label{display:flex;align-items:center;justify-content:space-between;min-width:0;padding:6px;box-sizing:border-box;background:#203e59}
      input{width:56px;height:28px;box-sizing:border-box;padding:2px;border:1px solid #678;background:#152637;color:white;font:inherit}
      button{grid-column:1 / -1;padding:0;border:0;border-radius:5px;background:#ffdf76;color:#142230;font:inherit}
    </style><form><label id="height-label">Height<input id="height" name="height" type="number" min="1" max="4" step="0.05" value="2.4" required></label><label id="radius-label">Radius<input id="radius" name="radius" type="number" min="0.4" max="1.3" step="0.05" value="0.75" required></label><button id="generate">Generate vase</button></form>`,
    width,
    height,
    font,
  );
  const instances = [native, ui.document].map((document, index) => {
    const form = required(document.querySelector('form'));
    const button = required(document.querySelector('button'));
    const label = document.createElement('label');
    label.id = 'sides-label';
    label.textContent = 'Sides';
    const input = document.createElement('input');
    input.id = input.name = 'sides';
    input.type = 'number';
    input.min = '8';
    input.max = '64';
    input.step = '1';
    input.required = true;
    input.value = '8.5';
    label.append(input);
    const trace: unknown[] = [];
    const hit = (x: number, y: number) =>
      index === 0 ? document.elementFromPoint(x, y) : ui.elementFromPoint(x, y);
    const centerHit = (node: Element) => {
      const rect = node.getBoundingClientRect();
      return hit(rect.x + rect.width / 2, rect.y + rect.height / 2);
    };
    form.addEventListener(
      'invalid',
      (event) => {
        trace.push(['invalid', (event.target as HTMLInputElement).name]);
      },
      { capture: true },
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      trace.push([
        'submit',
        Array.from(form.querySelectorAll('input')).map((field) => field.valueAsNumber),
      ]);
    });
    const originalButton = button.getBoundingClientRect();
    const originalButtonHit = () =>
      hit(
        originalButton.x + originalButton.width / 2,
        originalButton.y + originalButton.height / 2,
      );
    return { document, form, button, label, input, trace, centerHit, originalButtonHit };
  });
  const rectangles = ({ form }: (typeof instances)[number]) =>
    Array.from(form.querySelectorAll('label,input,button')).map((node) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { id: node.id, rect: [x, y, width, height] };
    });
  const compare = () => {
    const expected = rectangles(required(instances[0]));
    const actual = rectangles(required(instances[1]));
    expect(actual.map(({ id }) => id)).toEqual(expected.map(({ id }) => id));
    actual.forEach(({ id, rect }, i) => {
      rect.forEach((value, j) => {
        expect(
          Math.abs(value - required(required(expected[i]).rect[j])),
          `${id} ${['x', 'y', 'width', 'height'][j]}: Blitz ${rect}; Chromium ${required(expected[i]).rect}`,
        ).toBeLessThanOrEqual(1 / 64);
      });
    });
    for (const instance of instances) {
      expect(instance.centerHit(instance.button)).toBe(instance.button);
      if (instance.label.isConnected) {
        expect(instance.document.querySelector('#sides-label')).toBe(instance.label);
        expect(instance.document.querySelector('#sides')).toBe(instance.input);
        expect(instance.centerHit(instance.input)).toBe(instance.input);
      }
    }
  };
  const tap = async (part: 'label' | 'button') => {
    await userEvent.click(required(instances[0])[part]);
    const rect = required(instances[1])[part].getBoundingClientRect();
    for (const phase of ['down', 'up'] as const)
      ui.input.pointer({
        phase,
        pointerId: 1,
        pointerType: 'mouse',
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
      });
  };
  const stage = document.createElement('section');
  stage.style.cssText = `position:absolute;left:0;top:0;width:${width * 2 + 12}px;height:${height + 28}px;background:#10243a;color:white;font:13px sans-serif`;
  const legend = document.createElement('div');
  legend.style.cssText = 'height:28px;line-height:28px;padding-left:8px';
  legend.textContent = 'Chromium DOM (left) · Blitz WASM (right) · Grid form spans';
  iframe.style.top = '28px';
  iframe.style.zIndex = '1';
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.cssText = `position:absolute;left:${width + 12}px;top:28px`;
  // Reparenting a loaded iframe retires its document. Keep it over the left
  // half of the captured stage without replacing the browser reference realm.
  stage.append(legend, canvas);
  document.body.append(stage);
  cleanup.push(() => stage.remove());
  await page.viewport(width * 2 + 12, height + 28);
  const capture = async (name: string) => {
    const rgba = required(ui.paint(performance.now()));
    required(canvas.getContext('2d')).putImageData(
      new ImageData(new Uint8ClampedArray(rgba), width, height),
      0,
      0,
    );
    await commands.writeFile(
      `${evidence}/${name}.json`,
      JSON.stringify({
        name,
        browser: navigator.userAgent,
        width,
        height,
        ratio: devicePixelRatio,
        tolerance: 1 / 64,
        targets: instances.map((instance) => ({
          rectangles: rectangles(instance),
          trace: instance.trace,
          focus: instance.document.activeElement?.id,
        })),
      }),
    );
    await page.elementLocator(stage).screenshot({ path: `${evidence}/${name}.png` });
  };
  compare();
  for (const { form, label } of instances) form.append(label);
  compare(); // Appended child auto-places after the full-width submit row, before any paint.
  for (const { label, button } of instances)
    expect(label.getBoundingClientRect().top).toBe(button.getBoundingClientRect().bottom + 8);
  for (const { form, label, button } of instances) {
    form.insertBefore(label, button);
    label.style.gridColumn = '1 / -1';
  }
  compare();
  for (const { form, label, originalButtonHit } of instances) {
    expect(label.getBoundingClientRect().width).toBe(form.getBoundingClientRect().width);
    expect(originalButtonHit()).toBe(label); // A stale hit index would still activate Generate here.
  }
  await capture('01-inserted-full-span');
  await tap('label');
  for (const { document, input } of instances) expect(document.activeElement).toBe(input);
  for (const { button, label, input, centerHit, trace } of instances) {
    button.addEventListener(
      'click',
      (event) => {
        label.style.gridColumn = 'auto';
        expect(centerHit(input)).toBe(input); // Listener mutation resolves layout and hit synchronously.
        trace.push(['canceled', label.getBoundingClientRect().width, input.validity.stepMismatch]);
        event.preventDefault();
      },
      { once: true },
    );
  }
  await tap('button');
  compare();
  expect(required(instances[1]).trace).toEqual(required(instances[0]).trace);
  for (const { trace } of instances) expect(trace).toEqual([['canceled', 164, true]]);
  await tap('button');
  for (const { document, input, trace } of instances) {
    expect(document.activeElement).toBe(input);
    expect(trace).toEqual([
      ['canceled', 164, true],
      ['invalid', 'sides'],
    ]);
  }
  for (const { form, button, label, input, centerHit, trace } of instances) {
    button.addEventListener(
      'click',
      () => {
        label.remove();
        input.value = '32';
        label.style.gridColumn = 'span 2';
        form.insertBefore(label, button);
        expect(centerHit(input)).toBe(input);
        trace.push(['accepted', label.getBoundingClientRect().width, input.validity.valid]);
      },
      { once: true },
    );
  }
  await tap('button');
  compare();
  for (const { trace } of instances)
    expect(trace).toEqual([
      ['canceled', 164, true],
      ['invalid', 'sides'],
      ['accepted', 336, true],
      ['submit', [2.4, 0.75, 32]],
    ]);
  await capture('02-callback-span-valid-submit');
  for (const { label } of instances) label.remove();
  compare();
  for (const { button, originalButtonHit } of instances) expect(originalButtonHit()).toBe(button);
  for (const { form, label, button, input } of instances) {
    label.style.gridColumn = 'auto';
    form.insertBefore(label, button);
    expect(input.valueAsNumber).toBe(32);
  }
  compare();
  await capture('03-restored-auto-placement');
  expect(errors).toEqual([]);
});
function eventTrace(document: Document) {
  const main = required(document.querySelector('main'));
  const button = required(main.querySelector('button'));
  const trace: unknown[] = [];
  const event = new Event('work', { bubbles: true, cancelable: true });
  main.addEventListener(
    'work',
    () => {
      trace.push('capture');
      button.remove();
    },
    { capture: true },
  );
  button.addEventListener('work', (current) => {
    trace.push([
      current === event,
      current.target === button,
      current.composedPath().includes(main),
    ]);
    button.textContent = 'changed';
    trace.push(button.textContent);
    current.preventDefault();
  });
  main.addEventListener('work', () => trace.push('bubble'));
  trace.push(
    button.dispatchEvent(event),
    event.defaultPrevented,
    event.currentTarget === null,
    event.composedPath().length,
  );
  return trace;
}
it('matches synchronous event identity, path snapshots and cancellation', async () => {
  const { native, ui, errors } = await pair('<!doctype html><main><button>Go</button></main>');
  expect(eventTrace(ui.document)).toEqual(eventTrace(native));
  expect(errors).toEqual([]);
});
function shadowTrace(document: Document, composed: boolean, bubbles: boolean) {
  const host = document.createElement('section');
  document.body.append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML =
    '<style>:host{display:block;width:150px}span{display:block;width:20px;height:10px}:host(.wide) span{width:40px}</style><span></span>';
  const child = required(shadow.querySelector('span'));
  const trace: unknown[] = [];
  for (const [name, node] of [
    ['body', document.body],
    ['host', host],
    ['shadow', shadow],
    ['child', child],
  ] as const) {
    for (const capture of [true, false])
      node.addEventListener(
        'work',
        (event) => {
          trace.push([
            name,
            capture,
            event.eventPhase,
            event.target === child ? 'child' : event.target === host ? 'host' : 'other',
            event.composedPath().includes(shadow),
            event.composedPath().includes(document.body),
          ]);
          if (name === 'child' && !capture) host.remove();
        },
        { capture },
      );
  }
  const before = child.getBoundingClientRect().width;
  host.classList.add('wide');
  trace.push([
    before,
    child.getBoundingClientRect().width,
    child.getRootNode() === shadow,
    child.getRootNode({ composed: true }) === document,
  ]);
  const event = new Event('work', { composed, bubbles });
  child.dispatchEvent(event);
  trace.push([
    event.target === null ? 'null' : event.target === host ? 'host' : 'child',
    event.composedPath().length,
    child.isConnected,
  ]);
  return trace;
}
it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])('matches shadow boundary event phases and frozen retargeting (%s, %s)', async (composed, bubbles) => {
  const { native, ui, errors } = await pair(
    '<!doctype html><style>body{margin:0}span{width:90px!important}</style>',
  );
  expect(shadowTrace(ui.document, composed, bubbles)).toEqual(
    shadowTrace(native, composed, bubbles),
  );
  expect(errors).toEqual([]);
});

function cloneTemplate(document: Document) {
  const template = document.createElement('template');
  template.innerHTML =
    '<label data-field="radius"><span>Radius</span><input type="number" value="0.5"></label>';
  document.body.append(template);
  const source = required(template.content.querySelector('input'));
  source.value = '0.75';
  const clone = template.content.cloneNode(true) as DocumentFragment;
  const field = required(clone.querySelector('input'));
  document.body.append(clone);
  const label = required(document.body.querySelector('label'));
  const result = [
    template.childNodes.length,
    template.content.childNodes.length,
    document.querySelectorAll('input').length,
    clone.childNodes.length,
    field.value,
    field.getAttribute('value'),
    field !== source,
    label.dataset.field,
    label.classList.replace('absent', 'present'),
  ];
  label.classList.add('field', 'compact');
  label.classList.replace('compact', 'wide');
  return [...result, label.classList.value, label.classList.length, 'field' in label.dataset];
}
it('matches inert template content, deep cloning, insertion and live input values', async () => {
  const { native, ui, errors } = await pair('<!doctype html>');
  expect(cloneTemplate(ui.document)).toEqual(cloneTemplate(native));
  expect(errors).toEqual([]);
});

function focusTrace(document: Document) {
  const host = document.createElement('section');
  document.body.append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<label for="value">Value</label><input id="value"><button>Reload</button>';
  const input = required(shadow.querySelector('input'));
  const button = required(shadow.querySelector('button'));
  const trace: unknown[] = [];
  for (const [name, node] of [
    ['body', document.body],
    ['shadow', shadow],
    ['input', input],
    ['button', button],
  ] as const) {
    for (const type of ['blur', 'focusout', 'focus', 'focusin'])
      node.addEventListener(type, (event) => {
        const related = (event as FocusEvent).relatedTarget;
        trace.push([
          name,
          type,
          event.target === input ? 'input' : event.target === button ? 'button' : 'host',
          related === input
            ? 'input'
            : related === button
              ? 'button'
              : related === host
                ? 'host'
                : null,
        ]);
      });
  }
  input.focus();
  trace.push([document.activeElement === host, shadow.activeElement === input]);
  button.focus();
  button.blur();
  return trace;
}
it('matches focus transitions and retargeting across the mounted shadow boundary', async () => {
  const { native, ui, errors } = await pair('<!doctype html>');
  expect(focusTrace(ui.document)).toEqual(focusTrace(native));
  expect(errors).toEqual([]);
});

it('matches scroll geometry and descendant hit positions after an ordinary scrollTop write', async () => {
  const { native, ui } = await pair(
    '<!doctype html><style>body{margin:0}section{width:100px;height:80px;overflow:auto}div{height:120px}button{display:block;width:80px;height:30px}</style><section><div></div><button>Last</button><div></div></section>',
  );
  const results = [native, ui.document].map((document) => {
    const section = required(document.querySelector('section'));
    section.scrollTop = 100;
    const button = required(section.querySelector('button'));
    const rect = button.getBoundingClientRect();
    return [section.scrollTop, section.scrollHeight, section.clientHeight, rect.y];
  });
  expect(results[1]).toEqual(results[0]);
  expect(ui.elementFromPoint(20, 30)).toBe(ui.document.querySelector('button'));
  expect(ui.elementFromPoint(20, 100)).not.toBe(ui.document.querySelector('button'));
});

it('executes the shared authored guide controller and vase controls in both documents', async () => {
  const guide = new URL('../../../../templates/game-3d/assets/guide.ui.html', import.meta.url);
  const stylesheet = new URL('../../../../templates/game-3d/assets/guide.ui.css', import.meta.url);
  const behavior = new URL(
    '../../../../templates/game-3d/assets/ui/guide-controller.ts',
    import.meta.url,
  );
  // Fetching .html/.css through Vite returns injected HTML / a CSS HMR module.
  // Import raw author bytes so this differential test exercises the real UiAsset.
  const authored = async (url: URL): Promise<string> => {
    url.search = '?raw';
    const module = (await import(/* @vite-ignore */ url.href)) as { default: string };
    return module.default;
  };
  const [html, css, localization, module] = await Promise.all([
    authored(guide),
    authored(stylesheet),
    fetch(new URL('../../../../templates/game-3d/assets/guide.ui.i18n.json', import.meta.url)).then(
      (response) => response.json(),
    ),
    import(/* @vite-ignore */ behavior.href) as Promise<{
      createGuideUi(
        asset: UiAsset,
        host: {
          uiRoot: HTMLElement;
          port: MessagePort;
          controlMode: { read(): 'touch'; subscribe(listener: () => void): () => void };
        },
      ): Promise<UiInstance>;
    }>,
  ]);
  const { native, ui, errors } = await pair(
    '<!doctype html><style>html,body{margin:0;width:100%;height:100%}</style>',
    820,
    620,
  );
  const results: unknown[] = [];
  for (const document of [native, ui.document]) {
    const channel = new MessageChannel();
    cleanup.push(() => {
      channel.port1.close();
      channel.port2.close();
    });
    const messages: unknown[] = [];
    const playerMessages: Record<string, unknown>[] = [];
    channel.port2.addEventListener('message', (event) => {
      if (event.data.channel === 'game-3d/runtime-vase') messages.push(event.data);
      if (event.data.channel === 'game-3d/player-controls') playerMessages.push(event.data);
    });
    channel.port2.start();
    const mounted = await module.createGuideUi(
      { guid: 'game-3d-guide', html, css, localization },
      {
        uiRoot: document.body,
        port: channel.port1,
        controlMode: { read: () => 'touch', subscribe: () => () => {} },
      },
    );
    cleanup.push(() => mounted.dispose());
    const root = required(mounted.host.shadowRoot);
    expect(required(root.querySelector('[data-ui-slot="lock"]')).textContent).toContain(
      'Left stick to move · right pad to look',
    );
    required(root.querySelector<HTMLButtonElement>('[data-ui-action="language-fr"]')).click();
    await expect.poll(() => mounted.host.lang).toBe('fr');
    expect(required(root.querySelector('[data-ui-part="guide-title"]')).textContent).toBe(
      'Prototype 3C',
    );
    required(root.querySelector<HTMLButtonElement>('[data-ui-action="language-en"]')).click();
    await expect.poll(() => mounted.host.lang).toBe('en');
    await expect.poll(() => messages.length).toBe(1);
    const part = (name: string) =>
      required(root.querySelector<HTMLElement>(`[data-ui-part="${name}"]`));
    const move = part('move-stick'),
      look = part('look-pad'),
      run = part('run'),
      jump = part('jump');
    const flush = () =>
      new Promise<void>((resolve) => {
        const receive = (event: MessageEvent) => {
          if (event.data.channel !== 'test/barrier') return;
          channel.port2.removeEventListener('message', receive);
          resolve();
        };
        channel.port2.addEventListener('message', receive);
        channel.port1.postMessage({ channel: 'test/barrier' });
      });
    const point = (
      node: HTMLElement,
      id: number,
      phase: 'down' | 'move' | 'up' | 'cancel',
      dx = 0,
      dy = 0,
    ) => {
      const rect = node.getBoundingClientRect();
      const x = rect.left + rect.width / 2 + dx,
        y = rect.top + rect.height / 2 + dy;
      if (document === ui.document) {
        ui.input.pointer({ phase, pointerId: id, pointerType: 'touch', x, y });
      } else {
        node.dispatchEvent(
          new PointerEvent(`pointer${phase}`, {
            bubbles: true,
            composed: true,
            cancelable: true,
            pointerId: id,
            pointerType: 'touch',
            button: 0,
            clientX: x,
            clientY: y,
          }),
        );
        // Browsers emit this for a lifted touch even while other fingers remain.
        if (phase === 'up')
          node.dispatchEvent(
            new PointerEvent('pointerout', {
              bubbles: true,
              composed: true,
              pointerId: id,
              pointerType: 'touch',
              relatedTarget: null,
            }),
          );
      }
    };
    const controlState = () => {
      let horizontal = 0,
        vertical = 0,
        running = false,
        jumps = 0,
        lookX = 0;
      for (const message of playerMessages) {
        if (message.kind === 'reset') {
          horizontal = vertical = lookX = 0;
          running = false;
        }
        if (message.kind === 'move') {
          horizontal = Number(message.horizontal);
          vertical = Number(message.vertical);
        }
        if (message.kind === 'run') running = message.held === true;
        if (message.kind === 'look') lookX += Number(message.x);
        if (message.kind === 'jump') jumps++;
      }
      return { horizontal, vertical, running, jumps, lookX };
    };
    for (const node of [move, look, run, jump]) {
      const rect = node.getBoundingClientRect();
      expect(rect.width).toBeGreaterThanOrEqual(44);
      expect(rect.height).toBeGreaterThanOrEqual(44);
    }
    expect(part('vase-toggle').getAttribute('aria-expanded')).toBe('false');
    point(move, 10, 'down');
    point(move, 10, 'move', 0, -move.getBoundingClientRect().height * 0.3);
    point(look, 20, 'down');
    point(look, 20, 'move', 40, -20);
    run.focus();
    point(run, 30, 'down');
    jump.focus();
    point(jump, 40, 'down');
    point(jump, 40, 'up', 500, 500);
    await flush();
    expect(controlState()).toMatchObject({ horizontal: 0, running: true, jumps: 1 });
    expect(controlState().vertical).toBeCloseTo(1);
    expect(controlState().lookX).toBeCloseTo((40 * 1000) / 620);
    expect(part('move-thumb').style.transform).not.toBe('translate(0px, 0px)');
    point(run, 30, 'up', 500, 500);
    await flush();
    expect(controlState()).toMatchObject({ running: false, jumps: 1 });
    expect(controlState().vertical).toBeCloseTo(1);
    point(move, 10, 'cancel');
    point(look, 20, 'cancel');
    await flush();
    expect(controlState()).toMatchObject({ horizontal: 0, vertical: 0, running: false, lookX: 0 });
    point(move, 11, 'down');
    point(move, 11, 'move', 0, -40);
    point(run, 31, 'down');
    part('vase-toggle').click();
    await flush();
    expect(controlState()).toMatchObject({ horizontal: 0, vertical: 0, running: false });
    expect(part('touch-controls').getBoundingClientRect().height).toBe(0);
    expect(part('vase-toggle').getAttribute('aria-expanded')).toBe('true');
    const button = required(
      root.querySelector<HTMLButtonElement>('[data-ui-part="vase-controls"] button'),
    );
    const radius = required(root.querySelector<HTMLInputElement>('input[name="radius"]'));
    const status = required(root.querySelector<HTMLElement>('[data-ui-part="vase-status"]'));
    const state = (busy: boolean, error?: string) =>
      channel.port2.postMessage({
        channel: 'game-3d/runtime-vase',
        kind: 'state',
        state: {
          busy,
          guid: 'vase',
          values: { height: 2.4, radius: 0.75, sides: 32 },
          vertexCount: 1216,
          ...(error ? { error } : {}),
        },
      });
    state(false);
    await expect.poll(() => status.dataset.state).toBe('ready');
    radius.focus();
    await flush();
    expect(controlState()).toMatchObject({ horizontal: 0, vertical: 0, running: false, jumps: 1 });
    radius.value = '0.42';
    button.click();
    expect(messages).toHaveLength(1);
    radius.value = '0.8';
    button.click();
    await expect.poll(() => messages.length).toBe(2);
    expect(button.disabled).toBe(true);
    state(true);
    await expect.poll(() => radius.disabled).toBe(true);
    state(false, 'generation failed');
    await expect.poll(() => status.dataset.state).toBe('error');
    expect(radius.disabled).toBe(false);
    expect(button.disabled).toBe(false);
    expect(radius.value).toBe('0.8');
    state(false);
    await expect.poll(() => status.dataset.state).toBe('ready');
    results.push([
      messages,
      radius.value,
      status.textContent,
      root.querySelectorAll('label').length,
    ]);
  }
  expect(results[1]).toEqual(results[0]);
  expect(errors).toEqual([]);
});

it.each([
  'remove',
  'disabled',
  'readonly',
  'hidden',
  'inert',
  'non-text type',
] as const)('matches cancelled native edit eligibility after beforeinput makes a field %s', async (mutation) => {
  const { native, ui, errors } = await pair(
    '<!doctype html><form><input id="radius" type="number" value="0.5"><button>Generate</button></form>',
  );
  const fields = [native, ui.document].map((document) =>
    required(document.querySelector<HTMLInputElement>('input')),
  );
  const traces = fields.map(() => [] as string[]);
  for (const [index, field] of fields.entries()) {
    field.addEventListener('input', () => required(traces[index]).push('input'));
    field.addEventListener(
      'beforeinput',
      (event) => {
        if (index === 0) expect(event.isTrusted).toBe(true);
        required(traces[index]).push('beforeinput');
        if (mutation === 'remove') field.remove();
        else if (mutation === 'disabled') field.disabled = true;
        else if (mutation === 'readonly') field.readOnly = true;
        else if (mutation === 'hidden') field.style.display = 'none';
        else if (mutation === 'inert') required(field.closest('form')).inert = true;
        else field.type = 'checkbox';
      },
      { once: true },
    );
    field.focus();
  }
  await userEvent.keyboard(selectAllKeys());
  await cdp().send('Input.insertText', { text: '0.8' });
  expect(() => ui.input.text('0.8')).not.toThrow();
  expect(fields.map((field) => field.value)).toEqual(['0.5', '0.5']);
  expect(traces).toEqual([['beforeinput'], ['beforeinput']]);
  expect(() => ui.paint(0)).not.toThrow();
  expect(errors).toEqual([]);
});

it('migrates native current values through checkable controls and back to text defaults', async () => {
  const { native, ui, errors } = await pair('<!doctype html><body>');
  const cases = [
    ['number', null, '0.8', 'checkbox'],
    ['number', '0.35', '0.8', 'radio'],
    ['number', '0.35', '', 'checkbox'],
    ['text', null, '\u82b1\u74f6·A', 'radio'],
    ['range', null, '75', 'checkbox'],
    ['checkbox', null, null, 'radio'],
  ] as const;
  const run = (document: Document) =>
    cases.map(([type, initialDefault, value, next]) => {
      const field = document.createElement('input');
      field.type = type;
      if (initialDefault !== null) field.defaultValue = initialDefault;
      if (value !== null) field.value = value;
      document.body.append(field);
      const trace: object[] = [];
      const snapshot = () =>
        trace.push({
          type: field.type,
          value: field.value,
          defaultValue: field.defaultValue,
          attribute: field.getAttribute('value'),
        });
      snapshot();
      field.type = next;
      snapshot();
      field.removeAttribute('type');
      snapshot();
      field.defaultValue = 'reset';
      snapshot();
      field.remove();
      return trace;
    });
  expect(run(ui.document)).toEqual(run(native));
  expect(errors).toEqual([]);
});

it('keeps the edited control usable when beforeinput switches its value mode', async () => {
  const evidence = uiEvidenceDirectory(required(expect.getState().testPath), 'ui-edit-defaults');
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
  const { native, ui, errors, iframe } = await pair(
    '<!doctype html><style>body{margin:0;background:#10243a;color:white;font:16px "UI Fixture"}.panel{padding:18px}label{display:flex;align-items:center;gap:12px}input{color:#10243a}input[type=number],input[type=text]{width:90px;font:inherit}output{display:block;margin-top:18px;font-size:14px;white-space:pre-wrap}</style><section class="panel"><label>Radius <input id="field" type="number"></label><output id="state"></output></section>',
    340,
    170,
    font,
  );
  const stage = document.createElement('section');
  stage.style.cssText =
    'position:absolute;left:0;top:0;width:692px;height:198px;background:#10243a;color:white';
  const legend = document.createElement('div');
  legend.style.cssText = 'height:28px;font:13px/28px sans-serif';
  legend.textContent = 'Chromium (left) · Blitz (right) · edit default and value';
  const canvas = document.createElement('canvas');
  canvas.width = 340;
  canvas.height = 170;
  canvas.style.cssText = 'position:absolute;left:352px;top:28px';
  iframe.style.top = '28px';
  iframe.style.zIndex = '1';
  stage.append(legend, canvas);
  document.body.append(stage);
  cleanup.push(() => stage.remove());
  const fields = [native, ui.document].map((document) =>
    required(document.querySelector<HTMLInputElement>('#field')),
  );
  const inputs = [0, 0];
  const states: unknown[] = [];
  const paint = async (name: string) => {
    const snapshots = [native, ui.document].map((document, index) => {
      const field = required(fields[index]);
      const state = {
        type: field.type,
        value: field.value,
        defaultValue: field.defaultValue,
        inputs: inputs[index],
      };
      required(document.querySelector('#state')).textContent =
        `type: ${state.type}\nvalue: ${state.value}\ndefault: ${state.defaultValue || '(empty)'}\ninput events: ${state.inputs}`;
      return state;
    });
    expect(snapshots[1]).toEqual(snapshots[0]);
    states.push({ name, snapshots });
    const pixels = ui.paint(0);
    if (pixels)
      required(canvas.getContext('2d')).putImageData(
        new ImageData(new Uint8ClampedArray(pixels), 340, 170),
        0,
        0,
      );
    await page.viewport(692, 198);
    await page.elementLocator(stage).screenshot({ path: `${evidence}/${name}.png` });
  };
  for (const [index, field] of fields.entries()) {
    field.value = '0.5';
    field.focus();
    field.addEventListener('input', () => {
      inputs[index] = required(inputs[index]) + 1;
    });
    field.addEventListener(
      'beforeinput',
      (event) => {
        if (index === 0) expect(event.isTrusted).toBe(true);
        field.type = 'checkbox';
      },
      { once: true },
    );
  }
  await paint('01-number');
  await userEvent.keyboard(selectAllKeys());
  await cdp().send('Input.insertText', { text: '0.8' });
  ui.input.text('0.8');
  expect(inputs).toEqual([0, 0]);
  expect(fields.map((field) => field.value)).toEqual(['0.5', '0.5']);
  await paint('02-retired-edit-checkbox');
  for (const field of fields) {
    field.removeAttribute('type');
    field.defaultValue = '0.75';
    field.focus();
  }
  expect(fields.map((field) => field.value)).toEqual(['0.75', '0.75']);
  await paint('03-restored-text-default');
  await commands.writeFile(`${evidence}/states.json`, JSON.stringify(states, null, 2));
  expect(errors).toEqual([]);
});

it('keeps default text controls readable under light-text ancestors and honors authored colors', async () => {
  const evidence = uiEvidenceDirectory(required(expect.getState().testPath), 'ui-input-ua-colors');
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
  const html =
    '<!doctype html><style>body{margin:0;background:#10243a;color:white;font:16px "UI Fixture"}.row{display:flex;align-items:center;gap:12px;margin:12px 16px}label{width:70px}input,textarea{font:inherit;width:160px;box-sizing:border-box}textarea{height:48px}</style><div class="row"><label for="number">Number</label><input id="number" type="number" value="0.5"></div><div class="row"><label for="text">Text</label><input id="text" value="Readable"></div><div class="row"><label for="area">Textarea</label><textarea id="area">Type here</textarea></div>';
  await commands.writeFile(`${evidence}/fixture.html`, html);
  const { native, ui, errors, iframe } = await pair(html, 340, 190, font);
  const stage = document.createElement('section');
  stage.style.cssText =
    'position:absolute;left:0;top:0;width:692px;height:218px;background:#10243a;color:white';
  const legend = document.createElement('div');
  legend.style.cssText = 'height:28px;font:13px/28px sans-serif';
  legend.textContent = 'Chromium (left) · Blitz (right) · native input foreground';
  const canvas = document.createElement('canvas');
  canvas.width = 340;
  canvas.height = 190;
  canvas.style.cssText = 'position:absolute;left:352px;top:28px';
  iframe.style.top = '28px';
  iframe.style.zIndex = '1';
  stage.append(legend, canvas);
  document.body.append(stage);
  cleanup.push(() => stage.remove());
  const states: unknown[] = [];
  const capture = async (name: string) => {
    const snapshots = [native, ui.document].map((document, index) =>
      Array.from(document.querySelectorAll('input,textarea')).map((field) => ({
        id: field.id,
        color:
          index === 0
            ? required(native.defaultView).getComputedStyle(field).color
            : ui.getComputedStyle(field).getPropertyValue('color'),
      })),
    );
    const pixels = required(ui.paint(0));
    required(canvas.getContext('2d')).putImageData(
      new ImageData(new Uint8ClampedArray(pixels), 340, 190),
      0,
      0,
    );
    states.push({ name, snapshots });
    await commands.writeFile(`${evidence}/states.json`, JSON.stringify(states, null, 2));
    await page.viewport(692, 218);
    await page.elementLocator(stage).screenshot({ path: `${evidence}/${name}.png` });
    expect(snapshots[1]).toEqual(snapshots[0]);
    return pixels;
  };
  const pixels = await capture('01-default-foreground');
  for (const field of ui.document.querySelectorAll('input,textarea')) {
    const rect = field.getBoundingClientRect();
    let ink = 0;
    for (let y = Math.ceil(rect.top + 4); y < Math.floor(rect.bottom - 4); y++) {
      for (let x = Math.ceil(rect.left + 4); x < Math.floor(rect.right - 4); x++) {
        const offset = (y * 340 + x) * 4;
        if (
          required(pixels[offset]) < 80 &&
          required(pixels[offset + 1]) < 80 &&
          required(pixels[offset + 2]) < 80 &&
          required(pixels[offset + 3]) > 200
        )
          ink++;
      }
    }
    expect(ink, `${field.id} must paint readable native text`).toBeGreaterThan(20);
  }
  for (const document of [native, ui.document]) {
    for (const field of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'input,textarea',
    ))
      field.style.color = 'rgb(160, 0, 0)';
  }
  await capture('02-authored-foreground');
  expect(errors).toEqual([]);
});

it.each([
  ['reportValidity', 'value'],
  ['reportValidity', 'disabled'],
  ['reportValidity', 'readonly'],
  ['reportValidity', 'remove'],
  ['reportValidity', 'self-value'],
  ['reportValidity', 'self-remove'],
  ['reportValidity', 'self-disabled'],
  ['reportValidity', 'self-hidden'],
  ['reportValidity', 'next-invalid'],
  ['reportValidity', 'redirect-focus'],
  ['reportValidity', 'focused-self-hidden'],
  ['checkValidity', 'remove'],
] as const)('matches %s when an invalid callback changes %s', async (method, mutation) => {
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
  const { native, ui, errors, iframe } = await pair(
    '<!doctype html><style>body{margin:0;background:#10243a;color:white;font:16px "UI Fixture"}form{padding:16px}label{display:flex;align-items:center;gap:16px;margin-bottom:12px}input{width:100px;font:inherit}output{display:block;white-space:pre-wrap;margin-top:20px;font-size:14px}</style><form><label>First<input id="first" type="number" min="1" value="0"></label><label>Next<input id="next" type="number" min="1" value="0"></label><button>Generate</button><output></output></form>',
    340,
    230,
    font,
  );
  const run = (document: Document) => {
    const form = required(document.querySelector('form'));
    const first = required(document.querySelector<HTMLInputElement>('#first'));
    const next = required(document.querySelector<HTMLInputElement>('#next'));
    if (mutation === 'next-invalid') next.value = '2';
    if (mutation === 'focused-self-hidden') first.focus();
    if (mutation === 'redirect-focus')
      first.addEventListener('focus', () => required(form.querySelector('button')).focus());
    const trace: string[] = [];
    first.addEventListener(
      'invalid',
      () => {
        trace.push('first');
        if (mutation === 'value') next.value = '2';
        else if (mutation === 'disabled') next.disabled = true;
        else if (mutation === 'readonly') next.readOnly = true;
        else if (mutation === 'remove') next.remove();
        else if (mutation === 'self-value') first.value = '2';
        else if (mutation === 'self-disabled') first.disabled = true;
        else if (mutation === 'self-hidden' || mutation === 'focused-self-hidden')
          first.style.display = 'none';
        else if (mutation === 'next-invalid') next.value = '0';
        else if (mutation === 'self-remove') first.remove();
      },
      { once: true },
    );
    next.addEventListener('invalid', () => trace.push('next'));
    return { valid: form[method](), trace, focus: document.activeElement?.id ?? '' };
  };
  const states = [run(native), run(ui.document)];
  expect(states[1]).toEqual(states[0]);
  if (method === 'reportValidity' && (mutation === 'value' || mutation === 'self-remove')) {
    const evidence = uiEvidenceDirectory(
      required(expect.getState().testPath),
      'ui-form-validation',
    );
    for (const [index, document] of [native, ui.document].entries()) {
      const state = required(states[index]);
      required(document.querySelector('output')).textContent =
        `valid: ${state.valid}\ninvalid events: ${state.trace.join(', ')}\nfeedback focus: ${state.focus}`;
    }
    const stage = document.createElement('section');
    stage.style.cssText =
      'position:absolute;left:0;top:0;width:692px;height:258px;background:#10243a;color:white';
    const legend = document.createElement('div');
    legend.style.cssText = 'height:28px;font:13px/28px sans-serif';
    legend.textContent = `Chromium (left) · Blitz (right) · invalid callback: ${mutation}`;
    const canvas = document.createElement('canvas');
    canvas.width = 340;
    canvas.height = 230;
    canvas.style.cssText = 'position:absolute;left:352px;top:28px';
    iframe.style.top = '28px';
    iframe.style.zIndex = '1';
    stage.append(legend, canvas);
    document.body.append(stage);
    cleanup.push(() => stage.remove());
    required(canvas.getContext('2d')).putImageData(
      new ImageData(new Uint8ClampedArray(required(ui.paint(0))), 340, 230),
      0,
      0,
    );
    await page.viewport(692, 258);
    await page.elementLocator(stage).screenshot({ path: `${evidence}/${mutation}.png` });
    await commands.writeFile(`${evidence}/${mutation}.json`, JSON.stringify(states, null, 2));
  }
  expect(errors).toEqual([]);
});

it('parses scripted noscript as raw text in the head and body', async () => {
  const { native, ui, errors } = await pair(
    '<!doctype html><html><head><noscript id="head-fallback"><meta name="fallback" content="disabled"></noscript></head><body><noscript id="body-fallback"><b id="fallback">Fallback &amp; text</b></noscript><p>Scripted UI</p></body></html>',
  );
  const snapshot = (document: Document) =>
    Array.from(document.querySelectorAll('noscript')).map((node) => ({
      id: node.id,
      parent: node.parentElement?.tagName,
      text: node.textContent,
      html: node.innerHTML,
      children: Array.from(node.childNodes, (child) => child.nodeType),
      elements: node.querySelectorAll('*').length,
    }));
  expect(snapshot(ui.document)).toEqual(snapshot(native));
  for (const node of ui.document.querySelectorAll('noscript')) {
    expect(ui.getComputedStyle(node).getPropertyValue('display')).toBe('none');
    const actual = node.getBoundingClientRect();
    const expected = required(native.querySelector(`#${node.id}`)).getBoundingClientRect();
    expect([actual.x, actual.y, actual.width, actual.height]).toEqual([
      expected.x,
      expected.y,
      expected.width,
      expected.height,
    ]);
  }
  expect(errors).toEqual([]);
});

it.each([
  'div',
  'template',
  'shadow',
  'noscript',
] as const)('retains scripted noscript fragment and serialization semantics in %s', async (context) => {
  const { native, ui, errors } = await pair('<!doctype html><body></body>');
  const run = (document: Document) => {
    const container = document.createElement(context === 'shadow' ? 'section' : context);
    document.body.appendChild(container);
    const root = context === 'shadow' ? container.attachShadow({ mode: 'open' }) : container;
    const raw = '<b id="fallback">Fallback &amp; text</b>';
    root.innerHTML = context === 'noscript' ? raw : `<noscript>${raw}</noscript>`;
    const query = context === 'template' ? (container as HTMLTemplateElement).content : root;
    const fallback = context === 'noscript' ? container : required(query.querySelector('noscript'));
    const first = {
      html: root.innerHTML,
      text: fallback.textContent,
      elements: fallback.children.length,
    };
    fallback.innerHTML = '<i>Replacement &lt; value</i>';
    const second = {
      html: root.innerHTML,
      text: fallback.textContent,
      elements: fallback.children.length,
    };
    fallback.textContent = '<em>Scripted & value</em>';
    return { first, second, textWrite: root.innerHTML };
  };
  expect(run(ui.document)).toEqual(run(native));
  expect(errors).toEqual([]);
});

it('keeps the original startup noscript fallback absent after the host script runs', async () => {
  const source = (await import(
    new URL('../../../devkit/src/host/startup-source.ts', import.meta.url).href
  )) as {
    hostStartupDocument(title: string): string;
    hostStartupScript(enabled: boolean, host: string): string;
  };
  const evidence = uiEvidenceDirectory(required(expect.getState().testPath), 'ui-noscript');
  const html = source.hostStartupDocument('Original host startup');
  await commands.writeFile(`${evidence}/startup.html`, html);
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
  const { native, ui, errors, iframe } = await pair(html, 500, 140, font);
  const snapshots = [];
  for (const document of [native, ui.document]) {
    const startup = new Function('host', `return ${source.hostStartupScript(true, 'host').trim()}`)(
      {
        document,
        events: document,
        surface: () => document.querySelector('#app'),
        now: () => 0,
        visible: () => true,
        reducedMotion: true,
        reload: () => {},
      },
    ) as { prepare(): void; destroy(): void };
    cleanup.push(() => startup.destroy());
    startup.prepare();
    required(document.querySelector<HTMLElement>('#app-shell')).style.display = 'none';
    const fallback = required(document.querySelector('noscript'));
    snapshots.push({
      text: fallback.textContent,
      display:
        document === native
          ? required(native.defaultView).getComputedStyle(fallback).display
          : ui.getComputedStyle(fallback).getPropertyValue('display'),
      rect: (() => {
        const rect = fallback.getBoundingClientRect();
        return [rect.x, rect.y, rect.width, rect.height];
      })(),
    });
  }
  const stage = document.createElement('section');
  stage.style.cssText =
    'position:absolute;left:0;top:0;width:1012px;height:172px;background:white;color:black';
  const legend = document.createElement('div');
  legend.style.cssText = 'height:32px;font:13px/32px sans-serif';
  legend.textContent =
    'Chromium (left) | Blitz (right) | Original startup: scripted host, app shell hidden';
  const canvas = document.createElement('canvas');
  canvas.width = 500;
  canvas.height = 140;
  canvas.style.cssText = 'position:absolute;left:512px;top:32px';
  iframe.style.top = '32px';
  iframe.style.zIndex = '1';
  stage.append(legend, canvas);
  document.body.append(stage);
  cleanup.push(() => stage.remove());
  const pixels = required(ui.paint(0));
  required(canvas.getContext('2d')).putImageData(
    new ImageData(new Uint8ClampedArray(pixels), 500, 140),
    0,
    0,
  );
  await commands.writeFile(`${evidence}/startup.json`, JSON.stringify(snapshots, null, 2));
  await page.viewport(1012, 172);
  await page.elementLocator(stage).screenshot({ path: `${evidence}/startup.png` });
  expect(snapshots.map(({ text, rect }) => ({ text, rect }))[1]).toEqual(
    snapshots.map(({ text, rect }) => ({ text, rect }))[0],
  );
  expect(pixels.some((value) => value !== 0)).toBe(false);
  ui.resize(480, 160, 1);
  expect(
    ui
      .getComputedStyle(required(ui.document.querySelector('noscript')))
      .getPropertyValue('display'),
  ).toBe('none');
  expect(errors).toEqual([]);
});

it('retains noscript parsing and serialization owners across template detachment, clone and adoption', async () => {
  const { native, ui, errors } = await pair(
    '<!doctype html><template><noscript><b>Initial &amp; value</b></noscript></template>',
  );
  const run = (document: Document) => {
    const template = required(document.querySelector('template'));
    const fallback = required(template.content.querySelector('noscript'));
    const trace: unknown[] = [];
    const snapshot = () =>
      trace.push({
        html: fallback.innerHTML,
        text: fallback.textContent,
        children: fallback.children.length,
        connected: fallback.isConnected,
        templateHtml: template.innerHTML,
      });
    snapshot();
    fallback.innerHTML = '<i>Replacement &amp; value</i>';
    snapshot();
    fallback.textContent = '<b>Text & value</b>';
    snapshot();
    fallback.remove();
    snapshot();
    const clone = fallback.cloneNode(true) as HTMLElement;
    trace.push(clone.innerHTML);
    document.body.appendChild(fallback);
    snapshot();
    fallback.innerHTML = '<i>Active &amp; value</i>';
    snapshot();
    template.content.appendChild(fallback);
    snapshot();
    fallback.innerHTML = '<i>Inert &amp; value</i>';
    snapshot();
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<noscript><b>Shadow</b></noscript>';
    const shadowFallback = required(shadow.querySelector('noscript'));
    template.content.appendChild(host);
    trace.push(shadowFallback.innerHTML);
    document.body.appendChild(host);
    trace.push(shadowFallback.innerHTML);
    const nested = document.createElement('template');
    nested.innerHTML = '<noscript><b>Nested</b></noscript>';
    template.content.appendChild(nested);
    const clonedTemplate = template.cloneNode(true) as HTMLTemplateElement;
    document.body.appendChild(clonedTemplate);
    trace.push(required(clonedTemplate.content.querySelector('template')).innerHTML);
    return trace;
  };
  expect(run(ui.document)).toEqual(run(native));
  expect(errors).toEqual([]);
});
