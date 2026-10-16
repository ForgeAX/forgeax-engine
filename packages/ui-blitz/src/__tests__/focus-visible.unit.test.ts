/// <reference types="node" />
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { type BlitzUi, createBlitzUi } from '../index.js';
import { required } from './fixture.js';

const bytes = await readFile(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url));
const wasm = {
  readWasm: async () => bytes,
  instantiate: (imports: unknown) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
};
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const release of cleanup.splice(0).reverse()) release();
});
async function document() {
  const errors: unknown[] = [];
  const ui = await createBlitzUi({
    wasm,
    width: 640,
    height: 640,
    html: '<style>body{margin:0}button,input,textarea,select{display:block;margin:8px;width:150px;height:30px}</style><button id="one">One</button><button id="two">Two</button><input id="edit"><input id="readonly" readonly><input id="number" type="number"><input id="check" type="checkbox"><textarea id="area"></textarea><select id="select"><option>A</option></select>',
    onError: (error) => errors.push(error),
  });
  cleanup.push(() => {
    ui.dispose();
    expect(errors).toEqual([]);
  });
  return ui;
}
function pointer(ui: BlitzUi, element: Element, pointerType: 'touch' | 'mouse' = 'touch') {
  const rect = element.getBoundingClientRect();
  const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  expect(ui.elementFromPoint(point.x, point.y)).toBe(element);
  for (const phase of ['down', 'up'] as const)
    ui.input.pointer({ phase, pointerId: 1, pointerType, ...point });
}

it('matches focus-visible for initial scripted focus through the actual native state', async () => {
  const ui = await document();
  const button = required(ui.document.querySelector<HTMLElement>('#one'));
  button.focus();
  expect(button.matches(':focus-visible')).toBe(true);
  button.blur();
  expect(button.matches(':focus-visible')).toBe(false);
});

it.each([
  'touch',
  'mouse',
] as const)('preserves keyboard and script modality across %s defaults', async (kind) => {
  const ui = await document();
  const one = required(ui.document.querySelector<HTMLElement>('#one'));
  const two = required(ui.document.querySelector<HTMLElement>('#two'));
  pointer(ui, one, kind);
  expect(one.matches(':focus-visible')).toBe(false);
  two.focus();
  expect(two.matches(':focus-visible')).toBe(false);
  ui.input.key({ type: 'keydown', key: 'a' });
  expect(two.matches(':focus-visible')).toBe(true);
  pointer(ui, two, kind);
  expect(two.matches(':focus-visible')).toBe(true);
  one.focus();
  expect(one.matches(':focus-visible')).toBe(true);
  pointer(ui, two, kind);
  expect(two.matches(':focus-visible')).toBe(false);
  two.blur();
  one.focus();
  expect(one.matches(':focus-visible')).toBe(false);
});

it.each([
  'edit',
  'readonly',
  'number',
  'area',
  'select',
])('keeps %s visibly focused without converting later script focus to keyboard modality', async (id) => {
  const ui = await document();
  const editor = required(ui.document.querySelector<HTMLElement>(`#${id}`));
  const button = required(ui.document.querySelector<HTMLElement>('#two'));
  pointer(ui, editor);
  expect(editor.matches(':focus-visible')).toBe(true);
  button.focus();
  expect(button.matches(':focus-visible')).toBe(false);
});

it('updates visible focus before cancelled keys and preserves it for cancelled pointer defaults', async () => {
  const ui = await document();
  const one = required(ui.document.querySelector<HTMLElement>('#one'));
  const two = required(ui.document.querySelector<HTMLElement>('#two'));
  pointer(ui, one);
  one.addEventListener('keydown', (event) => event.preventDefault(), { once: true });
  ui.input.key({ type: 'keydown', key: 'Tab' });
  expect(ui.document.activeElement).toBe(one);
  expect(one.matches(':focus-visible')).toBe(true);
  two.addEventListener('pointerdown', (event) => event.preventDefault(), { once: true });
  pointer(ui, two);
  expect(ui.document.activeElement).toBe(one);
  two.focus();
  expect(two.matches(':focus-visible')).toBe(true);
  const check = required(ui.document.querySelector<HTMLElement>('#check'));
  one.addEventListener(
    'pointerdown',
    (event) => {
      event.preventDefault();
      check.focus();
    },
    { once: true },
  );
  pointer(ui, one);
  expect(check.matches(':focus-visible')).toBe(true);
});

it('ignores modified keys and keyup while accepting Shift keyboard navigation', async () => {
  const ui = await document();
  const button = required(ui.document.querySelector<HTMLElement>('#one'));
  pointer(ui, button);
  for (const key of ['Control', 'Alt', 'Meta']) {
    ui.input.key({ type: 'keydown', key });
    expect(button.matches(':focus-visible')).toBe(false);
  }
  for (const modifier of ['ctrlKey', 'altKey', 'metaKey']) {
    ui.input.key({ type: 'keydown', key: 'a', [modifier]: true });
    expect(button.matches(':focus-visible')).toBe(false);
  }
  ui.input.key({ type: 'keyup', key: 'a' });
  expect(button.matches(':focus-visible')).toBe(false);
  ui.input.key({ type: 'keydown', key: 'Shift', shiftKey: true });
  expect(button.matches(':focus-visible')).toBe(true);
  button.style.display = 'none';
  ui.paint(0); // Hidden focus retires when native style/layout resolves.
  expect(ui.document.activeElement).not.toBe(button);
  expect(button.matches(':focus-visible')).toBe(false);
});

it('retains pointer activation when an associated label forwards focus to its input', async () => {
  const ui = await document();
  const label = ui.document.createElement('label');
  label.htmlFor = 'edit';
  label.textContent = 'Text editor';
  label.style.cssText = 'display:block;width:150px;height:30px';
  ui.document.body.append(label);
  pointer(ui, label);
  const editor = required(ui.document.querySelector<HTMLElement>('#edit'));
  expect(editor.matches(':focus-visible')).toBe(true);
  const button = required(ui.document.querySelector<HTMLElement>('#two'));
  button.focus();
  expect(button.matches(':focus-visible')).toBe(false);
});

it('admits the unchanged capability-lab HUD and applies its authored focus-visible rule', async () => {
  const source = JSON.parse(
    await readFile(
      new URL('../../../../apps/game-capability-lab/assets/ui/hud.pack.json', import.meta.url),
      'utf8',
    ),
  );
  const { mountUi } = await import(new URL('../../../ui/src/index.ts', import.meta.url).href);
  const ui = await document();
  const mounted = mountUi(
    { guid: 'original-capability-hud', ...source.assets['ui/hud'].payload },
    { root: ui.document.body, layer: 1 },
  );
  expect(mounted.ok).toBe(true);
  if (!mounted.ok) throw mounted.error;
  cleanup.push(() => mounted.value.dispose());
  const root = required(mounted.value.host.shadowRoot as ShadowRoot | null);
  required(root.querySelector<HTMLDetailsElement>('.asset-lab')).open = true;
  const button = required(root.querySelector<HTMLElement>('.asset-control'));
  const before = ui.getComputedStyle(button).getPropertyValue('background-color');
  button.focus();
  expect(button.matches(':focus-visible')).toBe(true);
  expect(ui.getComputedStyle(button).getPropertyValue('background-color')).not.toBe(before);
  button.blur();
  expect(ui.getComputedStyle(button).getPropertyValue('background-color')).toBe(before);
});
