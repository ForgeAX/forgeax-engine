import { ok } from '@forgeax/engine-types';
import type {} from '@vitest/browser-playwright';
import { afterEach, expect, it } from 'vitest';
import { cdp, commands, page, userEvent } from 'vitest/browser';
import { attachBrowserInputBackend } from '../../../input/src/browser-backend.js';
import type { Platform } from '../../../platform/src/index.js';
import {
  createWechatInputBackend,
  type WechatTouchEvent,
  type WechatTouchSource,
} from '../../../platform-wechat/src/input.js';
import { createBlitzUi } from '../index.js';
import { required, uiEvidenceDirectory } from './fixture.js';
import { inventoryHtml, mountInventory } from './inventory-fixture.js';

const bytes = new Uint8Array(
  await (await fetch(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url))).arrayBuffer(),
);
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

it('keeps dynamic inventory focus, held contacts and gameplay input on their own paths', async () => {
  const width = 360,
    height = 360;
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
  const iframe = document.createElement('iframe');
  iframe.style.cssText = `position:absolute;left:0;top:28px;width:${width}px;height:${height}px;border:0;z-index:1`;
  const loaded = new Promise<void>((resolve) => {
    iframe.onload = () => resolve();
  });
  iframe.srcdoc = inventoryHtml;
  document.body.append(iframe);
  cleanup.push(() => iframe.remove());
  await loaded;
  const browser = required(iframe.contentDocument);
  browser.fonts.add(await new FontFace('Inventory Fixture', font.slice().buffer).load());
  await browser.fonts.load('14px "Noto Sans SC Variable"', '×');
  await browser.fonts.ready;
  const errors: unknown[] = [];
  const ui = await createBlitzUi({
    wasm: {
      readWasm: async () => bytes,
      instantiate: (imports) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
    },
    html: inventoryHtml,
    width,
    height,
    font,
    fontFamily: 'Inventory Fixture',
    onError: (error) => errors.push(error),
  });
  cleanup.push(() => ui.dispose());
  const native = mountInventory(browser),
    portable = mountInventory(ui.document);
  const instances = [native, portable];
  const acquisition = attachBrowserInputBackend(native.game, {
    uiRoot: native.inventory,
    document: browser,
    window: required(browser.defaultView),
    pointerLockAllowed: () => false,
    navigator: { getGamepads: () => [] },
  });
  cleanup.push(acquisition);
  const callbacks = new Map<string, (event: WechatTouchEvent) => void>();
  const source: WechatTouchSource = {
    onTouchStart: (fn) => {
      callbacks.set('down', fn);
    },
    offTouchStart: () => {
      callbacks.delete('down');
    },
    onTouchMove: (fn) => {
      callbacks.set('move', fn);
    },
    offTouchMove: () => {
      callbacks.delete('move');
    },
    onTouchEnd: (fn) => {
      callbacks.set('up', fn);
    },
    offTouchEnd: () => {
      callbacks.delete('up');
    },
    onTouchCancel: (fn) => {
      callbacks.set('cancel', fn);
    },
    offTouchCancel: () => {
      callbacks.delete('cancel');
    },
  };
  // Only native platform facts are supplied. The actual provider and real WASM
  // UI port own acquisition, focus changes and gameplay contact retirement.
  const platform = {
    visible: () => true,
    display: () => ok({ width, height, drawingWidth: width, drawingHeight: height }),
    subscribe: () => ok(() => {}),
  } as unknown as Platform;
  const backend = createWechatInputBackend(source, platform, { ui: ui.input }).unwrap();
  cleanup.push(() => backend.detach());
  const touch = (phase: string, identifier: number, x: number, y: number) =>
    required(callbacks.get(phase))({ changedTouches: [{ identifier, clientX: x, clientY: y }] });
  const key = async (key: string, shiftKey = false) => {
    await userEvent.keyboard(shiftKey ? `{Shift>}{${key}}{/Shift}` : `{${key}}`);
    ui.input.key({ type: 'keydown', key, shiftKey });
    ui.input.key({ type: 'keyup', key, shiftKey });
  };
  const add = async () => {
    for (const instance of instances) instance.add.focus();
    await key('Enter');
  };
  const active = (doc: Document) => doc.activeElement?.id ?? '';
  const expectFocus = (id: string) => {
    expect(active(browser)).toBe(id);
    expect(active(ui.document)).toBe(id);
  };
  const stage = document.createElement('section');
  stage.style.cssText = `position:absolute;left:0;top:0;width:${width * 2 + 12}px;height:${height + 28}px;background:#10243a;color:white;font:13px/28px sans-serif`;
  stage.textContent = 'Chromium DOM (left) · Blitz WASM (right) · Dynamic inventory';
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.cssText = `position:absolute;left:${width + 12}px;top:28px`;
  stage.append(canvas);
  document.body.append(stage);
  cleanup.push(() => stage.remove());
  await page.viewport(width * 2 + 12, height + 28);
  const evidence = uiEvidenceDirectory(required(expect.getState().testPath), 'ui-inventory-focus');
  const states: unknown[] = [];
  const capture = async (name: string) => {
    await new Promise(requestAnimationFrame);
    const pixels = ui.paint(performance.now());
    if (pixels)
      required(canvas.getContext('2d')).putImageData(
        new ImageData(new Uint8ClampedArray(pixels), width, height),
        0,
        0,
      );
    const snapshots = instances.map((instance) => ({
      active: active(instance.document),
      ids: Array.from(instance.items.children, (item) => item.id),
      trace: [...instance.trace],
      rectangles: Array.from(instance.items.querySelectorAll('button'), (button) => {
        const { x, y, width, height } = button.getBoundingClientRect();
        return [x, y, width, height];
      }),
    }));
    expect(snapshots[1]).toEqual(snapshots[0]);
    states.push({ name, snapshots, ownsInput: ui.input.ownsInput() });
    await commands.writeFile(
      `${evidence}/states.json`,
      JSON.stringify({ states, errors }, null, 2),
    );
    await page.elementLocator(stage).screenshot({ path: `${evidence}/${name}.png` });
  };
  await capture('01-initial');
  native.game.focus();
  await userEvent.keyboard('{w>}');
  expect(acquisition.backend.sample().downKeys.has('w')).toBe(true);
  touch('down', 90, 30, 320);
  expect(required(backend.sample().pointerEvents).map((event) => event.phase)).toEqual(['down']);
  await add();
  expectFocus('b');
  expect(acquisition.backend.sample().downKeys.size).toBe(0);
  expect(backend.sample()).toMatchObject({
    focused: false,
    pointers: [],
    pointerEvents: [],
    focusReset: true,
  });
  await userEvent.keyboard('{/w}');
  for (const phase of ['move', 'up']) touch(phase, 90, 35, 320);
  expect(backend.sample().pointerEvents).toEqual([]);
  await capture('02-inserted-keyboard-focus');
  await key('Delete');
  expectFocus('');
  await key('Tab');
  expectFocus('c');
  await capture('03-removed-forward-tab');
  await add();
  await key('Delete');
  await key('Tab', true);
  expectFocus('a');
  await capture('04-removed-reverse-tab');
  await add();
  await key('Delete');
  for (const instance of instances)
    instance.items.insertBefore(instance.row, instance.c.parentElement);
  await key('Tab');
  expectFocus('b');
  for (const instance of instances) expect(instance.items.querySelector('#b')).toBe(instance.b);
  await capture('05-reinserted-retained-row');

  for (const instance of instances)
    instance.b.addEventListener(
      'pointerdown',
      () => {
        instance.row.remove();
        instance.trace.push('pointer-remove');
      },
      { once: true },
    );
  const box = native.b.getBoundingClientRect(),
    frame = iframe.getBoundingClientRect();
  await cdp().send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: frame.x + box.x + box.width / 2,
    y: frame.y + box.y + box.height / 2,
    button: 'left',
    clickCount: 1,
  });
  const target = portable.b.getBoundingClientRect();
  touch('down', 91, target.x + target.width / 2, target.y + target.height / 2);
  expect(ui.input.ownsInput()).toBe(true);
  expect(backend.sample()).toMatchObject({ pointers: [], pointerEvents: [] });
  // Removal cannot transfer an in-progress UI contact to gameplay.
  await cdp().send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: frame.x + 30,
    y: frame.y + 320,
    button: 'left',
    buttons: 1,
  });
  touch('move', 91, 30, 320);
  expect(backend.sample().pointerEvents).toEqual([]);
  await cdp().send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: frame.x + 30,
    y: frame.y + 320,
    button: 'left',
    clickCount: 1,
  });
  touch('up', 91, 30, 320);
  expect(ui.input.ownsInput()).toBe(false);
  expect(backend.sample()).toMatchObject({ pointers: [], pointerEvents: [] });
  expect(acquisition.backend.sample().pointerEvents ?? []).toEqual([]);
  expect(portable.trace).not.toContain('use:b');
  await capture('06-held-contact-retired');
  for (const instance of instances) instance.close.focus();
  await key('Enter');
  await capture('07-closed');
  touch('down', 92, 30, 320);
  touch('up', 92, 30, 320);
  expect(required(backend.sample().pointerEvents).map((event) => event.phase)).toEqual([
    'down',
    'up',
  ]);
  native.game.focus();
  await userEvent.keyboard('{w>}');
  expect(acquisition.backend.sample().downKeys.has('w')).toBe(true);
  await userEvent.keyboard('{/w}');
  expect(errors).toEqual([]);
});
