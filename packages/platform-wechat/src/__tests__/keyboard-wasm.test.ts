import { readFile } from 'node:fs/promises';
import type { Platform, PlatformEvent } from '@forgeax/engine-platform';
import { ok } from '@forgeax/engine-types';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createWechatInputBackend,
  type WechatTouchEvent,
  type WechatTouchSource,
} from '../input.js';
import {
  attachWechatKeyboard,
  type WechatKeyboardEvent,
  type WechatKeyboardSource,
} from '../keyboard.js';

const { createBlitzUi } = (await import(
  new URL('../../../ui-blitz/src/index.ts', import.meta.url).href
)) as typeof import('@forgeax/engine-ui-blitz');
const bytes = await readFile(new URL('../../../ui-blitz/pkg/ui_blitz_bg.wasm', import.meta.url));
const wasm = {
  readWasm: async () => bytes,
  instantiate: (imports: unknown) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
};
const releases: (() => void)[] = [];
afterEach(() => {
  for (const release of releases.splice(0).reverse()) release();
});
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected the keyboard fixture element to exist');
  return value;
}

function nativeKeyboard() {
  const callbacks = new Map<string, (event: WechatKeyboardEvent) => void>();
  const source: WechatKeyboardSource = {
    showKeyboard: vi.fn(),
    hideKeyboard: vi.fn(),
    onKeyboardInput: (callback) => {
      callbacks.set('input', callback);
    },
    offKeyboardInput: () => {
      callbacks.delete('input');
    },
    onKeyboardConfirm: (callback) => {
      callbacks.set('confirm', callback);
    },
    offKeyboardConfirm: () => {
      callbacks.delete('confirm');
    },
    onKeyboardComplete: (callback) => {
      callbacks.set('complete', callback);
    },
    offKeyboardComplete: () => {
      callbacks.delete('complete');
    },
  };
  return { callbacks, source };
}

it('opens native editing only on input or label taps and keeps invalid feedback after Done', async () => {
  const errors: unknown[] = [];
  const ui = await createBlitzUi({
    wasm,
    html: '<style>body{margin:0;background:#123}input,button,label{position:absolute;width:90px;height:30px}label{top:0}input{top:40px}button{top:80px}</style><form><label for="radius">Radius</label><input id="radius" type="number" min="0.1" step="0.05" required><button>Generate</button></form>',
    width: 320,
    height: 160,
    onError: (error) => errors.push(error),
  });
  releases.push(() => ui.dispose());
  const { callbacks, source } = nativeKeyboard();
  releases.push(attachWechatKeyboard(ui.input, source, (error) => errors.push(error)));
  const field = required(ui.document.querySelector<HTMLInputElement>('input'));
  const label = required(ui.document.querySelector('label'));
  const button = required(ui.document.querySelector('button'));
  let submitted = 0,
    changes = 0;
  field.addEventListener('change', () => {
    changes++;
  });
  required(ui.document.querySelector('form')).addEventListener('submit', (event) => {
    event.preventDefault();
    submitted++;
  });
  const tap = (element: Element) => {
    const box = element.getBoundingClientRect();
    for (const phase of ['down', 'up'] as const)
      ui.input.pointer({
        phase,
        pointerId: 1,
        pointerType: 'touch',
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
      });
  };
  field.value = '0.42';
  field.focus();
  expect(source.showKeyboard).not.toHaveBeenCalled();
  tap(button);
  expect(submitted).toBe(0);
  expect(ui.document.activeElement).toBe(field);
  expect(field.validity.stepMismatch).toBe(true);
  expect(source.showKeyboard).not.toHaveBeenCalled();
  expect(ui.paint(0)).not.toBeNull();
  tap(field);
  expect(source.showKeyboard).toHaveBeenCalledTimes(1);
  expect(source.showKeyboard).toHaveBeenCalledWith(
    expect.objectContaining({ keyboardType: 'text', defaultValue: '0.42' }),
  );
  callbacks.get('confirm')?.({ value: '0.42' });
  const invalidPixels = ui.paint(0);
  expect(invalidPixels).not.toBeNull();
  callbacks.get('complete')?.({ value: '0.42' });
  expect(ui.document.activeElement).toBe(field);
  expect(ui.paint(0)).toBeNull();
  expect(callbacks.size).toBe(0);
  tap(field);
  expect(source.showKeyboard).toHaveBeenCalledTimes(2);
  for (const value of ['-', '-0', '-0.', '-0.75']) callbacks.get('input')?.({ value });
  expect(field.value).toBe('-0.75');
  expect(field.validity.rangeUnderflow).toBe(true);
  for (const value of ['.', '.7', '.75']) callbacks.get('input')?.({ value });
  expect(Number(field.value)).toBe(0.75);
  expect(field.validity.valid).toBe(true);
  for (const value of ['3', '3.', '3.5']) callbacks.get('input')?.({ value });
  expect(field.value).toBe('3.5');
  callbacks.get('input')?.({ value: '0.8' });
  callbacks.get('confirm')?.({ value: '0.8' });
  callbacks.get('complete')?.({ value: '0.8' });
  expect([submitted, changes]).toEqual([1, 1]);
  expect(ui.document.activeElement).toBe(field);
  label.addEventListener('click', (event) => event.preventDefault(), { once: true });
  tap(label);
  expect(source.showKeyboard).toHaveBeenCalledTimes(2);
  tap(label);
  expect(source.showKeyboard).toHaveBeenCalledTimes(3);
  callbacks.get('complete')?.({ value: '0.9' });
  expect(changes).toBe(2);
  field.addEventListener('click', (event) => event.preventDefault(), { once: true });
  tap(field);
  expect(source.showKeyboard).toHaveBeenCalledTimes(3);
  expect(errors).toEqual([]);
});

it('recreates the ordinary guide while retiring native editors and borrowed-port listeners', async () => {
  const authored = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');
  const [html, css, localization, font, controller] = await Promise.all([
    authored('../../../../templates/game-3d/assets/guide.ui.html'),
    authored('../../../../templates/game-3d/assets/guide.ui.css'),
    authored('../../../../templates/game-3d/assets/guide.ui.i18n.json'),
    readFile(
      new URL(
        '../../../devkit/node_modules/@fontsource-variable/noto-sans-sc/files/noto-sans-sc-latin-wght-normal.woff2',
        import.meta.url,
      ),
    ),
    import(
      new URL('../../../../templates/game-3d/assets/ui/guide-controller.ts', import.meta.url).href
    ) as Promise<{
      createGuideUi(
        asset: { guid: string; html: string; css: string; localization: object },
        host: {
          uiRoot: HTMLElement;
          port: MessagePort;
          controlMode: { read(): 'touch'; subscribe(listener: () => void): () => void };
        },
      ): Promise<{ host: HTMLElement; signal: AbortSignal; dispose(): void }>;
    }>,
  ]);
  const errors: unknown[] = [];
  const { callbacks, source } = nativeKeyboard();
  const channel = new MessageChannel();
  releases.push(() => {
    channel.port1.close();
    channel.port2.close();
  });
  const messages: { channel: string; kind: string; values?: Record<string, number> }[] = [];
  channel.port2.addEventListener('message', (event) => messages.push(event.data));
  channel.port2.start();
  const added = vi.spyOn(channel.port1, 'addEventListener');
  const removed = vi.spyOn(channel.port1, 'removeEventListener');
  const closed = vi.spyOn(channel.port1, 'close');
  const modes = new Set<() => void>();
  const controlMode = {
    read: () => 'touch' as const,
    subscribe(listener: () => void) {
      modes.add(listener);
      return () => modes.delete(listener);
    },
  };
  const generated = () => messages.filter((message) => message.kind === 'generate');
  const inspected = () => messages.filter((message) => message.kind === 'inspect');
  const oldEditors: ((event: WechatKeyboardEvent) => void)[] = [];
  let cycles = 0;
  for (let generation = 0; generation < 3; generation++) {
    const ui = await createBlitzUi({
      wasm,
      html: '<style>html,body{margin:0;width:100%;height:100%}</style>',
      width: 390,
      height: 640,
      font,
      onError: (error) => errors.push(error),
    });
    releases.push(() => ui.dispose());
    const owner = (
      ui.document as unknown as {
        realm: {
          listenerNodes: Set<unknown>;
          focusListeners: Set<unknown>;
          nodes: Map<unknown, unknown>;
        };
      }
    ).realm;
    const baseline = {
      listeners: owner.listenerNodes.size,
      focus: owner.focusListeners.size,
      children: ui.document.body.children.length,
    };
    const detach = attachWechatKeyboard(ui.input, source, (error) => errors.push(error));
    releases.push(detach);
    for (const callback of oldEditors) callback({ value: '1.4' });
    expect(callbacks.size).toBe(0);
    const tap = (element: Element) => {
      const box = element.getBoundingClientRect();
      expect(box.width).toBeGreaterThan(0);
      for (const phase of ['down', 'up'] as const)
        ui.input.pointer({
          phase,
          pointerId: 1,
          pointerType: 'touch',
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
        });
    };
    for (let mount = 0; mount < 3; mount++) {
      const guide = await controller.createGuideUi(
        { guid: 'ordinary-guide-lifecycle', html, css, localization: JSON.parse(localization) },
        {
          uiRoot: ui.document.body,
          port: channel.port1,
          controlMode,
        },
      );
      releases.push(() => guide.dispose());
      cycles++;
      await expect.poll(() => inspected().length).toBe(cycles);
      expect(modes.size).toBe(1);
      expect(owner.listenerNodes.size).toBeGreaterThan(baseline.listeners);
      const root = required(guide.host.shadowRoot);
      const toggle = required(root.querySelector<HTMLElement>('[data-ui-part="vase-toggle"]'));
      const field = required(root.querySelector<HTMLInputElement>('input[name="radius"]'));
      const status = required(root.querySelector<HTMLElement>('[data-ui-part="vase-status"]'));
      tap(toggle);
      tap(field);
      expect(callbacks.size).toBe(3);
      const canceled = [...callbacks.values()];
      callbacks.get('input')?.({ value: '0.42' });
      expect(field.value).toBe('0.42');
      ui.input.cancel();
      expect(root.activeElement).toBeNull();
      expect(callbacks.size).toBe(0);
      for (const callback of canceled) callback({ value: '0.9' });
      expect(field.value).toBe('0.42');
      expect(generated()).toHaveLength(cycles - 1);

      tap(field);
      const completed = required(callbacks.get('complete'));
      completed({ value: '0.8' });
      completed({ value: '0.9' });
      expect(field.value).toBe('0.8');
      expect(root.activeElement).toBe(field);
      expect(callbacks.size).toBe(0);
      expect(generated()).toHaveLength(cycles - 1);
      tap(required(root.querySelector('[data-ui-part="vase-controls"] button')));
      await expect.poll(() => generated().length).toBe(cycles);
      expect(generated().at(-1)?.values?.radius).toBe(0.8);

      tap(field);
      const retired = [...callbacks.values()];
      oldEditors.push(...retired);
      expect(retired).toHaveLength(3);
      const previousStatus = status.textContent;
      guide.dispose();
      guide.dispose();
      expect(guide.signal.aborted).toBe(true);
      expect(root.activeElement).toBeNull();
      expect(callbacks.size).toBe(0);
      expect(modes.size).toBe(0);
      expect(owner.listenerNodes.size).toBe(baseline.listeners);
      expect(owner.focusListeners.size).toBe(baseline.focus);
      expect(ui.document.body.children).toHaveLength(baseline.children);
      for (const callback of retired) callback({ value: '1.2' });
      // FIFO delivery on the same port proves the late state has been dispatched.
      await new Promise<void>((resolve) => {
        const drained = (event: MessageEvent) => {
          if (event.data.channel !== 'lifecycle') return;
          channel.port1.removeEventListener('message', drained);
          resolve();
        };
        channel.port1.addEventListener('message', drained);
        channel.port2.postMessage({
          channel: 'game-3d/runtime-vase',
          kind: 'state',
          state: { busy: true },
        });
        channel.port2.postMessage({ channel: 'lifecycle', kind: 'barrier' });
      });
      expect(status.textContent).toBe(previousStatus);
      expect(field.value).toBe('0.8');
      expect(generated()).toHaveLength(cycles);
      expect(closed).not.toHaveBeenCalled();
    }
    const addedMessages = added.mock.calls.filter(([name]) => name === 'message');
    const removedMessages = removed.mock.calls.filter(([name]) => name === 'message');
    expect(removedMessages).toHaveLength(addedMessages.length);
    for (const [, callback] of addedMessages)
      expect(removedMessages.some(([, removedCallback]) => removedCallback === callback)).toBe(
        true,
      );
    detach();
    ui.dispose();
    for (const callback of oldEditors) callback({ value: '1.4' });
    expect([
      owner.listenerNodes.size,
      owner.focusListeners.size,
      owner.nodes.size,
      callbacks.size,
    ]).toEqual([0, 0, 0, 0]);
  }
  expect(cycles).toBe(9);
  expect(errors).toEqual([]);
}, 30_000);

it('keeps native number controls and editors isolated across host visibility changes', async () => {
  const errors: unknown[] = [];
  const ui = await createBlitzUi({
    wasm,
    html: '<style>body{margin:0}input{position:absolute;left:20px;top:20px;width:120px;height:32px;box-sizing:border-box;padding:4px;border:1px solid #789;font:13px sans-serif}</style><input type=number min=0.6 max=0.7 step=0.05 value=0.65>',
    width: 240,
    height: 100,
    font: await readFile(
      new URL(
        '../../../../third_party/blitz/packages/blitz-dom/tests/fonts/dejavu-sans-ascii.ttf',
        import.meta.url,
      ),
    ),
    onError: (error) => errors.push(error),
  });
  releases.push(() => ui.dispose());
  const keyboard = nativeKeyboard();
  let visible = true;
  const lifecycle = new Set<(event: PlatformEvent) => void>();
  const events = new Map<string, (event: WechatTouchEvent) => void>();
  const source: WechatTouchSource = {
    onTouchStart: (listener) => {
      events.set('down', listener);
    },
    offTouchStart: () => {
      events.delete('down');
    },
    onTouchMove: (listener) => {
      events.set('move', listener);
    },
    offTouchMove: () => {
      events.delete('move');
    },
    onTouchEnd: (listener) => {
      events.set('up', listener);
    },
    offTouchEnd: () => {
      events.delete('up');
    },
    onTouchCancel: (listener) => {
      events.set('cancel', listener);
    },
    offTouchCancel: () => {
      events.delete('cancel');
    },
  };
  const platform: Platform = {
    now: () => ok(0),
    requestFrame: () => ok(() => {}),
    visible: () => visible,
    display: () =>
      ok({
        width: 240,
        height: 100,
        pixelRatio: 1,
        drawingWidth: 240,
        drawingHeight: 100,
        safeArea: { x: 0, y: 0, width: 240, height: 100 },
      }),
    subscribe: (listener) => {
      lifecycle.add(listener);
      return ok(() => {
        lifecycle.delete(listener);
      });
    },
    dispose: () => {},
  };
  const backend = createWechatInputBackend(source, platform, {
    ui: ui.input,
    keyboard: keyboard.source,
    onError: (error) => errors.push(error),
  }).unwrap();
  releases.push(() => backend.detach());
  const field = required(ui.document.querySelector<HTMLInputElement>('input'));
  const changes: string[] = [];
  field.addEventListener('change', () => changes.push(field.value));
  const tap = (direction: -1 | 0 | 1) => {
    const rect = field.getBoundingClientRect();
    const x = direction === 0 ? rect.x + 12 : rect.right - 12;
    const y = rect.y + rect.height / 2 - direction * 4;
    for (const phase of ['down', 'up']) {
      required(events.get(phase))({ changedTouches: [{ identifier: 3, clientX: x, clientY: y }] });
      expect(backend.sample()).toMatchObject({ pointers: [], pointerEvents: [] });
    }
  };
  for (const [direction, value] of [
    [1, '0.7'],
    [1, '0.7'],
    [-1, '0.65'],
    [-1, '0.6'],
    [-1, '0.6'],
  ] as const) {
    tap(direction);
    expect(field.value).toBe(value);
    expect(keyboard.source.showKeyboard).not.toHaveBeenCalled();
  }
  expect(changes).toEqual(['0.7', '0.65', '0.6']);
  field.readOnly = true;
  tap(1);
  expect(field.value).toBe('0.6');
  field.readOnly = false;
  field.disabled = true;
  tap(1);
  expect(field.value).toBe('0.6');
  expect(keyboard.source.showKeyboard).not.toHaveBeenCalled();
  field.disabled = false;
  tap(0);
  expect(keyboard.source.showKeyboard).toHaveBeenCalledTimes(1);
  // Native Android keyboard opening/resizing must not cancel the editor it just opened.
  for (const listener of lifecycle)
    listener({ kind: 'display', display: platform.display().unwrap() });
  expect(ui.input.focusedText()?.value).toBe('0.6');
  expect(keyboard.source.hideKeyboard).not.toHaveBeenCalled();
  expect(keyboard.callbacks.size).toBe(3);
  expect(backend.sample()).toMatchObject({ focusReset: true, pointers: [], pointerEvents: [] });
  keyboard.callbacks.get('input')?.({ value: '0.65' });
  keyboard.callbacks.get('complete')?.({ value: '0.65' });
  expect(field.value).toBe('0.65');
  expect(changes).toEqual(['0.7', '0.65', '0.6', '0.65']);

  tap(0);
  const late = [...keyboard.callbacks.values()];
  const cause = new Error('native keyboard unsubscribe failed');
  const unsubscribe = keyboard.source.offKeyboardInput;
  vi.spyOn(keyboard.source, 'offKeyboardInput').mockImplementationOnce((listener) => {
    unsubscribe(listener);
    throw cause;
  });
  visible = false;
  let failure: unknown;
  try {
    for (const listener of lifecycle) listener({ kind: 'visibility', visible });
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    code: 'platform-operation-failed',
    detail: {
      operation: 'release',
      cause: { errors: [{ detail: { cause: { errors: [cause] } } }] },
    },
  });
  expect(keyboard.source.hideKeyboard).toHaveBeenCalledTimes(1);
  expect(keyboard.callbacks.size).toBe(0);
  expect(ui.input.focusedText()).toBeNull();
  expect(backend.sample()).toMatchObject({
    focused: false,
    focusReset: true,
    pointers: [],
    pointerEvents: [],
  });
  for (const callback of late) callback({ value: '0.9' });
  expect(field.value).toBe('0.65');
  visible = true;
  for (const listener of lifecycle) listener({ kind: 'visibility', visible });
  tap(0);
  expect(keyboard.source.showKeyboard).toHaveBeenCalledTimes(3);
  keyboard.callbacks.get('input')?.({ value: '0.7' });
  expect(field.value).toBe('0.7');
  backend.detach();
  expect(keyboard.source.hideKeyboard).toHaveBeenCalledTimes(2);
  expect([events.size, lifecycle.size, keyboard.callbacks.size]).toEqual([0, 0, 0]);
  expect(errors).toEqual([]);
});
