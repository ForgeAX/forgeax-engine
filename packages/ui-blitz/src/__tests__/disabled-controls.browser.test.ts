import { expect, it } from 'vitest';
import { cdp, commands, page } from 'vitest/browser';
import { createBlitzUi } from '../index.js';
import { disabledControlsRasterCase, mountDisabledControls } from './disabled-controls-fixture.js';
import { required, uiEvidenceDirectory } from './fixture.js';

it('paints discoverable disabled controls while retaining readonly behavior and author colors', async () => {
  const { width, height, html } = disabledControlsRasterCase;
  await page.viewport(width, height);
  const iframe = document.createElement('iframe');
  iframe.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px;border:0`;
  const loaded = new Promise<void>((resolve) => {
    iframe.onload = () => resolve();
  });
  iframe.srcdoc = html;
  document.body.append(iframe);
  await loaded;
  const load = async (url: URL) => new Uint8Array(await (await fetch(url)).arrayBuffer());
  const [bytes, font] = await Promise.all([
    load(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url)),
    load(
      new URL(
        '../../../devkit/node_modules/@fontsource-variable/noto-sans-sc/files/noto-sans-sc-latin-wght-normal.woff2',
        import.meta.url,
      ),
    ),
  ]);
  const browser = required(iframe.contentDocument);
  browser.fonts.add(await new FontFace('Disabled Fixture', font.slice().buffer).load());
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
    fontFamily: 'Disabled Fixture',
    onError: (error) => errors.push(error),
  });
  const mounts = [browser, ui.document].map(mountDisabledControls);
  const roots = mounts.map((mount) => required(mount.host.shadowRoot));
  const field = (index: number, id: string) =>
    required(required(roots[index]).querySelector<HTMLInputElement>(`#${id}`));
  const evidence = uiEvidenceDirectory(
    required(expect.getState().testPath),
    'ui-disabled-controls',
  );
  try {
    const pixels = required(ui.paint(0));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    required(canvas.getContext('2d')).putImageData(
      new ImageData(new Uint8ClampedArray(pixels), width, height),
      0,
      0,
    );
    await commands.writeFile(
      `${evidence}/default.native.png`,
      required(canvas.toDataURL().split(',')[1]),
      'base64',
    );
    await page.elementLocator(iframe).screenshot({ path: `${evidence}/default.browser.png` });
    const styles = roots.map((root, index) =>
      Object.fromEntries(
        [...root.querySelectorAll<HTMLElement>('input,textarea,select,button')].map((control) => {
          const style =
            index === 0
              ? required(browser.defaultView).getComputedStyle(control)
              : ui.getComputedStyle(control);
          return [
            control.id,
            Object.fromEntries(
              ['color', 'border-top-color', 'background-color', 'opacity'].map((key) => [
                key,
                style.getPropertyValue(key),
              ]),
            ),
          ];
        }),
      ),
    );
    const pixel = (x: number, y: number) => [
      ...pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 3),
    ];
    const ink = (id: string) => {
      const rect = field(1, id).getBoundingClientRect();
      let darkest = 255;
      for (let y = Math.ceil(rect.top + 4); y < rect.bottom - 4; y++)
        for (let x = Math.ceil(rect.left + 4); x < rect.left + 30; x++)
          darkest = Math.min(darkest, ...pixel(x, y));
      return darkest;
    };
    const border = (id: string) => {
      const rect = field(1, id).getBoundingClientRect();
      return pixel(Math.floor(rect.left + rect.width / 2), Math.floor(rect.top));
    };
    const painted = {
      editableInk: ink('editable'),
      disabledInk: ink('disabled'),
      editableBorder: border('editable'),
      emptyDisabledBorder: border('empty'),
      authorBorder: border('author'),
    };
    await commands.writeFile(
      `${evidence}/states.json`,
      JSON.stringify({ styles, painted, errors }, null, 2),
    );
    expect(painted.disabledInk).toBeGreaterThan(painted.editableInk + 30);
    expect(painted.disabledInk).toBeLessThan(220);
    expect(required(painted.emptyDisabledBorder[0])).toBeGreaterThan(
      required(painted.editableBorder[0]) + 20,
    );
    expect(painted.authorBorder).toEqual([17, 102, 153]);
    for (const style of styles) {
      expect(style.author).toEqual({
        color: 'rgb(153, 0, 0)',
        'border-top-color': 'rgb(17, 102, 153)',
        'background-color': 'rgb(255, 240, 208)',
        opacity: '1',
      });
      expect(style.readonly?.color).toBe(style.editable?.color);
    }
    const native = required(styles[1]);
    for (const id of ['disabled', 'empty', 'textarea', 'select', 'button'])
      expect(native[id]?.color).not.toBe(native.editable?.color);
    const backgrounds: unknown[] = [];
    for (const [name, background] of [
      ['white', 'white'],
      ['dark', '#10243a'],
    ] as const) {
      for (const document of [browser, ui.document]) {
        document.documentElement.style.backgroundColor = background;
        document.body.style.backgroundColor = background;
      }
      const nativePixels = ui.paint(performance.now()) ?? pixels;
      required(canvas.getContext('2d')).putImageData(
        new ImageData(new Uint8ClampedArray(nativePixels), width, height),
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
      const bytes = Uint8Array.from(atob(typeof shot === 'string' ? shot : shot.base64), (char) =>
        char.charCodeAt(0),
      );
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      expect([bitmap.width, bitmap.height]).toEqual([width, height]);
      const reference = new OffscreenCanvas(width, height);
      const context = required(reference.getContext('2d'));
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const browserPixels = context.getImageData(0, 0, width, height).data;
      const samples = ['disabled', 'empty', 'textarea', 'select', 'button', 'author'].map((id) => {
        const sample = (index: number, rgba: Uint8Array | Uint8ClampedArray) => {
          const rect = field(index, id).getBoundingClientRect();
          const offset =
            (Math.floor(rect.y + rect.height / 2) * width +
              Math.floor(rect.x + rect.width * 0.75)) *
            4;
          return [...rgba.subarray(offset, offset + 4)];
        };
        return { id, browser: sample(0, browserPixels), native: sample(1, nativePixels) };
      });
      backgrounds.push({ name, samples });
      await commands.writeFile(
        `${evidence}/backgrounds.json`,
        JSON.stringify(backgrounds, null, 2),
      );
      for (const sample of samples)
        for (const [channel, value] of sample.native.entries())
          expect
            .soft(
              Math.abs(value - required(sample.browser[channel])),
              `${name} ${sample.id} channel ${channel}`,
            )
            .toBeLessThanOrEqual(3);
    }
    for (const index of [0, 1]) {
      const readonly = field(index, 'readonly');
      readonly.focus();
      for (const id of ['disabled', 'empty', 'textarea', 'select', 'button', 'author']) {
        let clicks = 0;
        const control = field(index, id);
        control.addEventListener('click', () => clicks++);
        control.focus();
        control.click();
        expect(required(roots[index]).activeElement).toBe(readonly);
        expect(clicks).toBe(0);
      }
    }
    await cdp().send('Input.insertText', { text: '9' });
    ui.input.text('9');
    expect([field(0, 'readonly').value, field(1, 'readonly').value]).toEqual(['3', '3']);
    expect([field(0, 'disabled').value, field(1, 'disabled').value]).toEqual(['3', '3']);
    expect(errors).toEqual([]);
  } finally {
    for (const mount of mounts) mount.dispose();
    ui.dispose();
    iframe.remove();
  }
});
