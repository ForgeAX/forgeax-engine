/// <reference types="vite/client" />

import { expect, it } from 'vitest';
import { cdp, commands, page } from 'vitest/browser';
import publishedFallback from '../../../devkit/node_modules/@fontsource-variable/noto-sans-sc/files/noto-sans-sc-latin-wght-normal.woff2?inline';
import { createBlitzUi } from '../index.js';
import { required, uiEvidenceDirectory } from './fixture.js';
import { compareUiRaster } from './gpu-parity-fixture.js';

it('uses loaded published fonts for missing author glyphs without an explicit CSS fallback', async () => {
  const previousViewport = { width: innerWidth, height: innerHeight };
  await page.viewport(640, 480);
  const load = async (url: URL) => new Uint8Array(await (await fetch(url)).arrayBuffer());
  const [bytes, font] = await Promise.all([
    load(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url)),
    load(
      new URL(
        '../../../../third_party/blitz/packages/blitz-dom/tests/fonts/dejavu-sans-ascii.ttf',
        import.meta.url,
      ),
    ),
  ]);
  const symbols = ['×', '±', '\u00e9', '€'];
  const width = 160,
    height = 40;
  const html = `<!doctype html><style>html,body{margin:0;background:white}span{display:inline-block;width:40px;color:black;font:32px/40px "Inventory Fixture"}@font-face{font-family:PublishedFallback;src:url("${publishedFallback}")}</style>${symbols.map((text, index) => `<span id="font-probe-${index}">${text}</span>`).join('')}`;
  const stage = document.createElement('section');
  stage.style.cssText =
    'position:absolute;left:0;top:0;width:332px;height:68px;background:#10243a;color:white;font:12px/28px sans-serif';
  stage.textContent = 'Chromium DOM (left) · Blitz WASM (right)';
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:absolute;left:0;top:28px;width:160px;height:40px;border:0';
  frame.srcdoc = html;
  const loaded = new Promise<void>((resolve) => {
    frame.onload = () => resolve();
  });
  stage.append(frame);
  document.body.append(stage);
  let ui: Awaited<ReturnType<typeof createBlitzUi>> | undefined;
  try {
    await loaded;
    const browser = required(frame.contentDocument);
    browser.fonts.add(await new FontFace('Inventory Fixture', font.slice().buffer).load());
    await browser.fonts.load('32px PublishedFallback', symbols.join(''));
    const errors: unknown[] = [];
    ui = await createBlitzUi({
      wasm: {
        readWasm: async () => bytes,
        instantiate: (imports) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
      },
      html,
      width,
      height,
      font,
      fontFamily: 'Inventory Fixture',
      onError: (error) => errors.push(error),
    });
    const protocol = cdp();
    await protocol.send('DOM.enable');
    await protocol.send('CSS.enable');
    const tree = await protocol.send('DOM.getDocument', { depth: -1, pierce: true });
    const find = (node: typeof tree.root, id: string): number | undefined => {
      if (node.attributes?.includes(id)) return node.nodeId;
      for (const child of [
        ...(node.children ?? []),
        ...(node.contentDocument ? [node.contentDocument] : []),
      ]) {
        const found = find(child, id);
        if (found) return found;
      }
      return undefined;
    };
    const resolvedFonts = () =>
      Promise.all(
        symbols.map((_, index) =>
          protocol.send('CSS.getPlatformFontsForNode', {
            nodeId: required(find(tree.root, `font-probe-${index}`)),
          }),
        ),
      );
    const implicitFonts = await resolvedFonts();
    const implicit = required(ui.paint(0));
    const ink = symbols.map((_, index) => {
      let count = 0;
      for (let y = 0; y < height; y++)
        for (let x = index * 40; x < (index + 1) * 40; x++) {
          const offset = (y * width + x) * 4;
          if (required(implicit[offset]) < 200 && required(implicit[offset + 3]) > 0) count++;
        }
      return count;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.style.cssText = 'position:absolute;left:172px;top:28px';
    required(canvas.getContext('2d')).putImageData(
      new ImageData(new Uint8ClampedArray(implicit), width, height),
      0,
      0,
    );
    stage.append(canvas);
    const evidence = uiEvidenceDirectory(required(expect.getState().testPath), 'ui-font-fallback');
    required(stage.firstChild).textContent = 'Implicit fallback: Chromium | Blitz';
    await page.elementLocator(stage).screenshot({ path: `${evidence}/implicit-fallback.png` });
    for (const doc of [browser, ui.document])
      for (const span of doc.querySelectorAll<HTMLElement>('span'))
        span.style.fontFamily = '"Inventory Fixture",PublishedFallback';
    browser.body.getBoundingClientRect();
    await new Promise(requestAnimationFrame);
    const explicitFonts = await resolvedFonts();
    const explicit = required(ui.paint(1));
    required(canvas.getContext('2d')).putImageData(
      new ImageData(new Uint8ClampedArray(explicit), width, height),
      0,
      0,
    );
    required(stage.firstChild).textContent = 'Same font bytes, 32px/400: Chromium | Blitz';
    await page.elementLocator(stage).screenshot({ path: `${evidence}/explicit-same-font.png` });
    const screenshot = await page
      .elementLocator(frame)
      .screenshot({ base64: true, path: `${evidence}/explicit-chromium.png` });
    const png = typeof screenshot === 'string' ? screenshot : screenshot.base64;
    const image = await createImageBitmap(
      new Blob([Uint8Array.from(atob(png), (value) => value.charCodeAt(0))], { type: 'image/png' }),
    );
    const browserCanvas = new OffscreenCanvas(width, height);
    const context = required(browserCanvas.getContext('2d'));
    expect([image.width, image.height]).toEqual([width, height]);
    context.drawImage(image, 0, 0);
    image.close();
    const browserPixels = new Uint8Array(context.getImageData(0, 0, width, height).data.buffer);
    const coverage = (pixels: Uint8Array) =>
      symbols.map((symbol, index) => {
        let ink = 0,
          minX = width,
          minY = height,
          maxX = -1,
          maxY = -1,
          darkness = 0;
        for (let y = 0; y < height; y++)
          for (let x = index * 40; x < (index + 1) * 40; x++) {
            const value = required(pixels[(y * width + x) * 4]);
            darkness += 255 - value;
            if (value < 200) {
              ink++;
              minX = Math.min(minX, x - index * 40);
              minY = Math.min(minY, y);
              maxX = Math.max(maxX, x - index * 40);
              maxY = Math.max(maxY, y);
            }
          }
        return { symbol, ink, darkness, bounds: [minX, minY, maxX, maxY] };
      });
    const styles = [browser, ui.document].map((doc) =>
      symbols.map((_, index) => {
        const element = required(doc.querySelector(`#font-probe-${index}`));
        const style =
          doc === browser
            ? required(browser.defaultView).getComputedStyle(element)
            : required(ui).getComputedStyle(element);
        return Object.fromEntries(
          ['font-family', 'font-size', 'font-weight', 'line-height', 'font-variation-settings'].map(
            (property) => [property, style.getPropertyValue(property)],
          ),
        );
      }),
    );
    const measure = required(browser.createElement('canvas').getContext('2d'));
    measure.font = '400 32px "Inventory Fixture", PublishedFallback';
    const textMetrics = symbols.map((symbol, index) => {
      const span = required(browser.querySelector(`#font-probe-${index}`));
      const marker = browser.createElement('i');
      marker.style.cssText =
        'display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:baseline';
      span.append(marker);
      const baseline = marker.getBoundingClientRect().top - span.getBoundingClientRect().top;
      marker.remove();
      const metrics = measure.measureText(symbol);
      return {
        symbol,
        baseline,
        advance: metrics.width,
        inkLeft: metrics.actualBoundingBoxLeft,
        inkRight: metrics.actualBoundingBoxRight,
        inkAscent: metrics.actualBoundingBoxAscent,
        inkDescent: metrics.actualBoundingBoxDescent,
        fontAscent: metrics.fontBoundingBoxAscent,
        fontDescent: metrics.fontBoundingBoxDescent,
      };
    });
    const identity = async (bytes: Uint8Array) => ({
      bytes: bytes.length,
      sha256: Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)),
        (value) => value.toString(16).padStart(2, '0'),
      ).join(''),
    });
    const fontInputs = {
      bootstrap: await identity(font),
      published: await identity(await load(new URL(publishedFallback))),
    };
    await commands.writeFile(
      `${evidence}/diagnosis.json`,
      JSON.stringify(
        {
          symbols,
          fontInputs,
          textMetrics,
          implicitFonts,
          explicitFonts,
          explicitRaster: {
            difference: compareUiRaster(browserPixels, explicit),
            browser: coverage(browserPixels),
            native: coverage(explicit),
            styles,
          },
          native: { ink, equal: implicit.every((value, index) => value === explicit[index]) },
          errors,
        },
        null,
        2,
      ),
    );
    expect(styles[0]).toEqual(styles[1]);
    for (const count of ink) expect(count).toBeGreaterThan(10);
    expect(implicit).toEqual(explicit);
    expect(errors).toEqual([]);
    for (const result of implicitFonts)
      expect(result.fonts.some((font) => font.glyphCount > 0)).toBe(true);
    for (const result of explicitFonts)
      expect(result.fonts.some((font) => font.isCustomFont && font.glyphCount > 0)).toBe(true);
  } finally {
    ui?.dispose();
    stage.remove();
    await page.viewport(previousViewport.width, previousViewport.height);
  }
});
