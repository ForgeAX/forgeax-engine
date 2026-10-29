import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  openReplay,
  summarizeFrame,
} from '@forgeax/engine-rhi-debug';
import type {} from '@vitest/browser-playwright';
import { expect, it } from 'vitest';
import { cdp, commands, page } from 'vitest/browser';
import * as webgpu from '../../../rhi-webgpu/src/index.js';
import { disabledControlsRasterCase } from '../../../ui-blitz/src/__tests__/disabled-controls-fixture.js';
import { required } from '../../../ui-blitz/src/__tests__/fixture.js';
import { compareUiRaster } from '../../../ui-blitz/src/__tests__/gpu-parity-fixture.js';
import { profileSettingsHtml as html } from '../../../ui-blitz/src/__tests__/profile-settings-fixture.js';
import { verifyGpuUiParity } from './gpu-ui-parity.fixture.js';

const width = 440,
  height = 480;
const load = async (url: URL) => new Uint8Array(await (await fetch(url)).arrayBuffer());
const bytes = await load(new URL('../../../ui-blitz/pkg/ui_blitz_bg.wasm', import.meta.url));
const wasm = {
  readWasm: async () => bytes,
  instantiate: (imports: object) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
};
const ids = ['check', 'radio-a', 'radio-b'];
const rectangles = (document: Document) =>
  ids.map((id) => {
    const node = required(document.getElementById(id));
    const rect = node.getBoundingClientRect();
    return { id, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
function base64(bytes: Uint8Array) {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 32768)
    text += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(text);
}
function pixelCanvas(pixels: Uint8Array, imageWidth = width) {
  const canvas = document.createElement('canvas');
  canvas.width = imageWidth;
  canvas.height = pixels.length / imageWidth / 4;
  required(canvas.getContext('2d')).putImageData(
    new ImageData(new Uint8ClampedArray(pixels), canvas.width, canvas.height),
    0,
    0,
  );
  return canvas;
}

async function screenshotPixels(iframe: HTMLIFrameElement, path: string) {
  const browserScreenshot = await page.elementLocator(iframe).screenshot({ base64: true, path });
  const browserBytes = Uint8Array.from(
    atob(typeof browserScreenshot === 'string' ? browserScreenshot : browserScreenshot.base64),
    (char) => char.charCodeAt(0),
  );
  const bitmap = await createImageBitmap(new Blob([browserBytes], { type: 'image/png' }));
  expect([bitmap.width, bitmap.height], 'browser reference must retain exact CSS pixels').toEqual([
    width,
    height,
  ]);
  const snapshot = new OffscreenCanvas(width, height);
  const context = required(snapshot.getContext('2d'));
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Uint8Array(context.getImageData(0, 0, width, height).data.buffer);
}

function controlInk(
  pixels: Uint8Array,
  rect: { x: number; y: number; width: number; height: number },
) {
  const accent: [number, number][] = [];
  let white = 0;
  for (let y = Math.floor(rect.y); y < Math.ceil(rect.y + rect.height); y++)
    for (let x = Math.floor(rect.x); x < Math.ceil(rect.x + rect.width); x++) {
      const offset = (y * width + x) * 4;
      const r = required(pixels[offset]),
        g = required(pixels[offset + 1]),
        b = required(pixels[offset + 2]);
      if (r < 50 && g > 70 && g < 180 && b > 200) accent.push([x, y]);
      if (r > 240 && g > 240 && b > 240) white++;
    }
  const left = Math.min(...accent.map(([x]) => x));
  const top = Math.min(...accent.map(([, y]) => y));
  const right = Math.max(...accent.map(([x]) => x));
  const bottom = Math.max(...accent.map(([, y]) => y));
  const track = [];
  const x = Math.floor(rect.x + rect.width * 0.75);
  for (let y = Math.floor(rect.y); y < Math.ceil(rect.y + rect.height); y++) {
    const offset = (y * width + x) * 4;
    const rgb = [...pixels.subarray(offset, offset + 3)];
    if (rgb[0] !== 16 || rgb[1] !== 36 || rgb[2] !== 58) track.push({ y: y - rect.y, rgb });
  }
  const thumb = accent.filter(([, y]) => y < rect.y + 4 || y >= rect.y + rect.height - 4);
  const thumbCenter = thumb.length
    ? (Math.min(...thumb.map(([x]) => x)) + Math.max(...thumb.map(([x]) => x)) + 1) / 2 - rect.x
    : null;
  return {
    white,
    thumbCenter,
    accent: accent.length
      ? { x: left - rect.x, y: top - rect.y, width: right - left + 1, height: bottom - top + 1 }
      : null,
    track,
  };
}

it('matches Chromium checkable and range geometry through native layout and WebGPU', async () => {
  const testPath = required(expect.getState().testPath);
  const evidence = `${testPath.slice(0, testPath.lastIndexOf('/packages/'))}/artifacts/ui-checkable-intrinsic`;
  const font = await load(
    new URL(
      '../../../devkit/node_modules/@fontsource-variable/noto-sans-sc/files/noto-sans-sc-latin-wght-normal.woff2',
      import.meta.url,
    ),
  );
  await cdp().send('Emulation.setDeviceMetricsOverride', {
    width: 1500,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // Portable native scroll containers use overlay/no-gutter geometry.
  // Match the existing native-control differential's browser display setting.
  await cdp().send('Emulation.setScrollbarsHidden', { hidden: true });
  await page.viewport(width * 3 + 24, height + 28);
  const stage = document.createElement('section');
  stage.style.cssText = `position:absolute;inset:0;width:${width * 3 + 24}px;height:${height + 28}px;background:#10243a;color:white`;
  const legend = document.createElement('div');
  legend.textContent =
    'Chromium (left) / Blitz CPU (middle) / Blitz WebGPU (right): native controls';
  legend.style.cssText = 'height:28px;font:14px/28px sans-serif';
  const iframe = document.createElement('iframe');
  iframe.style.cssText = `position:absolute;left:0;top:28px;width:${width}px;height:${height}px;border:0`;
  const loaded = new Promise<void>((resolve) => {
    iframe.onload = () => resolve();
  });
  iframe.srcdoc = html;
  stage.append(legend, iframe);
  document.body.append(stage);
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const replayDevice = (await (await webgpu.requestAdapter()).unwrap().requestDevice()).unwrap();
  try {
    await loaded;
    const browser = required(iframe.contentDocument);
    browser.fonts.add(await new FontFace('Reset Form', font.slice().buffer).load());
    await browser.fonts.ready;
    const browserRects = rectangles(browser);
    const allRects = (document: Document) =>
      Object.fromEntries(
        [...document.querySelectorAll<HTMLElement>('[id]')].map((node) => [
          node.id,
          node.getBoundingClientRect().toJSON(),
        ]),
      );
    const geometry: { browser: Record<string, DOMRect>; native: Record<string, DOMRect> } = {
      browser: allRects(browser),
      native: {},
    };
    const browserRange = required(browser.getElementById('volume')).getBoundingClientRect();
    const browserPixels = await screenshotPixels(iframe, `${evidence}/chromium.png`);
    let nativeRange: DOMRect | undefined;

    const browserDisabled = required(browser.getElementById('locked'));
    const browserDisabledStyle = required(browser.defaultView).getComputedStyle(browserDisabled);
    const disabled: Record<string, unknown> = {
      browser: {
        background: browserDisabledStyle.backgroundColor,
        color: browserDisabledStyle.color,
        rect: browserDisabled.getBoundingClientRect().toJSON(),
      },
    };
    let nativeDisabledRect: DOMRect | undefined;
    let nativeRects: ReturnType<typeof rectangles> = [];
    let livePixels: Uint8Array = new Uint8Array();
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const results = await verifyGpuUiParity({
      device,
      createReplacementDevice: async () => {
        throw new Error('This frame must retain its device');
      },
      wasm,
      font,
      fontFamily: 'Reset Form',
      cases: [
        {
          name: 'profile-markers',
          html,
          width,
          height,
          states: [
            {
              name: 'auto-width',
              time: 0,
              apply: (ui) => {
                nativeRects = rectangles(ui.document);
                geometry.native = allRects(ui.document);
                nativeRange = required(
                  ui.document.getElementById('volume'),
                ).getBoundingClientRect();
                const node = required(ui.document.getElementById('locked'));
                const style = ui.getComputedStyle(node);
                nativeDisabledRect = node.getBoundingClientRect();
                disabled.native = {
                  background: style.getPropertyValue('background-color'),
                  color: style.getPropertyValue('color'),
                  rect: nativeDisabledRect.toJSON(),
                };
              },
            },
          ],
        },
      ],
      createShaderModule: async (owner, code) =>
        (await recorder.backend.createShaderModule(owner, { code })).unwrap(),
      save: async (_name, _width, expected, actual) => {
        livePixels = actual;
        const rect = required(nativeDisabledRect);
        const offset =
          (Math.floor(rect.bottom - 5) * width + Math.floor(rect.left + rect.width / 2)) * 4;
        disabled.gpuInteriorPixel = [...actual.subarray(offset, offset + 4)];
        const browserRect = browserDisabled.getBoundingClientRect();
        const browserOffset =
          (Math.floor(browserRect.bottom - 5) * width +
            Math.floor(browserRect.left + browserRect.width / 2)) *
          4;
        disabled.browserInteriorPixel = [
          ...browserPixels.subarray(browserOffset, browserOffset + 4),
        ];
        const canvas = pixelCanvas(actual);
        canvas.style.cssText = `position:absolute;left:${(width + 12) * 2}px;top:28px`;
        const cpuCanvas = pixelCanvas(expected);
        cpuCanvas.style.cssText = `position:absolute;left:${width + 12}px;top:28px`;
        stage.append(cpuCanvas, canvas);
        await commands.writeFile(
          `${evidence}/cpu.png`,
          required(pixelCanvas(expected).toDataURL().split(',')[1]),
          'base64',
        );
        await commands.writeFile(
          `${evidence}/gpu.png`,
          required(canvas.toDataURL().split(',')[1]),
          'base64',
        );
      },
    });
    (await recorder.frameBoundary()).unwrap();
    const capture = (await pending).unwrap();
    await commands.writeFile(`${evidence}/frame.rhitape`, base64(capture.bytes), 'base64');
    const tape = decodeTape(capture.bytes).unwrap();
    const model = buildFrameModel(tape);
    await commands.writeFile(`${evidence}/model.json`, JSON.stringify(model));
    await commands.writeFile(
      `${evidence}/summary.json`,
      JSON.stringify(summarizeFrame(model), null, 2),
    );
    const replay = (
      await openReplay(tape, {
        device: replayDevice,
        createShaderModule: webgpu.createShaderModule,
      })
    ).unwrap();
    let inspection: unknown;
    let comparison: ReturnType<typeof compareUiRaster>;
    try {
      const final = required(model.works.at(-1));
      const read = (
        await replay.inspectWork(final.workIndex, ['pipeline', 'bindings', 'pixels'])
      ).unwrap();
      const { attachment: pixels, ...facts } = read;
      inspection = facts;
      const attachment = required(pixels);
      const rowStride = attachment.bytes.length / height;
      const rgba = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++)
        rgba.set(
          attachment.bytes.subarray(y * rowStride, y * rowStride + width * 4),
          y * width * 4,
        );
      comparison = compareUiRaster(livePixels, rgba);
      await commands.writeFile(
        `${evidence}/replay.png`,
        required(pixelCanvas(rgba).toDataURL().split(',')[1]),
        'base64',
      );
    } finally {
      (await replay.dispose()).unwrap();
    }
    await commands.writeFile(`${evidence}/inspection.json`, JSON.stringify(inspection, null, 2));
    const metrics = {
      browser: {
        check: controlInk(browserPixels, required(browserRects[0])),
        radio: controlInk(browserPixels, required(browserRects[1])),
        range: controlInk(browserPixels, browserRange),
      },
      native: {
        check: controlInk(livePixels, required(nativeRects[0])),
        radio: controlInk(livePixels, required(nativeRects[1])),
        range: controlInk(livePixels, required(nativeRange)),
      },
    };
    await commands.writeFile(
      `${evidence}/result.json`,
      JSON.stringify(
        {
          environment: { deviceScaleFactor: 1, scrollbarGutter: 0 },
          disabled,
          geometry,
          metrics,
          browserRects,
          nativeRects,
          results,
          comparison,
          digest: capture.digest,
          bytes: capture.byteLength,
          backend: device.caps.backendKind,
          unseededResources: model.unseededResources,
        },
        null,
        2,
      ),
    );
    await page.elementLocator(stage).screenshot({ path: `${evidence}/profile-markers.png` });
    expect(comparison.maxError).toBeLessThanOrEqual(0.05);
    for (const [id, rect] of Object.entries(geometry.native)) {
      const reference = required(geometry.browser[id]);
      for (const axis of ['x', 'y', 'width', 'height'] as const)
        expect(Math.abs(rect[axis] - reference[axis]), `${id} ${axis}`).toBeLessThanOrEqual(1);
    }
    expect(
      metrics.native.check.white,
      'checkmark retains its visible stroke',
    ).toBeGreaterThanOrEqual(metrics.browser.check.white * 0.7);
    expect(
      Math.abs(
        required(metrics.native.radio.accent).width - required(metrics.browser.radio.accent).width,
      ),
      'radio ring reaches the native box edge',
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(metrics.native.range.track.length - metrics.browser.range.track.length),
      'range track thickness',
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(
        required(metrics.native.range.accent).height -
          required(metrics.browser.range.accent).height,
      ),
      'visible thumb height',
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(required(metrics.native.range.accent).x - required(metrics.browser.range.accent).x),
      'range endpoint inset',
    ).toBeLessThanOrEqual(1);

    expect(
      Math.abs(
        required(metrics.native.range.thumbCenter) - required(metrics.browser.range.thumbCenter),
      ),
      'range value maps to the same thumb center',
    ).toBeLessThanOrEqual(1);
    for (const [channel, value] of (disabled.gpuInteriorPixel as number[]).entries())
      expect(
        Math.abs(value - required((disabled.browserInteriorPixel as number[])[channel])),
        'disabled native background composes with the actual authored backdrop',
      ).toBeLessThanOrEqual(3);
    for (const [index, rect] of nativeRects.entries()) {
      const reference = required(browserRects[index]);
      expect(rect.width, rect.id).toBe(reference.width);
      expect(rect.height, rect.id).toBe(reference.height);
      expect(rect.width, `${rect.id} remains hittable`).toBeGreaterThan(0);
    }

    const positions: unknown[] = [];
    let whiteField: DOMRect | undefined;
    const range = required(browser.querySelector<HTMLInputElement>('#volume'));
    await verifyGpuUiParity({
      device,
      createReplacementDevice: async () => {
        throw new Error('Unexpected control device replacement');
      },
      wasm,
      font,
      fontFamily: 'Reset Form',
      createShaderModule: async (owner, code) =>
        (await recorder.backend.createShaderModule(owner, { code })).unwrap(),
      cases: [
        {
          name: 'range',
          html,
          width,
          height,
          states: [0, 50, 100].map((value) => ({
            name: String(value),
            time: value + 1,
            apply: (ui) => {
              range.value = String(value);
              required(ui.document.querySelector<HTMLInputElement>('#volume')).value =
                String(value);
            },
          })),
        },
        {
          ...disabledControlsRasterCase,
          states: [
            {
              name: 'default',
              time: 0,
              apply: (ui) => {
                required(disabledControlsRasterCase.states[0]).apply?.(ui);
                const host = required(ui.document.querySelector('[data-ui-asset]'));
                whiteField = required(
                  required(host.shadowRoot).querySelector('#empty'),
                ).getBoundingClientRect();
              },
            },
          ],
        },
      ],
      save: async (name, imageWidth, expected, actual) => {
        if (name.startsWith('disabled-controls-')) {
          for (const [renderer, pixels] of [
            ['cpu', expected],
            ['gpu', actual],
          ] as const)
            await commands.writeFile(
              `${evidence}/disabled-white-${renderer}.png`,
              required(pixelCanvas(pixels, imageWidth).toDataURL().split(',')[1]),
              'base64',
            );
          const rect = required(whiteField);
          const offset =
            (Math.floor(rect.y + rect.height / 2) * imageWidth +
              Math.floor(rect.x + rect.width * 0.75)) *
            4;
          for (const value of actual.subarray(offset, offset + 3))
            expect(
              Math.abs(value - 248),
              'white-surface disabled native field',
            ).toBeLessThanOrEqual(1);
          return;
        }
        const reference = await screenshotPixels(iframe, `${evidence}/${name}-chromium.png`);
        const browserInk = controlInk(reference, range.getBoundingClientRect());
        const nativeInk = controlInk(actual, required(nativeRange));
        positions.push({ value: range.value, browser: browserInk, native: nativeInk });
        for (const canvas of stage.querySelectorAll('canvas')) canvas.remove();
        for (const [column, pixels] of [expected, actual].entries()) {
          const canvas = pixelCanvas(pixels);
          canvas.style.cssText = `position:absolute;left:${(width + 12) * (column + 1)}px;top:28px`;
          stage.append(canvas);
        }
        await page.elementLocator(stage).screenshot({ path: `${evidence}/${name}.png` });
        await commands.writeFile(
          `${evidence}/range-positions.json`,
          JSON.stringify(positions, null, 2),
        );
        expect(
          Math.abs(required(nativeInk.thumbCenter) - required(browserInk.thumbCenter)),
          name,
        ).toBeLessThanOrEqual(1);
      },
    });
  } finally {
    (await recorder.dispose()).unwrap();
    stage.remove();
    await cdp().send('Emulation.setScrollbarsHidden', { hidden: false });
    await cdp().send('Emulation.clearDeviceMetricsOverride');
  }
}, 30_000);
