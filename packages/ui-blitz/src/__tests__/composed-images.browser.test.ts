import type {} from '@vitest/browser-playwright';
import { afterEach, expect, it } from 'vitest';
import { cdp, commands, page, userEvent } from 'vitest/browser';
import { createBlitzUi, type UiWasmHost } from '../index.js';
import { composedGalleryHtml, mountComposedGallery } from './composed-gallery-fixture.js';
import { required, uiEvidenceDirectory } from './fixture.js';

const bytes = new Uint8Array(
  await (await fetch(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url))).arrayBuffer(),
);
const wasm: UiWasmHost = {
  readWasm: async () => bytes,
  instantiate: (imports) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
};
const cleanup: (() => void)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  await cdp().send('Emulation.clearDeviceMetricsOverride');
  await cdp().send('Emulation.setScrollbarsHidden', { hidden: false });
});

it('keeps image fit, padding and viewport modal geometry through composed Grid/Flex scrolling and DPR resize', async () => {
  const evidence = uiEvidenceDirectory(required(expect.getState().testPath), 'ui-composed-images');
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
  const imageUrl = await (
    await fetch(new URL('../../rust/test-assets/aspect-pattern.txt', import.meta.url))
  ).text();
  const html = composedGalleryHtml(imageUrl);
  let width = 600,
    height = 420,
    ratio = 1;
  await page.viewport(width, height);
  // Match the portable scroller's zero gutter in headed and headless Chromium.
  await cdp().send('Emulation.setScrollbarsHidden', { hidden: true });
  const iframe = document.createElement('iframe');
  iframe.style.cssText = `position:absolute;inset:0;width:${width}px;height:${height}px;border:0`;
  const loaded = new Promise<void>((resolve) => {
    iframe.onload = () => resolve();
  });
  iframe.srcdoc = html;
  document.body.append(iframe);
  cleanup.push(() => iframe.remove());
  await loaded;
  const browser = required(iframe.contentDocument);
  browser.fonts.add(await new FontFace('Image Fixture', font.slice().buffer).load());
  await browser.fonts.ready;
  await Promise.all(Array.from(browser.images, (image) => image.decode()));
  const errors: unknown[] = [];
  const ui = await createBlitzUi({
    wasm,
    html,
    width,
    height,
    font,
    fontFamily: 'Image Fixture',
    onError: (cause) => errors.push(cause),
  });
  cleanup.push(() => ui.dispose());
  const documents = [browser, ui.document];
  const scrolls = documents.map((document) =>
    required(document.querySelector<HTMLElement>('#scroll')),
  );
  const originalImages = documents.map((document) => Array.from(document.querySelectorAll('img')));
  for (const document of documents) cleanup.push(mountComposedGallery(document));
  const states: unknown[] = [];
  const capture = async (name: string) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const snapshots = documents.map((document, index) => ({
      geometry: Array.from(
        document.querySelectorAll('#toolbar,#scroll,.card,img,#modal'),
        (node) => {
          const rect = node.getBoundingClientRect();
          return { id: node.id, rect: [rect.x, rect.y, rect.width, rect.height] };
        },
      ),
      scroll: [
        required(scrolls[index]).scrollTop,
        required(scrolls[index]).scrollHeight,
        required(scrolls[index]).clientHeight,
      ],
    }));
    const rgba = required(ui.paint(performance.now()));
    const canvas = document.createElement('canvas');
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    required(canvas.getContext('2d')).putImageData(
      new ImageData(new Uint8ClampedArray(rgba), canvas.width, canvas.height),
      0,
      0,
    );
    await commands.writeFile(
      `${evidence}/${name}-native.png`,
      required(canvas.toDataURL().split(',')[1]),
      'base64',
    );
    const screenshot = `${evidence}/${name}-browser.png`;
    await page.elementLocator(iframe).screenshot({ path: screenshot, scale: 'css' });
    const reference = new Image();
    reference.src = `data:image/png;base64,${await commands.readFile(screenshot, 'base64')}`;
    await reference.decode();
    const referenceCanvas = document.createElement('canvas');
    referenceCanvas.width = width;
    referenceCanvas.height = height;
    const ctx = required(referenceCanvas.getContext('2d'));
    ctx.drawImage(reference, 0, 0);
    const expectedPixels = ctx.getImageData(0, 0, width, height).data;
    const pixelResults: unknown[] = [];
    const modalOpen = !required(browser.querySelector<HTMLElement>('#overlay')).hidden;
    const modal = required(browser.querySelector('#modal')).getBoundingClientRect();
    for (const expectedImage of browser.querySelectorAll('.card img,#preview')) {
      const rect = expectedImage.getBoundingClientRect();
      const scroll = required(scrolls[0]).getBoundingClientRect();
      const top = Math.max(rect.top + 6, expectedImage.id === 'preview' ? 0 : scroll.top + 2);
      const bottom = Math.min(rect.bottom - 6, height - 2);
      if (top >= bottom) continue;
      let samples = 0,
        mismatches = 0;
      const examples: unknown[] = [];
      // Stable interior samples exercise content and author padding while avoiding the border raster.
      for (let y = Math.ceil(top); y < bottom; y += 5)
        for (let x = Math.ceil(rect.left + 6); x < rect.right - 6; x += 5) {
          if (
            modalOpen &&
            expectedImage.id !== 'preview' &&
            x >= modal.left - 1 &&
            x <= modal.right + 1 &&
            y >= modal.top - 1 &&
            y <= modal.bottom + 1
          )
            continue;
          const a =
            (Math.floor((y + 0.5) * ratio) * width * ratio + Math.floor((x + 0.5) * ratio)) * 4;
          const b = (y * width + x) * 4;
          const actual = Array.from(rgba.slice(a, a + 4));
          const expected = Array.from(expectedPixels.slice(b, b + 4));
          samples++;
          if (actual.some((value, i) => Math.abs(value - required(expected[i])) > 3)) {
            mismatches++;
            if (examples.length < 4) examples.push({ x, y, actual, expected });
          }
        }
      pixelResults.push({ id: expectedImage.id, samples, mismatches, examples });
      expect.soft(mismatches, `${name} ${expectedImage.id} fitted image/padding pixels`).toBe(0);
    }
    states.push({ name, width, height, ratio, snapshots, pixelResults });
    await commands.writeFile(`${evidence}/states.json`, JSON.stringify(states, null, 2));
    for (const [i, actual] of required(snapshots[1]).geometry.entries()) {
      const expected = required(required(snapshots[0]).geometry[i]);
      for (let axis = 0; axis < 4; axis++)
        expect
          .soft(
            Math.abs(required(actual.rect[axis]) - required(expected.rect[axis])),
            `${name} ${actual.id} axis ${axis}`,
          )
          .toBeLessThanOrEqual(1);
    }
    expect
      .soft(required(snapshots[1]).scroll, `${name} scroll metrics`)
      .toEqual(required(snapshots[0]).scroll);
    documents.forEach((document, index) => {
      expect(Array.from(document.querySelectorAll('img'))).toEqual(originalImages[index]);
    });
  };
  const resize = async (w: number, h: number, dpr: number) => {
    width = w;
    height = h;
    ratio = dpr;
    await page.viewport(width, height);
    await cdp().send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: ratio,
      mobile: false,
    });
    iframe.style.width = `${width}px`;
    iframe.style.height = `${height}px`;
    ui.resize(width * ratio, height * ratio, ratio);
  };
  const click = async (id: string) => {
    await userEvent.click(required(browser.querySelector(`#${id}`)));
    const button = required(ui.document.querySelector(`#${id}`));
    const r = button.getBoundingClientRect();
    expect(ui.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)).toBe(button);
    for (const phase of ['down', 'up'] as const)
      ui.input.pointer({
        phase,
        pointerId: 1,
        pointerType: 'mouse',
        x: r.x + r.width / 2,
        y: r.y + r.height / 2,
      });
  };
  await capture('01-grid-landscape');
  for (const scroll of scrolls) scroll.scrollTop = 120;
  await capture('02-scrolled');
  await resize(380, 540, 2);
  await capture('03-grid-portrait-dpr2');
  for (const scroll of scrolls) scroll.scrollTop = 0;
  await capture('03a-portrait-top-cover-dpr2');
  for (const scroll of scrolls) scroll.scrollTop = 120;
  await click('open');
  await capture('04-modal-over-scroll-dpr2');
  await resize(480, 360, 3);
  await capture('05-modal-resize-dpr3');
  await click('close');
  for (const scroll of scrolls) scroll.scrollTop = 10000;
  await capture('06-grid-bottom-dpr3');
  await resize(600, 640, 1);
  await capture('07-grown-clamped-scroll');
  expect(errors).toEqual([]);
});
