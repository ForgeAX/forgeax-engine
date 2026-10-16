import type {} from '@vitest/browser-playwright';
import { expect, it } from 'vitest';
import { cdp, commands, page } from 'vitest/browser';
import { createBlitzUi } from '../index.js';
import { controlsWorkflowHtml, mountControlsWorkflow } from './controls-workflow-fixture.js';
import { required, uiEvidenceDirectory } from './fixture.js';

const bytes = new Uint8Array(
  await (await fetch(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url))).arrayBuffer(),
);
const wasm = {
  readWasm: async () => bytes,
  instantiate: (imports: object) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
};

it.each([
  240, 390, 480,
])('keeps authored settings reachable with the same font at %i CSS pixels high', async (height) => {
  const width = height === 480 ? 640 : 844;
  const pixelRatio = height === 480 ? 1 : 3;
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
  await page.viewport(width, height);
  const iframe = document.createElement('iframe');
  iframe.style.cssText = `position:absolute;inset:0;width:${width}px;height:${height}px;border:0`;
  const loaded = new Promise<void>((resolve) => {
    iframe.onload = () => resolve();
  });
  iframe.srcdoc = controlsWorkflowHtml;
  document.body.append(iframe);
  await loaded;
  const browser = required(iframe.contentDocument);
  const browserFont = await new FontFace('Inventory Fixture', font.slice().buffer, {
    weight: '100 900',
  }).load();
  browser.fonts.add(browserFont);
  await browser.fonts.ready;
  const errors: unknown[] = [];
  const ui = await createBlitzUi({
    wasm,
    html: controlsWorkflowHtml,
    width: width * pixelRatio,
    height: height * pixelRatio,
    pixelRatio,
    font,
    fontFamily: 'Inventory Fixture',
    onError: (error) => errors.push(error),
  });
  const flows = [mountControlsWorkflow(browser), mountControlsWorkflow(ui.document)];
  // Exact text-driven dimensions require the same font bytes. The unmodified
  // author asset and UA controls use system fonts whose metrics vary by host.
  for (const flow of flows)
    for (const element of [
      required(flow.settings.instance).host,
      ...flow.shadow.querySelectorAll<HTMLElement>('button,input,select'),
    ])
      element.style.fontFamily = '"Inventory Fixture"';
  const evidence = uiEvidenceDirectory(
    required(expect.getState().testPath),
    'ui-settings-responsive',
  );
  const panels = flows.map((flow) => required(flow.shadow.querySelector<HTMLElement>('.panel')));
  const rect = (element: Element) => {
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right };
  };
  const capture = async (state: string) => {
    const name = `${height}-${state}`;
    await page.elementLocator(iframe).screenshot({ path: `${evidence}/${name}.browser.png` });
    const canvas = document.createElement('canvas');
    canvas.width = width * pixelRatio;
    canvas.height = height * pixelRatio;
    required(canvas.getContext('2d')).putImageData(
      new ImageData(
        new Uint8ClampedArray(required(ui.paint(performance.now()))),
        canvas.width,
        canvas.height,
      ),
      0,
      0,
    );
    await commands.writeFile(
      `${evidence}/${name}.native.png`,
      required(canvas.toDataURL().split(',')[1]),
      'base64',
    );
    await commands.writeFile(
      `${evidence}/${name}.json`,
      JSON.stringify(
        panels.map((panel) => ({
          panel: rect(panel),
          scrollTop: panel.scrollTop,
          scrollHeight: panel.scrollHeight,
          clientHeight: panel.clientHeight,
          title: rect(required(panel.querySelector('h2'))),
          done: rect(required(panel.querySelector('button'))),
        })),
        null,
        2,
      ),
    );
  };
  try {
    for (const flow of flows) flow.settings.open();
    expect(browserFont.status).toBe('loaded');
    const fontFamilies = panels.map((panel, index) =>
      (index === 0
        ? required(browser.defaultView).getComputedStyle(panel)
        : ui.getComputedStyle(panel)
      ).getPropertyValue('font-family'),
    );
    for (const family of fontFamilies) expect(family).toContain('Inventory Fixture');
    await cdp().send('DOM.enable');
    await cdp().send('CSS.enable');
    const { nodes } = await cdp().send('DOM.getFlattenedDocument', { depth: -1, pierce: true });
    const textNodes = nodes.filter(
      (node) =>
        (node.nodeName === 'H2' && node.attributes?.includes('settings-title')) ||
        (node.nodeName === 'BUTTON' && node.attributes?.includes('close-settings')),
    );
    expect(textNodes).toHaveLength(2);
    const fonts = [];
    for (const node of textNodes) {
      const resolved = await cdp().send('CSS.getPlatformFontsForNode', { nodeId: node.nodeId });
      expect(resolved.fonts.length).toBeGreaterThan(0);
      for (const font of resolved.fonts) expect(font.isCustomFont).toBe(true);
      fonts.push({ element: node.nodeName, fonts: resolved.fonts });
    }
    await commands.writeFile(
      `${evidence}/${height}-font.json`,
      JSON.stringify(
        {
          bytes: font.length,
          sha256: Array.from(
            new Uint8Array(await crypto.subtle.digest('SHA-256', font.slice().buffer)),
            (value) => value.toString(16).padStart(2, '0'),
          ).join(''),
          fontFamilies,
          fonts,
        },
        null,
        2,
      ),
    );
    await capture('top');
    // The observed 844x390 phone landscape safe area excludes 47px side cutouts
    // and the bottom 21px home indicator. Preserve those edges in shorter windows.
    const safe =
      height === 480
        ? { left: 0, right: width, top: 0, bottom: height }
        : { left: 47, right: width - 47, top: 0, bottom: height - 21 };
    for (const [index, panel] of panels.entries()) {
      const bounds = rect(panel);
      expect
        .soft(bounds.x, `panel ${index} left safe margin`)
        .toBeGreaterThanOrEqual(safe.left + 8);
      expect
        .soft(bounds.right, `panel ${index} right safe margin`)
        .toBeLessThanOrEqual(safe.right - 8);
      expect.soft(bounds.y, `panel ${index} top safe margin`).toBeGreaterThanOrEqual(safe.top + 8);
      expect
        .soft(bounds.bottom, `panel ${index} bottom safe margin`)
        .toBeLessThanOrEqual(safe.bottom - 8);
      const title = rect(required(panel.querySelector('h2')));
      expect.soft(title.y).toBeGreaterThanOrEqual(bounds.y);
      expect.soft(title.bottom).toBeLessThanOrEqual(bounds.bottom);
      if (height === 480) {
        expect.soft(bounds.width).toBe(308);
        expect.soft(Math.abs(bounds.height - 397.85)).toBeLessThan(0.05);
        expect.soft(panel.scrollTop).toBe(0);
      } else {
        expect.soft(panel.scrollHeight).toBeGreaterThan(panel.clientHeight);
        const wheel = {
          x: bounds.right - 12,
          y: bounds.y + bounds.height / 2,
          deltaX: 0,
          deltaY: 1000,
        };
        if (index === 0) {
          await cdp().send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...wheel });
          await new Promise((resolve) => setTimeout(resolve, 150));
        } else ui.input.wheel(wheel);
        expect.soft(rect(panel).y, `panel ${index} stays fixed after excess wheel`).toBe(bounds.y);
      }
      const done = required(panel.querySelector<HTMLButtonElement>('button'));
      done.focus();
      const target = done.getBoundingClientRect();
      expect.soft(target.top).toBeGreaterThanOrEqual(bounds.y);
      expect.soft(target.bottom).toBeLessThanOrEqual(bounds.bottom);
      const hit =
        index === 0
          ? required(flows[0]).shadow.elementFromPoint(
              target.x + target.width / 2,
              target.y + target.height / 2,
            )
          : ui.elementFromPoint(target.x + target.width / 2, target.y + target.height / 2);
      expect.soft(hit, `panel ${index} Done remains reachable`).toBe(done);
    }
    await capture('done');
    expect(errors).toEqual([]);
  } finally {
    for (const flow of flows) {
      flow.settings.dispose();
      flow.inventoryUi.dispose();
    }
    ui.dispose();
    iframe.remove();
  }
});
