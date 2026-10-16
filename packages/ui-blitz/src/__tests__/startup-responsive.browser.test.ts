import type { UiAsset, UiInstance } from '@forgeax/engine-ui';
import type {} from '@vitest/browser-playwright';
import { afterEach, expect, it } from 'vitest';
import { cdp, commands, page } from 'vitest/browser';
import { createBlitzUi } from '../index.js';
import { required, uiEvidenceDirectory } from './fixture.js';

const bytes = new Uint8Array(
  await (await fetch(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url))).arrayBuffer(),
);
const wasm = {
  readWasm: async () => bytes,
  instantiate: (imports: object) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
};

const cleanup: (() => void)[] = [];
afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) release();
  await cdp().send('Emulation.setScrollbarsHidden', { hidden: false });
});

it.each([
  'guide',
  'settings',
] as const)('keeps slow and fatal Reload reachable above the %s UI in a short viewport', async (consumer) => {
  const source = (await import(
    /* @vite-ignore */
    new URL('../../../devkit/src/host/startup-source.ts', import.meta.url).href
  )) as {
    hostStartupDocument(title: string): string;
    hostStartupScript(enabled: boolean, host: string): string;
  };
  const width = 600,
    height = 240;
  let now = 0;
  await page.viewport(width * 2 + 12, height);
  await cdp().send('Emulation.setScrollbarsHidden', { hidden: true });
  const html = source.hostStartupDocument('Ordinary game startup');
  const stage = document.createElement('section');
  stage.style.cssText = `position:absolute;inset:0;width:${width * 2 + 12}px;height:${height}px`;
  const iframe = document.createElement('iframe');
  iframe.style.cssText = `position:absolute;inset:0;width:${width}px;height:${height}px;border:0`;
  const loaded = new Promise<void>((resolve) => {
    iframe.onload = () => resolve();
  });
  iframe.srcdoc = html;
  stage.append(iframe);
  document.body.append(stage);
  cleanup.push(() => stage.remove());
  await loaded;
  const browser = required(iframe.contentDocument);
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
  browser.fonts.add(
    await new FontFace('Startup Fixture', font.slice().buffer, { weight: '100 900' }).load(),
  );
  const errors: unknown[] = [];
  const ui = await createBlitzUi({
    wasm,
    html,
    width,
    height,
    font,
    fontFamily: 'Startup Fixture',
    reducedMotion: true,
    onError: (error) => errors.push(error),
  });
  cleanup.push(() => ui.dispose());
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.cssText = `position:absolute;left:${width + 12}px;top:0`;
  stage.append(canvas);
  const instances = await Promise.all(
    [browser, ui.document].map(async (document) => {
      const gameRoot = required(document.querySelector<HTMLElement>('#game-ui'));
      const surface = required(document.querySelector<HTMLElement>('#app'));
      let reloads = 0,
        enabled = false;
      const startup = new Function(
        'host',
        `return ${source.hostStartupScript(true, 'host').trim()}`,
      )({
        document,
        events: document,
        surface: () => surface,
        now: () => now,
        visible: () => true,
        reducedMotion: true,
        reload: () => reloads++,
      }) as {
        destroy(): void;
        prepare(): void;
        fail(reason: unknown, execution?: { readonly fault: unknown }): void;
        visibilityChanged(): void;
        bindSession(value: string): void;
        submitted(receipt: object): void;
        enter(receipt: object): void;
        bindInput(callback: (value: boolean) => void): () => void;
      };
      cleanup.push(() => startup.destroy());
      cleanup.push(
        startup.bindInput((value) => {
          enabled = value;
        }),
      );
      // Use the same published font for this layout case; native control
      // decoration and tiny text-raster differences remain acceptable.
      for (const id of ['forgeax-loading', 'forgeax-fatal'])
        required(document.querySelector<HTMLElement>(`#${id}`)).style.fontFamily =
          '"Startup Fixture"';
      let mounted: UiInstance;
      let open = () => {};
      if (consumer === 'guide') {
        const authored = async (path: string) => {
          const url = new URL(path, import.meta.url);
          url.search = '?raw';
          return ((await import(/* @vite-ignore */ url.href)) as { default: string }).default;
        };
        const [html, css, localization, controller] = await Promise.all([
          authored('../../../../templates/game-3d/assets/guide.ui.html'),
          authored('../../../../templates/game-3d/assets/guide.ui.css'),
          fetch(
            new URL('../../../../templates/game-3d/assets/guide.ui.i18n.json', import.meta.url),
          ).then((r) => r.json()),
          import(
            /* @vite-ignore */ new URL(
              '../../../../templates/game-3d/assets/ui/guide-controller.ts',
              import.meta.url,
            ).href
          ) as Promise<{
            createGuideUi(
              asset: UiAsset,
              host: { uiRoot: HTMLElement; port: MessagePort },
            ): Promise<UiInstance>;
          }>,
        ]);
        const channel = new MessageChannel();
        cleanup.push(() => {
          channel.port1.close();
          channel.port2.close();
        });
        mounted = await controller.createGuideUi(
          { guid: 'startup-guide', html, css, localization },
          { uiRoot: gameRoot, port: channel.port1 },
        );
        cleanup.push(() => mounted.dispose());
      } else {
        const [settings, asset] = await Promise.all([
          import(
            /* @vite-ignore */ new URL(
              '../../../../apps/game-capability-lab/assets/plugins/settings.ts',
              import.meta.url,
            ).href
          ) as Promise<{
            createGameSettingsState(): unknown;
            mountSettings(
              asset: UiAsset,
              root: HTMLElement,
              state: unknown,
              fallback: HTMLElement,
            ): {
              instance: UiInstance | null;
              error?: unknown;
              open(): void;
              dispose(): void;
            };
          }>,
          fetch(
            new URL(
              '../../../../apps/game-capability-lab/assets/ui/settings.pack.json',
              import.meta.url,
            ),
          ).then((r) => r.json()),
        ]);
        const handle = settings.mountSettings(
          { guid: 'startup-settings', ...asset.assets['ui/settings'].payload },
          gameRoot,
          settings.createGameSettingsState(),
          surface,
        );
        if (handle.error) throw handle.error;
        mounted = required(handle.instance);
        open = () => handle.open();
        cleanup.push(() => handle.dispose());
      }
      const shadow = required(mounted.host.shadowRoot);
      const control = required(shadow.querySelector<HTMLInputElement>('input'));
      const trace: string[] = [];
      gameRoot.addEventListener('click', () => trace.push('game-click'));
      gameRoot.addEventListener('keydown', () => trace.push('game-key'));
      return {
        document,
        startup,
        gameRoot,
        surface,
        mounted,
        control,
        open,
        trace,
        enabled: () => enabled,
        reloads: () => reloads,
      };
    }),
  );
  const evidence = uiEvidenceDirectory(
    required(expect.getState().testPath),
    'ui-startup-responsive',
  );
  const states: unknown[] = [];
  const rect = (element: Element) => {
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom };
  };
  const capture = async (name: string) => {
    const rows = instances.map(({ document, gameRoot, control, enabled, reloads }) => ({
      inputEnabled: enabled(),
      inert: gameRoot.inert,
      value: control.value,
      reloads: reloads(),
      active: document.activeElement?.id,
      nodes: [
        'app-shell',
        'game-ui',
        'forgeax-loading',
        'forgeax-loading-title',
        'forgeax-loading-reload',
        'forgeax-fatal',
        'forgeax-fatal-message',
        'forgeax-fatal-details',
        'forgeax-fatal-reload',
      ].map((id) => {
        const element = required(document.querySelector<HTMLElement>(`#${id}`));
        return {
          id,
          rect: rect(element),
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
        };
      }),
    }));
    states.push({ name, rows });
    await commands.writeFile(`${evidence}/${consumer}.json`, JSON.stringify(states, null, 2));
    const pixels = ui.paint(now);
    if (pixels)
      required(canvas.getContext('2d')).putImageData(
        new ImageData(new Uint8ClampedArray(pixels), width, height),
        0,
        0,
      );
    await page.elementLocator(stage).screenshot({ path: `${evidence}/${consumer}-${name}.png` });
  };
  const wheel = async (deltaY = 1000) => {
    // The outer overlay margin is outside the independently scrolling <pre>.
    const point = { x: 8, y: height / 2, deltaX: 0, deltaY };
    await cdp().send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point });
    ui.input.wheel(point);
    await new Promise((resolve) => setTimeout(resolve, 150));
  };
  const tap = async (targets: HTMLElement[]) => {
    for (const [index, target] of targets.entries()) {
      const r = rect(target);
      const point = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      if (index === 0) {
        await cdp().send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          ...point,
          button: 'left',
          clickCount: 1,
        });
        await cdp().send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          ...point,
          button: 'left',
          clickCount: 1,
        });
      } else
        for (const phase of ['down', 'up'] as const)
          ui.input.pointer({ phase, pointerId: 1, pointerType: 'mouse', ...point });
    }
  };
  now = 15000;
  for (const { startup, gameRoot, control } of instances) {
    startup.visibilityChanged();
    expect(gameRoot.inert).toBe(true);
    control.focus();
  }
  await wheel();
  await capture('01-slow-reload');
  for (const { document } of instances) {
    const button = required(document.querySelector<HTMLElement>('#forgeax-loading-reload'));
    expect.soft(rect(button).y).toBeGreaterThanOrEqual(0);
    expect.soft(rect(button).bottom).toBeLessThanOrEqual(height);
  }
  await wheel(-1000);
  for (const { document } of instances) {
    const title = required(document.querySelector<HTMLElement>('#forgeax-loading-title'));
    expect.soft(rect(title).y).toBeGreaterThanOrEqual(0);
    expect.soft(rect(title).bottom).toBeLessThanOrEqual(height);
  }
  for (const { startup } of instances) {
    startup.bindSession('ordinary-world');
    startup.prepare();
    const receipt = {
      worldIdentity: 'ordinary-world',
      deviceGeneration: 1,
      frameId: 1,
      presentation: 'ready',
    };
    startup.submitted(receipt);
    startup.enter(receipt);
  }
  await expect.poll(() => instances.map(({ enabled }) => enabled())).toEqual([true, true]);
  for (const instance of instances) {
    instance.open();
    instance.control.value = consumer === 'guide' ? '3.1' : '43';
    instance.control.focus();
    expect(required(instance.mounted.host.shadowRoot).activeElement).toBe(instance.control);
  }
  await capture('02-ready-form');
  for (const instance of instances) {
    const error = {
      code: 'app-system-update-failed',
      message: 'The active game failed',
      detail: { lines: 'asset dependency failed\n'.repeat(40) },
    };
    instance.startup.fail(error, { fault: error });
    instance.startup.fail({ message: 'secondary cleanup failure' });
    expect(instance.enabled()).toBe(false);
    expect(instance.gameRoot.inert).toBe(true);
    expect(instance.document.activeElement?.id).toBe('forgeax-fatal-reload');
  }
  await capture('03-fatal-summary');
  await tap(
    instances.map(({ document }) => required(document.querySelector<HTMLElement>('summary'))),
  );
  for (const { document } of instances) {
    expect.soft(required(document.querySelector('details')).hasAttribute('open')).toBe(true);
    expect(required(document.querySelector('#forgeax-fatal-details')).textContent).not.toContain(
      'secondary cleanup failure',
    );
  }
  await wheel();
  await capture('04-fatal-diagnostics');
  for (const { document } of instances) {
    const overlay = required(document.querySelector<HTMLElement>('#forgeax-fatal'));
    expect.soft(rect(overlay).y).toBe(0);
    expect.soft(rect(overlay).bottom).toBe(height);
  }
  const reloads = instances.map(({ document }) =>
    required(document.querySelector<HTMLElement>('#forgeax-fatal-reload')),
  );
  for (const button of reloads) {
    expect.soft(rect(button).y).toBeGreaterThanOrEqual(0);
    expect.soft(rect(button).bottom).toBeLessThanOrEqual(height);
  }
  await wheel(-1000);
  for (const { document } of instances) {
    const message = required(document.querySelector<HTMLElement>('#forgeax-fatal-message'));
    expect.soft(rect(message).y).toBeGreaterThanOrEqual(0);
    expect.soft(rect(message).bottom).toBeLessThanOrEqual(height);
  }
  await wheel();
  await tap(reloads);
  expect(instances.map(({ reloads }) => reloads())).toEqual([1, 1]);
  for (const { control, trace, gameRoot } of instances) {
    expect(control.value).toBe(consumer === 'guide' ? '3.1' : '43');
    expect(gameRoot.inert).toBe(true);
    expect(trace).toEqual([]);
  }
  await tap(reloads);
  expect(instances.map(({ reloads }) => reloads())).toEqual([1, 1]);
  expect(errors).toEqual([]);
});
