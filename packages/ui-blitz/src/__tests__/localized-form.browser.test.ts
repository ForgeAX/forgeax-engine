import type { UiAsset, UiInstance } from '@forgeax/engine-ui';
import type {} from '@vitest/browser-playwright';
import { afterEach, expect, it } from 'vitest';
import { cdp, commands, page, userEvent } from 'vitest/browser';
import { createBlitzUi } from '../index.js';
import { required, uiEvidenceDirectory } from './fixture.js';

const cleanup: (() => void)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  await cdp().send('Emulation.setScrollbarsHidden', { hidden: false });
});

it('localizes the complete dynamic form without replacing edits, focus, validation or generation state', async () => {
  const authored = async (path: string) => {
    const url = new URL(path, import.meta.url);
    url.search = '?raw';
    return ((await import(/* @vite-ignore */ url.href)) as { default: string }).default;
  };
  const [html, css, localization, controller, bytes, font] = await Promise.all([
    authored('../../../../templates/game-3d/assets/guide.ui.html'),
    authored('../../../../templates/game-3d/assets/guide.ui.css'),
    fetch(new URL('../../../../templates/game-3d/assets/guide.ui.i18n.json', import.meta.url)).then(
      (response) => response.json(),
    ),
    import(
      /* @vite-ignore */
      new URL('../../../../templates/game-3d/assets/ui/guide-controller.ts', import.meta.url).href
    ) as Promise<{
      createGuideUi(
        asset: UiAsset,
        host: { uiRoot: HTMLElement; port?: MessagePort },
      ): Promise<UiInstance>;
    }>,
    fetch(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url)).then((r) => r.arrayBuffer()),
    fetch(
      new URL(
        '../../../devkit/node_modules/@fontsource-variable/noto-sans-sc/files/noto-sans-sc-latin-wght-normal.woff2',
        import.meta.url,
      ),
    ).then((r) => r.arrayBuffer()),
  ]);
  let width = 860,
    height = 520;
  await page.viewport(width * 2 + 16, height);
  await cdp().send('Emulation.setScrollbarsHidden', { hidden: true });
  const shell = '<!doctype html><style>html,body{margin:0;background:#10243a}</style>';
  const stage = document.createElement('section');
  stage.style.cssText = `position:absolute;inset:0;width:${width * 2 + 16}px;height:${height}px`;
  const iframe = document.createElement('iframe');
  iframe.style.cssText = `position:absolute;inset:0;width:${width}px;height:${height}px;border:0`;
  const loaded = new Promise<void>((resolve) => {
    iframe.onload = () => resolve();
  });
  iframe.srcdoc = shell;
  stage.append(iframe);
  document.body.append(stage);
  cleanup.push(() => stage.remove());
  await loaded;
  const browser = required(iframe.contentDocument);
  browser.fonts.add(
    await new FontFace('Form Fixture', font.slice(0), { weight: '100 900' }).load(),
  );
  const errors: unknown[] = [];
  const ui = await createBlitzUi({
    wasm: {
      readWasm: async () => new Uint8Array(bytes),
      instantiate: (imports) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
    },
    html: shell,
    width,
    height,
    font: new Uint8Array(font),
    fontFamily: 'Form Fixture',
    onError: (error) => errors.push(error),
  });
  cleanup.push(() => ui.dispose());
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.cssText = `position:absolute;left:${width + 16}px;top:0`;
  stage.append(canvas);
  // Font identity makes missing glyphs visible; ordinary platform control
  // decoration and text antialiasing do not have a cross-browser pixel threshold.
  const asset: UiAsset = {
    guid: 'localized-ordinary-guide',
    html,
    css: `${css}\n:host{font-family:"Form Fixture"}`,
    localization,
  };
  const instances = await Promise.all(
    [browser, ui.document].map(async (document) => {
      const channel = new MessageChannel();
      cleanup.push(() => {
        channel.port1.close();
        channel.port2.close();
      });
      const requests: Record<string, unknown>[] = [];
      channel.port2.addEventListener('message', (event) => {
        if (event.data.channel === 'game-3d/runtime-vase') requests.push(event.data);
      });
      channel.port2.start();
      const mounted = await controller.createGuideUi(asset, {
        uiRoot: document.body,
        port: channel.port1,
      });
      cleanup.push(() => mounted.dispose());
      const root = required(mounted.host.shadowRoot);
      const form = required(root.querySelector<HTMLFormElement>('form'));
      const inputs = Array.from(form.querySelectorAll('input'));
      const status = required(root.querySelector<HTMLElement>('[data-ui-part="vase-status"]'));
      const button = required(form.querySelector('button'));
      const independent = await controller.createGuideUi(asset, { uiRoot: document.body });
      independent.host.style.display = 'none';
      cleanup.push(() => independent.dispose());
      return { mounted, root, form, inputs, status, button, channel, requests, independent };
    }),
  );
  const snapshot = () =>
    instances.map(({ mounted, root, inputs, status, button }) => ({
      language: mounted.host.lang,
      labels: inputs.map((input) => input.parentElement?.textContent),
      values: inputs.map((input) => input.value),
      disabled: [button.disabled, ...inputs.map((input) => input.disabled)],
      button: button.textContent,
      status: status.textContent,
      state: status.dataset.state,
      panelLabel: root.querySelector('.vase-panel')?.getAttribute('aria-label'),
      description: root.querySelector('.vase-panel p')?.textContent,
    }));
  const evidence = uiEvidenceDirectory(required(expect.getState().testPath), 'ui-localized-form');
  const resize = async (nextWidth: number, nextHeight: number) => {
    width = nextWidth;
    height = nextHeight;
    ui.resize(width, height);
    canvas.width = width;
    canvas.height = height;
    canvas.style.left = `${width + 16}px`;
    iframe.style.width = `${width}px`;
    iframe.style.height = `${height}px`;
    stage.style.width = `${width * 2 + 16}px`;
    stage.style.height = `${height}px`;
    await page.viewport(width * 2 + 16, height);
  };
  const states: unknown[] = [];
  const capture = async (name: string) => {
    const rows = snapshot();
    expect(rows[1]).toEqual(rows[0]);
    states.push({ name, rows, requests: instances.map(({ requests }) => [...requests]) });
    await commands.writeFile(`${evidence}/states.json`, JSON.stringify(states, null, 2));
    const pixels = ui.paint(performance.now());
    if (pixels)
      required(canvas.getContext('2d')).putImageData(
        new ImageData(new Uint8ClampedArray(pixels), width, height),
        0,
        0,
      );
    await page.elementLocator(stage).screenshot({ path: `${evidence}/${name}.png` });
  };
  const language = async (value: 'en' | 'fr') => {
    const before = instances.map(({ requests }) => requests.length);
    for (const { root } of instances)
      required(root.querySelector<HTMLElement>(`[data-ui-action="language-${value}"]`)).click();
    await expect
      .poll(() => instances.map(({ mounted }) => mounted.host.lang))
      .toEqual([value, value]);
    // Observe all preceding Host-to-game messages before claiming that a
    // language change did not request regeneration or inspection.
    await Promise.all(
      instances.map(
        ({ channel }) =>
          new Promise<void>((resolve) => {
            const receive = (event: MessageEvent) => {
              if (event.data.channel !== 'test/localization-barrier') return;
              channel.port2.removeEventListener('message', receive);
              resolve();
            };
            channel.port2.addEventListener('message', receive);
            channel.port1.postMessage({ channel: 'test/localization-barrier' });
          }),
      ),
    );
    expect(instances.map(({ requests }) => requests.length)).toEqual(before);
    for (const { root, inputs } of instances)
      expect(Array.from(root.querySelectorAll('input'))).toEqual(inputs);
  };
  const state = async (busy: boolean, error?: string, radius = 0.8, vertexCount = 1216) => {
    for (const { channel } of instances)
      channel.port2.postMessage({
        channel: 'game-3d/runtime-vase',
        kind: 'state',
        state: {
          busy,
          guid: 'retained-vase',
          generation: 7,
          entity: 42,
          values: { height: 2.4, radius, sides: 32 },
          vertexCount,
          ...(error ? { error } : {}),
        },
      });
    await expect
      .poll(() => instances.map(({ status }) => status.dataset.state))
      .toEqual([
        busy ? 'busy' : error ? 'error' : 'ready',
        busy ? 'busy' : error ? 'error' : 'ready',
      ]);
  };
  await expect.poll(() => instances.map(({ requests }) => requests.length)).toEqual([1, 1]);
  await language('fr');
  await capture('01-french-preparing');
  for (const row of snapshot()) {
    expect.soft(row.labels).toEqual(['Hauteur', 'Rayon', 'C\u00f4t\u00e9s']);
    expect.soft(row.button).toBe('G\u00e9n\u00e9rer le vase');
    expect.soft(row.status).toBe('Pr\u00e9paration du vase...');
    expect.soft(row.panelLabel).toBe('Vase g\u00e9n\u00e9r\u00e9 dans le jeu');
    expect
      .soft(row.description)
      .toBe('Modifiez la forme, puis g\u00e9n\u00e9rez-la dans cette sc\u00e8ne.');
  }
  for (const { independent } of instances) expect(independent.host.lang).toBe('en');
  await state(false);
  const radii = instances.map(({ inputs }) =>
    required(inputs.find((input) => input.name === 'radius')),
  );
  required(radii[0]).focus();
  await userEvent.keyboard('{Control>}a{/Control}0.65');
  required(radii[1]).focus();
  ui.input.text('0.65');
  await language('en');
  for (const [index, instance] of instances.entries()) {
    expect(instance.root.activeElement).toBe(radii[index]);
    expect(required(radii[index]).value).toBe('0.65');
    expect(instance.status.textContent).toBe('1216 vertices · Generated in game');
    required(radii[index]).value = '9';
    expect(instance.form.reportValidity()).toBe(false);
  }
  await language('fr');
  for (const [index, instance] of instances.entries()) {
    expect(instance.root.activeElement).toBe(radii[index]);
    expect(required(radii[index]).validity.rangeOverflow).toBe(true);
    required(radii[index]).value = '0.65';
    expect(instance.form.reportValidity()).toBe(true);
    instance.button.click();
  }
  await expect.poll(() => instances.map(({ requests }) => requests.length)).toEqual([2, 2]);
  for (const { requests } of instances)
    expect(requests[1]).toEqual({
      channel: 'game-3d/runtime-vase',
      kind: 'generate',
      values: {
        height: 2.4,
        radius: 0.65,
        sides: 32,
      },
    });
  await state(true);
  await language('en');
  await language('fr');
  for (const row of snapshot()) {
    expect.soft(row.status).toBe('G\u00e9n\u00e9ration...');
    expect(row.disabled).toEqual([true, true, true, true]);
    expect(row.values[1]).toBe('0.65');
  }
  await capture('02-french-busy');
  await state(false, 'producer failed');
  await language('en');
  await language('fr');
  for (const row of snapshot()) {
    expect
      .soft(row.status)
      .toBe(
        '\u00c9chec de la g\u00e9n\u00e9ration. Le vase pr\u00e9c\u00e9dent est conserv\u00e9 ; v\u00e9rifiez les valeurs puis r\u00e9essayez.',
      );
    expect(row.disabled).toEqual([false, false, false, false]);
    expect(row.values[1]).toBe('0.65');
  }
  await resize(390, 520);
  for (const { status } of instances) {
    status.scrollIntoView({ block: 'nearest' });
    const bounds = status.getBoundingClientRect();
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(height);
  }
  await capture('03-french-error-narrow');
  for (const [index, { button }] of instances.entries()) {
    const bounds = button.getBoundingClientRect();
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(height);
    if (index === 0) await userEvent.click(button);
    else {
      const point = {
        pointerId: 1,
        pointerType: 'mouse' as const,
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height / 2,
      };
      expect(ui.elementFromPoint(point.x, point.y)).toBe(button);
      ui.input.pointer({ phase: 'down', ...point });
      ui.input.pointer({ phase: 'up', ...point });
    }
  }
  await expect.poll(() => instances.map(({ requests }) => requests.length)).toEqual([3, 3]);
  await state(false, undefined, 0.65, 1280);
  await language('en');
  await language('fr');
  for (const row of snapshot())
    expect.soft(row.status).toBe('1280 sommets · G\u00e9n\u00e9r\u00e9 dans le jeu');
  await capture('04-french-recovered');
  for (const { mounted, status, channel, independent } of instances) {
    const previous = status.textContent;
    mounted.dispose();
    expect(mounted.host.isConnected).toBe(false);
    const drained = new Promise<void>((resolve) =>
      channel.port1.addEventListener('message', () => resolve(), { once: true }),
    );
    channel.port2.postMessage({
      channel: 'game-3d/runtime-vase',
      kind: 'state',
      state: { busy: true },
    });
    await drained;
    const other = required(independent.host.shadowRoot);
    required(other.querySelector<HTMLElement>('[data-ui-action="language-fr"]')).click();
    await expect.poll(() => independent.host.lang).toBe('fr');
    expect
      .soft(required(other.querySelector('[data-ui-part="vase-status"]')).textContent)
      .toBe('La g\u00e9n\u00e9ration de vase est indisponible sur cet h\u00f4te.');
    expect(status.textContent).toBe(previous);
  }
  expect(errors).toEqual([]);
});
