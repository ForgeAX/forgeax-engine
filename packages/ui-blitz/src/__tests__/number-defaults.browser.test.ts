import { mountUi } from '@forgeax/engine-ui';
import { expect, it } from 'vitest';
import { cdp, commands, page } from 'vitest/browser';
import { createBlitzUi } from '../index.js';
import { required, uiEvidenceDirectory } from './fixture.js';

it('keeps mounted number adjustment buttons visible before hover and after touch editing', async () => {
  const width = 400,
    height = 300;
  const html = '<style>html,body{margin:0;background:white}</style>';
  const css =
    'main{pointer-events:auto;padding:20px;font:16px/24px "Number Fixture"}label{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}input{box-sizing:border-box;width:120px;height:32px;padding:4px;font:16px/24px "Number Fixture"}';
  const asset = {
    guid: 'number-defaults',
    html: '<main><label>Editable<input id=number type=number value=3 min=1 max=9></label><label>Disabled<input id=disabled type=number value=3 disabled></label><label>Read only<input id=readonly type=number value=3 readonly></label><button id=done>Done</button></main>',
    css,
  };
  await page.viewport(width, height);
  const iframe = document.createElement('iframe');
  iframe.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px;border:0`;
  const loaded = new Promise<void>((resolve) => {
    iframe.onload = () => resolve();
  });
  iframe.srcdoc = html;
  document.body.append(iframe);
  await loaded;
  const bytes = new Uint8Array(
    await (await fetch(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url))).arrayBuffer(),
  );
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
  const browser = required(iframe.contentDocument);
  browser.fonts.add(await new FontFace('Number Fixture', font.slice().buffer).load());
  await browser.fonts.ready;
  const errors: unknown[] = [];
  const ui = await createBlitzUi({
    wasm: {
      readWasm: async () => bytes,
      instantiate: (imports) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
    },
    html,
    width,
    height,
    font,
    fontFamily: 'Number Fixture',
    onError: (error) => errors.push(error),
  });
  const documents = [required(iframe.contentDocument), ui.document];
  const mounts = documents.map((document) => {
    const result = mountUi(asset, { root: document.body, layer: 1 });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.value;
  });
  const fields = mounts.map((mount) =>
    required(required(mount.host.shadowRoot).querySelector<HTMLInputElement>('#number')),
  );
  const evidence = uiEvidenceDirectory(required(expect.getState().testPath), 'ui-number-defaults');
  const images: Uint8Array[] = [],
    browserImages: Uint8Array[] = [];
  const capture = async (name: string) => {
    const pixels = required(ui.paint(performance.now()));
    images.push(pixels);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    required(canvas.getContext('2d')).putImageData(
      new ImageData(new Uint8ClampedArray(pixels), width, height),
      0,
      0,
    );
    await commands.writeFile(
      `${evidence}/${name}.native.png`,
      required(canvas.toDataURL().split(',')[1]),
      'base64',
    );
    const shot = await page
      .elementLocator(iframe)
      .screenshot({ path: `${evidence}/${name}.browser.png`, base64: true });
    const bitmap = await createImageBitmap(
      new Blob(
        [
          Uint8Array.from(atob(typeof shot === 'string' ? shot : shot.base64), (char) =>
            char.charCodeAt(0),
          ),
        ],
        { type: 'image/png' },
      ),
    );
    const context = required(canvas.getContext('2d'));
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    browserImages.push(new Uint8Array(context.getImageData(0, 0, width, height).data));
  };
  try {
    await capture('01-idle');
    const rect = required(fields[1]).getBoundingClientRect();
    // The default must contain the same actual triangle ink as focused painting.
    await cdp().send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: rect.right - 8,
      y: rect.y + 8,
    });
    ui.input.pointer({
      phase: 'move',
      pointerId: 1,
      pointerType: 'mouse',
      x: rect.right - 8,
      y: rect.y + 8,
    });
    await capture('02-hover');
    for (const field of fields) field.focus({ preventScroll: true });
    await capture('03-focus');
    const native = required(images[0]),
      focused = required(images[2]);
    for (let y = rect.y + 8; y < rect.y + 24; y++)
      for (let x = rect.right - 19; x < rect.right - 5; x++) {
        const offset = (y * width + x) * 4;
        expect(
          Array.from(native.subarray(offset, offset + 4)),
          `default spin pixel ${x},${y}`,
        ).toEqual(Array.from(focused.subarray(offset, offset + 4)));
      }
    const browserField = required(fields[0]);
    const browserRect = browserField.getBoundingClientRect();
    await cdp().send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: browserRect.right - 10, y: browserRect.y + 9 }],
    });
    await cdp().send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    for (const phase of ['down', 'up'] as const)
      ui.input.pointer({
        phase,
        pointerId: 2,
        pointerType: 'touch',
        x: rect.right - 10,
        y: rect.y + 9,
      });
    expect(fields.map((field) => field.value)).toEqual(['4', '4']);
    for (const mount of mounts)
      required(required(mount.host.shadowRoot).querySelector<HTMLButtonElement>('#done')).focus();
    await cdp().send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 390, y: 290 });
    ui.input.pointer({ phase: 'move', pointerId: 1, pointerType: 'mouse', x: 390, y: 290 });
    await capture('04-blurred-after-step');
    const counts = (pixels: Uint8Array, rect: DOMRect) =>
      [0, 1].map((half) => {
        let ink = 0;
        for (let y = rect.y + 6 + half * 10; y < rect.y + 16 + half * 10; y++)
          for (let x = rect.right - 20; x < rect.right - 5; x++) {
            const offset = (y * width + x) * 4;
            const r = required(pixels[offset]),
              g = required(pixels[offset + 1]),
              b = required(pixels[offset + 2]);
            if (r === g && g === b && r < 220) ink++;
          }
        return ink;
      });
    const evidenceRows = [0, 3].map((index) => ({
      index,
      browser: counts(required(browserImages[index]), browserRect),
      native: counts(required(images[index]), rect),
    }));
    for (const row of evidenceRows)
      for (const ink of [...row.browser, ...row.native]) expect(ink).toBeGreaterThan(3);
    for (const [index, mount] of mounts.entries())
      for (const id of ['disabled', 'readonly']) {
        const control = required(
          required(mount.host.shadowRoot).querySelector<HTMLInputElement>(`#${id}`),
        );
        expect(
          counts(
            required(index === 0 ? browserImages[0] : images[0]),
            control.getBoundingClientRect(),
          ),
        ).toEqual([0, 0]);
      }
    await commands.writeFile(
      `${evidence}/states.json`,
      JSON.stringify(
        { values: fields.map((field) => field.value), spinInk: evidenceRows, errors },
        null,
        2,
      ),
    );
    expect(errors).toEqual([]);
  } finally {
    for (const mount of mounts) mount.dispose();
    ui.dispose();
    iframe.remove();
  }
});
