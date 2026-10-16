import assert from 'node:assert/strict';

// A pending/navigating iframe is not ready; frame completion remains the caller's gate.
export async function assertNoRuntimeFailure(frame, label, errors, consoleErrors) {
  const diagnostic = frame.locator('#forgeax-fatal');
  if (await diagnostic.isVisible()) {
    const detail = await diagnostic.textContent({ timeout: 1000 }).catch(() =>
      'Visible fatal diagnostic disappeared during document replacement');
    assert.fail(`${label} must have no visible fatal diagnostic: ${detail?.trim().slice(0, 16000)}`);
  }
  assert.deepEqual(consoleErrors, [], `${label} must have no browser console errors`);
  assert.deepEqual(errors, [], `${label} must have no uncaught browser errors`);
}
export async function assertScenePixels(page, png, label) {
  const pixels = await page.evaluate(async png => {
    const image = await createImageBitmap(await (await fetch(png)).blob());
    try {
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, image.width, image.height).data;
      const colors = new Uint32Array(4096);
      let minimum = 255, maximum = 0, dominant = 0;
      for (let index = 0; index < data.length; index += 4) {
        const r = data[index], g = data[index + 1], b = data[index + 2];
        minimum = Math.min(minimum, r, g, b);
        maximum = Math.max(maximum, r, g, b);
        const bucket = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
        dominant = Math.max(dominant, ++colors[bucket]);
      }
      return { width: image.width, height: image.height, range: maximum - minimum,
        nonDominantRatio: 1 - dominant / (data.length / 4) };
    } finally { image.close(); }
  }, png);
  assert.ok(pixels.range >= 16 && pixels.nonDominantRatio >= 0.01,
    `${label} must show the authored multi-mesh scene, rather than a flat canvas: ${JSON.stringify(pixels)}`);
  return pixels;
}
