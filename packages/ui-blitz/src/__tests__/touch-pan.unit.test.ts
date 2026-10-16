import { readFile } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { createBlitzUi, UiDomError, type UiWasmHost } from '../index.js';
import { required } from './fixture.js';

const bytes = await readFile(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url));
const wasm: UiWasmHost = {
  readWasm: async () => bytes,
  instantiate: (imports) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
};
const live: Awaited<ReturnType<typeof createBlitzUi>>[] = [];
afterEach(() => {
  for (const ui of live.splice(0)) ui.dispose();
});

async function create(touchAction?: string) {
  const ui = await createBlitzUi({
    wasm,
    html: `<style>body{margin:0}section{width:100px;height:80px;overflow:auto}div{display:block;width:200px;height:200px;${touchAction ? `touch-action:${touchAction}` : ''}}</style><section><div>Drag</div></section>`,
    width: 180,
    height: 120,
    onError: (cause) => {
      throw cause;
    },
  });
  live.push(ui);
  return ui;
}

function drag(ui: Awaited<ReturnType<typeof createBlitzUi>>) {
  ui.input.pointer({ phase: 'down', pointerId: 1, x: 60, y: 60 });
  ui.input.pointer({ phase: 'move', pointerId: 1, x: 30, y: 30 });
  ui.input.pointer({ phase: 'up', pointerId: 1, x: 30, y: 30 });
}

it('retains default touch scrolling when the author has not restricted panning', async () => {
  const ui = await create();
  const section = required(ui.document.querySelector('section'));
  drag(ui);
  expect([section.scrollLeft, section.scrollTop]).toEqual([30, 30]);
});

it('does not mistake canceled pointer events for a CSS panning restriction', async () => {
  const ui = await create();
  const section = required(ui.document.querySelector('section'));
  const control = required(ui.document.querySelector('div'));
  control.addEventListener('pointerdown', (event) => event.preventDefault());
  control.addEventListener('pointermove', (event) => event.preventDefault());
  drag(ui);
  expect([section.scrollLeft, section.scrollTop]).toEqual([30, 30]);
});

it('keeps touch-action none gestures with the control while wheel scrolling remains available', async () => {
  const ui = await create('none');
  const section = required(ui.document.querySelector('section'));
  const control = required(ui.document.querySelector('div'));
  const trace: string[] = [];
  for (const type of ['pointerdown', 'pointermove', 'pointercancel', 'pointerup'])
    control.addEventListener(type, () => trace.push(type));
  drag(ui);
  expect([section.scrollLeft, section.scrollTop]).toEqual([0, 0]);
  expect(trace).toEqual(['pointerdown', 'pointermove', 'pointerup']);
  expect(ui.input.wheel({ x: 60, y: 60, deltaX: 0, deltaY: 30 })).toBe(true);
  expect(section.scrollTop).toBe(30);
});

it.each([
  ['pan-x', [30, 0]],
  ['pan-y', [0, 30]],
  ['pan-x pan-y', [30, 30]],
  ['manipulation', [30, 30]],
] as const)('applies %s to direct manipulation only', async (value, expected) => {
  const ui = await create(value);
  const section = required(ui.document.querySelector('section'));
  drag(ui);
  expect([section.scrollLeft, section.scrollTop]).toEqual(expected);
});

it.each([
  ['auto', 'none', [30, 30], [0, 0]],
  ['none', 'auto', [0, 0], [30, 30]],
] as const)('freezes %s for the gesture before a pointerdown handler changes it to %s', async (initial, next, first, second) => {
  const ui = await create(initial);
  const section = required(ui.document.querySelector('section'));
  const control = required(ui.document.querySelector<HTMLElement>('div'));
  control.addEventListener('pointerdown', () => {
    control.style.touchAction = next;
  });
  drag(ui);
  expect([section.scrollLeft, section.scrollTop]).toEqual(first);
  section.scrollLeft = section.scrollTop = 0;
  drag(ui);
  expect([section.scrollLeft, section.scrollTop]).toEqual(second);
});

it('applies the shadow host pan policy to a control in its shadow tree', async () => {
  const ui = await create();
  const section = required(ui.document.querySelector<HTMLElement>('section'));
  section.style.touchAction = 'none';
  const shadow = section.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<style>div{width:200px;height:200px}</style><div>Drag</div>';
  drag(ui);
  expect([section.scrollLeft, section.scrollTop]).toEqual([0, 0]);
});

it('keeps two contacts with different pan policies independent', async () => {
  const ui = await create('none');
  const body = required(ui.document.querySelector<HTMLElement>('body'));
  body.style.display = 'flex';
  const first = required(ui.document.querySelector<HTMLElement>('section'));
  first.style.width = '80px';
  first.style.flexShrink = '0';
  const second = first.cloneNode(true) as HTMLElement;
  body.appendChild(second);
  required(second.querySelector<HTMLElement>('div')).style.touchAction = 'auto';
  ui.input.pointer({ phase: 'down', pointerId: 1, x: 40, y: 60 });
  ui.input.pointer({ phase: 'down', pointerId: 2, x: 120, y: 60 });
  ui.input.pointer({ phase: 'move', pointerId: 1, x: 20, y: 30 });
  ui.input.pointer({ phase: 'move', pointerId: 2, x: 100, y: 30 });
  expect([first.scrollLeft, first.scrollTop]).toEqual([0, 0]);
  expect([second.scrollLeft, second.scrollTop]).toEqual([20, 30]);
  ui.input.cancel();
  expect(ui.input.ownsInput()).toBe(false);
});

it('rejects unimplemented directional and zoom policies instead of silently admitting them', async () => {
  const ui = await create();
  const control = required(ui.document.querySelector<HTMLElement>('div'));
  for (const value of ['pan-left', 'pan-right', 'pan-up', 'pan-down', 'pinch-zoom'])
    expect(() => {
      control.style.touchAction = value;
    }).toThrow(UiDomError);
});
