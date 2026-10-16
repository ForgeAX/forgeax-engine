/// <reference types="node" />
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { createBlitzUi, type UiWasmHost } from '../index.js';
import { required } from './fixture.js';

const wasm = await readFile(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url));
const wasmHost: UiWasmHost = {
  readWasm: async () => wasm,
  instantiate: (imports) => WebAssembly.instantiate(wasm, imports as WebAssembly.Imports),
};
const [html, css, localization, font, controller] = await Promise.all([
  readFile(new URL('../../../../templates/game-3d/assets/guide.ui.html', import.meta.url), 'utf8'),
  readFile(new URL('../../../../templates/game-3d/assets/guide.ui.css', import.meta.url), 'utf8'),
  readFile(
    new URL('../../../../templates/game-3d/assets/guide.ui.i18n.json', import.meta.url),
    'utf8',
  ),
  readFile(
    new URL(
      '../../../devkit/node_modules/@fontsource-variable/noto-sans-sc/files/noto-sans-sc-latin-wght-normal.woff2',
      import.meta.url,
    ),
  ),
  import(
    new URL('../../../../templates/game-3d/assets/ui/guide-controller.ts', import.meta.url).href
  ),
]);
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const release of cleanup.splice(0).reverse()) release();
});

async function guide(rethrow = false) {
  const errors: unknown[] = [];
  const ui = await createBlitzUi({
    wasm: wasmHost,
    html: '<style>html,body{margin:0;width:100%;height:100%}</style><div id="game-ui"></div>',
    width: 600,
    height: 400,
    font,
    onError: (error) => {
      errors.push(error);
      if (rethrow) throw error;
    },
  });
  const channel = new MessageChannel();
  const mounted = await controller.createGuideUi(
    {
      guid: 'retirement-guide',
      html,
      css,
      localization: JSON.parse(localization),
    },
    {
      uiRoot: required(ui.document.querySelector('#game-ui')),
      port: channel.port1,
      controlMode: { read: () => 'touch', subscribe: () => () => {} },
    },
  );
  let closed = false;
  const retire = () => {
    if (closed) return;
    closed = true;
    mounted.dispose();
    channel.port1.close();
    channel.port2.close();
    ui.dispose();
  };
  cleanup.push(retire);
  const root = required(mounted.host.shadowRoot as ShadowRoot | null);
  const toggle = required(root.querySelector<HTMLElement>('[data-ui-part="vase-toggle"]'));
  toggle.click();
  const field = required(root.querySelector<HTMLInputElement>('input[name="radius"]'));
  const owner = (
    ui.document as unknown as {
      realm: {
        listenerNodes: Set<unknown>;
        focusListeners: Set<unknown>;
        nodes: Map<unknown, unknown>;
        core: { free(): void };
      };
    }
  ).realm;
  const freed = vi.spyOn(owner.core, 'free');
  const pointer = (type: 'down' | 'up', element: Element) => {
    const rect = element.getBoundingClientRect();
    return ui.input.pointer({
      phase: type,
      pointerId: 1,
      pointerType: 'touch',
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
    });
  };
  return { ui, field, toggle, errors, owner, freed, pointer, retire };
}

it('completes and cancels replacement strings after sequential focus without submitting or requesting another keyboard', async () => {
  const current = await guide();
  const { ui, field } = current;
  const form = required(field.closest<HTMLFormElement>('form'));
  required(form.querySelector<HTMLInputElement>('input[name="height"]')).focus();
  ui.input.key({ type: 'keydown', key: 'Tab' });
  ui.input.key({ type: 'keyup', key: 'Tab' });
  expect(ui.input.focusedText()?.type).toBe('number');
  const changes: string[] = [];
  const submit = vi.fn((event: Event) => event.preventDefault());
  const editRequest = vi.fn();
  form.addEventListener('submit', submit);
  field.addEventListener('change', () => changes.push(field.value));
  ui.input.subscribeTextEdit(editRequest);
  ui.input.text('0.7');
  ui.input.commitText();
  ui.input.commitText();
  expect(changes).toEqual(['0.7']);
  expect(ui.input.focusedText()?.value).toBe('0.7');
  ui.input.text('0.8');
  ui.input.cancel();
  ui.input.cancel();
  expect(changes).toEqual(['0.7', '0.8']);
  expect(ui.input.focusedText()).toBeNull();
  field.focus();
  expect(ui.input.focusedText()?.value).toBe('0.8');
  expect(form.querySelector('input[name="radius"]')).toBe(field);
  expect(submit).not.toHaveBeenCalled();
  expect(editRequest).not.toHaveBeenCalled();
  current.retire();
  expect(current.freed).toHaveBeenCalledOnce();
  expect(current.errors).toEqual([]);
});

it.each([
  'pointerdown',
  'pointerup',
  'click',
  'keydown',
  'beforeinput',
  'change',
  'change-on-blur',
  'invalid',
  'submit',
  'wheel',
  'focus',
  'blur',
] as const)('finishes %s safely when its original-guide callback retires the UI Host', async (event) => {
  const current = await guide();
  const { ui, field, toggle } = current;
  const target =
    event === 'submit'
      ? required(field.closest<HTMLFormElement>('form'))
      : ['beforeinput', 'change', 'change-on-blur', 'invalid'].includes(event)
        ? field
        : toggle;
  if (event === 'focus') field.focus();
  else target.focus();
  const type = event === 'change-on-blur' ? 'change' : event;
  target.addEventListener(type, current.retire, { once: true });
  const late = vi.fn();
  target.addEventListener(type, late);
  const action = () => {
    if (event === 'pointerdown') current.pointer('down', toggle);
    else if (event === 'click' || event === 'pointerup') {
      current.pointer('down', toggle);
      current.pointer('up', toggle);
    } else if (event === 'keydown') ui.input.key({ type: 'keydown', key: 'Enter' });
    else if (event === 'focus') toggle.focus();
    else if (event === 'blur') field.focus();
    else if (event === 'beforeinput') ui.input.text('0.8');
    else if (event === 'change') {
      ui.input.text('0.8');
      ui.input.confirm();
    } else if (event === 'change-on-blur') {
      ui.input.text('0.8');
      toggle.focus();
    } else if (event === 'submit') {
      field.value = '0.8';
      // This fixture owns submission; the game's generator is a local button action.
      const submit = ui.document.createElement('button');
      submit.type = 'submit';
      target.appendChild(submit);
      submit.click();
    } else if (event === 'invalid') {
      field.value = '0.42';
      required(field.closest<HTMLFormElement>('form')).reportValidity();
    } else {
      const rect = toggle.getBoundingClientRect();
      ui.input.wheel({
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        deltaX: 0,
        deltaY: 40,
      });
    }
  };
  expect(action).not.toThrow();
  expect(current.freed).toHaveBeenCalledOnce();
  expect(late).not.toHaveBeenCalled();
  expect(current.errors).toEqual([]);
  expect([
    current.owner.listenerNodes.size,
    current.owner.focusListeners.size,
    current.owner.nodes.size,
  ]).toEqual([0, 0, 0]);
  expect(ui.input.pointer({ phase: 'up', pointerId: 1, pointerType: 'touch', x: 0, y: 0 })).toBe(
    false,
  );
  expect(ui.input.key({ type: 'keyup', key: 'Enter' })).toBe(false);
  expect(() => {
    ui.input.text('0.9');
    ui.input.confirm();
    ui.dispose();
  }).not.toThrow();
  expect(current.freed).toHaveBeenCalledOnce();
});

it('releases the real document once when pointer cancellation reenters UI disposal', async () => {
  const current = await guide();
  current.pointer('down', current.toggle);
  current.toggle.addEventListener('pointercancel', () => current.ui.dispose(), { once: true });
  expect(() => current.retire()).not.toThrow();
  expect(current.errors).toEqual([]);
  expect(current.freed).toHaveBeenCalledOnce();
});

it('revokes a held contact before its cancellation callback reenters cancel', async () => {
  const current = await guide();
  current.pointer('down', current.toggle);
  current.toggle.addEventListener('pointercancel', () => current.ui.input.cancel(), { once: true });
  const canceled = vi.fn();
  current.toggle.addEventListener('pointercancel', canceled);
  current.ui.input.cancel();
  expect(canceled).toHaveBeenCalledOnce();
  expect(current.ui.input.ownsInput()).toBe(false);
  expect(current.errors).toEqual([]);
});

it('releases every owner when a cancellation error reporter throws', async () => {
  const current = await guide(true);
  current.pointer('down', current.toggle);
  const failure = new Error('Native cancellation observer failed');
  current.toggle.addEventListener('pointercancel', () => {
    throw failure;
  });
  expect(() => current.retire()).toThrow(failure);
  expect(current.errors).toEqual([failure]);
  expect(current.freed).toHaveBeenCalledOnce();
  expect(current.ui.input.ownsInput()).toBe(false);
  expect([
    current.owner.listenerNodes.size,
    current.owner.focusListeners.size,
    current.owner.nodes.size,
  ]).toEqual([0, 0, 0]);
});

it('cancels every held contact and the editor even when an error reporter throws', async () => {
  const current = await guide(true);
  current.pointer('down', current.toggle);
  const rect = current.field.getBoundingClientRect();
  current.ui.input.pointer({
    phase: 'down',
    pointerId: 2,
    pointerType: 'touch',
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  });
  expect(current.ui.input.focusedText()).not.toBeNull();
  const failure = new Error('First cancellation observer failed');
  current.toggle.addEventListener('pointercancel', () => {
    throw failure;
  });
  const canceled = vi.fn();
  current.field.addEventListener('pointercancel', canceled);
  expect(() => current.ui.input.cancel()).toThrow(failure);
  expect(canceled).toHaveBeenCalledOnce();
  expect(current.ui.input.ownsInput()).toBe(false);
  expect(current.ui.input.focusedText()).toBeNull();
  expect(current.freed).not.toHaveBeenCalled();
  expect(current.errors).toEqual([failure]);
  current.toggle.focus();
  expect(current.ui.input.ownsInput()).toBe(true);
});

it.each([
  'remove',
  'disabled',
  'readonly',
  'hidden',
  'inert',
  'non-text type',
] as const)('stops the original guide edit when beforeinput makes the field %s', async (mutation) => {
  const current = await guide();
  const { ui, field } = current;
  field.value = '0.5';
  field.focus();
  const input = vi.fn();
  field.addEventListener('input', input);
  field.addEventListener(
    'beforeinput',
    () => {
      if (mutation === 'remove') field.remove();
      else if (mutation === 'disabled') field.disabled = true;
      else if (mutation === 'readonly') field.readOnly = true;
      else if (mutation === 'hidden') field.style.display = 'none';
      else if (mutation === 'inert') required(field.closest('form')).inert = true;
      else field.type = 'checkbox';
    },
    { once: true },
  );
  expect(() => ui.input.text('0.8')).not.toThrow();
  expect(field.value).toBe('0.5');
  expect(input).not.toHaveBeenCalled();
  expect(() => ui.paint(0)).not.toThrow();
  expect(current.errors).toEqual([]);
});

it('validates current guide fields after an earlier invalid callback corrects the radius', async () => {
  const current = await guide();
  const form = required(current.field.closest<HTMLFormElement>('form'));
  const height = required(form.querySelector<HTMLInputElement>('input[name="height"]'));
  height.value = '0';
  current.field.value = '0.42';
  const trace: string[] = [];
  height.addEventListener('invalid', () => {
    trace.push('height');
    current.field.value = '0.8';
  });
  current.field.addEventListener('invalid', () => trace.push('radius'));
  expect(form.reportValidity()).toBe(false);
  expect(trace).toEqual(['height']);
  expect(height.matches(':focus')).toBe(true);
  expect(current.field.validity.valid).toBe(true);
  expect(() => current.ui.paint(0)).not.toThrow();
  expect(current.errors).toEqual([]);
});
