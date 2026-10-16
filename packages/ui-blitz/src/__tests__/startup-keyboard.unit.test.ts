/// <reference types="node" />
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import type { UiAsset, UiInstance } from '@forgeax/engine-ui';
import { afterEach, expect, it, vi } from 'vitest';
import { createBlitzUi, type UiWasmHost } from '../index.js';
import { required } from './fixture.js';

const wasm = await readFile(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url));
const host: UiWasmHost = {
  readWasm: async () => wasm,
  instantiate: (imports) => WebAssembly.instantiate(wasm, imports as WebAssembly.Imports),
};
const font = await readFile(
  new URL(
    '../../../devkit/node_modules/@fontsource-variable/noto-sans-sc/files/noto-sans-sc-latin-wght-normal.woff2',
    import.meta.url,
  ),
);
const source = (await import(
  new URL('../../../devkit/src/host/startup-source.ts', import.meta.url).href
)) as {
  hostStartupDocument(title: string): string;
  hostStartupScript(enabled: boolean, host: string): string;
};
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const release of cleanup.splice(0).reverse()) release();
  vi.useRealTimers();
});

it('enters slow Reload, reads fatal diagnostics and restores the ordinary guide after native startup recovery', async () => {
  const authored = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');
  const [html, css, localization, controller] = await Promise.all([
    authored('../../../../templates/game-3d/assets/guide.ui.html'),
    authored('../../../../templates/game-3d/assets/guide.ui.css'),
    authored('../../../../templates/game-3d/assets/guide.ui.i18n.json'),
    import(
      new URL('../../../../templates/game-3d/assets/ui/guide-controller.ts', import.meta.url).href
    ) as Promise<{
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
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let now = 0;
  const advance = (duration: number) => {
    now += duration;
    vi.advanceTimersByTime(duration);
  };
  const reload = vi.fn();
  const errors: unknown[] = [];
  const create = async () => {
    const ui = await createBlitzUi({
      wasm: host,
      html: source.hostStartupDocument('Game startup'),
      width: 600,
      height: 400,
      font,
      onError: (error) => errors.push(error),
    });
    const startup = runInNewContext(source.hostStartupScript(true, 'host'), {
      host: {
        document: ui.document,
        events: ui.document,
        surface: () => ui.document.querySelector('#app'),
        now: () => now,
        visible: () => true,
        reducedMotion: false,
        reload,
      },
      setTimeout,
      clearTimeout,
    }) as {
      destroy(): void;
      prepare(): void;
      fail(error: unknown): void;
      bindInput(callback: (enabled: boolean) => void): () => void;
      bindSession(session: string): void;
      submitted(receipt: object): void;
      enter(receipt: object): void;
    };
    let inputEnabled = false;
    const unbind = startup.bindInput((enabled) => {
      inputEnabled = enabled;
    });
    const gameUi = required(ui.document.querySelector<HTMLElement>('#game-ui'));
    const channel = new MessageChannel();
    const guide = await controller.createGuideUi(
      { guid: 'startup-guide', html, css, localization: JSON.parse(localization) },
      {
        uiRoot: gameUi,
        port: channel.port1,
        controlMode: { read: () => 'touch', subscribe: () => () => {} },
      },
    );
    const retire = () => {
      unbind();
      startup.destroy();
      guide.dispose();
      ui.dispose();
      channel.port1.close();
      channel.port2.close();
    };
    cleanup.push(retire);
    const key = (key: string, shiftKey = false) => {
      for (const type of ['keydown', 'keyup'] as const) ui.input.key({ type, key, shiftKey });
    };
    const tap = (element: Element) => {
      const rect = element.getBoundingClientRect();
      expect(rect.width).toBeGreaterThan(0);
      for (const phase of ['down', 'up'] as const)
        ui.input.pointer({
          phase,
          pointerId: 1,
          pointerType: 'touch',
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
        });
    };
    const background = required(guide.host.shadowRoot);
    const toggle = required(background.querySelector<HTMLElement>('[data-ui-part="vase-toggle"]'));
    expect(ui.paint(now)).not.toBeNull();
    expect(gameUi.inert).toBe(true);
    toggle.focus();
    expect(background.activeElement).toBeNull();
    return {
      ui,
      startup,
      gameUi,
      background,
      toggle,
      key,
      tap,
      retire,
      inputEnabled: () => inputEnabled,
    };
  };

  const loading = await create();
  const slowReload = required(
    loading.ui.document.querySelector<HTMLElement>('#forgeax-loading-reload'),
  );
  loading.key('Tab');
  expect(loading.background.activeElement).toBeNull();
  expect(slowReload.getBoundingClientRect().width).toBe(0);
  advance(14999);
  expect(slowReload.getBoundingClientRect().width).toBe(0);
  advance(1);
  expect(slowReload.getBoundingClientRect().width).toBeGreaterThan(0);
  loading.key('Tab');
  expect(loading.ui.document.activeElement).toBe(slowReload);
  expect(loading.ui.getComputedStyle(slowReload).getPropertyValue('outline-style')).toBe('auto');
  expect(loading.ui.paint(now)).not.toBeNull();
  loading.key('Tab', true);
  expect(loading.background.activeElement).toBeNull();
  loading.key('Enter');
  expect(reload).toHaveBeenCalledTimes(1);
  loading.tap(slowReload);
  expect(reload).toHaveBeenCalledTimes(1);
  loading.retire();

  const failed = await create();
  failed.startup.bindSession('world-failed');
  failed.startup.prepare();
  expect(failed.ui.document.querySelector('#forgeax-loading-status')?.textContent).toBe(
    'Preparing scene…',
  );
  const failure = {
    code: 'plugin-startup-failed',
    message: 'Scene preparation rejected',
    cause: {
      code: 'asset-read-failed',
      detail: { lines: 'missing scene dependency\n'.repeat(40) },
    },
  };
  failed.startup.fail(failure);
  failed.startup.fail({ code: 'cleanup-failed', message: 'secondary failure' });
  const fatalReload = required(
    failed.ui.document.querySelector<HTMLElement>('#forgeax-fatal-reload'),
  );
  const details = required(failed.ui.document.querySelector<HTMLElement>('#forgeax-fatal-details'));
  const summary = required(failed.ui.document.querySelector<HTMLElement>('summary'));
  expect(failed.ui.document.activeElement).toBe(fatalReload);
  expect(failed.inputEnabled()).toBe(false);
  expect(details.textContent).toContain('plugin-startup-failed');
  expect(details.textContent).not.toContain('secondary failure');
  failed.key('Tab', true);
  expect(failed.ui.document.activeElement).toBe(summary);
  failed.key('Enter');
  expect(summary.parentElement?.hasAttribute('open')).toBe(true);
  expect(details.scrollHeight).toBeGreaterThan(details.clientHeight);
  const rect = details.getBoundingClientRect();
  failed.ui.input.wheel({
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
    deltaX: 0,
    deltaY: 90,
  });
  expect(details.scrollTop).toBeGreaterThan(0);
  expect(failed.ui.paint(now)).not.toBeNull();
  failed.tap(fatalReload);
  expect(reload).toHaveBeenCalledTimes(2);
  failed.retire();

  const recovered = await create();
  recovered.startup.bindSession('world-recovered');
  recovered.startup.prepare();
  const pending = {
    worldIdentity: 'world-recovered',
    deviceGeneration: 2,
    frameId: 1,
    presentation: 'pending',
  };
  recovered.startup.submitted(pending);
  recovered.startup.enter(pending);
  recovered.startup.enter({ ...pending, presentation: 'ready' });
  expect(recovered.inputEnabled()).toBe(false);
  expect(recovered.gameUi.inert).toBe(true);
  const ready = { ...pending, frameId: 2, presentation: 'ready' };
  recovered.startup.submitted(ready);
  recovered.startup.enter(ready);
  expect(recovered.inputEnabled()).toBe(false);
  expect(recovered.gameUi.inert).toBe(true);
  advance(149);
  expect(recovered.inputEnabled()).toBe(false);
  advance(1);
  expect(recovered.inputEnabled()).toBe(true);
  expect(recovered.gameUi.inert).toBe(false);
  expect(recovered.ui.document.querySelector<HTMLElement>('#forgeax-loading')?.style.display).toBe(
    'none',
  );
  recovered.key('Tab');
  expect(recovered.background.activeElement).not.toBeNull();
  recovered.toggle.focus();
  expect(recovered.background.activeElement).toBe(recovered.toggle);
  expect(recovered.toggle.getAttribute('aria-expanded')).toBe('false');
  recovered.key('Enter');
  expect(recovered.toggle.getAttribute('aria-expanded')).toBe('true');
  expect(recovered.ui.paint(now)).not.toBeNull();
  recovered.retire();
  expect(vi.getTimerCount()).toBe(0);
  expect(errors).toEqual([]);
});
