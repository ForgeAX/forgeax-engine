import type { UiAsset, UiInstance } from '@forgeax/engine-ui';
import type {} from '@vitest/browser-playwright';
import { afterEach, expect, it } from 'vitest';
import { cdp, commands, page, userEvent } from 'vitest/browser';
import { createBlitzUi, type UiWasmHost } from '../index.js';
import { required, selectAllKeys, uiEvidenceDirectory } from './fixture.js';

const { inspectUi } = (await import(
  /* @vite-ignore */
  new URL('../../../ui/src/inspection.ts', import.meta.url).href
)) as typeof import('../../../ui/src/inspection.js');

const bytes = new Uint8Array(
  await (await fetch(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url))).arrayBuffer(),
);
const wasm: UiWasmHost = {
  readWasm: async () => bytes,
  instantiate: (imports) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
};
const fontUrl = new URL(
  '../../../devkit/node_modules/@fontsource-variable/noto-sans-sc/files/noto-sans-sc-latin-wght-normal.woff2',
  import.meta.url,
);
const font = new Uint8Array(await (await fetch(fontUrl)).arrayBuffer());
async function contentHash(body: BufferSource): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', body)))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}
const [wasmSha256, fontSha256] = await Promise.all([contentHash(bytes), contentHash(font)]);
const cleanup: (() => void)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  await cdp().send('Emulation.clearDeviceMetricsOverride');
  await cdp().send('Emulation.setScrollbarsHidden', { hidden: false });
});

it('uses the ordinary game guide keyboard form through scrolling, busy recovery and resize', async () => {
  // Match the portable scroller's zero gutter in headed and headless Chromium.
  await cdp().send('Emulation.setScrollbarsHidden', { hidden: true });
  const evidence = uiEvidenceDirectory(required(expect.getState().testPath), 'ui-game3d-focus');
  const authored = async (path: string): Promise<string> => {
    const url = new URL(path, import.meta.url);
    url.search = '?raw';
    return ((await import(/* @vite-ignore */ url.href)) as { default: string }).default;
  };
  const behavior = new URL(
    '../../../../templates/game-3d/assets/ui/guide-controller.ts',
    import.meta.url,
  );
  const [html, css, localization, controller] = await Promise.all([
    authored('../../../../templates/game-3d/assets/guide.ui.html'),
    authored('../../../../templates/game-3d/assets/guide.ui.css'),
    fetch(new URL('../../../../templates/game-3d/assets/guide.ui.i18n.json', import.meta.url)).then(
      (response) => response.json(),
    ),
    import(/* @vite-ignore */ behavior.href) as Promise<{
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
  const stage = document.createElement('section');
  stage.style.cssText =
    'position:absolute;left:0;top:0;background:#10243a;color:white;font:13px sans-serif';
  const legend = document.createElement('div');
  legend.style.cssText = 'height:28px;line-height:28px;padding-left:8px';
  legend.textContent = 'Chromium DOM (left) · Blitz WASM (right) · ordinary game-3d UI';
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:absolute;left:0;top:28px;border:0';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;top:28px';
  stage.append(legend, iframe, canvas);
  document.body.append(stage);
  cleanup.push(() => stage.remove());
  const loaded = new Promise<void>((resolve) => {
    iframe.onload = () => resolve();
  });
  const shell =
    '<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:#10243a}</style><body tabindex="-1">';
  iframe.srcdoc = shell;
  await loaded;
  const native = required(iframe.contentDocument);
  const nativeFont = new FontFace('Guide Fixture', `url(${fontUrl.href})`);
  native.fonts.add(await nativeFont.load());
  const asciiFont = new Uint8Array(
    await (
      await fetch(
        new URL(
          '../../../../third_party/blitz/packages/blitz-dom/tests/fonts/dejavu-sans-ascii.ttf',
          import.meta.url,
        ),
      )
    ).arrayBuffer(),
  );
  native.fonts.add(await new FontFace('Input ASCII', asciiFont).load());
  const errors: unknown[] = [];
  const ui = await createBlitzUi({
    wasm,
    html: shell,
    width: 600,
    height: 320,
    font,
    fontFamily: 'Guide Fixture',
    resources: {
      baseUrl: 'https://guide-font.invalid/',
      read: async (url) => {
        expect(url).toBe('https://guide-font.invalid/input-ascii.ttf');
        return asciiFont;
      },
    },
    onError: (error) => errors.push(error),
  });
  cleanup.push(() => ui.dispose());
  let width = 600;
  let height = 320;
  let ratio = 1;
  const resize = async (nextWidth: number, nextHeight: number, nextRatio = 1) => {
    width = nextWidth;
    height = nextHeight;
    ratio = nextRatio;
    stage.style.width = `${width * 2 + 12}px`;
    stage.style.height = `${height + 28}px`;
    iframe.style.width = canvas.style.width = `${width}px`;
    iframe.style.height = canvas.style.height = `${height}px`;
    canvas.style.left = `${width + 12}px`;
    ui.resize(width * ratio, height * ratio, ratio);
    await page.viewport(width * 2 + 12, height + 28);
    await cdp().send('Emulation.setDeviceMetricsOverride', {
      width: width * 2 + 12,
      height: height + 28,
      deviceScaleFactor: ratio,
      mobile: false,
    });
    await new Promise(requestAnimationFrame);
    expect(required(native.defaultView).devicePixelRatio).toBe(ratio);
  };
  await resize(width, height);
  const instances = await Promise.all(
    [native, ui.document].map(async (document) => {
      const channel = new MessageChannel();
      cleanup.push(() => {
        channel.port1.close();
        channel.port2.close();
      });
      const generated: { values: Record<string, number> }[] = [];
      channel.port2.addEventListener('message', (event) => {
        if (event.data.channel === 'game-3d/runtime-vase' && event.data.kind === 'generate')
          generated.push(event.data);
      });
      channel.port2.start();
      const mounted = await controller.createGuideUi(
        {
          guid: 'game-guide-keyboard',
          html,
          css: `${css}\n:host{font-family:"Guide Fixture"}`,
          localization,
        },
        {
          uiRoot: document.body,
          port: channel.port1,
          controlMode: { read: () => 'touch', subscribe: () => () => {} },
        },
      );
      cleanup.push(() => mounted.dispose());
      const root = required(mounted.host.shadowRoot);
      return {
        root,
        generated,
        channel,
        panel: required(root.querySelector<HTMLElement>('.vase-panel')),
        radius: required(root.querySelector<HTMLInputElement>('input[name="radius"]')),
        status: required(root.querySelector<HTMLElement>('[data-ui-part="vase-status"]')),
      };
    }),
  );
  const press = async (key: 'Tab' | 'Enter' | 'Escape') => {
    await userEvent.keyboard(`{${key}}`);
    ui.input.key({ type: 'keydown', key });
    ui.input.key({ type: 'keyup', key });
  };
  const active = () =>
    instances.map(({ root }) => {
      const element = root.activeElement as HTMLElement | null;
      return (
        element?.getAttribute('name') ??
        element?.dataset.uiPart ??
        element?.dataset.uiAction ??
        element?.getAttribute('type')
      );
    });
  const focusAppearance = () =>
    instances.map(({ root }, index) => {
      const element = root.activeElement;
      if (!element) return { style: 'none', width: '0px', color: 'transparent' };
      const style =
        index === 0
          ? required(native.defaultView).getComputedStyle(element)
          : ui.getComputedStyle(element);
      return {
        style: style.getPropertyValue('outline-style'),
        width: style.getPropertyValue('outline-width'),
        color: style.getPropertyValue('outline-color'),
      };
    });
  const requireVisibleFocus = () => {
    for (const [index, outline] of focusAppearance().entries()) {
      expect(outline.style, `target ${index} keyboard focus indicator`).not.toBe('none');
      expect(Number.parseFloat(outline.width)).toBeGreaterThan(0);
    }
  };
  const scrollFocus: unknown[] = [];
  const requireFocusedControlReachable = () => {
    scrollFocus.push(
      instances.map(({ root, panel }, index) => {
        const element = required(root.activeElement);
        const bounds = panel.getBoundingClientRect();
        const field = element.getBoundingClientRect();
        expect(field.top).toBeGreaterThanOrEqual(bounds.top);
        expect(field.bottom).toBeLessThanOrEqual(bounds.bottom);
        const x = field.x + field.width / 2;
        const y = field.y + field.height / 2;
        expect(index === 0 ? root.elementFromPoint(x, y) : ui.elementFromPoint(x, y)).toBe(element);
        return {
          control: element.getAttribute('name') ?? element.getAttribute('type'),
          scrollTop: panel.scrollTop,
          field: [field.x, field.y, field.width, field.height],
          panel: [bounds.x, bounds.y, bounds.width, bounds.height],
          hit: true,
        };
      }),
    );
  };
  const capture = async (name: string) => {
    const beforeInspection = instances.map(({ generated }) => generated.length);
    const inspections = instances.map(({ root }, index) => {
      const result = inspectUi(
        root.host as HTMLElement,
        {
          styles: [
            'display',
            'pointer-events',
            'font-family',
            'font-size',
            'font-weight',
            'line-height',
            'box-sizing',
            'padding-top',
            'padding-bottom',
            'border-top-width',
            'border-bottom-width',
          ],
          limit: 128,
        },
        index === 1 ? ui : undefined,
      );
      if (!result.ok) throw result.error;
      expect(result.value.truncated).toBe(false);
      expect(
        result.value.nodes
          .filter((node) => node.tag === 'input')
          .map((node) => node.attributes.name),
      ).toEqual(['height', 'radius', 'sides']);
      for (const node of result.value.nodes) expect(node.source?.guid).toBe('game-guide-keyboard');
      return result.value;
    });
    // Preserve the measured state even when the first parity assertion fails.
    // Painting afterward must not replace the CSSOM values under comparison.
    const measurements = {
      name,
      browser: navigator.userAgent,
      width,
      height,
      ratio,
      wasmSha256,
      fontSha256,
      inspections,
      inputs: instances.map(({ root }, index) =>
        Array.from(root.querySelectorAll('input')).map((input) => {
          const style =
            index === 0
              ? required(native.defaultView).getComputedStyle(input)
              : ui.getComputedStyle(input);
          return {
            name: input.name,
            value: input.value,
            active: root.activeElement === input,
            rectWidth: input.getBoundingClientRect().width,
            clientWidth: input.clientWidth,
            scrollWidth: input.scrollWidth,
            styles: Object.fromEntries(
              [
                'width',
                'box-sizing',
                'padding-left',
                'padding-right',
                'border-left-width',
                'border-right-width',
                'font-family',
                'font-size',
              ].map((property) => [property, style.getPropertyValue(property)]),
            ),
          };
        }),
      ),
    };
    await commands.writeFile(`${evidence}/${name}-inspection.json`, JSON.stringify(measurements));
    const controls = inspections.map((value) =>
      value.nodes
        .filter((node) => node.control)
        .map((node) => ({ ...node.control, validationMessage: undefined })),
    );
    expect(controls[1]).toEqual(controls[0]);
    for (const expected of required(inspections[0]).nodes) {
      if (
        !['input', 'label', 'form'].includes(expected.tag) &&
        !['vase-panel', 'vase-body'].includes(expected.attributes.class ?? '')
      )
        continue;
      const actual = required(
        required(inspections[1]).nodes.find((node) => node.path === expected.path),
      );
      const actualOverflow = actual.scroll.width - actual.scroll.clientWidth;
      const expectedOverflow = expected.scroll.width - expected.scroll.clientWidth;
      const differs =
        expected.tag === 'input'
          ? actualOverflow !== expectedOverflow
          : actual.scroll.width !== expected.scroll.width;
      if (differs) {
        // biome-ignore lint/suspicious/noConsole: Preserve bounded failure facts when CI artifact transfer is unavailable.
        console.log(
          '[ui-game3d-input-widths]',
          JSON.stringify({
            name,
            browser: navigator.userAgent,
            wasmSha256,
            fontSha256,
            inputs: measurements.inputs,
          }),
        );
      }
      if (expected.tag === 'input') {
        // Chromium 157 reports a different internal client box for number
        // controls. Compare overflow in that space; outer widths below and
        // ancestor extents still reject constrained inputs leaking parent width.
        expect(actualOverflow, `${name}: ${expected.path} horizontal overflow`).toBe(
          expectedOverflow,
        );
      } else {
        expect(actual.scroll.width, `${name}: ${expected.path} scrollWidth`).toBe(
          expected.scroll.width,
        );
      }
    }
    for (const { panel, radius } of instances) {
      const x = radius.getBoundingClientRect().x;
      panel.scrollLeft = 100;
      expect(panel.scrollLeft).toBe(0);
      expect(radius.getBoundingClientRect().x).toBe(x);
    }
    expect(instances.map(({ generated }) => generated.length)).toEqual(beforeInspection);
    // Both targets measure the published font. Bound native DPR rounding per
    // control and the accumulated form drift; the closed panel retains a separate 4px difference.
    const tolerance = { geometry: 0.05, controlHeight: 1, formHeight: 3, panelHeight: 4 };
    for (const selector of ['.vase-panel', 'form', 'input']) {
      const nativeNodes = Array.from(required(instances[0]).root.querySelectorAll(selector));
      const blitzNodes = Array.from(required(instances[1]).root.querySelectorAll(selector));
      expect(blitzNodes).toHaveLength(nativeNodes.length);
      for (const [index, node] of nativeNodes.entries()) {
        const expected = node.getBoundingClientRect();
        const actual = required(blitzNodes[index]).getBoundingClientRect();
        expect(Math.abs(actual.x - expected.x)).toBeLessThanOrEqual(tolerance.geometry);
        expect(Math.abs(actual.width - expected.width)).toBeLessThanOrEqual(tolerance.geometry);
        expect(Math.abs(actual.height - expected.height)).toBeLessThanOrEqual(
          selector === '.vase-panel'
            ? tolerance.panelHeight
            : selector === 'form'
              ? tolerance.formHeight
              : tolerance.controlHeight,
        );
        if (selector === '.vase-panel')
          expect(Math.abs(actual.y - expected.y)).toBeLessThanOrEqual(tolerance.geometry);
      }
    }
    await commands.writeFile(
      `${evidence}/${name}.json`,
      JSON.stringify({
        name,
        browser: navigator.userAgent,
        width,
        height,
        ratio,
        tolerance,
        inspections,
        scrollFocus,
        focusAppearance: instances.some(({ root }) => root.activeElement) ? focusAppearance() : [],
        targets: instances.map(({ root, panel }, index) => ({
          scrollTop: panel.scrollTop,
          rectangles: [
            '.guide',
            '.languages button',
            '.vase-panel',
            '[data-ui-part="vase-toggle"]',
            'form',
            'label',
            'input',
            '[data-ui-part="vase-controls"] button',
            '[data-ui-part="vase-status"]',
          ].map((selector) => ({
            selector,
            rects: Array.from(root.querySelectorAll(selector)).map((element) => {
              const rect = element.getBoundingClientRect();
              return [rect.x, rect.y, rect.width, rect.height];
            }),
            textMetrics: Array.from(root.querySelectorAll(selector)).map((element) => {
              const style =
                index === 0
                  ? required(native.defaultView).getComputedStyle(element)
                  : ui.getComputedStyle(element);
              return ['font-size', 'line-height', 'letter-spacing'].map((name) =>
                style.getPropertyValue(name),
              );
            }),
          })),
        })),
      }),
    );
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const rgba = required(ui.paint(performance.now()));
    const pixels = new Uint8ClampedArray(rgba);
    for (let i = 0; i < pixels.length; i += 4) {
      const alpha = pixels[i + 3] ?? 0;
      if (alpha === 0) continue;
      for (let channel = 0; channel < 3; channel++)
        pixels[i + channel] = Math.round(((pixels[i + channel] ?? 0) * 255) / alpha);
    }
    required(canvas.getContext('2d')).putImageData(
      new ImageData(pixels, canvas.width, canvas.height),
      0,
      0,
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    await page.elementLocator(stage).screenshot({
      path: `${evidence}/${name}.png`,
    });
    return rgba;
  };
  const state = async (busy: boolean, error?: string) => {
    for (const { channel } of instances)
      channel.port2.postMessage({
        channel: 'game-3d/runtime-vase',
        kind: 'state',
        state: {
          busy,
          guid: 'vase',
          values: { height: 2.4, radius: 0.8, sides: 32 },
          vertexCount: 1216,
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

  native.body.focus();
  await press('Tab');
  expect(active()).toEqual(['vase-toggle', 'vase-toggle']);
  requireVisibleFocus();
  await capture('01-landscape-keyboard-entry');
  await press('Enter');
  for (const name of ['height', 'radius', 'sides']) {
    await press('Tab');
    expect(active()).toEqual([name, name]);
    requireFocusedControlReachable();
  }
  await press('Tab');
  expect(active()).toEqual(['button', 'button']);
  requireFocusedControlReachable();
  expect(instances.every(({ panel }) => panel.scrollTop > 0)).toBe(true);
  const nativeRadius = required(instances[0]).radius;
  const blitzRadius = required(instances[1]).radius;
  const edit = async (value: string) => {
    nativeRadius.focus();
    await userEvent.keyboard(`${selectAllKeys()}${value}`);
    blitzRadius.focus();
    ui.input.text(value);
  };
  const lifecycle: unknown[] = [];
  const radiusEvents: string[][] = instances.map(() => []);
  for (const [index, { radius }] of instances.entries())
    for (const type of ['change', 'blur'])
      radius.addEventListener(type, () => required(radiusEvents[index]).push(type));
  let editRequests = 0;
  cleanup.push(ui.input.subscribeTextEdit(() => editRequests++));
  const activate = async (targets: HTMLElement[], pointerType: 'mouse' | 'touch') => {
    for (const [index, target] of targets.entries()) {
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const rect = target.getBoundingClientRect();
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      if (index === 0 && pointerType === 'mouse') await userEvent.click(target);
      else if (index === 0) {
        const frame = iframe.getBoundingClientRect();
        await cdp().send('Emulation.setTouchEmulationEnabled', {
          enabled: true,
          maxTouchPoints: 1,
        });
        await cdp().send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: frame.x + x, y: frame.y + y }],
        });
        await cdp().send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await cdp().send('Emulation.setTouchEmulationEnabled', { enabled: false });
      } else {
        for (const phase of ['down', 'up'] as const)
          ui.input.pointer({ phase, pointerId: 41, pointerType, x, y });
      }
    }
  };
  const lifecycleState = async (name: string) => {
    const states = instances.map(({ root, radius }, index) => ({
      focus: active()[index] ?? null,
      value: radius.value,
      badInput: radius.validity.badInput,
      expanded: root.querySelector('[data-ui-part="vase-toggle"]')?.getAttribute('aria-expanded'),
      visible: radius.getBoundingClientRect().height > 0,
      events: [...required(radiusEvents[index])],
    }));
    lifecycle.push({ name, states, editor: ui.input.focusedText(), editRequests });
    await commands.writeFile(`${evidence}/edit-lifecycle.json`, JSON.stringify(lifecycle, null, 2));
    return states;
  };
  await activate([nativeRadius, blitzRadius], 'mouse');
  await edit('0.65');
  const beforeEscape = await lifecycleState('mouse-edit');
  await press('Escape');
  const afterEscape = await lifecycleState('escape');
  await capture('01a-mouse-escape');
  await press('Tab');
  const afterTab = await lifecycleState('tab-after-escape');
  const toggles = instances.map(({ root }) =>
    required(root.querySelector<HTMLElement>('[data-ui-part="vase-toggle"]')),
  );
  await activate(toggles, 'touch');
  const afterClose = await lifecycleState('touch-close');
  await capture('01b-touch-closed');
  await press('Enter');
  await press('Tab');
  await press('Tab');
  const afterReopen = await lifecycleState('keyboard-reopen');
  const selectedPixels = await capture('01c-keyboard-reopened');
  const selectedRect = blitzRadius.getBoundingClientRect();
  let selectionCoverage = 0;
  for (let y = Math.ceil(selectedRect.top + 3); y < selectedRect.bottom - 3; y++) {
    for (let x = Math.ceil(selectedRect.left + 3); x < selectedRect.right - 3; x++) {
      const offset = (y * width + x) * 4;
      if (
        selectedPixels[offset] === 25 &&
        selectedPixels[offset + 1] === 103 &&
        selectedPixels[offset + 2] === 210 &&
        selectedPixels[offset + 3] === 255
      )
        selectionCoverage++;
    }
  }
  expect(selectionCoverage).toBeGreaterThan(10);
  for (const states of [beforeEscape, afterEscape, afterTab, afterClose, afterReopen])
    expect(states[1]).toEqual(states[0]);
  expect(editRequests).toBe(1);
  expect(ui.input.focusedText()?.value).toBe('0.65');
  expect(
    instances.every(({ root, radius }) => root.querySelector('input[name="radius"]') === radius),
  ).toBe(true);
  const selectionReference = {
    selectedText: native.defaultView?.getSelection()?.toString(),
    start: nativeRadius.selectionStart,
    end: nativeRadius.selectionEnd,
  };
  await userEvent.keyboard('7');
  // The existing native provider delivers complete replacement strings.
  ui.input.text('7');
  const afterReplacement = await lifecycleState('tab-selection-type-replacement');
  await userEvent.keyboard('{Backspace}');
  ui.input.text('');
  const afterDeletion = await lifecycleState('delete-replacement');
  await commands.writeFile(
    `${evidence}/sequential-edit.json`,
    JSON.stringify(
      {
        selectionReference,
        selectionCoverage,
        afterReplacement,
        afterDeletion,
      },
      null,
      2,
    ),
  );
  expect(selectionReference).toEqual({ selectedText: '0.65', start: null, end: null });
  expect(afterReplacement[1]).toEqual(afterReplacement[0]);
  expect(afterDeletion[1]).toEqual(afterDeletion[0]);
  await edit('0.42');
  await press('Enter');
  expect(instances.map(({ radius }) => radius.validity.stepMismatch)).toEqual([true, true]);
  expect(instances.every(({ radius }) => radius.validationMessage.length > 0)).toBe(true);
  expect(instances.map(({ generated }) => generated.length)).toEqual([0, 0]);
  expect(active()).toEqual(['radius', 'radius']);
  await capture('02-landscape-invalid-number');
  await edit('0.8');
  await press('Enter');
  await expect.poll(() => instances.map(({ generated }) => generated.length)).toEqual([1, 1]);
  expect(required(instances[0]).generated).toEqual(required(instances[1]).generated);
  await state(true);
  expect(instances.map(({ radius }) => radius.disabled)).toEqual([true, true]);
  expect(active()[1]).toBeUndefined();
  // Chromium retires native focus at a rendering boundary; Blitz must retire it synchronously.
  await expect.poll(() => active()[0]).toBeUndefined();
  for (const { radius } of instances) radius.focus();
  expect(active()).toEqual([undefined, undefined]);
  await capture('03-landscape-busy');
  await state(false, 'generation failed');
  expect(instances.map(({ radius }) => [radius.disabled, radius.value])).toEqual([
    [false, '0.8'],
    [false, '0.8'],
  ]);
  await resize(390, 640, 2);
  expect(instances.map(({ panel }) => panel.scrollTop)).toEqual([0, 0]);
  expect(required(instances[0]).root.querySelector('input[name="radius"]')).toBe(nativeRadius);
  expect(required(instances[1]).root.querySelector('input[name="radius"]')).toBe(blitzRadius);
  await capture('04-portrait-recovery-dpr2');
  await resize(390, 844, 3);
  // Actual WeChat portrait capsule, observed on the ordinary 0e23 publication.
  const capsule = { left: 292, top: 44, right: 380, bottom: 76 };
  const beforeLocalization = instances.map(({ generated }) => generated.length);
  for (const language of ['fr', 'en']) {
    for (const [index, { root }] of instances.entries()) {
      const button = required(
        root.querySelector<HTMLElement>(`[data-ui-action="language-${language}"]`),
      );
      const rect = button.getBoundingClientRect();
      expect(
        rect.left < capsule.right &&
          rect.right > capsule.left &&
          rect.top < capsule.bottom &&
          rect.bottom > capsule.top,
        `target ${index} language control intersects the observed native capsule`,
      ).toBe(false);
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      expect(index === 0 ? root.elementFromPoint(x, y) : ui.elementFromPoint(x, y)).toBe(button);
      const inspected = inspectUi(
        root.host as HTMLElement,
        { point: { x, y } },
        index === 1 ? ui : undefined,
      );
      if (!inspected.ok) throw inspected.error;
      expect(
        inspected.value.nodes.find((node) => node.path === inspected.value.hit)?.attributes[
          'data-ui-action'
        ],
      ).toBe(`language-${language}`);
      // Match scripted localization activation on both documents; pointer editing
      // and touch cancellation are exercised by the preceding real input journey.
      button.focus();
      button.click();
    }
    await expect
      .poll(() => instances.map(({ root }) => root.host.getAttribute('lang')))
      .toEqual([language, language]);
    for (const { root, panel } of instances) {
      const guide = required(root.querySelector('.guide')).getBoundingClientRect();
      const bounds = panel.getBoundingClientRect();
      expect(bounds.top - guide.bottom).toBeGreaterThanOrEqual(14);
      expect(bounds.bottom).toBeLessThanOrEqual(height);
      for (const field of root.querySelectorAll('input,[data-ui-part="vase-controls"] button')) {
        const control = field.getBoundingClientRect();
        expect(control.left).toBeGreaterThanOrEqual(bounds.left);
        expect(control.right).toBeLessThanOrEqual(bounds.right);
        expect(control.top).toBeGreaterThanOrEqual(bounds.top);
        expect(control.bottom).toBeLessThanOrEqual(bounds.bottom);
      }
    }
    expect(instances.map(({ generated }) => generated.length)).toEqual(beforeLocalization);
    if (language === 'fr') await capture('04a-portrait-fr-language-hit-dpr3');
  }
  await capture('04b-portrait-language-hit-dpr3');
  await state(false);
  await press('Tab');
  for (const { root } of instances)
    required(root.querySelector<HTMLElement>('.languages button')).focus();
  requireVisibleFocus();
  await resize(600, 320);
  for (const { root } of instances)
    for (const button of root.querySelectorAll('.languages button'))
      expect(button.getBoundingClientRect().toJSON()).toMatchObject({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      });
  expect(active()).toEqual([undefined, undefined]);
  native.body.focus();
  ui.input.cancel();
  expect(active()).toEqual([undefined, undefined]);
  await press('Tab');
  expect(active()).toEqual(['vase-toggle', 'vase-toggle']);
  requireVisibleFocus();
  await capture('05-landscape-recovered-keyboard');
  for (const invalid of [
    { limit: 0 },
    { limit: 513 },
    { selector: '[' },
    { point: { x: Number.NaN, y: 0 } },
  ]) {
    for (const [index, { root }] of instances.entries())
      expect(
        inspectUi(root.host as HTMLElement, invalid, index === 1 ? ui : undefined),
      ).toMatchObject({ ok: false, error: { code: 'inspection-failed' } });
  }
  for (const [index, { root }] of instances.entries()) {
    const bounded = inspectUi(root.host as HTMLElement, { limit: 2 }, index === 1 ? ui : undefined);
    expect(bounded).toMatchObject({ ok: true, value: { visited: 2, truncated: true } });
  }
  // Reuse the original guide field to prove intrinsic height follows its font
  // strut, rather than the current value's fallback glyphs or empty editor state.
  const beforeFontProbe = instances.map(({ radius, generated }) => ({
    value: radius.value,
    type: radius.getAttribute('type'),
    style: radius.getAttribute('style'),
    generated: generated.length,
  }));
  for (const { root, radius } of instances) {
    const toggle = required(root.querySelector<HTMLElement>('[data-ui-part="vase-toggle"]'));
    if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
    expect(radius.getBoundingClientRect().height).toBeGreaterThan(0);
  }
  const fontStyle = ui.document.createElement('style');
  fontStyle.textContent = '@font-face{font-family:"Input ASCII";src:url(input-ascii.ttf)}';
  required(instances[1]).root.append(fontStyle);
  await ui.loadResources();
  for (const { radius } of instances) {
    radius.setAttribute('type', 'text');
    radius.style.fontFamily = '"Input ASCII","Guide Fixture"';
  }
  const fontMetrics = [];
  for (const lineHeight of ['normal', '2', '30px']) {
    for (const { radius } of instances) radius.style.lineHeight = lineHeight;
    let emptyHeights: number[] | undefined;
    for (const value of ['', 'A', '\u00e9', 'A']) {
      for (const { radius } of instances) radius.value = value;
      await ui.loadResources();
      expect(instances.map(({ radius }) => radius.value)).toEqual([value, value]);
      const heights = instances.map(({ radius }) => radius.getBoundingClientRect().height);
      emptyHeights ??= heights;
      expect(
        heights,
        `${lineHeight}: value ${JSON.stringify(value)} changes intrinsic height`,
      ).toEqual(emptyHeights);
      expect(Math.abs(required(heights[1]) - required(heights[0]))).toBeLessThanOrEqual(1);
      fontMetrics.push({ lineHeight, value, heights });
    }
  }
  await commands.writeFile(`${evidence}/font-strut.json`, JSON.stringify(fontMetrics));
  fontStyle.remove();
  for (const [index, { radius, generated }] of instances.entries()) {
    const before = required(beforeFontProbe[index]);
    for (const name of ['type', 'style'] as const) {
      const value = before[name];
      if (value === null) radius.removeAttribute(name);
      else radius.setAttribute(name, value);
    }
    radius.value = before.value;
    expect(generated).toHaveLength(before.generated);
  }
  expect(errors).toEqual([]);
}, 30_000);
