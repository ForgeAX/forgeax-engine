import assert from 'node:assert/strict';
import { PNG } from 'pngjs';

let captureId = 0;

export async function captureCanvas(page, { name, path, assertScene = true }) {
  const viewport = page.viewportSize();
  assert(viewport, `${name} requires a fixed browser viewport`);
  const stateKey = `__forgeaxVisualSmokeOverlay${captureId++}`;
  await page.evaluate((key) => {
    const overlays = [...document.querySelectorAll('[data-visual-smoke-overlay], .panel, .inspector, .panel-toggle')];
    (window)[key] = overlays.map((element) => ({ element, style: element.getAttribute('style') }));
    for (const { element } of (window)[key]) {
      element.style.setProperty('visibility', 'hidden', 'important');
      element.style.setProperty('pointer-events', 'none', 'important');
    }
  }, stateKey);

  let bytes;
  try {
    const canvas = page.locator('#scene');
    bytes = path ? await canvas.screenshot({ path }) : await canvas.screenshot();
  } finally {
    await page.evaluate((key) => {
      for (const { element, style } of (window)[key] ?? []) {
        if (style === null) element.removeAttribute('style');
        else element.setAttribute('style', style);
      }
      delete (window)[key];
    }, stateKey);
  }

  const surface = await page.evaluate(() => {
    const canvas = document.querySelector('#scene');
    const rect = canvas.getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight },
      devicePixelRatio,
      canvas: {
        left: rect.left,
        top: rect.top,
        cssWidth: rect.width,
        cssHeight: rect.height,
        backingWidth: canvas.width,
        backingHeight: canvas.height,
      },
    };
  });
  assert.deepEqual(surface.viewport, viewport, `${name} actual viewport differs from requested viewport`);
  assert(Math.abs(surface.canvas.left) <= 0.5 && Math.abs(surface.canvas.top) <= 0.5,
    `${name} canvas origin is offset: ${JSON.stringify(surface.canvas)}`);
  assert(Math.abs(surface.canvas.cssWidth - viewport.width) <= 0.5 && Math.abs(surface.canvas.cssHeight - viewport.height) <= 0.5,
    `${name} canvas CSS size differs from viewport: ${JSON.stringify(surface.canvas)}`);
  assert.equal(surface.canvas.backingWidth, Math.max(1, Math.floor(surface.canvas.cssWidth * surface.devicePixelRatio)),
    `${name} canvas backing width does not match CSS size and device pixel ratio`);
  assert.equal(surface.canvas.backingHeight, Math.max(1, Math.floor(surface.canvas.cssHeight * surface.devicePixelRatio)),
    `${name} canvas backing height does not match CSS size and device pixel ratio`);

  const image = PNG.sync.read(bytes);
  assert.equal(image.width, Math.round(surface.canvas.cssWidth), `${name} canvas PNG width differs from CSS size`);
  assert.equal(image.height, Math.round(surface.canvas.cssHeight), `${name} canvas PNG height differs from CSS size`);
  const metrics = pixelMetrics(image);
  if (assertScene) assertScenePixels(metrics, name);
  return { bytes, metrics, surface };
}

export function projectWorldPoint(point, view, width, height) {
  const sub = (left, right) => left.map((value, index) => value - right[index]);
  const dot = (left, right) => left.reduce((sum, value, index) => sum + value * right[index], 0);
  const cross = (left, right) => [left[1] * right[2] - left[2] * right[1], left[2] * right[0] - left[0] * right[2], left[0] * right[1] - left[1] * right[0]];
  const normalize = (value) => { const length = Math.hypot(...value); return value.map((channel) => channel / length); };
  const forward = normalize(sub(view.target, view.eye));
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const relative = sub(point, view.eye);
  const depth = dot(relative, forward);
  const tangent = Math.tan(view.fov / 2);
  const aspect = width / height;
  const xNdc = dot(relative, right) / (depth * tangent * aspect);
  const yNdc = dot(relative, up) / (depth * tangent);
  return { x: (xNdc + 1) * width / 2, y: (1 - yNdc) * height / 2 };
}

export function countPixelsInCircle(bytes, center, radius, predicate) {
  const image = PNG.sync.read(bytes);
  const minX = Math.max(0, Math.floor(center.x - radius));
  const maxX = Math.min(image.width - 1, Math.ceil(center.x + radius));
  const minY = Math.max(0, Math.floor(center.y - radius));
  const maxY = Math.min(image.height - 1, Math.ceil(center.y + radius));
  let count = 0;
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    if ((x - center.x) ** 2 + (y - center.y) ** 2 > radius ** 2) continue;
    const offset = (y * image.width + x) * 4;
    if (predicate(image.data[offset], image.data[offset + 1], image.data[offset + 2])) count++;
  }
  return count;
}

export function pixelDifferenceInCircle(leftBytes, rightBytes, center, radius, threshold = 4) {
  const left = PNG.sync.read(leftBytes), right = PNG.sync.read(rightBytes);
  assert.equal(left.width, right.width);
  assert.equal(left.height, right.height);
  const minX = Math.max(0, Math.floor(center.x - radius));
  const maxX = Math.min(left.width - 1, Math.ceil(center.x + radius));
  const minY = Math.max(0, Math.floor(center.y - radius));
  const maxY = Math.min(left.height - 1, Math.ceil(center.y + radius));
  let changed = 0, compared = 0;
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    if ((x - center.x) ** 2 + (y - center.y) ** 2 > radius ** 2) continue;
    compared++;
    const offset = (y * left.width + x) * 4;
    if ([0, 1, 2].some((channel) => Math.abs(left.data[offset + channel] - right.data[offset + channel]) > threshold)) changed++;
  }
  return { center, radius, changedPixels: changed, comparedPixels: compared, changedRatio: compared === 0 ? 0 : changed / compared };
}

function pixelMetrics(image) {
  const colors = new Set();
  const clear = [image.data[0], image.data[1], image.data[2]];
  let different = 0, opaque = 0, luminance = 0, luminanceSquared = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const r = image.data[offset], g = image.data[offset + 1], b = image.data[offset + 2], a = image.data[offset + 3];
    colors.add(`${r},${g},${b}`);
    if (a > 245) opaque++;
    if (Math.max(Math.abs(r - clear[0]), Math.abs(g - clear[1]), Math.abs(b - clear[2])) > 12) different++;
    const value = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255;
    luminance += value;
    luminanceSquared += value * value;
  }
  const count = image.width * image.height;
  const mean = luminance / count;
  return {
    width: image.width,
    height: image.height,
    distinctColors: colors.size,
    uniqueColorBins: new Set([...colors].map((color) => color.split(',').map((channel) => Number(channel) >> 3).join(':'))).size,
    opaqueRatio: opaque / count,
    pixelsDifferentFromClearCorner: different,
    differentFromClearRatio: different / count,
    luminanceVariance: luminanceSquared / count - mean * mean,
  };
}

export function assertScenePixels(metrics, name) {
  assert(metrics.distinctColors > 80, `${name} canvas has too few colors: ${JSON.stringify(metrics)}`);
  assert(metrics.opaqueRatio > 0.9, `${name} canvas is mostly transparent: ${JSON.stringify(metrics)}`);
  assert(metrics.differentFromClearRatio > 0.015, `${name} canvas has too little scene variation: ${JSON.stringify(metrics)}`);
  assert(metrics.luminanceVariance > 0.001, `${name} canvas appears nearly flat: ${JSON.stringify(metrics)}`);
}
