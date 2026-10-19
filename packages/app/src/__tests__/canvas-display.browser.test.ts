import type { DisplayFacts } from '@forgeax/engine-platform';
import { createBrowserPlatform } from '@forgeax/engine-platform-browser';
import { expect, it } from 'vitest';
import { measureCanvasDrawingBuffer } from '../canvas-sizing';

it('uses native canvas display events across padded resize and visibility without frame-time layout reads', async () => {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:800px;height:450px;padding:4px;border:3px solid black';
  document.body.append(canvas);
  const platform = createBrowserPlatform(canvas).unwrap();
  let display: DisplayFacts = platform.display().unwrap();
  const release = platform
    .subscribe((event) => {
      if (event.kind === 'display') display = event.display;
    })
    .unwrap();
  const frame = () =>
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  const width = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')?.get;
  const height = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')?.get;
  if (width === undefined || height === undefined)
    throw new Error('missing native layout accessors');
  let reads = 0;
  Object.defineProperties(canvas, {
    clientWidth: {
      get() {
        reads++;
        return width.call(this);
      },
    },
    clientHeight: {
      get() {
        reads++;
        return height.call(this);
      },
    },
  });
  try {
    await frame();
    expect([display.width, display.height]).toEqual([808, 458]);
    reads = 0;
    for (let i = 0; i < 120; i++) measureCanvasDrawingBuffer(canvas, 1, display);
    expect(reads).toBe(0);
    expect(measureCanvasDrawingBuffer(canvas, 1, display)).toEqual({ width: 808, height: 458 });
    canvas.style.width = '450px';
    canvas.style.height = '800px';
    await frame();
    expect([display.width, display.height]).toEqual([458, 808]);
    reads = 0;
    expect(measureCanvasDrawingBuffer(canvas, 1, display)).toEqual({ width: 458, height: 808 });
    expect(reads).toBe(0);
    canvas.style.display = 'none';
    await frame();
    expect([display.width, display.height]).toEqual([0, 0]);
    expect(measureCanvasDrawingBuffer(canvas, 1, display)).toEqual({ width: 300, height: 150 });
    canvas.style.display = '';
    await frame();
    expect(measureCanvasDrawingBuffer(canvas, 1, display)).toEqual({ width: 458, height: 808 });
    release();
    platform.dispose();
    const previous = display;
    canvas.style.width = '700px';
    await frame();
    expect(display).toBe(previous);
  } finally {
    release();
    platform.dispose();
    canvas.remove();
  }
});
