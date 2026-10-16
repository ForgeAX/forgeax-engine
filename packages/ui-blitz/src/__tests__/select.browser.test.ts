import { mountUi } from '@forgeax/engine-ui';
import { afterEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { createBlitzUi, UiDomError, type UiWasmHost } from '../index.js';
import { required } from './fixture.js';

const bytes = new Uint8Array(
  await (await fetch(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url))).arrayBuffer(),
);
const host: UiWasmHost = {
  readWasm: async () => bytes,
  instantiate: (imports) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
};
const settings = await (
  await fetch(
    new URL('../../../../apps/game-capability-lab/assets/ui/settings.pack.json', import.meta.url),
  )
).json();
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
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});
async function pair(width = 500, height = 500) {
  const native = document.createElement('section');
  native.style.cssText =
    'position:absolute;left:0;top:0;width:500px;height:500px;background:white;z-index:100';
  document.body.append(native);
  cleanup.push(() => native.remove());
  const ui = await createBlitzUi({
    wasm: host,
    html: '<style>body{margin:0}</style>',
    width,
    height,
    font,
    onError: (cause) => {
      throw cause;
    },
  });
  cleanup.push(() => ui.dispose());
  return { native, ui };
}

function properties(document: Document) {
  const select = document.createElement('select');
  select.innerHTML =
    '<option value="">Choose</option><option value="a" selected>Alpha</option><option value="b">Beta</option><option>  Text   value </option>';
  const states: unknown[] = [];
  const snapshot = () =>
    states.push({
      value: select.value,
      index: select.selectedIndex,
      type: select.type,
      options: Array.from(select.options, (option) => [
        option.value,
        option.text,
        option.label,
        option.selected,
        option.defaultSelected,
      ]),
      selected: Array.from(select.selectedOptions, (option) => option.value),
    });
  const alpha = required(select.querySelector<HTMLOptionElement>('[value="a"]'));
  const beta = required(select.querySelector<HTMLOptionElement>('[value="b"]'));
  snapshot();
  select.value = 'b';
  snapshot();
  alpha.defaultSelected = false;
  alpha.defaultSelected = true;
  snapshot();
  beta.selected = true;
  beta.defaultSelected = true;
  beta.defaultSelected = false;
  snapshot();
  select.selectedIndex = 3;
  snapshot();
  required(select.options[3]).text = 'Changed text';
  required(select.options[3]).label = 'Visible label';
  snapshot();
  select.value = 'missing';
  snapshot();
  select.selectedIndex = 0;
  snapshot();
  beta.selected = true;
  beta.remove();
  snapshot();
  select.required = true;
  select.selectedIndex = 0;
  const invalid = [select.willValidate, select.validity.valueMissing, select.checkValidity()];
  select.selectedIndex = 1;
  const valid = [select.validity.valueMissing, select.checkValidity()];
  return { states, invalid, valid };
}

it('matches Chromium select values, option defaults, mutation and required validation', async () => {
  const { ui } = await pair();
  expect(properties(ui.document)).toEqual(properties(document));
  const select = ui.document.createElement('select');
  expect(() => {
    select.multiple = true;
  }).toThrow(UiDomError);
  expect(() => {
    select.size = 2;
  }).toThrow(UiDomError);
  expect(select.multiple).toBe(false);
  expect(select.size).toBe(0);
});

it('matches direct control clicks and label forwarding for selects and textareas without recursion', async () => {
  const { native, ui } = await pair();
  function run(root: HTMLElement) {
    const holder = root.ownerDocument.createElement('section');
    root.append(holder);
    holder.innerHTML =
      '<label id="choice-label"><span id="choice-text">Choice</span><select id="choice"><option>A</option></select></label><label id="text-label"><span id="text-caption">Text</span><textarea id="text">Value</textarea></label>';
    const trace: string[] = [];
    for (const element of holder.querySelectorAll<HTMLElement>('label,select,textarea'))
      element.addEventListener('click', (event) =>
        trace.push(`${element.id}:${(event.target as HTMLElement).id}`),
      );
    for (const field of holder.querySelectorAll<HTMLSelectElement | HTMLTextAreaElement>(
      'select,textarea',
    )) {
      const label = required(field.parentElement);
      const caption = required(label.querySelector<HTMLElement>('span'));
      field.click();
      label.click();
      caption.click();
      label.addEventListener('click', (event) => event.preventDefault(), { once: true });
      caption.click();
      field.disabled = true;
      field.click();
      label.click();
      field.disabled = false;
      field.addEventListener('click', (event) => event.preventDefault(), { once: true });
      label.click();
    }
    holder.remove();
    return trace;
  }
  expect(run(required(ui.document.body))).toEqual(run(native));
});

it('opens and selects the actual settings label-wrapped dropdown at the native portrait viewport', async () => {
  const { ui } = await pair(390, 844);
  const result = mountUi(
    { guid: 'settings-pointer-consumer', ...settings.assets['ui/settings'].payload },
    { root: required(ui.document.body), layer: 70 },
  );
  if (!result.ok) throw result.error;
  cleanup.push(() => result.value.dispose());
  const shadow = required(result.value.host.shadowRoot);
  required(shadow.querySelector<HTMLElement>('[role="dialog"]')).hidden = false;
  const field = required(shadow.querySelector<HTMLSelectElement>('[data-ui-setting="antialias"]'));
  const trace: string[] = [];
  for (const kind of ['click', 'input', 'change'])
    field.addEventListener(kind, () => trace.push(`${kind}:${field.value}`));
  expect(ui.paint(0)?.length).toBe(390 * 844 * 4);
  const rect = field.getBoundingClientRect();
  const tap = (y: number) => {
    for (const phase of ['down', 'up'] as const)
      ui.input.pointer({
        phase,
        pointerId: 1,
        pointerType: 'touch',
        x: rect.x + rect.width / 2,
        y,
      });
  };
  tap(rect.y + rect.height / 2);
  expect(trace).toEqual(['click:fxaa']);
  expect(ui.paint(1)?.length).toBe(390 * 844 * 4);
  tap(rect.bottom + 12);
  expect(field.value).toBe('none');
  expect(trace).toEqual(['click:fxaa', 'click:fxaa', 'input:none', 'change:none']);
  expect(ui.paint(2)?.length).toBe(390 * 844 * 4);
});

it('mounts the actual settings selects and matches keyboard defaults without a text editor', async () => {
  const { native, ui } = await pair();
  const payload = settings.assets['ui/settings'].payload;
  const fields = [native, required(ui.document.body)].map((root) => {
    const result = mountUi({ guid: 'settings-select-consumer', ...payload }, { root, layer: 1 });
    if (!result.ok) throw result.error;
    cleanup.push(() => result.value.dispose());
    const shadow = required(result.value.host.shadowRoot);
    required(shadow.querySelector<HTMLElement>('[role="dialog"]')).hidden = false;
    return required(shadow.querySelector<HTMLSelectElement>('[data-ui-setting="antialias"]'));
  });
  async function run(field: HTMLSelectElement, key: (key: string) => Promise<void>) {
    const trace: unknown[] = [];
    for (const kind of ['input', 'change'])
      field.addEventListener(kind, (event) =>
        trace.push([kind, field.value, event.bubbles, event.composed]),
      );
    field.focus();
    for (const keyName of ['Home', 'ArrowDown', 'End', 'ArrowUp']) await key(keyName);
    field.addEventListener('keydown', (event) => event.preventDefault(), { once: true });
    await key('Home');
    await key(' ');
    await key('ArrowDown');
    await key('Escape');
    await key(' ');
    await key('ArrowDown');
    await key('Enter');
    return { trace, value: field.value, index: field.selectedIndex };
  }
  const expected = await run(required(fields[0]), (key) =>
    userEvent.keyboard(key === ' ' ? ' ' : `{${key}}`),
  );
  const actual = await run(required(fields[1]), async (key) => {
    ui.input.key({ type: 'keydown', key });
    ui.input.key({ type: 'keyup', key });
  });
  expect(actual).toEqual(expected);
  expect(ui.input.focusedText()).toBeNull();
  expect(ui.paint(0)?.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
});

it('paints selectable popup rows and respects pointer cancellation, disabled options and blur', async () => {
  const { ui } = await pair();
  required(ui.document.body).innerHTML =
    '<select style="position:absolute;left:10px;top:10px;width:160px;height:30px"><option value="a">Alpha</option><option value="b" disabled>Beta</option><option value="c">Gamma</option></select><button style="position:absolute;left:300px;top:10px">Elsewhere</button>';
  const field = required(ui.document.querySelector('select'));
  const rect = field.getBoundingClientRect();
  const x = rect.x + rect.width / 2;
  const tap = (y: number) => {
    for (const phase of ['down', 'up'] as const)
      ui.input.pointer({ phase, pointerId: 1, pointerType: 'touch', x, y });
  };
  const trace: string[] = [];
  for (const kind of ['input', 'change'])
    field.addEventListener(kind, () => trace.push(`${kind}:${field.value}`));
  field.focus();
  const focused = required(ui.paint(0));
  tap(rect.y + rect.height / 2);
  const opened = required(ui.paint(1));
  const popupRows = Array.from({ length: 500 }, (_, y) => y).filter(
    (y) => y >= Math.ceil(rect.bottom) && (opened[(y * 500 + Math.floor(x)) * 4 + 3] ?? 0) > 0,
  );
  expect(popupRows.length).toBeGreaterThan(30);
  const popupTop = required(popupRows[0]);
  const rowHeight = popupRows.length / 3;
  tap(popupTop + rowHeight * 1.5);
  expect(field.value).toBe('a');
  expect(trace).toEqual([]);
  for (const kind of ['pointerdown', 'pointerup', 'click']) {
    field.addEventListener(kind, (event) => event.preventDefault(), { once: true });
    tap(popupTop + rowHeight * 2.5);
    expect(field.value).toBe('a');
    expect(trace).toEqual([]);
  }
  tap(popupTop + rowHeight * 2.5);
  expect(field.value).toBe('c');
  expect(trace).toEqual(['input:c', 'change:c']);
  expect(ui.input.focusedText()).toBeNull();
  const closed = required(ui.paint(2));
  expect(
    popupRows.every((y) => {
      const alpha = (y * 500 + Math.floor(x)) * 4 + 3;
      return closed[alpha] === focused[alpha];
    }),
  ).toBe(true);
  tap(rect.y + rect.height / 2);
  ui.paint(3);
  ui.input.cancel();
  const canceled = required(ui.paint(4));
  expect(popupRows.every((y) => canceled[(y * 500 + Math.floor(x)) * 4 + 3] === 0)).toBe(true);
  tap(rect.y + rect.height / 2);
  ui.paint(5);
  required(ui.document.querySelector('button')).focus();
  const blurred = required(ui.paint(6));
  expect(popupRows.every((y) => blurred[(y * 500 + Math.floor(x)) * 4 + 3] === 0)).toBe(true);
});
