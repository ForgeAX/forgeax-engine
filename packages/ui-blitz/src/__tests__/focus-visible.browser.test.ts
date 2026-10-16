import { mountUi, type UiAsset } from '@forgeax/engine-ui';
import { afterEach, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createBlitzUi } from '../index.js';
import { required, uiEvidenceDirectory } from './fixture.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const release of cleanup.splice(0).reverse()) release();
});

it('keeps the original HUD focus-visible source and its pointer, keyboard and script behavior', async () => {
  const evidence = uiEvidenceDirectory(
    required(expect.getState().testPath),
    'ui-hud-focus-visible',
  );
  const source = await (
    await fetch(
      new URL('../../../../apps/game-capability-lab/assets/ui/hud.pack.json', import.meta.url),
    )
  ).json();
  const asset: UiAsset = { guid: 'original-capability-hud', ...source.assets['ui/hud'].payload };
  const fontUrl = new URL(
    '../../../devkit/node_modules/@fontsource-variable/noto-sans-sc/files/noto-sans-sc-latin-wght-normal.woff2',
    import.meta.url,
  );
  const symbolsUrl = new URL(
    '../../../devkit/node_modules/@fontsource-variable/noto-sans-sc/files/noto-sans-sc-87-wght-normal.woff2',
    import.meta.url,
  );
  const symbols = new Uint8Array(await (await fetch(symbolsUrl)).arrayBuffer());
  const bytes = new Uint8Array(
    await (await fetch(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url))).arrayBuffer(),
  );
  const font = new Uint8Array(await (await fetch(fontUrl)).arrayBuffer());
  const stage = document.createElement('section');
  stage.style.cssText =
    'position:absolute;left:0;top:0;width:1292px;height:508px;background:#10243a;color:white';
  const legend = document.createElement('div');
  legend.style.cssText = 'height:28px;font:14px/28px sans-serif';
  legend.textContent = 'Chromium (left) · Blitz (right) · original capability-lab HUD';
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:absolute;left:0;top:28px;width:640px;height:480px;border:0';
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  canvas.style.cssText = 'position:absolute;left:652px;top:28px';
  stage.append(legend, iframe, canvas);
  document.body.append(stage);
  cleanup.push(() => stage.remove());
  const loaded = new Promise<void>((resolve) => {
    iframe.onload = () => resolve();
  });
  const shell =
    '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;background:#10243a}@font-face{font-family:"HUD Fixture";font-weight:100 900;src:url(https://hud-font.invalid/symbols.woff2);unicode-range:U+2665}</style>';
  iframe.srcdoc = shell;
  await loaded;
  const native = required(iframe.contentDocument);
  // Both references use the same variable face and the symbol subset needed by the original hearts.
  native.fonts.add(
    await new FontFace('HUD Fixture', font.slice().buffer, { weight: '100 900' }).load(),
  );
  native.fonts.add(
    await new FontFace('HUD Fixture', symbols.slice().buffer, {
      weight: '100 900',
      unicodeRange: 'U+2665',
    }).load(),
  );
  const errors: unknown[] = [];
  const ui = await createBlitzUi({
    wasm: {
      readWasm: async () => bytes,
      instantiate: (imports) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
    },
    html: shell,
    width: 640,
    height: 480,
    font,
    fontFamily: 'HUD Fixture',
    resources: {
      baseUrl: 'https://hud-font.invalid/',
      read: async (url) => {
        expect(url).toBe('https://hud-font.invalid/symbols.woff2');
        return symbols;
      },
    },
    onError: (error) => errors.push(error),
  });
  cleanup.push(() => ui.dispose());
  const instances = [native, ui.document].map((document) => {
    const mounted = mountUi(asset, { root: document.body, layer: 1 });
    if (!mounted.ok) throw mounted.error;
    cleanup.push(() => mounted.value.dispose());
    // Both references select the same prepared face; the original HUD CSS stays intact.
    mounted.value.host.style.fontFamily = '"HUD Fixture"';
    const root = required(mounted.value.host.shadowRoot);
    required(root.querySelector<HTMLDetailsElement>('.asset-lab')).open = true;
    return { root, buttons: [...root.querySelectorAll<HTMLButtonElement>('.asset-control')] };
  });
  const snapshot = () =>
    instances.map(({ buttons }, index) =>
      buttons.map((node) => ({
        action: node.dataset.uiAction,
        focus: node.matches(':focus'),
        visible: node.matches(':focus-visible'),
        background: (index === 0
          ? required(native.defaultView).getComputedStyle(node)
          : ui.getComputedStyle(node)
        ).getPropertyValue('background-color'),
      })),
    );
  const compare = () => {
    const [browser, blitz] = snapshot();
    expect(blitz).toEqual(browser);
  };
  const paint = async (name: string) => {
    const pixels = ui.paint(0);
    if (pixels)
      required(canvas.getContext('2d')).putImageData(
        new ImageData(new Uint8ClampedArray(pixels), 640, 480),
        0,
        0,
      );
    await page.viewport(1292, 508);
    await page.elementLocator(stage).screenshot({ path: `${evidence}/${name}.png` });
  };
  for (const instance of instances) required(instance.buttons[0]).focus();
  compare();
  expect(required(instances[1]?.buttons[0]).matches(':focus-visible')).toBe(true);
  await paint('01-script-keyboard-focus');

  const clickTrace: string[] = [];
  for (const type of ['pointerdown', 'mousedown', 'focus', 'click'])
    required(instances[0]?.buttons[1]).addEventListener(type, (event) => {
      expect(event.isTrusted).toBe(true);
      clickTrace.push(type);
    });
  const browserTarget = required(instances[0]?.buttons[1]).getBoundingClientRect();
  // Target the enclosing frame so Playwright dispatches real pointer defaults inside it.
  await page.elementLocator(iframe).click({
    position: {
      x: browserTarget.x + browserTarget.width / 2,
      y: browserTarget.y + browserTarget.height / 2,
    },
  });
  expect(clickTrace).toEqual(['pointerdown', 'mousedown', 'focus', 'click']);
  await userEvent.hover(legend);
  const target = required(instances[1]?.buttons[1]);
  const rect = target.getBoundingClientRect();
  for (const phase of ['down', 'up'] as const)
    ui.input.pointer({
      phase,
      pointerId: 1,
      pointerType: 'touch',
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
    });
  compare();
  expect(target.matches(':focus-visible')).toBe(false);
  await paint('02-pointer-focus');
  await userEvent.keyboard('{Tab}');
  for (const type of ['keydown', 'keyup'] as const) ui.input.key({ type, key: 'Tab' });
  compare();
  expect(required(instances[1]?.buttons[2]).matches(':focus-visible')).toBe(true);
  for (const instance of instances) required(instance.buttons[3]).focus();
  compare();
  await paint('03-tab-script-focus');
  expect(errors).toEqual([]);
});
